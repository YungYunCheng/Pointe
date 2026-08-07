import { Hono } from "hono";
import { connect, closeAll } from "./lib/db.js";
import { runDailyJobs, runHourlyJobs } from "./lib/jobs.js";
import health from "./routes/health.js";

/* ============================================================
   Baydo Pointe — one API on Cloudflare Workers

   Two front ends, one backend. The same Worker answers on both
   hostnames, which is what removes CORS: each site calls /api on
   its own domain and neither request is cross-origin.

   With one program, the line between public and staff is a route
   prefix rather than a deployment boundary. That line is only as
   good as the one place it is enforced, so it is enforced in one
   place:

       /api/public/*   no session, anyone
       /api/tenant/*   a tenant session
       everything else a staff session

   Deny by default. A route added without thinking about auth ends
   up behind a staff session, which is the safe direction to be
   wrong in. Listing what needs protecting instead fails open the
   day somebody forgets a line.
   ============================================================ */

const app = new Hono();

/* One connection per request. A Worker has no process to hold a pool in,
   which is what Hyperdrive is for — it pools on Cloudflare's side. */
app.use("/api/*", async (c, next) => {
  c.set("db", connect(c.env));
  try {
    await next();
  } finally {
    // Not awaited. Holding the response to tidy up costs the caller latency
    // for something they get nothing from.
    c.executionCtx?.waitUntil?.(closeAll(c));
  }
});

/* ---------- The line ---------- */

const PUBLIC_PREFIX = "/api/public/";
const TENANT_PREFIX = "/api/tenant/";

app.use("/api/*", async (c, next) => {
  const path = c.req.path;

  // Open, so a monitor does not need a credential.
  if (path === "/api/health") return next();

  if (path.startsWith(PUBLIC_PREFIX)) {
    // Rate limited by address. The alternative is an account wall in front of
    // "how much is the rent", or an open bill.
    const ok = await withinRate(c.env, c.req.header("cf-connecting-ip") ?? "unknown");
    if (!ok) return c.json({ code: "RATE_LIMITED" }, 429);
    return next();
  }

  const token = bearer(c);
  if (!token) return c.json({ code: "NOT_AUTHENTICATED" }, 401);

  if (path.startsWith(TENANT_PREFIX)) {
    const tenant = await tenantSession(c, token);
    if (!tenant) return c.json({ code: "SESSION_INVALID" }, 401);
    c.set("tenant", tenant);
    return next();
  }

  // A tenant token is not accepted here even when valid. The two stores are
  // separate so a mistake in one cannot produce access to the other.
  const user = await staffSession(c, token);
  if (!user) return c.json({ code: "SESSION_INVALID" }, 401);
  c.set("user", user);
  return next();
});

/* ---------- Sessions ---------- */

