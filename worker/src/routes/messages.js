import { Hono } from "hono";
import { require_ } from "../lib/auth.js";

/* ============================================================
   The record of everything sent

   Every message, searchable, with what it actually said.

   Separate from notifications on purpose. A record is something
   you go and look at when you need it; a notification is
   something that interrupts somebody. Around nine hundred
   messages a month go out from a building this size, and perhaps
   eight of them need anybody to do anything.

   Turning all nine hundred into notifications does not mean
   everybody knows — it means nobody reads the list, and the day
   they stop reading it is the day it contains a notice of entry
   that never went out.

   So: everything is here. Only what needs a person is a
   notification.
   ============================================================ */

const r = new Hono();

/* What each kind is, in words, so a list of forty rows reads as forty things
   that happened rather than forty codes. */
const KIND = {
  entry_notice:    { label: "Notice of entry", legal: true },
  rent_increase:   { label: "Rent increase", legal: true },
  renewal:         { label: "Renewal offer", legal: true },
  arrears:         { label: "Arrears", legal: true },
  lease_signed:    { label: "Signed lease" },
  showing_confirm: { label: "Viewing confirmed" },
  application:     { label: "Application" },
  password_reset:  { label: "Password reset" },
  tenant_claim:    { label: "Portal access" },
  staff_invite:    { label: "Staff invitation" },
  signup_verify:   { label: "Email confirmation" },
  security_notice: { label: "Security notice" },
  maintenance:     { label: "Maintenance" },
  receipt:         { label: "Receipt" },
};

r.get("/messages", require_("audit.view"), async (c) => {
  const sql = c.get("db");
  const { unit, kind, state, q, since, limit = 100 } = c.req.query();
  const n = Math.min(Number(limit), 500);

  /* One query with optional filters rather than five queries.
     
     Written as a sequence of AND clauses that are all true when the filter is
     absent, because building SQL by string concatenation is how a search box
     becomes an injection. */
  const rows = await sql`
    SELECT o.id, o.channel, o.to_email, o.to_phone, o.to_name, o.kind,
           o.subject, o.body, o.state, o.attempts, o.last_error,
           o.required_by, o.sent_at, o.created_at, o.provider_id,
           o.ref_type, o.ref_id, o.attachment_name,
           u.full_name AS created_by_name
    FROM outbox o
    LEFT JOIN users u ON u.id = o.created_by
    WHERE (${unit ?? null}::text IS NULL
           OR o.ref_id = ${unit ?? null}
           OR o.body ILIKE ${"%" + (unit ?? "") + "%"})
      AND (${kind ?? null}::text IS NULL OR o.kind = ${kind ?? null})
      AND (${state ?? null}::text IS NULL OR o.state = ${state ?? null})
      AND (${since ?? null}::text IS NULL OR o.created_at >= ${since ?? null}::timestamptz)
      AND (${q ?? null}::text IS NULL
           OR o.to_email ILIKE ${"%" + (q ?? "") + "%"}
           OR o.subject ILIKE ${"%" + (q ?? "") + "%"}
           OR o.to_name ILIKE ${"%" + (q ?? "") + "%"})
    ORDER BY o.created_at DESC
    LIMIT ${n}`;

  const [counts] = await sql`
    SELECT
      COUNT(*)::int                                          AS total,
      COUNT(*) FILTER (WHERE state = 'sent')::int            AS sent,
      COUNT(*) FILTER (WHERE state = 'queued')::int          AS queued,
      COUNT(*) FILTER (WHERE state = 'sending')::int         AS in_flight,
      COUNT(*) FILTER (WHERE state = 'failed')::int          AS failed,
      COUNT(*) FILTER (WHERE state IN ('queued','failed')
        AND required_by::timestamptz < now())::int           AS overdue
    FROM outbox
    WHERE created_at > now() - INTERVAL '90 days'`;

  return c.json({
    messages: rows.map((m) => ({
      ...m,
      ...(KIND[m.kind] ?? { label: m.kind }),
      // Whether it actually landed, said plainly. 'sent' means the mail
      // server accepted it, which is not the same as it having been read —
      // and the difference matters when somebody says they never got it.
      delivered: m.state === "sent",
      note: m.state === "sent"
        ? "Accepted by the mail server. That is not proof it was read."
        : m.state === "failed"
        ? m.last_error
        : m.state === "queued" && m.required_by && new Date(m.required_by) < new Date()
        ? "Past the time it had to go out. Treat the notice as not served."
        : null,
    })),
    counts_90_days: counts,
  });
});

