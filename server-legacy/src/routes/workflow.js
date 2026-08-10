import { Router } from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { db, uid, nowISO, txn, addDays, daysBetween, fileHash, UPLOAD_DIR } from "../db.js";
import { authenticate, require_, audit, notify } from "../rbac.js";

const r = Router();
r.use(authenticate);

/* Defaults reflecting Alberta practice. Confirm with your manager before relying
   on them; they are constants here so they are easy to change in one place. */
const NOTICE_REQUIRED = { periodic: 30, fixed_12: 0, fixed_6: 0 };
const REFUND_DAYS = 10;
const ENTRY_NOTICE_HOURS = 24;

/* ================= Move-out ================= */

r.post("/moveouts", require_("moveout.process"), (req, res) => {
  const { unit_number, tenant_name, tenant_phone, tenant_email,
          notice_date, moveout_date, lease_id } = req.body ?? {};
  if (!unit_number || !notice_date || !moveout_date)
    return res.status(400).json({ code: "MISSING_MOVEOUT_FIELDS" });

  const lease = lease_id
    ? db.prepare("SELECT * FROM leases WHERE id = ?").get(lease_id)
    : db.prepare(`SELECT * FROM leases WHERE unit_number = ? AND status='active'
                  ORDER BY start_date DESC LIMIT 1`).get(unit_number);

  const term = lease?.term_type ?? "periodic";
  const required = NOTICE_REQUIRED[term] ?? 30;
  const given = daysBetween(notice_date, moveout_date);
  const ok = given >= required ? 1 : 0;

  const id = uid("mo_");
  db.prepare(`INSERT INTO moveouts (id, unit_number, lease_id, tenant_name, tenant_phone,
    tenant_email, notice_date, moveout_date, notice_days, notice_required, notice_ok,
    deposit_original, refund_deadline)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, unit_number, lease?.id ?? null, tenant_name ?? null, tenant_phone ?? null,
         tenant_email ?? null, notice_date, moveout_date, given, required, ok,
         lease?.deposit ?? null, addDays(moveout_date, REFUND_DAYS));

  // PM and Admin get the notice-period result; BM is told showings can begin.
  const code = ok ? "MOVEOUT_NOTICE_OK" : "MOVEOUT_NOTICE_SHORT";
  const params = { unit: unit_number, given, required };
  notify("property_manager", "moveout", code, params, `/moveouts/${id}`);
  notify("admin", "moveout", code, params, `/moveouts/${id}`);
  notify("building_manager", "showing", "MOVEOUT_SHOWINGS_MAY_START",
         { unit: unit_number, moveout_date, hours: ENTRY_NOTICE_HOURS },
         `/showings?unit=${unit_number}`);

  audit(req, { action: "moveout.create", entityType: "moveout", entityId: id,
               after: { unit_number, notice_date, moveout_date, given, required, ok } });
  res.status(201).json({ id, notice_days: given, notice_required: required, notice_ok: !!ok });
});

r.get("/moveouts", require_("units.view"), (req, res) => {
  const rows = db.prepare("SELECT * FROM moveouts ORDER BY moveout_date").all();
  const steps = db.prepare("SELECT * FROM moveout_steps").all();
  const deds = db.prepare("SELECT * FROM deductions").all();
  const today = new Date().toISOString().slice(0, 10);
  res.json({
    moveouts: rows.map((m) => ({
      ...m,
      steps: steps.filter((s) => s.moveout_id === m.id),
      deductions: deds.filter((d) => d.moveout_id === m.id),
      days_to_refund: m.refund_deadline ? daysBetween(today, m.refund_deadline) : null,
    })),
  });
});

r.post("/moveouts/:id/steps/:step", require_("moveout.process"), (req, res) => {
  const mo = db.prepare("SELECT * FROM moveouts WHERE id = ?").get(req.params.id);
  if (!mo) return res.status(404).json({ code: "MOVEOUT_NOT_FOUND" });
  db.prepare(`INSERT INTO moveout_steps (id, moveout_id, step, payload, done_by)
              VALUES (?,?,?,?,?)
              ON CONFLICT(moveout_id, step) DO UPDATE SET payload=excluded.payload,
              done_by=excluded.done_by, done_at=datetime('now')`)
    .run(uid("ms_"), mo.id, req.params.step, JSON.stringify(req.body ?? {}), req.user.id);
  audit(req, { action: "moveout.step", entityType: "moveout", entityId: mo.id,
               after: { step: req.params.step, payload: req.body } });
  res.json({ ok: true });
});

/** Confirming the tenant has vacated releases parking (promoting the waitlist)
 *  and the unit, all in one transaction. */
r.post("/moveouts/:id/vacate", require_("moveout.process"), (req, res) => {
  try {
    const out = txn(() => {
      const mo = db.prepare("SELECT * FROM moveouts WHERE id = ?").get(req.params.id);
      if (!mo) throw Object.assign(new Error("MOVEOUT_NOT_FOUND"), { status: 404 });
      if (mo.vacated_at) throw Object.assign(new Error("ALREADY_VACATED"), { status: 409 });

      const mine = db.prepare(`SELECT * FROM parking_allocations
                               WHERE unit_number=? AND status<>'released'`).all(mo.unit_number);
      const promoted = [];
      for (const a of mine) {
        db.prepare("UPDATE parking_allocations SET status='released', released_at=? WHERE id=?")
          .run(nowISO(), a.id);
        if (a.status === "assigned") {
          const next = db.prepare(`SELECT * FROM parking_allocations
                                   WHERE pool_code=? AND status='waiting'
                                   ORDER BY requested_at LIMIT 1`).get(a.pool_code);
          if (next) {
            db.prepare("UPDATE parking_allocations SET status='assigned', assigned_at=? WHERE id=?")
              .run(nowISO(), next.id);
            promoted.push({ unit: next.unit_number, pool: a.pool_code });
          }
        }
      }

      db.prepare(`UPDATE units SET status='turnover', available_from=NULL, updated_at=?
                  WHERE unit_number=?`).run(nowISO(), mo.unit_number);
      db.prepare("UPDATE moveouts SET vacated_at=?, vacated_by=? WHERE id=?")
        .run(nowISO(), req.user.id, mo.id);
      if (mo.lease_id) db.prepare("UPDATE leases SET status='ended' WHERE id=?").run(mo.lease_id);
      db.prepare("DELETE FROM unit_locks WHERE unit_number=?").run(mo.unit_number);

      return { unit: mo.unit_number, released: mine.length, promoted };
    })();

    notify("building_manager", "turnover", "UNIT_VACATED", { unit: out.unit }, `/units/${out.unit}`);
    audit(req, { action: "moveout.vacate", entityType: "moveout", entityId: req.params.id, after: out });
    res.json(out);
  } catch (e) {
    res.status(e.status ?? 500).json({ code: e.message });
  }
});

/* ================= Deductions ================= */

r.post("/moveouts/:id/deductions", require_("moveout.process"), (req, res) => {
  const { label, amount, basis } = req.body ?? {};
  if (!label || !Number.isFinite(Number(amount)))
    return res.status(400).json({ code: "MISSING_DEDUCTION_FIELDS" });
  const id = uid("dd_");
  db.prepare(`INSERT INTO deductions (id, moveout_id, label, amount, basis, created_by)
              VALUES (?,?,?,?,?,?)`)
    .run(id, req.params.id, label, Number(amount), basis ?? null, req.user.id);
  audit(req, { action: "deduction.add", entityType: "deduction", entityId: id,
               after: { label, amount, basis } });
  res.status(201).json({ id });
});

/** Notice must go out before the tenant-response stage. Deducting without
 *  notifying first is the most common way these disputes are lost. */
r.post("/moveouts/:id/deductions/notify", require_("moveout.process"), (req, res) => {
  const n = db.prepare(`UPDATE deductions SET state='notified', notified_at=?
                        WHERE moveout_id=? AND state='proposed'`).run(nowISO(), req.params.id);
  audit(req, { action: "deduction.notify", entityType: "moveout", entityId: req.params.id,
               after: { notified: n.changes } });
  res.json({ notified: n.changes });
});

r.patch("/deductions/:id", require_("moveout.process"), (req, res) => {
  const before = db.prepare("SELECT * FROM deductions WHERE id = ?").get(req.params.id);
  if (!before) return res.status(404).json({ code: "DEDUCTION_NOT_FOUND" });
  const { state, tenant_says, upheld_basis } = req.body ?? {};

  if (state === "upheld") {
    if (!(upheld_basis ?? before.upheld_basis ?? "").trim())
      return res.status(400).json({ code: "UPHELD_REQUIRES_BASIS" });
    const ev = db.prepare(`SELECT COUNT(*) n FROM evidence
                           WHERE entity_type='deduction' AND entity_id=?`).get(before.id).n;
    if (ev === 0) return res.status(400).json({ code: "UPHELD_REQUIRES_EVIDENCE" });
  }

  db.prepare(`UPDATE deductions SET state=COALESCE(?,state), tenant_says=COALESCE(?,tenant_says),
              upheld_basis=COALESCE(?,upheld_basis),
              resolved_at=CASE WHEN ? IN ('accepted','withdrawn','upheld') THEN ? ELSE resolved_at END
              WHERE id=?`)
    .run(state ?? null, tenant_says ?? null, upheld_basis ?? null, state ?? "", nowISO(), before.id);

  const after = db.prepare("SELECT * FROM deductions WHERE id = ?").get(before.id);
  audit(req, { action: "deduction.update", entityType: "deduction", entityId: before.id, before, after });
  res.json({ deduction: after });
});

/* ================= Evidence ================= */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
});

r.post("/evidence", require_("evidence.upload"), upload.array("files", 10), (req, res) => {
  const { entity_type, entity_id, caption, taken_at } = req.body ?? {};
  if (!entity_type || !entity_id) return res.status(400).json({ code: "MISSING_ENTITY" });
  if (!req.files?.length) return res.status(400).json({ code: "NO_FILES" });

  const saved = [];
  for (const f of req.files) {
    const hash = fileHash(f.buffer);
    const safe = f.originalname.replace(/[^\w.\-]/g, "_").slice(-80);
    const name = `${Date.now()}_${hash.slice(0, 8)}_${safe}`;
    const dir = path.join(UPLOAD_DIR, entity_type);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), f.buffer);

    const id = uid("ev_");
    db.prepare(`INSERT INTO evidence (id, entity_type, entity_id, filename, stored_path,
      mime_type, size_bytes, sha256, caption, taken_at, uploaded_by, uploaded_name)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, entity_type, entity_id, f.originalname, path.join(entity_type, name),
           f.mimetype, f.size, hash, caption ?? null, taken_at ?? null, req.user.id, req.user.name);
    saved.push({ id, filename: f.originalname, sha256: hash, size: f.size });
  }

  audit(req, { action: "evidence.upload", entityType: entity_type, entityId: entity_id,
               after: { files: saved.map((s) => ({ name: s.filename, sha256: s.sha256 })) } });
  res.status(201).json({ evidence: saved });
});

