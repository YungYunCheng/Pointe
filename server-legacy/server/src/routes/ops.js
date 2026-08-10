import { Router } from "express";
import { db, uid, nowISO, addDays } from "../db.js";
import { authenticate, require_, audit, notify } from "../rbac.js";
import { queue, requestConfirmation, respondToConfirmation, confirmationFor,
         resolveChannel, drainOutbox, overdueMessages } from "../outbox.js";
import { screen, recordScreen, upsertContact, normEmail, normPhone } from "../screening.js";

const r = Router();

/* ============================================================
   Notifications, confirmations, entry windows and screening
   ============================================================ */

const ENTRY_NOTICE_HOURS = 24;
const today = () => new Date().toISOString().slice(0, 10);
const hoursUntil = (iso) => (new Date(iso) - Date.now()) / 3.6e6;

/* ---------- Public: responding to a confirmation ----------
   No session. The token is the credential, it identifies one question, and
   it is useless for anything else. Asking a tenant to create an account
   before they can say "yes, that time works" is how a confirmation rate
   drops to nothing. */

r.get("/public/confirm/:token", (req, res) => {
  const c = db.prepare("SELECT * FROM confirmations WHERE token=?").get(req.params.token);
  if (!c) return res.status(404).json({ code: "CONFIRMATION_NOT_FOUND" });
  const expired = c.expires_at && c.expires_at < nowISO();
  res.json({
    question: c.question, ref_type: c.ref_type,
    state: expired && c.state === "sent" ? "expired" : c.state,
    responded_at: c.responded_at,
  });
});

r.post("/public/confirm/:token", (req, res) => {
  const { response, note } = req.body ?? {};
  if (!["confirmed", "declined"].includes(response))
    return res.status(400).json({ code: "INVALID_RESPONSE" });
  const c = respondToConfirmation(req.params.token, response, note);
  if (!c) return res.status(404).json({ code: "CONFIRMATION_NOT_FOUND" });
  if (c.state === "expired") return res.status(410).json({ code: "CONFIRMATION_EXPIRED" });

  // A decline is the useful signal. It means the slot is free again and
  // somebody should offer another one, rather than turning up to a locked door.
  if (response === "declined") {
    notify("building_manager", "confirmation", "TENANT_DECLINED",
           { ref_type: c.ref_type, ref_id: c.ref_id, note: note ?? "" },
           `/${c.ref_type}s/${c.ref_id}`);
  }
  res.json({ ok: true, state: response });
});

/* ---------- Everything below needs a session ---------- */
r.use(authenticate);

/* ---------- Outbox ---------- */

r.get("/outbox", require_("notifications.view"), (req, res) => {
  const { state, kind, limit = 200 } = req.query;
  let sql = "SELECT * FROM outbox WHERE 1=1";
  const args = [];
  if (state) { sql += " AND state = ?"; args.push(state); }
  if (kind) { sql += " AND kind = ?"; args.push(kind); }
  sql += " ORDER BY created_at DESC LIMIT ?";
  args.push(Math.min(Number(limit) || 200, 1000));
  res.json({
    messages: db.prepare(sql).all(...args),
    overdue: overdueMessages(),
    queued: db.prepare("SELECT COUNT(*) n FROM outbox WHERE state='queued'").get().n,
    no_provider: !process.env.EMAIL_PROVIDER_KEY,
  });
});

r.post("/outbox/send", require_("notifications.view"), async (req, res) => {
  const out = await drainOutbox(Number(req.body?.limit) || 50);
  res.json(out);
});

