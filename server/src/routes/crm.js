import { Router } from "express";
import { db, uid, nowISO, prevBusinessDay, daysBetween } from "../db.js";
import { authenticate, require_, audit, notify } from "../rbac.js";
import { screen, upsertContact, normEmail, normPhone } from "../screening.js";
import { queue, requestConfirmation } from "../outbox.js";

const r = Router();
r.use(authenticate);

/* ============================================================
   Leads, schedule, documents and key handover
   ============================================================ */

const today = () => new Date().toISOString().slice(0, 10);
const parseJson = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

/* How long a lead can sit at each stage before it counts as overdue. The
   first hour matters most: in rentals whoever replies first usually wins,
   and a lead nobody answered is worth nothing however good the pipeline
   looks. */
const STAGE_SLA_HOURS = { new: 1, contacted: 48, viewed: 48, applied: 24 };
const OPEN_STAGES = ["new", "contacted", "booked", "viewed", "applied"];

/* ================= Leads ================= */

r.get("/leads", require_("leads.view"), (req, res) => {
  const { stage, assigned, q, limit = 500 } = req.query;
  let sql = "SELECT * FROM leads WHERE 1=1";
  const args = [];
  if (stage === "open") { sql += ` AND stage IN (${OPEN_STAGES.map(() => "?").join(",")})`;
                          args.push(...OPEN_STAGES); }
  else if (stage) { sql += " AND stage = ?"; args.push(stage); }
  if (assigned) { sql += " AND assigned_to = ?"; args.push(assigned); }
  if (q) { sql += " AND (name LIKE ? OR email LIKE ? OR phone LIKE ? OR units LIKE ?)";
           args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  sql += " ORDER BY COALESCE(last_contact_at, created_at) DESC LIMIT ?";
  args.push(Math.min(Number(limit) || 500, 2000));

  const rows = db.prepare(sql).all(...args);
  const notes = db.prepare("SELECT * FROM lead_notes ORDER BY at DESC").all();

  const withMeta = rows.map((l) => {
    const ref = l.last_contact_at || l.created_at;
    const hours = (Date.now() - new Date(ref).getTime()) / 3.6e6;
    const sla = STAGE_SLA_HOURS[l.stage];
    return { ...l, units: parseJson(l.units, []),
      notes: notes.filter((n) => n.lead_id === l.id),
      idle_hours: Number(hours.toFixed(1)),
      overdue: !!(sla && OPEN_STAGES.includes(l.stage) && hours > sla) };
  });

  res.json({ leads: withMeta, overdue: withMeta.filter((l) => l.overdue).length });
});

r.post("/leads", require_("leads.manage"), (req, res) => {
  const { name, email, phone, source, units, beds, move_in, override_note } = req.body ?? {};
  if (!name?.trim()) return res.status(400).json({ code: "NAME_REQUIRED" });

  const outcome = screen({ email, phone, full_name: name });

  // An email or phone already on file is refused. A resemblance is not:
  // people share names, and refusing one of them automatically would fall
  // unevenly across communities where surnames are shared widely.
  if (outcome.result === "duplicate")
    return res.status(409).json({ code: "DUPLICATE_LEAD", detail: outcome.detail,
                                   matched_id: outcome.matched_id });
  if (outcome.result === "review" && !override_note?.trim())
    return res.status(409).json({ code: "SIMILAR_LEAD_NEEDS_NOTE", detail: outcome.detail,
                                   similarity: outcome.similarity, matched_id: outcome.matched_id });

  const contactId = upsertContact({ full_name: name, email, phone });
  const id = uid("ld_");
  db.prepare(`INSERT INTO leads (id, contact_id, name, email, phone, source, stage, beds,
    move_in, units, assigned_to, assigned_name) VALUES (?,?,?,?,?,?,'new',?,?,?,?,?)`)
    .run(id, contactId, name.trim(), email ?? null, phone ?? null, source ?? null,
         beds ?? null, move_in ?? null, JSON.stringify(units ?? []),
         req.user.id, req.user.name);

  if (outcome.result === "review") {
    db.prepare(`INSERT INTO lead_notes (id, lead_id, body, by_user, by_name)
      VALUES (?,?,?,?,?)`).run(uid("ln_"), id,
      `Flagged as similar to an existing record and allowed: ${override_note.trim()}`,
      req.user.id, "screening");
  }

  audit(req, { action: "lead.create", entityType: "lead", entityId: id,
               after: { name, email: normEmail(email), phone: normPhone(phone),
                        screen: outcome.result, override: override_note ?? null } });
  res.status(201).json({ id, screen: outcome });
});

r.patch("/leads/:id", require_("leads.manage"), (req, res) => {
  const before = db.prepare("SELECT * FROM leads WHERE id=?").get(req.params.id);
  if (!before) return res.status(404).json({ code: "LEAD_NOT_FOUND" });
  const { stage, lost_reason, units, move_in, assigned_to, next_action_at,
          do_not_contact, beds } = req.body ?? {};

  // A stage change is contact, so the idle clock resets. Otherwise a lead
  // moved forward still shows as untouched and the overdue list is noise.
  const touched = stage && stage !== before.stage ? nowISO() : before.last_contact_at;

  db.prepare(`UPDATE leads SET stage=COALESCE(?,stage),
    lost_reason=CASE WHEN ?='lost' THEN ? ELSE NULL END,
    units=COALESCE(?,units), move_in=COALESCE(?,move_in), beds=COALESCE(?,beds),
    assigned_to=COALESCE(?,assigned_to), next_action_at=COALESCE(?,next_action_at),
    do_not_contact=COALESCE(?,do_not_contact), last_contact_at=? WHERE id=?`)
    .run(stage ?? null, stage ?? "", lost_reason ?? null,
         units ? JSON.stringify(units) : null, move_in ?? null, beds ?? null,
         assigned_to ?? null, next_action_at ?? null,
         do_not_contact === undefined ? null : (do_not_contact ? 1 : 0), touched, before.id);

  const after = db.prepare("SELECT * FROM leads WHERE id=?").get(before.id);
  audit(req, { action: "lead.update", entityType: "lead", entityId: before.id,
               before: { stage: before.stage, dnc: before.do_not_contact },
               after: { stage: after.stage, dnc: after.do_not_contact } });
  res.json({ lead: { ...after, units: parseJson(after.units, []) } });
});

r.post("/leads/:id/notes", require_("leads.manage"), (req, res) => {
  const body = String(req.body?.body ?? "").trim();
  if (!body) return res.status(400).json({ code: "EMPTY_NOTE" });
  const id = uid("ln_");
  db.prepare(`INSERT INTO lead_notes (id, lead_id, body, by_user, by_name) VALUES (?,?,?,?,?)`)
    .run(id, req.params.id, body, req.user.id, req.user.name);
  db.prepare("UPDATE leads SET last_contact_at=? WHERE id=?").run(nowISO(), req.params.id);
  res.status(201).json({ id });
});

r.get("/leads/funnel", require_("leads.view"), (req, res) => {
  const byStage = db.prepare("SELECT stage, COUNT(*) n FROM leads GROUP BY stage").all();
  const bySource = db.prepare(`SELECT source, COUNT(*) total,
    SUM(CASE WHEN stage='leased' THEN 1 ELSE 0 END) leased
    FROM leads GROUP BY source ORDER BY total DESC`).all();
  const lost = db.prepare(`SELECT COALESCE(lost_reason,'not recorded') reason, COUNT(*) n
    FROM leads WHERE stage='lost' GROUP BY reason ORDER BY n DESC`).all();
  const resp = db.prepare(`SELECT AVG((julianday(last_contact_at) - julianday(created_at)) * 24) h
    FROM leads WHERE last_contact_at IS NOT NULL`).get();
  const total = db.prepare("SELECT COUNT(*) n FROM leads").get().n;
  const leased = byStage.find((s) => s.stage === "leased")?.n ?? 0;
  res.json({ by_stage: byStage, by_source: bySource, lost_reasons: lost, total, leased,
             conversion: total ? Number((leased / total * 100).toFixed(1)) : null,
             avg_first_reply_hours: resp?.h ? Number(resp.h.toFixed(1)) : null });
});

/* ================= Schedule ================= */

const DUR = { showing: 30, signing: 45, keys: 30, maintenance: 60, followup: 15, review: 10 };
const BLOCKING = ["showing", "signing", "keys"];

r.get("/events", require_("schedule.view"), (req, res) => {
  const { from, to, type, assignee, state } = req.query;
  let sql = "SELECT * FROM events WHERE 1=1";
  const args = [];
  if (from) { sql += " AND date(starts_at) >= ?"; args.push(from); }
  if (to) { sql += " AND date(starts_at) <= ?"; args.push(to); }
  if (type) { sql += " AND type = ?"; args.push(type); }
  if (assignee) { sql += " AND assignee_id = ?"; args.push(assignee); }
  if (state) { sql += " AND state = ?"; args.push(state); }
  sql += " ORDER BY starts_at LIMIT 1000";
  const rows = db.prepare(sql).all(...args);
  const confs = db.prepare(`SELECT * FROM confirmations WHERE ref_type='event'`).all();
  const outcomes = db.prepare("SELECT * FROM showing_outcomes").all();
  res.json({ events: rows.map((e) => ({ ...e,
    confirmation: confs.find((c) => c.ref_id === e.id) ?? null,
    outcome: outcomes.find((o) => o.event_id === e.id) ?? null })) });
});

/** Booking checks the assignee is free. Only showings, signings and key
 *  handovers occupy anyone's time; a vendor visit goes on the calendar so
 *  the manager knows somebody is coming, but does not block the slot. */
r.post("/events", require_("schedule.view"), (req, res) => {
  const { type, unit_number, contact_name, contact_info, assignee_id, assignee,
          starts_at, duration_min, ref_id, created_via } = req.body ?? {};
  if (!type || !starts_at) return res.status(400).json({ code: "MISSING_EVENT_FIELDS" });

  const mins = Number(duration_min) || DUR[type] || 30;
  const blocking = BLOCKING.includes(type) ? 1 : 0;

  if (blocking && (assignee_id || assignee)) {
    const start = new Date(starts_at);
    const end = new Date(start.getTime() + mins * 60000);
    const clash = db.prepare(`SELECT * FROM events WHERE state='booked' AND blocking=1
      AND (assignee_id = ? OR assignee = ?)
      AND datetime(starts_at) < datetime(?)
      AND datetime(starts_at, '+' || duration_min || ' minutes') > datetime(?)`)
      .get(assignee_id ?? "", assignee ?? "", end.toISOString(), start.toISOString());
    if (clash) return res.status(409).json({ code: "SLOT_TAKEN",
      clash: { id: clash.id, type: clash.type, unit: clash.unit_number, at: clash.starts_at } });
  }

  const id = uid("ev_");
  db.prepare(`INSERT INTO events (id, type, unit_number, contact_name, contact_info,
    assignee_id, assignee, starts_at, duration_min, blocking, ref_id, created_via)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, type, unit_number ?? null, contact_name ?? null, contact_info ?? null,
         assignee_id ?? req.user.id, assignee ?? req.user.name, starts_at, mins, blocking,
         ref_id ?? null, created_via ?? "staff");

  audit(req, { action: "event.create", entityType: "event", entityId: id,
               after: { type, unit_number, starts_at } });
  res.status(201).json({ id, duration_min: mins, blocking: !!blocking });
});

/** Sends the confirmation and records that it is outstanding. A booking
 *  nobody confirmed is a trip to a locked door. */
r.post("/events/:id/confirm-request", require_("schedule.view"), (req, res) => {
  const e = db.prepare("SELECT * FROM events WHERE id=?").get(req.params.id);
  if (!e) return res.status(404).json({ code: "EVENT_NOT_FOUND" });
  const channel = req.body?.channel ?? "email";
  const when = `${e.starts_at.slice(0, 10)} ${e.starts_at.slice(11, 16)}`;

  const body = [
    `We have you booked for a ${e.type} at ${e.unit_number ?? "our office"} on ${when}.`,
    "Reply to confirm, or tell us if another time suits you better.",
    "",
    `已為你預約 ${when}${e.unit_number ? `，${e.unit_number}` : ""}。`,
    "回覆確認即可，時間不方便的話也請告訴我們。",
  ].join("\n");

  const isEmail = String(e.contact_info ?? "").includes("@");
  const msg = queue({ kind: `${e.type}_confirm`, channel,
    toEmail: isEmail ? e.contact_info : null, toPhone: isEmail ? null : e.contact_info,
    toName: e.contact_name, subject: `Your ${e.type} on ${when}`,
    body, refType: "event", refId: e.id, userId: req.user.id });

  const conf = requestConfirmation({ refType: "event", refId: e.id,
    question: `Does ${when} still work for you?`,
    toEmail: isEmail ? e.contact_info : null, toPhone: isEmail ? null : e.contact_info,
    outboxId: msg.id, expiresAt: e.starts_at });

  audit(req, { action: "event.confirm_request", entityType: "event", entityId: e.id,
               after: { channel: msg.channel } });
  res.status(201).json({ message: msg, confirmation: conf });
});

r.patch("/events/:id", require_("schedule.view"), (req, res) => {
  const before = db.prepare("SELECT * FROM events WHERE id=?").get(req.params.id);
  if (!before) return res.status(404).json({ code: "EVENT_NOT_FOUND" });
  const { state, starts_at, assignee_id, assignee, outcome } = req.body ?? {};
  db.prepare(`UPDATE events SET state=COALESCE(?,state), starts_at=COALESCE(?,starts_at),
    assignee_id=COALESCE(?,assignee_id), assignee=COALESCE(?,assignee),
    outcome=COALESCE(?,outcome) WHERE id=?`)
    .run(state ?? null, starts_at ?? null, assignee_id ?? null, assignee ?? null,
         outcome ?? null, before.id);
  audit(req, { action: "event.update", entityType: "event", entityId: before.id,
               before: { state: before.state, starts_at: before.starts_at },
               after: { state: state ?? before.state, starts_at: starts_at ?? before.starts_at } });
  res.json({ ok: true });
});

/** Recording the outcome moves the lead. A showing with no outcome is the
 *  gap where follow-up quietly stops. */
r.post("/events/:id/outcome", require_("showings.manage"), (req, res) => {
  const { outcome, reason, note } = req.body ?? {};
  if (!outcome) return res.status(400).json({ code: "OUTCOME_REQUIRED" });
  const e = db.prepare("SELECT * FROM events WHERE id=?").get(req.params.id);
  if (!e) return res.status(404).json({ code: "EVENT_NOT_FOUND" });

  db.prepare(`INSERT INTO showing_outcomes (event_id, outcome, reason, note, by_user, by_name)
    VALUES (?,?,?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET outcome=excluded.outcome,
    reason=excluded.reason, note=excluded.note, by_user=excluded.by_user,
    by_name=excluded.by_name, at=datetime('now')`)
    .run(e.id, outcome, reason ?? null, note ?? null, req.user.id, req.user.name);
  db.prepare("UPDATE events SET state=?, outcome=? WHERE id=?")
    .run(outcome === "no_show" ? "no_show" : "done", outcome, e.id);

  const stage = { interested: "viewed", undecided: "viewed", not_interested: "lost" }[outcome];
  if (stage && e.contact_info) {
    db.prepare(`UPDATE leads SET stage=?, last_contact_at=?,
      lost_reason=CASE WHEN ?='lost' THEN ? ELSE lost_reason END
      WHERE email=? OR phone=?`)
      .run(stage, nowISO(), stage, reason ?? "Not interested after viewing",
           e.contact_info, e.contact_info);
  }

  audit(req, { action: "showing.outcome", entityType: "event", entityId: e.id,
               after: { outcome, reason } });
  res.json({ ok: true, lead_stage: stage ?? null });
});

/** Today's list plus what needs a reminder. Reminders go on the previous
 *  business day, so Monday's bookings surface on Friday. */
r.get("/schedule/today", require_("schedule.view"), (req, res) => {
  const day = req.query.date || today();
  const events = db.prepare(`SELECT * FROM events WHERE date(starts_at)=? AND state='booked'
    ORDER BY starts_at`).all(day);

  const upcoming = db.prepare(`SELECT * FROM events WHERE state='booked'
    AND date(starts_at) > ? AND date(starts_at) <= date(?, '+7 day')`).all(day, day);
  const due = upcoming.filter((e) => prevBusinessDay(e.starts_at.slice(0, 10)) === day);

  const pendingSignings = db.prepare(`SELECT * FROM events WHERE type='signing'
    AND state='booked' ORDER BY starts_at`).all();

  res.json({
    date: day, events,
    reminders_due: due.map((e) => ({ ...e,
      gap_days: daysBetween(day, e.starts_at.slice(0, 10)) })),
    pending_signings: pendingSignings,
  });
});

r.get("/holidays", require_("schedule.view"), (req, res) => {
  res.json({ holidays: db.prepare("SELECT * FROM holidays ORDER BY holiday_date").all() });
});

r.post("/holidays", require_("settings.pricing.edit"), (req, res) => {
  const { holiday_date, name_en, name_zh, is_observed = 1 } = req.body ?? {};
  if (!holiday_date) return res.status(400).json({ code: "DATE_REQUIRED" });
  db.prepare(`INSERT INTO holidays (holiday_date, name_en, name_zh, is_observed)
    VALUES (?,?,?,?) ON CONFLICT(holiday_date) DO UPDATE SET name_en=excluded.name_en,
    is_observed=excluded.is_observed`)
    .run(holiday_date, name_en ?? holiday_date, name_zh ?? name_en ?? holiday_date,
         is_observed ? 1 : 0);
  audit(req, { action: "holiday.set", entityType: "holiday", entityId: holiday_date,
               after: { name_en, is_observed } });
  res.json({ ok: true });
});

/* ================= Documents ================= */

r.get("/templates", require_("units.view"), (req, res) => {
  const rows = db.prepare("SELECT * FROM document_templates ORDER BY kind, name").all();
  const fields = db.prepare("SELECT * FROM template_fields").all();
  const isAdmin = req.user.perms.has("templates.manage");
  res.json({ templates: rows.map((t) => ({
    ...t,
    // The body is the clause text. Only the people who own the library see it;
    // everyone else works with the generated document.
    body: isAdmin ? t.body : undefined,
    fields: fields.filter((f) => f.template_id === t.id) })) });
});

r.post("/templates", require_("templates.manage"), (req, res) => {
  const { name, kind, body, version, note, filename } = req.body ?? {};
  if (!name?.trim()) return res.status(400).json({ code: "NAME_REQUIRED" });
  const id = uid("tpl_");
  db.prepare(`INSERT INTO document_templates (id, name, kind, body, version, note, filename,
    status) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, name.trim(), kind ?? "other", body ?? null, version ?? null, note ?? null,
         filename ?? null, body ? "draft" : "missing");

  // Blanks are detected rather than typed. A field somebody forgot to declare
  // is a field that reaches the tenant unfilled.
  if (body) {
    const keys = [...new Set([...body.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]))];
    const ins = db.prepare(`INSERT OR IGNORE INTO template_fields (id, template_id, field_key,
      label, source) VALUES (?,?,?,?,?)`);
    for (const k of keys) ins.run(uid("tf_"), id, k, k.replace(/_/g, " "), "staff");
  }
  audit(req, { action: "template.create", entityType: "template", entityId: id,
               after: { name, kind } });
  res.status(201).json({ id });
});

r.patch("/templates/:id", require_("templates.manage"), (req, res) => {
  const before = db.prepare("SELECT * FROM document_templates WHERE id=?").get(req.params.id);
  if (!before) return res.status(404).json({ code: "TEMPLATE_NOT_FOUND" });
  const { status, body, version, note, name } = req.body ?? {};

  // Approving is what makes a template usable. Recording who did it is the
  // point: "which version did we send" has to have an answer.
  const approving = status === "approved" && before.status !== "approved";
  db.prepare(`UPDATE document_templates SET name=COALESCE(?,name), status=COALESCE(?,status),
    body=COALESCE(?,body), version=COALESCE(?,version), note=COALESCE(?,note),
    approved_by=CASE WHEN ? THEN ? ELSE approved_by END,
    approved_name=CASE WHEN ? THEN ? ELSE approved_name END,
    approved_at=CASE WHEN ? THEN ? ELSE approved_at END,
    updated_at=? WHERE id=?`)
    .run(name ?? null, status ?? null, body ?? null, version ?? null, note ?? null,
         approving ? 1 : 0, req.user.id, approving ? 1 : 0, req.user.name,
         approving ? 1 : 0, nowISO(), nowISO(), before.id);

  if (body) {
    const keys = [...new Set([...body.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]))];
    const ins = db.prepare(`INSERT OR IGNORE INTO template_fields (id, template_id, field_key,
      label, source) VALUES (?,?,?,?,?)`);
    for (const k of keys) ins.run(uid("tf_"), before.id, k, k.replace(/_/g, " "), "staff");
  }
  audit(req, { action: "template.update", entityType: "template", entityId: before.id,
               before: { status: before.status, version: before.version },
               after: { status: status ?? before.status, version: version ?? before.version } });
  res.json({ ok: true });
});