r.get("/evidence/:entityType/:entityId", require_("evidence.upload"), (req, res) => {
  res.json({ evidence: db.prepare(`SELECT id, filename, mime_type, size_bytes, sha256, caption,
    taken_at, uploaded_name, uploaded_at FROM evidence
    WHERE entity_type=? AND entity_id=? ORDER BY uploaded_at`)
    .all(req.params.entityType, req.params.entityId) });
});

r.get("/evidence/file/:id", require_("evidence.upload"), (req, res) => {
  const e = db.prepare("SELECT * FROM evidence WHERE id = ?").get(req.params.id);
  if (!e) return res.status(404).json({ code: "EVIDENCE_NOT_FOUND" });
  res.type(e.mime_type || "application/octet-stream")
     .sendFile(path.join(UPLOAD_DIR, e.stored_path));
});

/* No delete endpoint. To retract a file, add a note; the original stays. */

/* ================= Maintenance ================= */

r.get("/maintenance", require_("units.view"), (req, res) => {
  const rows = db.prepare("SELECT * FROM maintenance ORDER BY rush DESC, created_at DESC").all();
  const notes = db.prepare("SELECT * FROM maintenance_notes ORDER BY at").all();
  res.json({ tickets: rows.map((t) => ({ ...t, notes: notes.filter((n) => n.ticket_id === t.id) })) });
});

