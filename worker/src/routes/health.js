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

export default r;