/** Queue a message and, when it needs an answer, a confirmation with it. */
r.post("/notify", require_("notifications.view"), (req, res) => {
  const { kind, channel, to_email, to_phone, to_name, locale, subject, body,
          ref_type, ref_id, required_by, ask_confirmation, question,
          confirmation_hours } = req.body ?? {};
  if (!kind || !body) return res.status(400).json({ code: "MISSING_MESSAGE_FIELDS" });
  if (!to_email && !to_phone) return res.status(400).json({ code: "NO_RECIPIENT" });

  const msg = queue({ kind, channel, toEmail: to_email, toPhone: to_phone, toName: to_name,
    locale, subject, body, refType: ref_type, refId: ref_id, requiredBy: required_by,
    userId: req.user.id });

  let confirmation = null;
  if (ask_confirmation) {
    confirmation = requestConfirmation({ refType: ref_type ?? kind, refId: ref_id ?? msg.id,
      question: question ?? "Does this time work for you?",
      toEmail: to_email, toPhone: to_phone, outboxId: msg.id,
      expiresAt: new Date(Date.now() + (Number(confirmation_hours) || 72) * 3600e3).toISOString() });
  }

  audit(req, { action: "notify.queue", entityType: ref_type ?? "message", entityId: ref_id ?? msg.id,
               after: { kind, channel: msg.channel, confirmation: !!confirmation } });
  res.status(201).json({ message: msg, confirmation });
});

r.get("/confirmations", require_("notifications.view"), (req, res) => {
  const { ref_type, ref_id, state } = req.query;
  let sql = "SELECT * FROM confirmations WHERE 1=1";
  const args = [];
  if (ref_type) { sql += " AND ref_type = ?"; args.push(ref_type); }
  if (ref_id) { sql += " AND ref_id = ?"; args.push(ref_id); }
  if (state) { sql += " AND state = ?"; args.push(state); }
  sql += " ORDER BY created_at DESC LIMIT 300";
  res.json({ confirmations: db.prepare(sql).all(...args) });
});

/* ---------- Entry windows ---------- */
/*
   When a tenant will and will not accept access. A refusal is recorded as
   carefully as availability: entering during a window the tenant excluded
   is what turns a repair into a complaint.
*/

r.get("/entry-windows/:unit", require_("units.view"), (req, res) => {
  res.json({ windows: db.prepare(`SELECT * FROM entry_windows WHERE unit_number=?
    ORDER BY kind, weekday, from_time`).all(req.params.unit) });
});