r.post("/maintenance", require_("maintenance.manage"), (req, res) => {
  const { unit_number, tenant_name, tenant_phone, category, priority, description } = req.body ?? {};
  if (!unit_number || !description) return res.status(400).json({ code: "MISSING_TICKET_FIELDS" });
  const id = uid("mt_");
  db.prepare(`INSERT INTO maintenance (id, unit_number, tenant_name, tenant_phone,
    category, priority, description) VALUES (?,?,?,?,?,?,?)`)
    .run(id, unit_number, tenant_name ?? null, tenant_phone ?? null,
         category ?? "other", priority ?? "normal", description);
  audit(req, { action: "maintenance.create", entityType: "maintenance", entityId: id,
               after: { unit_number, category, priority } });
  res.status(201).json({ id });
});

r.patch("/maintenance/:id", require_("maintenance.manage"), (req, res) => {
  const before = db.prepare("SELECT * FROM maintenance WHERE id = ?").get(req.params.id);
  if (!before) return res.status(404).json({ code: "TICKET_NOT_FOUND" });
  const { state, rush, vendor, scheduled_at, priority } = req.body ?? {};
  const rushFlag = rush === undefined ? null : (rush ? 1 : 0);

  db.prepare(`UPDATE maintenance SET state=COALESCE(?,state), priority=COALESCE(?,priority),
    vendor=COALESCE(?,vendor), scheduled_at=COALESCE(?,scheduled_at),
    rush=COALESCE(?,rush),
    rush_by=CASE WHEN ?=1 THEN ? ELSE rush_by END,
    rush_at=CASE WHEN ?=1 THEN ? ELSE rush_at END,
    completed_at=CASE WHEN ?='done' THEN ? ELSE completed_at END
    WHERE id=?`)
    .run(state ?? null, priority ?? null, vendor ?? null, scheduled_at ?? null, rushFlag,
         rushFlag ?? 0, req.user.name, rushFlag ?? 0, nowISO(), state ?? "", nowISO(), before.id);

  // A vendor visit goes on the calendar but does not occupy staff time (blocking = 0),
  // so it never collides with a showing or a key handover.
  if (scheduled_at) {
    db.prepare(`INSERT INTO events (id, type, unit_number, contact_name, contact_info,
      assignee, starts_at, duration_min, blocking, ref_id, created_via)
      VALUES (?,?,?,?,?,?,?,?,0,?,'staff')`)
      .run(uid("ev_"), "maintenance", before.unit_number,
           `${before.category} / ${vendor ?? before.vendor ?? "vendor TBD"}`,
           before.tenant_phone ?? "", "vendor", scheduled_at, 60, before.id);
    notify("building_manager", "maintenance", "VENDOR_VISIT_SCHEDULED",
           { unit: before.unit_number, at: scheduled_at, hours: ENTRY_NOTICE_HOURS },
           `/maintenance/${before.id}`);
  }

  const after = db.prepare("SELECT * FROM maintenance WHERE id = ?").get(before.id);
  audit(req, { action: "maintenance.update", entityType: "maintenance", entityId: before.id,
               before, after });
  res.json({ ticket: after });
});