r.patch("/templates/:tid/fields/:key", require_("templates.manage"), (req, res) => {
  const { source, label, field_type, note } = req.body ?? {};
  db.prepare(`UPDATE template_fields SET source=COALESCE(?,source), label=COALESCE(?,label),
    field_type=COALESCE(?,field_type), note=COALESCE(?,note)
    WHERE template_id=? AND field_key=?`)
    .run(source ?? null, label ?? null, field_type ?? null, note ?? null,
         req.params.tid, req.params.key);
  res.json({ ok: true });
});

r.get("/documents", require_("units.view"), (req, res) => {
  const { state, limit = 200 } = req.query;
  let sql = `SELECT di.*, dt.name template_name, dt.kind, dt.version template_version
             FROM document_instances di JOIN document_templates dt ON dt.id = di.template_id
             WHERE 1=1`;
  const args = [];
  if (state) { sql += " AND di.state = ?"; args.push(state); }
  sql += " ORDER BY di.created_at DESC LIMIT ?";
  args.push(Math.min(Number(limit) || 200, 1000));
  res.json({ documents: db.prepare(sql).all(...args)
    .map((d) => ({ ...d, values: parseJson(d.values_json, {}) })) });
});

r.post("/documents", require_("documents.approve"), (req, res) => {
  const { template_id, unit_number, tenant_name, tenant_email, tenant_phone,
          values } = req.body ?? {};
  const t = db.prepare("SELECT * FROM document_templates WHERE id=?").get(template_id);
  if (!t) return res.status(404).json({ code: "TEMPLATE_NOT_FOUND" });

  // Only an approved template can generate a document. Everything downstream
  // assumes the clause text was reviewed.
  if (t.status !== "approved")
    return res.status(409).json({ code: "TEMPLATE_NOT_APPROVED", status: t.status });

  const id = uid("di_");
  db.prepare(`INSERT INTO document_instances (id, template_id, unit_number, tenant_name,
    tenant_email, tenant_phone, values_json, created_by) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, template_id, unit_number ?? null, tenant_name ?? null, tenant_email ?? null,
         tenant_phone ?? null, JSON.stringify(values ?? {}), req.user.id);
  audit(req, { action: "document.create", entityType: "document", entityId: id,
               after: { template: t.name, unit_number } });
  res.status(201).json({ id });
});

r.post("/documents/:id/approve", require_("documents.approve"), (req, res) => {
  const d = db.prepare(`SELECT di.*, dt.body, dt.name FROM document_instances di
    JOIN document_templates dt ON dt.id = di.template_id WHERE di.id=?`).get(req.params.id);
  if (!d) return res.status(404).json({ code: "DOCUMENT_NOT_FOUND" });

  // Every blank filled before it goes out. A document with {{tenant_name}} still
  // in it reaching a tenant is the kind of error that costs a signing.
  const fields = db.prepare("SELECT * FROM template_fields WHERE template_id=?")
                   .all(d.template_id);
  const values = parseJson(d.values_json, {});
  const blanks = fields.filter((f) => !String(values[f.field_key] ?? "").trim());
  if (blanks.length)
    return res.status(409).json({ code: "UNFILLED_FIELDS",
      fields: blanks.map((b) => b.label || b.field_key) });

  db.prepare(`UPDATE document_instances SET state='approved', approved_by=?, approved_name=?,
    approved_at=? WHERE id=?`).run(req.user.id, req.user.name, nowISO(), d.id);
  audit(req, { action: "document.approve", entityType: "document", entityId: d.id,
               after: { by: req.user.name, template: d.name } });
  res.json({ ok: true });
});

r.post("/documents/:id/send", require_("documents.approve"), (req, res) => {
  const d = db.prepare("SELECT * FROM document_instances WHERE id=?").get(req.params.id);
  if (!d) return res.status(404).json({ code: "DOCUMENT_NOT_FOUND" });
  if (d.state !== "approved") return res.status(409).json({ code: "NOT_APPROVED" });

  queue({ kind: "document_send", channel: "email", toEmail: d.tenant_email,
    toName: d.tenant_name, subject: "Your document from Baydo Pointe",
    body: "Your document is ready. Open the link in this message to review and sign it.",
    refType: "document", refId: d.id, userId: req.user.id });

  db.prepare("UPDATE document_instances SET state='sent', sent_at=? WHERE id=?")
    .run(nowISO(), d.id);
  audit(req, { action: "document.send", entityType: "document", entityId: d.id });
  res.json({ ok: true });
});

r.get("/documents/:id/renditions", require_("units.view"), (req, res) => {
  res.json({ renditions: db.prepare(`SELECT * FROM document_renditions
    WHERE instance_id=? OR template_id=? ORDER BY created_at DESC`)
    .all(req.params.id, req.params.id) });
});

/* ================= Key handover ================= */

r.get("/key-handovers", require_("units.view"), (req, res) => {
  res.json({ handovers: db.prepare(`SELECT * FROM key_handovers ORDER BY
    CASE state WHEN 'pending' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END, lease_start`)
    .all().map((k) => ({ ...k, items: parseJson(k.items, {}) })) });
});

r.post("/key-handovers", require_("keys.manage"), (req, res) => {
  const { unit_number, lease_id, tenant_name, tenant_email, tenant_phone,
          lease_start } = req.body ?? {};
  if (!unit_number) return res.status(400).json({ code: "UNIT_REQUIRED" });
  const id = uid("kh_");
  db.prepare(`INSERT INTO key_handovers (id, unit_number, lease_id, tenant_name, tenant_email,
    tenant_phone, lease_start, items) VALUES (?,?,?,?,?,?,?,'{}')`)
    .run(id, unit_number, lease_id ?? null, tenant_name ?? null, tenant_email ?? null,
         tenant_phone ?? null, lease_start ?? null);
  audit(req, { action: "keys.create", entityType: "key_handover", entityId: id,
               after: { unit_number, lease_start } });
  res.status(201).json({ id });
});

r.patch("/key-handovers/:id", require_("keys.manage"), (req, res) => {
  const k = db.prepare("SELECT * FROM key_handovers WHERE id=?").get(req.params.id);
  if (!k) return res.status(404).json({ code: "HANDOVER_NOT_FOUND" });
  const { scheduled_at, assignee, items, notes, state } = req.body ?? {};

  // Completing requires every item handed over. A missing fob discovered a
  // week later is nobody's word against anybody's.
  if (state === "done") {
    const list = items ?? parseJson(k.items, {});
    const required = ["Unit keys", "Mailbox key", "Access fob",
                      "Move-in inspection report completed"];
    const missing = required.filter((x) => !list[x]);
    if (missing.length) return res.status(409).json({ code: "CHECKLIST_INCOMPLETE", missing });
  }

  db.prepare(`UPDATE key_handovers SET scheduled_at=COALESCE(?,scheduled_at),
    assignee=COALESCE(?,assignee), items=COALESCE(?,items), notes=COALESCE(?,notes),
    state=COALESCE(?,state),
    completed_at=CASE WHEN ?='done' THEN ? ELSE completed_at END WHERE id=?`)
    .run(scheduled_at ?? null, assignee ?? null, items ? JSON.stringify(items) : null,
         notes ?? null, state ?? null, state ?? "", nowISO(), k.id);
  audit(req, { action: "keys.update", entityType: "key_handover", entityId: k.id,
               after: { state: state ?? k.state, scheduled_at } });
  res.json({ ok: true });
});

export default r;
