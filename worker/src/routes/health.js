import { Hono } from "hono";

const r = new Hono();

/* Whether the Worker is running. Answers nothing about the database on
   purpose — a health check that touches Postgres turns a monitoring ping into
   database load, and it is the first thing that gets hammered. */
r.get("/health", (c) =>
  c.json({
    ok: true,
    service: "Baydo Pointe API",
    runtime: "Cloudflare Workers",
    environment: c.env.ENVIRONMENT ?? "unknown",
    time: new Date().toISOString(),
  }));

/**
 * Whether the database is reachable, and whether it is the right one.
 *
 * A count of 330 units is the useful check. "Connected" only proves there is
 * a Postgres at the other end, and pointing at an empty staging database
 * looks exactly like a healthy connection until somebody tries to sign a
 * lease.
 */
r.get("/db-health", async (c) => {
  const sql = c.get("db");
  const started = Date.now();

  try {
    const [{ count: units }] = await sql`SELECT COUNT(*)::int AS count FROM units`;
    const [{ count: tables }] = await sql`
      SELECT COUNT(*)::int AS count FROM information_schema.tables
      WHERE table_schema = 'public'`;
    const [{ now }] = await sql`SELECT now()`;

    return c.json({
      ok: true,
      total_units: units,
      tables,
      // 330 is what this property has. Anything else means the wrong database
      // or an incomplete migration, and both look like success without this.
      expected_units: 330,
      units_match: units === 330,
      database_time: now,
      ms: Date.now() - started,
      note: units === 330 ? null
        : units === 0 ? "Connected, but empty. The schema may be there and the seed not run."
        : `Connected, but ${units} units rather than 330. Check which database this is pointed at.`,
    });
  } catch (e) {
    return c.json({
      ok: false,
      code: e.code ?? "DB_UNREACHABLE",
      detail: e.message,
      ms: Date.now() - started,
      hint: e.message?.includes("HYPERDRIVE")
        ? "No Hyperdrive binding. Create one and put its id in wrangler.jsonc."
        : "Check the connection string in the Hyperdrive config, and that the database allows connections from Cloudflare.",
    }, 503);
  }
});

/**
 * Whether messages are actually going out.
 *
 * Separate from db-health because "the database answers" and "notices are
 * reaching tenants" are different questions, and the second one is the one
 * that matters legally. A notice of entry that never left looks exactly like
 * one that did — same row, same green tick on screen — and the difference is
 * everything if a tenant refuses at the door.
 */
r.get("/outbox-health", async (c) => {
  const sql = c.get("db");

  const [counts] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE state = 'queued')::int          AS queued,
      COUNT(*) FILTER (WHERE state = 'sent')::int            AS sent,
      COUNT(*) FILTER (WHERE state = 'failed')::int          AS failed,
      COUNT(*) FILTER (WHERE state = 'queued'
        AND required_by IS NOT NULL
        AND required_by::timestamptz < now())::int           AS overdue,
      COUNT(*) FILTER (WHERE state = 'sent'
        AND sent_at > now() - INTERVAL '24 hours')::int      AS sent_today,
      MAX(sent_at)                                           AS last_sent
    FROM outbox`;

  const stuck = await sql`
    SELECT kind, to_email, attempts, last_error, created_at
    FROM outbox WHERE state IN ('queued','failed') AND attempts > 0
    ORDER BY created_at LIMIT 10`;

  const configured = !!c.env.RESEND_API_KEY;
  const from = c.env.FROM_EMAIL ?? null;
  const deliveryErrors = [...new Set(stuck.map((x) => x.last_error).filter(Boolean))];
  const hasProviderFailure = deliveryErrors.some((x) => /^EMAIL_[45]\d\d/.test(x));

  return c.json({
    ok: configured && counts.overdue === 0 && !hasProviderFailure,
    provider_configured: configured,
    from,
    counts,
    // The most useful line when something is wrong. A single repeated error
    // across every message is a setting; different errors are addresses.
    recent_errors: deliveryErrors,
    stuck: stuck.slice(0, 5),
    note: !configured
      ? "No RESEND_API_KEY. Messages are queuing and will go out once it is set — nothing has been lost."
      : hasProviderFailure
      ? "The email provider is configured but is rejecting messages. Check the error below and the sending domain/API key in Resend."
      : counts.overdue > 0
      ? `${counts.overdue} message${counts.overdue === 1 ? "" : "s"} past the time they had to go out. A notice of entry or a rent increase in here has not given the notice it claims to.`
      : from && !String(from).includes("@")
      ? "FROM_EMAIL does not look like an address."
      : null,
  });
});

/** Workers AI binding plus the Supabase audit tables used by the public chat.
 * This does not call the model: a health-page refresh must not spend inference
 * quota or create a fake conversation. */
r.get("/ai-health", async (c) => {
  const configured = !!c.env.AI;
  const model = c.env.WORKERS_AI_MODEL ?? "@cf/zai-org/glm-4.7-flash";
  try {
    const [today] = await c.get("db")`
      SELECT COALESCE(SUM(request_count), 0)::int AS requests,
        COALESCE(SUM(error_count), 0)::int AS errors,
        COALESCE(SUM(request_count) FILTER (WHERE provider = 'workers_ai'), 0)::int
          AS model_requests,
        COALESCE(SUM(error_count) FILTER (WHERE provider = 'workers_ai'), 0)::int
          AS model_errors,
        COALESCE(SUM(request_count) FILTER (WHERE provider = 'database'), 0)::int
          AS database_answers,
        COALESCE(SUM(request_count) FILTER (WHERE provider = 'human'), 0)::int
          AS human_handoffs
      FROM ai_usage_daily WHERE usage_date = CURRENT_DATE`;
    return c.json({
      ok: configured,
      provider: "cloudflare_workers_ai",
      provider_configured: configured,
      model,
      audit_storage: true,
      today,
      note: configured
        ? "Live property questions use Supabase first; Workers AI handles only safe unmatched questions."
        : "No Workers AI binding named AI. Database answers still work; unmatched questions go to Confirmations.",
    });
  } catch (error) {
    return c.json({
      ok: false,
      provider: "cloudflare_workers_ai",
      provider_configured: configured,
      model,
      audit_storage: false,
      today: { requests:0, errors:0, model_requests:0, model_errors:0,
        database_answers:0, human_handoffs:0 },
      note: "Run worker/schema/019_workers_ai_cloud.sql in Supabase so AI decisions and usage can be recorded.",
      detail: error?.message,
    });
  }
});

export default r;
