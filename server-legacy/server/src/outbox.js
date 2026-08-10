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
   Two providers, both over plain HTTP so nothing extra has to be installed.
   Without keys the queue holds and says so, rather than reporting a send
   that did not happen — a silent success here is worse than an obvious
   failure, because a notice of entry that never arrived looks identical to
   one that did. */

const FROM_EMAIL = process.env.FROM_EMAIL || "noreply@themizar.ca";
const FROM_NAME = process.env.FROM_NAME || "Baydo Pointe";

async function sendEmail({ to, name, subject, body }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("EMAIL_NOT_CONFIGURED");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: [name ? `${name} <${to}>` : to],
      subject: subject || "A message from Baydo Pointe",
      text: body,
    }),
  });
  if (!res.ok) throw new Error(`EMAIL_${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json())?.id ?? null;
}

async function sendSms({ to, body }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  if (!sid || !token || !from) throw new Error("SMS_NOT_CONFIGURED");

  // Long messages split into several billable segments. Truncating with a
  // pointer back is cheaper and reads better than three fragments arriving
  // out of order.
  const text = body.length > 300 ? `${body.slice(0, 280)}… (see your email for the rest)` : body;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
               "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: from, Body: text }),
  });
  if (!res.ok) throw new Error(`SMS_${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json())?.sid ?? null;
}

export function providerStatus() {
  return {
    email: !!process.env.RESEND_API_KEY,
    sms: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
            && process.env.TWILIO_FROM),
  };
}

export async function deliver(row) {
  const want = row.channel;
  const status = providerStatus();
  const results = [];
  let anySent = false, lastError = null;

  const tryEmail = (want === "email" || want === "both") && row.to_email;
  const trySms = (want === "sms" || want === "both") && row.to_phone;

  if (tryEmail) {
    if (!status.email) lastError = "Email provider not configured";
    else {
      try {
        const id = await sendEmail({ to: row.to_email, name: row.to_name,
                                     subject: row.subject, body: row.body });
        results.push(`email:${id ?? "ok"}`); anySent = true;
      } catch (e) { lastError = e.message; }
    }
  }

  if (trySms) {
    if (!status.sms) lastError = lastError ?? "SMS provider not configured";
    else {
      try {
        const id = await sendSms({ to: row.to_phone, body: row.body });
        results.push(`sms:${id ?? "ok"}`); anySent = true;
      } catch (e) { lastError = e.message; }
    }
  }

  if (!tryEmail && !trySms) {
    db.prepare(`UPDATE outbox SET state='failed', attempts=attempts+1,
      last_error='No usable address for the requested channel' WHERE id=?`).run(row.id);
    return false;
  }

  // "Both" counts as delivered if either arrived. The tenant got the message;
  // the failure is recorded so the gap in one channel is still visible.
  if (anySent) {
    db.prepare(`UPDATE outbox SET state='sent', sent_at=?, provider_id=?,
      attempts=attempts+1, last_error=? WHERE id=?`)
      .run(nowISO(), results.join(","), lastError, row.id);
    return true;
  }

  const attempts = row.attempts + 1;
  db.prepare(`UPDATE outbox SET attempts=?, last_error=?, state=? WHERE id=?`)
    .run(attempts, lastError, attempts >= 5 ? "failed" : "queued", row.id);
  return false;
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