const bearer = (c) => {
  const h = c.req.header("authorization") ?? "";
  if (h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  return (c.req.header("cookie") ?? "").match(/baydo_session=([^;]+)/)?.[1] ?? null;
};

async function staffSession(c, token) {
  const sql = c.get("db");
  const hash = await sha256(token);
  const [row] = await sql`
    SELECT s.id AS session_id, s.expires_at, u.id, u.email, u.full_name,
           u.role_code, u.is_active
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${hash} AND s.revoked_at IS NULL`;
  if (!row || !row.is_active) return null;
  if (new Date(row.expires_at) < new Date()) return null;

  // Permissions are read on every request rather than carried in the token,
  // so a role change takes effect now instead of when the session expires.
  const perms = await sql`
    SELECT permission_code AS p FROM role_permissions WHERE role_code = ${row.role_code}
    UNION
    SELECT permission AS p FROM user_permissions
      WHERE user_id = ${row.id} AND effect = 'grant'
        AND (expires_at IS NULL OR expires_at > now())
    EXCEPT
    SELECT permission AS p FROM user_permissions
      WHERE user_id = ${row.id} AND effect = 'revoke'
        AND (expires_at IS NULL OR expires_at > now())`;

  return { id: row.id, email: row.email, name: row.full_name, role: row.role_code,
           perms: new Set(perms.map((x) => x.p)), sessionId: row.session_id };
}

async function tenantSession(c, token) {
  const hash = await sha256(token);
  const [row] = await c.get("db")`
    SELECT s.id AS session_id, s.expires_at, a.id, a.email, a.full_name,
           a.unit_number, a.lease_id, a.locale, a.is_active
    FROM tenant_sessions s JOIN tenant_accounts a ON a.id = s.account_id
    WHERE s.token_hash = ${hash} AND s.revoked_at IS NULL`;
  if (!row || !row.is_active) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  return { id: row.id, email: row.email, name: row.full_name, unit: row.unit_number,
           leaseId: row.lease_id, locale: row.locale, sessionId: row.session_id };
}

/** Every staff route declares what it needs, so "who can do this" is answered
 *  in the route rather than in a document that drifts. */
export const require_ = (permission) => async (c, next) => {
  const user = c.get("user");
  if (!user?.perms?.has(permission))
    return c.json({ code: "FORBIDDEN", needs: permission }, 403);
  return next();
};

/** Only a tenant's own unit. Without this a tenant session could read any
   suite by changing a number in the URL, which is the classic version of
   this mistake. */
export const ownUnit = (c, unit) => {
  const t = c.get("tenant");
  if (!t || t.unit !== unit)
    throw Object.assign(new Error("NOT_YOUR_UNIT"), { status: 403, code: "NOT_YOUR_UNIT" });
  return true;
};

/* KV is eventually consistent, so a limit is briefly generous across edges.
   That is fine: this stops a loop spending a month's budget in an afternoon,
   not a determined attacker. */
async function withinRate(env, ip, limit = 60, windowSeconds = 900) {
  if (!env.SESSIONS) return true;
  const key = `rate:${ip}`;
  const current = Number((await env.SESSIONS.get(key)) ?? 0);
  if (current >= limit) return false;
  await env.SESSIONS.put(key, String(current + 1), { expirationTtl: windowSeconds });
  return true;
}

async function sha256(s) {
  const bits = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------- Errors ---------- */

app.onError((err, c) => {
  console.error("[error]", c.req.path, err?.message);
  const status = err?.status ?? 500;
  // A stack trace on a public endpoint is a map. This says what happened for
  // the caller, not how the query was built.
  return c.json({
    code: err?.code ?? (status === 500 ? "INTERNAL_ERROR" : "REQUEST_FAILED"),
    detail: status === 500 ? undefined : err?.message,
  }, status);
});

app.notFound((c) => c.json({ code: "NOT_FOUND", path: c.req.path }, 404));

/* ---------- Routes ---------- */

app.get("/", (c) => c.json({
  service: "Baydo Pointe API",
  runtime: "Cloudflare Workers",
  note: "Both front ends call this on their own hostname, so nothing here is cross-origin.",
}));

app.route("/api", health);

/* Ported routes go here. Order is in docs/CLOUDFLARE.zh-Hant.md — auth first,
   because everything else needs a session.

   Public routes go under /api/public/, tenant routes under /api/tenant/.
   That prefix is the whole boundary now, so which one a route belongs in is
   worth being deliberate about. */
// app.route("/api", auth);
// app.route("/api", core);
// app.route("/api", accounting);
// app.route("/api", tenant);

export default {
  fetch: app.fetch,

  /**
   * Cron. What ran on setInterval in the container.
   *
   * Triggers fire in UTC and Alberta observes daylight saving, so the jobs
   * work out the local date themselves rather than trusting the hour. A rent
   * run on the wrong side of midnight bills the wrong month, silently.
   */
  async scheduled(event, env, ctx) {
    const sql = connect(env);
    const hour = new Date(event.scheduledTime).getUTCHours();
    if (hour === 7) ctx.waitUntil(runDailyJobs(sql, env));
    else ctx.waitUntil(runHourlyJobs(sql, env));
  },
};
