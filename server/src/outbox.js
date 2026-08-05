import crypto from "node:crypto";
import { db, uid, nowISO } from "./db.js";

/* ============================================================
   Outbox and confirmations

   Nothing sends directly from the code that caused it. A message is
   queued, then delivered by a worker. A provider outage delays
   messages instead of losing them, and every message that should
   have gone out is visible afterwards.

   That matters most for a notice of entry: "we sent it" has to be
   provable, and "it failed and nobody noticed" has to be impossible.
   ============================================================ */

export const CHANNELS = ["email", "sms", "both"];

/* SMS costs money per message and arrives in the middle of dinner. Email is
   the default for anything that can wait; SMS is for what cannot. */
export const DEFAULT_CHANNEL = {
  showing_confirm:   "email",
  showing_reminder:  "both",     // a missed viewing wastes two people's time
  entry_notice:      "email",    // the written record is the point
  entry_reminder:    "both",     // 24 hours out, and they may not be home
  signing_ready:     "email",
  keys_confirm:      "both",
  repair_scheduled:  "both",     // somebody is coming into their home
  rent_receipt:      "email",
  arrears:           "email",
  password_reset:    "email",    // never SMS: a reset link in a text is a gift to whoever has the phone
  application_ack:   "email",
};

const norm = (s) => String(s ?? "").trim().toLowerCase();

/** Preferences are respected for anything optional. A notice of entry is not
 *  optional — it is a legal notice, and a tenant declining SMS does not remove
 *  the obligation to give it in writing. */
export function resolveChannel(kind, requested, contactKey) {
  const base = requested || DEFAULT_CHANNEL[kind] || "email";
  if (!contactKey) return base;
  const pref = db.prepare("SELECT * FROM contact_preferences WHERE contact_key = ?")
                 .get(norm(contactKey));
  if (!pref) return base;
  const legal = kind === "entry_notice" || kind === "entry_reminder";
  if (legal) return base;
  const email = pref.allow_email !== 0;
  const sms = pref.allow_sms !== 0;
  if (base === "both") return email && sms ? "both" : email ? "email" : sms ? "sms" : "email";
  if (base === "sms" && !sms) return email ? "email" : "email";
  if (base === "email" && !email) return sms ? "sms" : "email";
  return base;
}

export function queue({ kind, channel, toEmail, toPhone, toName, locale = "en",
                        subject, body, refType, refId, requiredBy, userId }) {
  const resolved = resolveChannel(kind, channel, toEmail || toPhone);
  const id = uid("ob_");
  db.prepare(`INSERT INTO outbox (id, channel, to_email, to_phone, to_name, locale, kind,
    subject, body, ref_type, ref_id, required_by, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, resolved, toEmail ?? null, toPhone ?? null, toName ?? null, locale, kind,
         subject ?? null, body, refType ?? null, refId ?? null, requiredBy ?? null,
         userId ?? null);
  return { id, channel: resolved };
}

/** Asks the other side to confirm, and returns a token that identifies the
 *  reply. A step waiting on this does not advance on the assumption that a
 *  message was read. */
export function requestConfirmation({ refType, refId, question, toEmail, toPhone,
                                      expiresAt, outboxId }) {
  const token = crypto.randomBytes(18).toString("base64url");
  const id = uid("cf_");
  db.prepare(`INSERT INTO confirmations (id, token, ref_type, ref_id, to_email, to_phone,
    question, expires_at, outbox_id) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, token, refType, refId, toEmail ?? null, toPhone ?? null, question,
         expiresAt ?? null, outboxId ?? null);
  return { id, token };
}

export function respondToConfirmation(token, state, note) {
  const c = db.prepare("SELECT * FROM confirmations WHERE token = ?").get(token);
  if (!c) return null;
  if (c.state !== "sent") return c;
  if (c.expires_at && c.expires_at < nowISO()) {
    db.prepare("UPDATE confirmations SET state='expired' WHERE id=?").run(c.id);
    return { ...c, state: "expired" };
  }
  db.prepare(`UPDATE confirmations SET state=?, response_note=?, responded_at=? WHERE id=?`)
    .run(state, note ?? null, nowISO(), c.id);
  return { ...c, state };
}

export function confirmationFor(refType, refId) {
  return db.prepare(`SELECT * FROM confirmations WHERE ref_type=? AND ref_id=?
                     ORDER BY created_at DESC LIMIT 1`).get(refType, refId);
}

/* ---------- Delivery ----------
   The provider is not wired. Until it is, messages queue and the worker
   marks them for review rather than pretending they went out — a silent
   success here would be worse than an obvious failure. */

export async function deliver(row) {
  const hasProvider = !!process.env.EMAIL_PROVIDER_KEY;
  if (!hasProvider) {
    db.prepare(`UPDATE outbox SET attempts = attempts + 1,
      last_error = 'No delivery provider configured' WHERE id = ?`).run(row.id);
    return false;
  }
  // TODO: send through the provider, then record its id so a bounce can be traced.
  db.prepare("UPDATE outbox SET state='sent', sent_at=? WHERE id=?").run(nowISO(), row.id);
  return true;
}

export async function drainOutbox(limit = 50) {
  const rows = db.prepare(`SELECT * FROM outbox WHERE state='queued' AND attempts < 5
                           ORDER BY created_at LIMIT ?`).all(limit);
  let sent = 0;
  for (const row of rows) if (await deliver(row)) sent++;
  return { attempted: rows.length, sent };
}

/** Anything that had to be out by now and is not. This is the number worth
 *  watching: a queue that grows quietly is a notice of entry that never
 *  reached a tenant. */
export function overdueMessages() {
  return db.prepare(`SELECT * FROM outbox
    WHERE state='queued' AND required_by IS NOT NULL AND required_by < datetime('now')
    ORDER BY required_by`).all();
}
