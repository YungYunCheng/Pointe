import { Router } from "express";
import crypto from "node:crypto";
import { db, uid, nowISO, cents, txn } from "../db.js";
import { authenticate, require_, audit, notify } from "../rbac.js";
import { queue } from "../outbox.js";

const r = Router();
r.use(authenticate);

/* ============================================================
   Arrears files

   Every demand for rent is recorded, not only queued as a message.
   Those are different things. A message queue answers "did we send
   it". An application to end a tenancy needs what was owed, what
   was demanded, when, and how it reached them.

   In Alberta an application for non-payment usually fails on
   service or on the notice itself rather than on the debt. So this
   holds the record and the proof of service; the notice form is
   uploaded and approved like any other agreement, because a notice
   with the wrong wording fails whatever the arrears show.

   This system does not generate that notice, and the reason is the
   same one that applies to the lease: a generated notice reads
   exactly as convincingly as a valid one.
   ============================================================ */

const parse = (s, f) => { try { return s ? JSON.parse(s) : f; } catch { return f; } };
const today = () => new Date().toISOString().slice(0, 10);
const money = (n) => new Intl.NumberFormat("en-CA",
  { style: "currency", currency: "CAD" }).format(n ?? 0);
const addDays = (d, n) => new Date(new Date(d + "T12:00:00").getTime() + n * 864e5)
  .toISOString().slice(0, 10);

/* Alberta's service rules set when something counts as received, and that
   date is what a notice period runs from. These are named constants because
   they are legal figures — confirm each with your lawyer before relying on a
   deemed date in an application. */
const DEEMED_SERVICE_DAYS = {
  personal:       0,   // handed over, effective immediately
  posted_on_door: 0,   // affixed to the door
  email:          0,   // where the tenant has agreed to service by email
  sms:            0,
  courier:        1,
  post:           5,   // ordinary mail, the one most often argued about
};

/* The stages of a demand. Nothing past "direct" is generated here — the
   14-day notice is a statutory form and it comes from the agreement library. */
const STEPS = {
  reminder: { label: "Reminder", after: 5,
    describe: "Rent is late. Most arrears end here, and a reminder that reads as an accusation is what stops that happening." },
  request:  { label: "Request", after: 15,
    describe: "Clearer, still not threatening. This is where a payment arrangement usually gets made." },
  direct:   { label: "Direct request", after: 30,
    describe: "States the position plainly and asks for a date. Still collections — nothing here mentions ending the tenancy." },
  notice:   { label: "Notice served", after: null,
    describe: "The statutory notice. Uploaded from the agreement library, not generated. Recorded here with how it was served." },
  filing:   { label: "Application filed", after: null,
    describe: "Recorded for completeness. The file is what supports it." },
};

/* ---------- Files ---------- */

r.get("/arrears", require_("accounting.view"), (req, res) => {
  const { state, limit = 200 } = req.query;
  let sql = "SELECT * FROM arrears_files WHERE 1=1";
  const args = [];
  if (state && state !== "all") { sql += " AND state = ?"; args.push(state); }
  sql += " ORDER BY current_owed DESC LIMIT ?";
  args.push(Math.min(Number(limit) || 200, 500));

  const files = db.prepare(sql).all(...args);
  const steps = db.prepare("SELECT * FROM arrears_steps ORDER BY seq").all();
  const payments = db.prepare("SELECT * FROM arrears_payments ORDER BY received_on").all();

  res.json({
    files: files.map((f) => {
      const mine = steps.filter((s) => s.file_id === f.id);
      const last = mine[mine.length - 1];
      const daysSince = last ? Math.floor(
        (Date.now() - new Date(last.served_on + "T12:00").getTime()) / 864e5) : null;
      return { ...f,
        steps: mine.map((s) => ({ ...s, charges_cited: parse(s.charges_cited, []) })),
        payments: payments.filter((p) => p.file_id === f.id),
        last_step: last?.step ?? null,
        days_since_last: daysSince,
        // What the next step would be, and whether it is due. Nothing sends
        // itself — this is a prompt, not a schedule.
        next_step: nextStepFor(mine, f),
      };
    }),
    steps_available: STEPS,
    deemed_service: DEEMED_SERVICE_DAYS,
  });
});

