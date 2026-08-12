import { Hono } from "hono";
import { uid } from "../lib/auth.js";
import { sha256 } from "../lib/crypto.js";

/* ============================================================
   Delivery relay

   For sending through something that is not an HTTP API — a
   Python script, an SMTP server, an Outlook mailbox, whatever
   already works.

   Workers cannot do that themselves. They run V8, not Python,
   and they cannot open the TCP connection SMTP needs. So the
   Worker does not send: it holds the queue and hands messages
   out, and something else does the sending and reports back.

   That split is better than it sounds. The queue, the retry
   count and the deadline stay in one place with the rest of the
   data, and the part that talks to a mail server can be
   restarted, moved or rewritten without any of that being at
   risk.
   ============================================================ */

const r = new Hono();

const LEASE_MINUTES = 10;

/* Agents authenticate with a shared secret, not a staff session. A cron job
   on a server somewhere has no browser and no person behind it, so a session
   is the wrong shape — and giving it a staff account would give it far more
   than it needs. */
async function checkAgent(c) {
  const provided = c.req.header("x-relay-key");
  if (!provided || !c.env.RELAY_KEY) return false;

  // Constant-time-ish: compare hashes rather than strings, so a wrong key
  // does not leak its length or prefix through timing.
  return (await sha256(provided)) === (await sha256(c.env.RELAY_KEY));
}

r.use("/relay/*", async (c, next) => {
  if (!await checkAgent(c))
    return c.json({ code: "BAD_RELAY_KEY" }, 401);
  return next();
});

/**
 * Claim messages to send.
 *
 * Leased rather than just handed over. A message goes out marked as being
 * worked on and, if nothing confirms it within ten minutes, it comes back to
 * the queue — so an agent that dies mid-run loses nothing, and two agents
 * running at once do not both send the same notice.
 *
 * Sending a notice of entry twice is not harmless: the tenant gets two
 * different dates for the same visit and has to guess which is real.
 */
r.get("/relay/pull", async (c) => {
  const sql = c.get("db");
  const limit = Math.min(Number(c.req.query("limit") ?? 25), 100);
  const channel = c.req.query("channel") ?? "email";

  const lease = uid("lease_");

  const rows = await sql`
    UPDATE outbox SET
      state = 'sending',
      lease_id = ${lease},
      leased_until = now() + INTERVAL '1 minute' * ${LEASE_MINUTES},
      attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM outbox
      WHERE state = 'queued' AND attempts < 5
        AND (channel = ${channel} OR channel = 'both')
        AND to_email IS NOT NULL
      ORDER BY
        -- Anything with a deadline first, and the closest deadline first
        -- within that. A notice of entry has hours to run; a marketing note
        -- does not.
        required_by NULLS LAST,
        created_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, to_email, to_name, locale, kind, subject, body,
              ref_type, ref_id, required_by, attempts, attachment_key,
              attachment_name`;

  /* Attachments come back as a short-lived URL rather than as bytes.
     
     Base64 in a JSON response would triple the size of a signed lease and put
     it through two more systems on the way. A URL the agent fetches keeps the
     file on one path, and the link expires so a pull response sitting in a
     log is not a way to read somebody's tenancy. */
  const withFiles = rows.map((m) => ({
    ...m,
    attachment_url: m.attachment_key
      ? `${c.env.PUBLIC_URL}/api/relay/file/${m.id}`
      : null,
  }));

  return c.json({
    lease_id: lease,
    expires_in_seconds: LEASE_MINUTES * 60,
    messages: withFiles,
    from: { email: c.env.FROM_EMAIL ?? null, name: c.env.FROM_NAME ?? "Baydo Pointe" },
    note: rows.length
      ? `Confirm each one within ${LEASE_MINUTES} minutes or it returns to the queue.`
      : null,
  });
});

/**
 * Report what happened.
 *
 * Per message rather than per batch, because a batch result cannot say which
 * three of twenty bounced — and the three that bounced are the whole point.
 */
r.post("/relay/report", async (c) => {
  const sql = c.get("db");
  const { results } = await c.req.json().catch(() => ({}));

  if (!Array.isArray(results))
    return c.json({ code: "RESULTS_REQUIRED",
      detail: 'Send { "results": [{ "id": "...", "ok": true, "provider_id": "..." }] }' }, 400);

  let sent = 0, failed = 0;

  for (const row of results) {
    if (!row?.id) continue;

    if (row.ok) {
      await sql`UPDATE outbox
        SET state = 'sent', sent_at = now(), provider_id = ${row.provider_id ?? null},
            lease_id = NULL, leased_until = NULL, last_error = NULL
        WHERE id = ${row.id}`;
      sent++;
    } else {
      /* Back to the queue unless it has run out of attempts.
         
         A permanent failure — no such mailbox — is marked failed straight
         away rather than retried five times. Retrying an address that does
         not exist just delays somebody noticing that it does not exist. */
      const permanent = row.permanent === true
        || /55[0-9]|no such|does not exist|invalid recipient/i.test(row.error ?? "");

      await sql`UPDATE outbox
        SET state = CASE WHEN ${permanent} OR attempts >= 5 THEN 'failed' ELSE 'queued' END,
            last_error = ${String(row.error ?? "unknown").slice(0, 500)},
            lease_id = NULL, leased_until = NULL
        WHERE id = ${row.id}`;
      failed++;
    }
  }

  return c.json({ ok: true, sent, failed });
});

/**
 * The file for a message being sent.
 *
 * Only while the message is leased. A signed lease is not something to serve
 * from a URL that keeps working after the send — the agent needs it for the
 * length of one batch, and nothing else needs it at all.
 */
r.get("/relay/file/:id", async (c) => {
  const sql = c.get("db");
  const [m] = await sql`SELECT attachment_key, attachment_name, state, leased_until
    FROM outbox WHERE id = ${c.req.param("id")}`;

  if (!m?.attachment_key) return c.json({ code: "NO_ATTACHMENT" }, 404);
  if (m.state !== "sending" || new Date(m.leased_until) < new Date())
    return c.json({ code: "NOT_LEASED",
      detail: "This message is not currently being sent." }, 409);

  if (!c.env.FILES) return c.json({ code: "NO_STORAGE" }, 503);
  const obj = await c.env.FILES.get(m.attachment_key);
  if (!obj) return c.json({ code: "FILE_MISSING" }, 410);

  c.header("Content-Type", obj.httpMetadata?.contentType ?? "application/pdf");
  c.header("Content-Disposition",
    `attachment; filename="${m.attachment_name ?? "document.pdf"}"`);
  return c.body(obj.body);
});

/** What the agent should know without needing a person to tell it. */
r.get("/relay/status", async (c) => {
  const sql = c.get("db");
  const [counts] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE state = 'queued')::int   AS queued,
      COUNT(*) FILTER (WHERE state = 'sending')::int  AS in_flight,
      COUNT(*) FILTER (WHERE state = 'failed')::int   AS failed,
      COUNT(*) FILTER (WHERE state = 'queued' AND required_by::timestamptz < now())::int AS overdue
    FROM outbox`;
  return c.json({ ...counts, from: c.env.FROM_EMAIL ?? null });
});

export default r;