r.post("/maintenance/:id/notes", require_("maintenance.manage"), (req, res) => {
  const body = String(req.body?.body ?? "").trim();
  if (!body) return res.status(400).json({ code: "EMPTY_NOTE" });
  const id = uid("mn_");
  db.prepare(`INSERT INTO maintenance_notes (id, ticket_id, body, by_user, by_name)
              VALUES (?,?,?,?,?)`).run(id, req.params.id, body, req.user.id, req.user.name);
  res.status(201).json({ id });
});

/* ================= Notices of entry ================= */
/* Shared by showings and vendor visits: anyone entering an occupied unit needs one. */

r.get("/entry-notices/pending", require_("entrynotice.manage"), (req, res) => {
  const occupied = db.prepare(`SELECT unit_number, tenant_name, tenant_email, tenant_phone
                               FROM moveouts WHERE state='open' AND vacated_at IS NULL`).all();
  const map = Object.fromEntries(occupied.map((o) => [o.unit_number, o]));
  const sent = new Set(db.prepare("SELECT ref_id FROM entry_notices WHERE state='sent'")
                         .all().map((x) => x.ref_id));

  const showings = db.prepare(`SELECT * FROM events
    WHERE type='showing' AND state='booked' AND starts_at > datetime('now')`).all()
    .filter((e) => map[e.unit_number] && !sent.has(e.id))
    .map((e) => ({ kind: "showing", ref_id: e.id, unit_number: e.unit_number,
                   starts_at: e.starts_at, tenant: map[e.unit_number],
                   lead_hours: (new Date(e.starts_at) - Date.now()) / 3.6e6 }));

  const visits = db.prepare(`SELECT * FROM maintenance
    WHERE scheduled_at IS NOT NULL AND state IN ('scheduled','in_progress')
      AND datetime(scheduled_at) > datetime('now')`).all()
    .filter((m) => !sent.has(m.id))
    .map((m) => ({ kind: "maintenance", ref_id: m.id, unit_number: m.unit_number,
                   starts_at: m.scheduled_at, vendor: m.vendor,
                   tenant: map[m.unit_number] ?? { tenant_name: m.tenant_name,
                                                   tenant_phone: m.tenant_phone },
                   lead_hours: (new Date(m.scheduled_at) - Date.now()) / 3.6e6 }));

  const all = [...showings, ...visits].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  res.json({ pending: all, required_hours: ENTRY_NOTICE_HOURS,
             insufficient: all.filter((x) => x.lead_hours < ENTRY_NOTICE_HOURS).length });
});