function nextStepFor(steps, file) {
  const done = new Set(steps.map((s) => s.step));
  const daysOpen = Math.floor(
    (Date.now() - new Date(file.opened_on + "T12:00").getTime()) / 864e5);
  for (const [key, spec] of Object.entries(STEPS)) {
    if (spec.after == null) continue;
    if (done.has(key)) continue;
    return { step: key, label: spec.label, due: daysOpen >= spec.after,
             days_open: daysOpen, suggested_after: spec.after };
  }
  return null;
}

/** Opens a file when a charge goes past due. One file per run of arrears, so
 *  a tenant who fell behind last year and caught up starts a fresh one — the
 *  history stays, but the current file is about the current problem. */
r.post("/arrears", require_("accounting.ar"), (req, res) => {
  const { unit_number, lease_id, contact_id, tenant_name } = req.body ?? {};
  if (!unit_number) return res.status(400).json({ code: "UNIT_REQUIRED" });

  const open = db.prepare(`SELECT * FROM arrears_files WHERE unit_number=?
    AND state IN ('open','arrangement','notice_served')`).get(unit_number);
  if (open) return res.status(409).json({ code: "FILE_ALREADY_OPEN", id: open.id });

  const owed = db.prepare(`SELECT COALESCE(SUM(amount - paid_amount), 0) t
    FROM ar_charges WHERE unit_number=? AND state IN ('open','partial')
      AND due_date < date('now')`).get(unit_number).t;
  if (cents(owed) <= 0)
    return res.status(400).json({ code: "NOTHING_OVERDUE" });

  const id = uid("arf_");
  db.prepare(`INSERT INTO arrears_files (id, unit_number, lease_id, contact_id, tenant_name,
    opened_on, opening_owed, current_owed, peak_owed, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, unit_number, lease_id ?? null, contact_id ?? null,
         tenant_name ?? "Tenant", today(), cents(owed), cents(owed), cents(owed),
         req.user.id);

  audit(req, { action: "arrears.open", entityType: "arrears_file", entityId: id,
               after: { unit_number, owed: cents(owed) } });
  res.status(201).json({ id, owed: cents(owed) });
});

/* ---------- Steps ---------- */

/**
 * Records a demand and, where it is a message, sends it.
 *
 * The figure owed is captured at this moment rather than read later. Six
 * months on, "what was owed when we sent that" cannot be recomputed from a
 * ledger that has moved since.
 */
r.post("/arrears/:id/steps", require_("accounting.ar"), (req, res) => {
  try {
    const out = txn(() => {
      const f = db.prepare("SELECT * FROM arrears_files WHERE id=?").get(req.params.id);
      if (!f) throw Object.assign(new Error("FILE_NOT_FOUND"), { status: 404 });

      const { step, subject, body, method = "email", served_on, served_by, witness,
              drafted_by_ai, evidence_key, evidence_sha256, send } = req.body ?? {};
      if (!STEPS[step]) throw Object.assign(new Error("UNKNOWN_STEP"), { status: 400 });
      if (!body?.trim()) throw Object.assign(new Error("BODY_REQUIRED"), { status: 400 });

      // The statutory notice is not drafted here. It comes from the agreement
      // library, approved, because a notice with the wrong wording fails the
      // application whatever the arrears show.
      if (step === "notice" && drafted_by_ai)
        throw Object.assign(new Error("NOTICE_MUST_NOT_BE_GENERATED"), { status: 409,
          detail: "The statutory notice is uploaded and approved in the agreement library. Nothing generates it." });

      const charges = db.prepare(`SELECT id, period, kind, amount, paid_amount, due_date
        FROM ar_charges WHERE unit_number=? AND state IN ('open','partial')
          AND due_date < date('now') ORDER BY due_date`).all(f.unit_number);
      const owed = cents(charges.reduce((t, c) => t + (c.amount - c.paid_amount), 0));

      const on = served_on || today();
      const deemed = addDays(on, DEEMED_SERVICE_DAYS[method] ?? 0);
      const seq = db.prepare("SELECT COALESCE(MAX(seq),0) n FROM arrears_steps WHERE file_id=?")
        .get(f.id).n + 1;

      let outboxId = null;
      if (send && ["email", "sms"].includes(method)) {
        const c = f.contact_id
          ? db.prepare("SELECT * FROM contacts WHERE id=?").get(f.contact_id) : null;
        const msg = queue({
          kind: "arrears", channel: method,
          toEmail: method === "email" ? c?.email : null,
          toPhone: method === "sms" ? c?.phone : null,
          toName: f.tenant_name, locale: c?.locale ?? "en",
          subject: subject ?? `Rent outstanding · ${f.unit_number}`,
          body, refType: "arrears_file", refId: f.id, userId: req.user.id,
        });
        outboxId = msg.id;
      }

      const id = uid("ars_");
      db.prepare(`INSERT INTO arrears_steps (id, file_id, seq, step, owed_at_time,
        charges_cited, subject, body, method, served_on, deemed_served_on, served_by,
        witness, delivery_state, outbox_id, evidence_key, evidence_sha256,
        drafted_by_ai, approved_by, approved_name)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, f.id, seq, step, owed,
             JSON.stringify(charges.map((c) => ({ period: c.period, kind: c.kind,
               owing: cents(c.amount - c.paid_amount), due_date: c.due_date }))),
             subject ?? null, body.trim(), method, on, deemed,
             served_by ?? req.user.name, witness ?? null,
             outboxId ? "queued" : "delivered", outboxId,
             evidence_key ?? null, evidence_sha256 ?? null,
             drafted_by_ai ? 1 : 0, req.user.id, req.user.name);

      db.prepare(`UPDATE arrears_files SET current_owed=?, peak_owed=MAX(peak_owed, ?),
        state=CASE WHEN ?='notice' THEN 'notice_served' ELSE state END WHERE id=?`)
        .run(owed, owed, step, f.id);

      // Personal service and a notice on a door have no delivery report, so
      // the record has to be made by whoever did it. Without that there is
      // nothing to put in front of an adjudicator.
      const needsProof = ["personal", "posted_on_door", "post"].includes(method);

      return { id, seq, owed, deemed_served_on: deemed,
        needs_proof: needsProof && !evidence_key,
        proof_note: needsProof && !evidence_key
          ? "This method leaves no delivery report. Add a photograph or a signed note of service — an application turns on this more often than on the debt."
          : null };
    })();

    audit(req, { action: "arrears.step", entityType: "arrears_file",
                 entityId: req.params.id, after: out });
    res.status(201).json(out);
  } catch (e) {
    res.status(e.status ?? 500).json({ code: e.message, detail: e.detail });
  }
});

