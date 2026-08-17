import { Hono } from "hono";
import { uid } from "../lib/auth.js";

/* ============================================================
   Notifications

   Things the system needs somebody to know about.

   Sorted by consequence rather than time. A notice of entry that
   never left is more urgent than eleven older items about
   anything else, and a list in date order buries it.
   ============================================================ */

const r = new Hono();

/* What each code actually means, in words.
   
   Kept here rather than in the front end because the same explanation should
   reach a screen, an email digest and anybody reading the table directly. A
   code with no explanation is a code somebody dismisses. */
const MEANING = {
  DELIVERY_OVERDUE: {
    severity: "urgent",
    title: "A message with a deadline has not gone out",
    what: "The notice period this message was meant to start has not started. Whatever it was for, treat it as not served.",
  },
  ADDRESS_UNDELIVERABLE: {
    severity: "urgent",
    title: "An email address is not reachable",
    what: "Every message to this tenancy is failing the same way and will keep failing until the address is corrected.",
  },
  DELIVERY_STOPPED: {
    severity: "urgent",
    title: "Nothing is going out",
    what: "Messages are queuing and none has been sent in two hours. The delivery agent or the mail server has stopped.",
  },
  ARCHIVE_FAILED: {
    severity: "attention",
    title: "A signed document did not reach the company server",
    what: "The signature is safe. The copy is not, and it stopped retrying.",
  },
  SCHEDULE_STOPPED: {
    severity: "urgent",
    title: "A charge schedule has stopped while the tenancy continues",
    what: "Somebody is living in a suite that is not being billed for it.",
  },
  DAILY_DIGEST: {
    severity: "info",
    title: "Yesterday's messages",
    what: "What went out. Worth a glance rather than a read — a morning with no receipts, or forty notices of entry, looks wrong here in a way no single message does.",
  },
  RENT_INCREASE_APPLIED: { severity: "info", title: "A rent increase took effect" },
  RENT_REVIEW_DUE: { severity: "info", title: "A tenancy is due for a rent review" },
  LEASE_ENDING: { severity: "attention", title: "A lease is ending" },
  RENEWAL_ACCEPTED: { severity: "info", title: "A tenant accepted a renewal" },
  RENEWAL_DECLINED: { severity: "attention", title: "A tenant is not renewing" },
  RENEWAL_QUESTION: { severity: "attention", title: "A tenant wants to discuss a renewal" },
  URGENT_REPAIR_REPORTED: { severity: "urgent", title: "An urgent repair was reported" },
  REPAIR_REPORTED: { severity: "info", title: "A repair was reported" },
  CHAT_CONFIRMATION_REQUIRED: {
    severity: "attention",
    title: "A customer chat needs confirmation",
    what: "The automated answer rules could not safely answer this question. The role shown on the item must review it.",
  },
};

const RANK = { urgent: 0, attention: 1, info: 2 };

r.get("/notifications", async (c) => {
  const sql = c.get("db");
  const user = c.get("user");
  if (!user) return c.json({ code: "NOT_AUTHENTICATED" }, 401);

  // Admin sees everything. Everybody else sees what is addressed to their
  // role — a notification nobody can act on is one that trains people to
  // dismiss the list.
  const rows = user.role === "admin"
    ? await sql`SELECT * FROM notifications
        WHERE read_at IS NULL OR created_at > now() - INTERVAL '7 days'
        ORDER BY created_at DESC LIMIT 200`
    : await sql`SELECT * FROM notifications
        WHERE audience = ${user.role}
          AND (read_at IS NULL OR created_at > now() - INTERVAL '7 days')
        ORDER BY created_at DESC LIMIT 200`;

  const enriched = rows.map((n) => {
    const meaning = MEANING[n.code] ?? { severity: "info", title: n.code };
    let params = {};
    try { params = typeof n.params === "string" ? JSON.parse(n.params) : (n.params ?? {}); }
    catch { /* a malformed row should not hide the rest of the list */ }
    return { ...n, ...meaning, params, unread: !n.read_at };
  });

  /* Consequence first, then time within that.
     
     A notice of entry that never left outranks eleven older items about
     anything else, and a list in date order buries it under them. */
  enriched.sort((a, b) =>
    (RANK[a.severity] - RANK[b.severity])
    || (a.unread === b.unread ? 0 : a.unread ? -1 : 1)
    || String(b.created_at).localeCompare(String(a.created_at)));

  return c.json({
    notifications: enriched,
    counts: {
      unread: enriched.filter((n) => n.unread).length,
      urgent: enriched.filter((n) => n.severity === "urgent" && n.unread).length,
    },
  });
});

r.post("/notifications/:id/read", async (c) => {
  const [n] = await c.get("db")`
    UPDATE notifications SET read_at = now()
    WHERE id = ${c.req.param("id")} AND read_at IS NULL RETURNING id`;
  return c.json({ ok: true, marked: !!n });
});

/** Marking everything read. Deliberately not offered for urgent ones —
 *  clearing a list of things that have not been dealt with is how they stop
 *  being dealt with. */
r.post("/notifications/read-all", async (c) => {
  const sql = c.get("db");
  const user = c.get("user");

  const cleared = await sql`
    UPDATE notifications SET read_at = now()
    WHERE read_at IS NULL
      AND (${user.role === "admin"} OR audience = ${user.role})
      AND code NOT IN ('DELIVERY_OVERDUE', 'ADDRESS_UNDELIVERABLE',
                       'DELIVERY_STOPPED', 'SCHEDULE_STOPPED')
    RETURNING id`;

  return c.json({ ok: true, cleared: cleared.length,
    note: "Anything with a consequence is still there. Those clear when the underlying problem does." });
});

/** Retrying a failed message by hand, once the address has been corrected. */
r.post("/notifications/outbox/:id/retry", async (c) => {
  const sql = c.get("db");
  const [m] = await sql`
    UPDATE outbox SET state = 'queued', attempts = 0, last_error = NULL,
      lease_id = NULL, leased_until = NULL
    WHERE id = ${c.req.param("id")} AND state IN ('failed','queued')
    RETURNING id, to_email, kind`;
  if (!m) return c.json({ code: "NOT_FOUND" }, 404);

  return c.json({ ok: true, message: m,
    note: "Back in the queue. If the address was the problem, correct it on the contact first or this fails the same way." });
});

export default r;