r.post("/entry-notices", require_("entrynotice.manage"), (req, res) => {
  const { purpose, ref_type, ref_id, unit_number, tenant_name, tenant_contact,
          entry_date, window_from, window_to, body, locale } = req.body ?? {};
  if (!purpose || !ref_id || !unit_number || !entry_date)
    return res.status(400).json({ code: "MISSING_NOTICE_FIELDS" });
  const id = uid("en_");
  db.prepare(`INSERT INTO entry_notices (id, purpose, ref_type, ref_id, unit_number,
    tenant_name, tenant_contact, entry_date, window_from, window_to, body, locale, drafted_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, purpose, ref_type ?? purpose, ref_id, unit_number, tenant_name ?? null,
         tenant_contact ?? null, entry_date, window_from, window_to, body ?? null,
         locale ?? "en", req.user.name);
  res.status(201).json({ id });
});

/** Short notice is refused rather than allowed with a warning. Entering on
 *  insufficient notice is worse than rescheduling. */
r.post("/entry-notices/:id/send", require_("entrynotice.manage"), (req, res) => {
  const n = db.prepare("SELECT * FROM entry_notices WHERE id = ?").get(req.params.id);
  if (!n) return res.status(404).json({ code: "NOTICE_NOT_FOUND" });

  const entryAt = new Date(`${n.entry_date}T${n.window_from}:00`);
  const lead = (entryAt - Date.now()) / 3.6e6;
  if (lead < ENTRY_NOTICE_HOURS)
    return res.status(409).json({ code: "NOTICE_TOO_SHORT",
                                  lead_hours: Number(lead.toFixed(1)),
                                  required_hours: ENTRY_NOTICE_HOURS });

  db.prepare(`UPDATE entry_notices SET state='sent', sent_by=?, sent_at=?, lead_hours=? WHERE id=?`)
    .run(req.user.id, nowISO(), lead, n.id);
  audit(req, { action: "entrynotice.send", entityType: "entry_notice", entityId: n.id,
               after: { unit: n.unit_number, entry_date: n.entry_date, lead_hours: lead } });
  res.json({ ok: true, lead_hours: lead });
});

/* ================= Renewals ================= */

r.get("/renewals", require_("units.view"), (req, res) => {
  res.json({ renewals: db.prepare(`SELECT rt.*, l.term_type, l.start_date, l.last_increase_at,
    l.contact_id FROM renewal_tasks rt JOIN leases l ON l.id = rt.lease_id
    ORDER BY rt.end_date`).all()
    .map((x) => ({ ...x, increase_params: x.increase_params ? JSON.parse(x.increase_params) : {} })) });
});

/**
 * PM decides: renew on a fixed term, convert to periodic, or do not renew.
 * Alberta has no RTB and no government rent-increase form -- BC does. The notice
 * comes from your own approved template. Two rules are checked here: 365 days
 * since the last increase or the start of tenancy, and the notice period for
 * periodic tenancies.
 */
r.patch("/renewals/:id", require_("renewals.decide"), (req, res) => {
  const t = db.prepare("SELECT * FROM renewal_tasks WHERE id = ?").get(req.params.id);
  if (!t) return res.status(404).json({ code: "RENEWAL_NOT_FOUND" });
  const lease = db.prepare("SELECT * FROM leases WHERE id = ?").get(t.lease_id);
  const { decision, proposed_rent, notice_text, state } = req.body ?? {};

  let increaseOk = 1, code = t.increase_code, params = {};
  if (proposed_rent != null && Number(proposed_rent) > Number(t.current_rent)) {
    const since = lease.last_increase_at ?? lease.start_date;
    const days = daysBetween(since, new Date().toISOString().slice(0, 10));
    if (days < 365) { increaseOk = 0; code = "INCREASE_TOO_SOON"; params = { days }; }
    else if (lease.term_type === "periodic") { code = "INCREASE_PERIODIC_NOTICE"; params = { months: 3 }; }
    else code = "INCREASE_AT_NEW_TERM";
  }

  db.prepare(`UPDATE renewal_tasks SET decision=COALESCE(?,decision),
    proposed_rent=COALESCE(?,proposed_rent), notice_text=COALESCE(?,notice_text),
    state=COALESCE(?,state), increase_ok=?, increase_code=?, increase_params=?,
    reviewed_by=?, reviewed_at=? WHERE id=?`)
    .run(decision ?? null, proposed_rent ?? null, notice_text ?? null, state ?? null,
         increaseOk, code ?? null, JSON.stringify(params), req.user.id, nowISO(), t.id);

  const after = db.prepare("SELECT * FROM renewal_tasks WHERE id = ?").get(t.id);
  audit(req, { action: "renewal.decide", entityType: "renewal_task", entityId: t.id,
               before: t, after });
  res.json({ renewal: after, increase_ok: !!increaseOk, code, params });
});

r.post("/renewals/:id/send", require_("renewals.decide"), (req, res) => {
  const t = db.prepare("SELECT * FROM renewal_tasks WHERE id = ?").get(req.params.id);
  if (!t) return res.status(404).json({ code: "RENEWAL_NOT_FOUND" });
  if (!t.decision) return res.status(400).json({ code: "RENEWAL_NO_DECISION" });
  if (!t.notice_text?.trim()) return res.status(400).json({ code: "RENEWAL_NOTICE_NOT_REVIEWED" });
  if (t.increase_ok === 0)
    return res.status(409).json({ code: t.increase_code ?? "INCREASE_NOT_ALLOWED",
                                  params: t.increase_params ? JSON.parse(t.increase_params) : {} });

  db.prepare("UPDATE renewal_tasks SET state='sent', sent_at=? WHERE id=?").run(nowISO(), t.id);
  audit(req, { action: "renewal.send", entityType: "renewal_task", entityId: t.id,
               after: { decision: t.decision, proposed_rent: t.proposed_rent } });
  res.json({ ok: true });
});

export default r;