/** A payment lands against the file, so the running figure in the history is
 *  the figure that was true on the day of each demand. */
r.post("/arrears/:id/payments", require_("accounting.ar"), (req, res) => {
  const f = db.prepare("SELECT * FROM arrears_files WHERE id=?").get(req.params.id);
  if (!f) return res.status(404).json({ code: "FILE_NOT_FOUND" });
  const amount = cents(req.body?.amount ?? 0);
  if (amount <= 0) return res.status(400).json({ code: "AMOUNT_REQUIRED" });

  const after = cents(f.current_owed - amount);
  db.transaction(() => {
    db.prepare(`INSERT INTO arrears_payments (id, file_id, receipt_id, amount,
      received_on, owed_after, note) VALUES (?,?,?,?,?,?,?)`)
      .run(uid("arp_"), f.id, req.body?.receipt_id ?? null, amount,
           req.body?.received_on ?? today(), Math.max(0, after), req.body?.note ?? null);
    db.prepare(`UPDATE arrears_files SET current_owed=?,
      state=CASE WHEN ? <= 0 THEN 'cleared' ELSE state END,
      cleared_on=CASE WHEN ? <= 0 THEN ? ELSE cleared_on END WHERE id=?`)
      .run(Math.max(0, after), after, after, today(), f.id);
  })();

  audit(req, { action: "arrears.payment", entityType: "arrears_file", entityId: f.id,
               before: { owed: f.current_owed }, after: { owed: Math.max(0, after) } });
  res.json({ owed: Math.max(0, after), cleared: after <= 0 });
});