r.post("/entry-windows", require_("entrynotice.manage"), (req, res) => {
  const { unit_number, kind, weekday, specific_date, from_time, to_time, reason, set_by } = req.body ?? {};
  if (!unit_number || !kind || !from_time || !to_time)
    return res.status(400).json({ code: "MISSING_WINDOW_FIELDS" });
  if (weekday == null && !specific_date)
    return res.status(400).json({ code: "NEED_WEEKDAY_OR_DATE" });
  const id = uid("ew_");
  db.prepare(`INSERT INTO entry_windows (id, unit_number, kind, weekday, specific_date,
    from_time, to_time, reason, set_by) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, unit_number, kind, weekday ?? null, specific_date ?? null, from_time, to_time,
         reason ?? null, set_by ?? "staff");
  audit(req, { action: "entrywindow.create", entityType: "unit", entityId: unit_number,
               after: { kind, weekday, specific_date, from_time, to_time } });
  res.status(201).json({ id });
});

r.delete("/entry-windows/:id", require_("entrynotice.manage"), (req, res) => {
  const w = db.prepare("SELECT * FROM entry_windows WHERE id=?").get(req.params.id);
  if (!w) return res.status(404).json({ code: "WINDOW_NOT_FOUND" });
  db.prepare("DELETE FROM entry_windows WHERE id=?").run(req.params.id);
  audit(req, { action: "entrywindow.delete", entityType: "unit", entityId: w.unit_number,
               before: w });
  res.json({ ok: true });
});

/** Whether a proposed time falls inside a blocked window. Advisory rather than
 *  enforced: a landlord retains a right of entry on proper notice, and a
 *  genuine emergency does not wait for a convenient slot. But going ahead over
 *  a stated objection should be a decision someone makes on purpose. */
r.get("/entry-windows/:unit/check", require_("units.view"), (req, res) => {
  const { at, minutes = 60 } = req.query;
  if (!at) return res.status(400).json({ code: "MISSING_TIME" });
  const start = new Date(at);
  const end = new Date(start.getTime() + Number(minutes) * 60000);
  const date = start.toISOString().slice(0, 10);
  const weekday = start.getDay();
  const hhmm = (d) => d.toISOString().slice(11, 16);

  const windows = db.prepare(`SELECT * FROM entry_windows WHERE unit_number=?
    AND (specific_date = ? OR weekday = ?)`).all(req.params.unit, date, weekday);

  const overlaps = (w) => hhmm(start) < w.to_time && w.from_time < hhmm(end);
  const blocked = windows.filter((w) => w.kind === "blocked" && overlaps(w));
  const available = windows.filter((w) => w.kind === "available");
  const insideAvailable = available.length === 0 || available.some((w) => overlaps(w));

  res.json({
    ok: blocked.length === 0 && insideAvailable,
    blocked_by: blocked,
    outside_preferred: available.length > 0 && !insideAvailable,
    available_windows: available,
  });
});

/* ---------- Entry notice with a reminder ---------- */
/*
   The notice itself is the legal step and goes out first. A reminder
   follows closer to the time, because a notice read four days ago is
   not the same as knowing someone is at the door this afternoon.
*/

r.post("/entry-notices/:id/schedule-reminder", require_("entrynotice.manage"), (req, res) => {
  const n = db.prepare("SELECT * FROM entry_notices WHERE id=?").get(req.params.id);
  if (!n) return res.status(404).json({ code: "NOTICE_NOT_FOUND" });
  if (n.state !== "sent") return res.status(409).json({ code: "NOTICE_NOT_SENT" });

  const entryAt = `${n.entry_date}T${n.window_from}:00`;
  const lead = hoursUntil(entryAt);
  if (lead < 0) return res.status(409).json({ code: "ENTRY_ALREADY_PASSED" });

  const remindAt = new Date(new Date(entryAt).getTime() - ENTRY_NOTICE_HOURS * 3600e3);
  const bilingual = [
    `Reminder: we will be entering ${n.unit_number} on ${n.entry_date} between ${n.window_from} and ${n.window_to}.`,
    `Reason: ${n.purpose}. You do not need to be home. If the time no longer works, reply and we will arrange another.`,
    "",
    `提醒：我們將於 ${n.entry_date} ${n.window_from} 至 ${n.window_to} 進入 ${n.unit_number}。`,
    `原因：${n.purpose}。你不需要在家。如果這個時間不方便，回覆我們可以另約。`,
  ].join("\n");

  const msg = queue({
    kind: "entry_reminder", channel: req.body?.channel ?? "both",
    toEmail: n.tenant_contact?.includes("@") ? n.tenant_contact : null,
    toPhone: n.tenant_contact?.includes("@") ? null : n.tenant_contact,
    toName: n.tenant_name, locale: n.locale ?? "en",
    subject: `Reminder: entry to ${n.unit_number} on ${n.entry_date}`,
    body: bilingual, refType: "entry_notice", refId: n.id,
    requiredBy: remindAt.toISOString(), userId: req.user.id,
  });

  const conf = requestConfirmation({ refType: "entry", refId: n.id,
    question: `We will enter ${n.unit_number} on ${n.entry_date}, ${n.window_from}–${n.window_to}. Does that still work?`,
    toEmail: msg.channel !== "sms" ? n.tenant_contact : null,
    toPhone: msg.channel !== "email" ? n.tenant_contact : null,
    outboxId: msg.id, expiresAt: entryAt });

  audit(req, { action: "entrynotice.reminder", entityType: "entry_notice", entityId: n.id,
               after: { remind_at: remindAt.toISOString(), channel: msg.channel } });
  res.status(201).json({ message: msg, confirmation: conf,
                         remind_at: remindAt.toISOString() });
});

/* ---------- Application screening ---------- */

/** Checks before anything is created. The client calls this as the applicant
 *  types, so a duplicate is caught at the email field rather than after six
 *  steps of form filling. */
r.post("/screen", (req, res) => {
  const { email, phone, full_name } = req.body ?? {};
  const outcome = screen({ email, phone, full_name });
  res.json({
    result: outcome.result,
    detail: outcome.detail,
    similarity: outcome.similarity,
    // A duplicate is refused outright. A resemblance never is: it goes to a
    // person, because two people with the same common surname are two people.
    blocking: outcome.result === "duplicate",
  });
});

r.post("/applications/:id/screen", require_("leads.manage"), (req, res) => {
  const { email, phone, full_name } = req.body ?? {};
  const outcome = screen({ email, phone, full_name });
  const id = recordScreen(req.params.id, { email, phone, full_name }, outcome);
  if (outcome.result === "review") {
    notify("property_manager", "screening", "APPLICATION_NEEDS_REVIEW",
           { application: req.params.id, detail: outcome.detail },
           `/leads?screen=${id}`);
  }
  audit(req, { action: "application.screen", entityType: "application", entityId: req.params.id,
               after: { result: outcome.result, matched_type: outcome.matched_type,
                        similarity: outcome.similarity } });
  res.json({ screen_id: id, ...outcome });
});

r.get("/screens", require_("leads.view"), (req, res) => {
  const { result, limit = 100 } = req.query;
  let sql = "SELECT * FROM application_screens WHERE 1=1";
  const args = [];
  if (result) { sql += " AND result = ?"; args.push(result); }
  sql += " ORDER BY created_at DESC LIMIT ?";
  args.push(Math.min(Number(limit) || 100, 500));
  res.json({ screens: db.prepare(sql).all(...args) });
});

/** A flagged application is decided by a person, with the reason recorded.
 *  "The system said no" is not a defensible answer to a complaint. */
r.post("/screens/:id/decide", require_("leads.manage"), (req, res) => {
  const { decision, note } = req.body ?? {};
  if (!["allow", "reject"].includes(decision))
    return res.status(400).json({ code: "INVALID_DECISION" });
  if (!note?.trim()) return res.status(400).json({ code: "DECISION_NOTE_REQUIRED" });

  const s = db.prepare("SELECT * FROM application_screens WHERE id=?").get(req.params.id);
  if (!s) return res.status(404).json({ code: "SCREEN_NOT_FOUND" });

  db.prepare(`UPDATE application_screens SET decision=?, decision_note=?, decided_by=?,
    decided_at=? WHERE id=?`).run(decision, note.trim(), req.user.id, nowISO(), s.id);
  audit(req, { action: "screen.decide", entityType: "application", entityId: s.application_id,
               before: { result: s.result, similarity: s.similarity },
               after: { decision, note: note.trim(), by: req.user.name } });
  res.json({ ok: true });
});

r.post("/contacts", require_("leads.manage"), (req, res) => {
  const { full_name, email, phone, locale } = req.body ?? {};
  const outcome = screen({ email, phone, full_name });
  if (outcome.result === "duplicate")
    return res.status(409).json({ code: "DUPLICATE_CONTACT", detail: outcome.detail,
                                   matched_id: outcome.matched_id });
  const id = upsertContact({ full_name, email, phone, locale });
  audit(req, { action: "contact.create", entityType: "contact", entityId: id,
               after: { full_name, email: normEmail(email), phone: normPhone(phone) } });
  res.status(201).json({ id, screen: outcome });
});

/* ---------- Preferences ---------- */

r.post("/preferences", (req, res) => {
  const { contact_key, allow_email, allow_sms, allow_marketing, locale } = req.body ?? {};
  if (!contact_key) return res.status(400).json({ code: "MISSING_CONTACT_KEY" });
  db.prepare(`INSERT INTO contact_preferences (contact_key, allow_email, allow_sms,
    allow_marketing, locale, updated_at) VALUES (?,?,?,?,?,datetime('now'))
    ON CONFLICT(contact_key) DO UPDATE SET allow_email=excluded.allow_email,
    allow_sms=excluded.allow_sms, allow_marketing=excluded.allow_marketing,
    locale=excluded.locale, updated_at=datetime('now')`)
    .run(String(contact_key).trim().toLowerCase(),
         allow_email === false ? 0 : 1, allow_sms === false ? 0 : 1,
         allow_marketing ? 1 : 0, locale ?? "en");
  res.json({ ok: true });
});

export default r;