/** One message, exactly as it was sent.
 *
 *  The body is kept and shown because "what did we actually tell them" is the
 *  question that gets asked, and a summary of a notice is not the notice. */
r.get("/messages/:id", require_("audit.view"), async (c) => {
  const sql = c.get("db");
  const [m] = await sql`
    SELECT o.*, u.full_name AS created_by_name
    FROM outbox o LEFT JOIN users u ON u.id = o.created_by
    WHERE o.id = ${c.req.param("id")}`;
  if (!m) return c.json({ code: "NOT_FOUND" }, 404);

  return c.json({
    message: { ...m, ...(KIND[m.kind] ?? { label: m.kind }) },
    // The whole picture of one message: when it was made, when it had to go,
    // when it went, and what the far end said.
    timeline: [
      { at: m.created_at, event: "created",
        by: m.created_by_name ?? "system" },
      m.required_by && { at: m.required_by, event: "had to be sent by" },
      m.sent_at && { at: m.sent_at, event: "accepted by the mail server",
        detail: m.provider_id },
      m.last_error && { at: null, event: "last error", detail: m.last_error },
    ].filter(Boolean),
  });
});

/**
 * Everything sent to one suite.
 *
 * This is how the question actually arrives. Nobody opens a message log and
 * browses — somebody rings to say they were never told about the inspection,
 * and the useful thing is every message that suite has ever been sent, in
 * order, with what each one said.
 */
r.get("/messages/unit/:unit", require_("units.view"), async (c) => {
  const sql = c.get("db");
  const unit = c.req.param("unit");

  const rows = await sql`
    SELECT o.id, o.kind, o.subject, o.body, o.to_email, o.to_name, o.state,
           o.required_by, o.sent_at, o.created_at, o.last_error, o.provider_id
    FROM outbox o
    WHERE o.ref_id = ${unit}
       OR (o.ref_type = 'unit' AND o.ref_id = ${unit})
       OR o.to_email IN (
            SELECT ct.email FROM leases l JOIN contacts ct ON ct.id = l.contact_id
            WHERE l.unit_number = ${unit})
    ORDER BY o.created_at DESC LIMIT 200`;

  return c.json({
    unit,
    messages: rows.map((m) => ({ ...m, ...(KIND[m.kind] ?? { label: m.kind }) })),
    // The ones that carry a period. If somebody is disputing whether they
    // were told, these are the rows that answer it.
    legal_notices: rows
      .filter((m) => KIND[m.kind]?.legal)
      .map((m) => ({ kind: m.kind, label: KIND[m.kind].label,
        sent_at: m.sent_at, state: m.state,
        served: m.state === "sent",
        note: m.state !== "sent"
          ? "This never went out. The period it was meant to start did not start."
          : null })),
  });
});

/** What went out today, for whoever wants to glance rather than search. */
r.get("/messages/summary/today", require_("audit.view"), async (c) => {
  const sql = c.get("db");
  const rows = await sql`
    SELECT kind, state, COUNT(*)::int AS count
    FROM outbox WHERE created_at > CURRENT_DATE
    GROUP BY kind, state ORDER BY count DESC`;

  return c.json({
    today: rows.map((x) => ({ ...x, ...(KIND[x.kind] ?? { label: x.kind }) })),
    total: rows.reduce((s, x) => s + x.count, 0),
  });
});

export default r;