/** A payment arrangement. Worth recording separately: a tenant keeping to an
 *  agreed schedule is not in the same position as one who has not answered,
 *  and an application that ignores an arrangement it made is a weak one. */
r.post("/arrears/:id/arrangement", require_("accounting.ar"), (req, res) => {
  const note = String(req.body?.note ?? "").trim();
  if (!note) return res.status(400).json({ code: "NOTE_REQUIRED" });
  db.prepare(`UPDATE arrears_files SET state='arrangement', arrangement_note=?,
    arrangement_from=? WHERE id=?`)
    .run(note, req.body?.from ?? today(), req.params.id);
  audit(req, { action: "arrears.arrangement", entityType: "arrears_file",
               entityId: req.params.id, after: { note } });
  res.json({ ok: true });
});

/* ---------- The bundle ---------- */

/**
 * Everything about this file, in order, as a document.
 *
 * This is what supports an application: what was owed and when, every demand
 * with how it was served and when it was deemed received, every payment, and
 * where proof is missing.
 *
 * It says plainly what it is not. The bundle is evidence; the notice is a
 * statutory form and comes from the agreement library.
 */
r.get("/arrears/:id/bundle", require_("accounting.view"), (req, res) => {
  const f = db.prepare("SELECT * FROM arrears_files WHERE id=?").get(req.params.id);
  if (!f) return res.status(404).json({ code: "FILE_NOT_FOUND" });

  const steps = db.prepare("SELECT * FROM arrears_steps WHERE file_id=? ORDER BY seq")
    .all(f.id);
  const payments = db.prepare(`SELECT * FROM arrears_payments WHERE file_id=?
    ORDER BY received_on`).all(f.id);
  const lease = f.lease_id
    ? db.prepare("SELECT * FROM leases WHERE id=?").get(f.lease_id) : null;

  const charges = db.prepare(`SELECT period, kind, amount, paid_amount, due_date, charge_date
    FROM ar_charges WHERE unit_number=? AND state IN ('open','partial')
    ORDER BY due_date`).all(f.unit_number);

  // Where the file is weak. Better found now than by an adjudicator.
  const gaps = [];
  for (const s of steps) {
    if (["personal", "posted_on_door", "post"].includes(s.method) && !s.evidence_key)
      gaps.push(`Step ${s.seq} (${STEPS[s.step]?.label}) was served by ${s.method} with no proof attached. That method leaves no delivery report.`);
    if (s.delivery_state === "bounced")
      gaps.push(`Step ${s.seq} bounced. It did not reach them, and a demand that did not arrive is not a demand.`);
    if (s.delivery_state === "queued")
      gaps.push(`Step ${s.seq} is still queued and may never have gone out.`);
  }
  if (f.state === "arrangement")
    gaps.push("A payment arrangement is recorded on this file. An application that ignores an arrangement made with the tenant is a weak one — be ready to explain what happened to it.");
  if (!steps.some((s) => s.step === "notice"))
    gaps.push("No statutory notice recorded. The demands here support one; they are not a substitute for it.");

  const lines = [
    `ARREARS FILE · ${f.unit_number}`,
    `Tenant: ${f.tenant_name}`,
    lease ? `Lease: ${lease.start_date} to ${lease.end_date ?? "periodic"}, rent ${money(lease.rent)}` : "",
    `File opened: ${f.opened_on}, owing ${money(f.opening_owed)}`,
    `Currently owing: ${money(f.current_owed)}`,
    f.peak_owed !== f.current_owed ? `Highest owed: ${money(f.peak_owed)}` : "",
    "",
    "WHAT IS OUTSTANDING",
    ...charges.map((c) => `  ${c.period} ${c.kind}: ${money(cents(c.amount - c.paid_amount))} of ${money(c.amount)}, due ${c.due_date}`),
    "",
    "DEMANDS MADE",
    ...steps.flatMap((s) => [
      `  ${s.seq}. ${STEPS[s.step]?.label ?? s.step} — ${s.served_on}`,
      `     Owed at the time: ${money(s.owed_at_time)}`,
      `     Served by ${s.method}${s.served_by ? ` (${s.served_by})` : ""}${s.witness ? `, witnessed by ${s.witness}` : ""}`,
      `     Deemed received: ${s.deemed_served_on}`,
      `     Delivery: ${s.delivery_state}${s.provider_id ? ` (${s.provider_id})` : ""}`,
      s.evidence_key ? `     Proof attached: ${s.evidence_sha256?.slice(0, 16)}…` : `     No proof attached`,
      s.tenant_response ? `     Tenant replied ${s.responded_at}: ${s.tenant_response}` : "",
      "",
    ]),
    payments.length ? "PAYMENTS RECEIVED WHILE OPEN" : "NO PAYMENTS RECEIVED WHILE OPEN",
    ...payments.map((p) => `  ${p.received_on}: ${money(p.amount)}, leaving ${money(p.owed_after)}`),
    "",
    f.arrangement_note ? `ARRANGEMENT\n  From ${f.arrangement_from}: ${f.arrangement_note}\n` : "",
    gaps.length ? "WHERE THIS FILE IS WEAK" : "NO OBVIOUS GAPS",
    ...gaps.map((g) => `  · ${g}`),
    "",
    "ABOUT THIS BUNDLE",
    "  This is the record of what was owed and what was demanded. It is evidence,",
    "  not a notice. The statutory notice to end a tenancy is a prescribed form with",
    "  its own wording and notice period, and it comes from the agreement library",
    "  where a lawyer has approved it. Nothing in this system generates one.",
    "",
    "  Service dates above use the deemed-service days configured in this system.",
    "  Confirm those against the Act before relying on a date in an application —",
    "  an application for non-payment fails on service far more often than on the debt.",
    "",
    `  Prepared ${nowISO().slice(0, 16).replace("T", " ")} by ${req.user.name}`,
  ].filter((x) => x !== "");

  const text = lines.join("\n");
  const sha = crypto.createHash("sha256").update(text).digest("hex");

  db.prepare(`INSERT INTO arrears_exports (id, file_id, purpose, step_count,
    owed_at_export, sha256, exported_by, exported_name) VALUES (?,?,?,?,?,?,?,?)`)
    .run(uid("arx_"), f.id, req.query.purpose ?? "internal", steps.length,
         f.current_owed, sha, req.user.id, req.user.name);
  audit(req, { action: "arrears.bundle", entityType: "arrears_file", entityId: f.id,
               after: { steps: steps.length, sha256: sha, purpose: req.query.purpose } });

  if (req.query.format === "text") {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition",
      `attachment; filename="arrears-${f.unit_number}-${today()}.txt"`);
    res.setHeader("X-Content-SHA256", sha);
    return res.send(text);
  }

  res.json({ file: f, steps, payments, charges, gaps, text, sha256: sha });
});

/** Files where the next step is due. A prompt, not a schedule — nothing here
 *  sends itself, and a demand that went out because a timer fired is a demand
 *  nobody chose to make. */
r.get("/arrears/due", require_("accounting.view"), (req, res) => {
  const files = db.prepare(`SELECT * FROM arrears_files
    WHERE state IN ('open','arrangement') ORDER BY current_owed DESC`).all();
  const steps = db.prepare("SELECT * FROM arrears_steps ORDER BY seq").all();

  const due = files.map((f) => {
    const mine = steps.filter((s) => s.file_id === f.id);
    const next = nextStepFor(mine, f);
    return next?.due ? { ...f, next_step: next, steps_taken: mine.length } : null;
  }).filter(Boolean);

  res.json({ due, count: due.length,
    note: "A prompt, not a schedule. Nothing here sends itself — a demand that went out because a timer fired is a demand nobody chose to make." });
});

export default r;
