import { Hono } from "hono";
import { connect, closeAll } from "./lib/db.js";
import { runDailyJobs, runHourlyJobs, runMorningMoveJobs } from "./lib/jobs.js";
import { require_, tenantUnit, mustBeTheirs, audit } from "./lib/auth.js";
import health from "./routes/health.js";
import auth from "./routes/auth.js";
import core from "./routes/core.js";
import tenant from "./routes/tenant.js";
import signup from "./routes/signup.js";
import renewals from "./routes/renewals.js";
import increases from "./routes/increases.js";
import leases from "./routes/leases.js";
import payments from "./routes/payments.js";
import operations from "./routes/operations.js";
import ai from "./routes/ai.js";
import accounting from "./routes/accounting.js";
import accountingWorkspace from "./routes/accounting-workspace.js";
import messages from "./routes/messages.js";
import notifications from "./routes/notifications.js";
import website from "./routes/website.js";
import moveBookings from "./routes/move-bookings.js";

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

/* API responses carry the browser protections here so a newly added route
   cannot forget them. Cloudflare may add more at the edge; these are the
   application minimums. */
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  const successful = c.res.status >= 200 && c.res.status < 300;
  if (successful && c.req.path.startsWith("/api/public/site-images/"))
    c.header("Cache-Control", "public, max-age=86400");
  else if (successful && c.req.path.startsWith("/api/public/floorplan-images/"))
    c.header("Cache-Control", "public, max-age=60");
  else if (successful && c.req.path === "/api/public/site-content")
    c.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
  else c.header("Cache-Control", "no-store");
});

/* Cookie-authenticated writes must come from one of our own front ends.
   SameSite is useful, but it is not the whole CSRF boundary when two sites
   share a parent domain. Requests with no Origin are kept for cron/CLI API
   clients that authenticate with an Authorization header. */
app.use("/api/*", async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const origin = c.req.header("origin");
    const allowed = new Set([c.env.PUBLIC_URL, c.env.PUBLIC_TENANT_URL].filter(Boolean));
    if (origin && !allowed.has(origin)) return c.json({ code: "ORIGIN_NOT_ALLOWED" }, 403);
    const bearerClient = (c.req.header("authorization") ?? "")
      .toLowerCase().startsWith("bearer ");
    const cookieClient = /(?:^|;\s*)baydo_(?:tenant_)?session=/
      .test(c.req.header("cookie") ?? "");
    if (!origin && cookieClient && !bearerClient)
      return c.json({ code: "ORIGIN_REQUIRED" }, 403);

    const length = Number(c.req.header("content-length") ?? 0);
    const accountingFile = /^\/api\/accounting\/(?:documents\/[^/]+\/[^/]+\/upload|captures)$/.test(c.req.path);
    const websiteImage = c.req.path === "/api/admin/site-images";
    const floorplanImage = /^\/api\/unit-types\/[^/]+\/floorplan-image$/.test(c.req.path);
    // Multipart framing adds a little overhead around the 10 MB file itself.
    const limit = accountingFile || websiteImage || floorplanImage ? 11 * 1024 * 1024 : 1_048_576;
    if (length > limit) return c.json({ code: "PAYLOAD_TOO_LARGE", max_bytes: limit }, 413);
  }
  return next();
});

/* One connection per request. A Worker has no process to hold a pool in,
   which is what Hyperdrive is for — it pools on Cloudflare's side. */
app.use("/api/*", async (c, next) => {
  // The liveness check deliberately does not need a database binding.
  if (c.req.path === "/api/health") return next();
  // Reject an unauthenticated private request before opening Postgres. Public
  // routes and requests carrying a credential still need the database.
  const publicRoute = c.req.path.startsWith("/api/public/");
  const authHeader = c.req.header("authorization") ?? "";
  const cookies = c.req.header("cookie") ?? "";
  const hasCredential = authHeader.toLowerCase().startsWith("bearer ") ||
    /(?:^|;\s*)baydo_(?:tenant_)?session=/.test(cookies);
  if (!publicRoute && !hasCredential) return next();
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

  // Signing in is how a session is obtained, so it cannot require one. It
  // lives under /api/public/auth/ for exactly that reason rather than being
  // an exception listed here — an exception list is a thing that grows.

  if (path.startsWith(PUBLIC_PREFIX)) {
    // Public images are immutable/cacheable R2 assets, not database browse
    // requests. Counting every hero, gallery and floor-plan image against the
    // same 60-request allowance makes ordinary refreshes exhaust the page's
    // budget and causes the UI to fall back to its default artwork.
    const publicImage = c.req.method === "GET" &&
      (path.startsWith("/api/public/site-images/") ||
       path.startsWith("/api/public/floorplan-images/"));
    if (publicImage) return next();

    // Rate limited by address, in the bucket that matches what the call
    // costs. The alternative to a limit is an account wall in front of "how
    // much is the rent", or an open bill.
    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    const bucket = bucketFor(path, c.req.method);
    if (!await withinRate(c.env, ip, bucket))
      return c.json({
        code: "RATE_LIMITED",
        // Says which limit, so somebody hitting the browse limit is not left
        // wondering whether their password is wrong.
        detail: bucket === "auth"
          ? "Too many sign-in attempts from this address. Try again in a few minutes."
          : "Too many requests. Try again shortly.",
      }, 429);
    return next();
  }

  const token = bearer(c, path.startsWith(TENANT_PREFIX) ? "tenant" : "staff");
  if (!token) return c.json({ code: "NOT_AUTHENTICATED" }, 401);

  if (path.startsWith(TENANT_PREFIX)) {
    const tenant = await tenantSession(c, token);
    if (!tenant) return c.json({ code: "SESSION_INVALID" }, 401);

    // A tenant route must not take a unit from the caller. If one ever does,
    // this refuses it here rather than trusting every route to check — the
    // check that has to be remembered is the check that gets forgotten.
    const claimed = c.req.query("unit") ?? c.req.param?.("unit");
    if (claimed && claimed !== tenant.unit)
      return c.json({ code: "NOT_FOUND" }, 404);

    c.set("tenant", tenant);
    return next();
  }

  // A tenant token is not accepted here even when valid. The two stores are
  // separate so a mistake in one cannot produce access to the other.
  const user = await staffSession(c, token);
  if (!user) return c.json({ code: "SESSION_INVALID" }, 401);
  if (user.mustChangePassword && !path.startsWith("/api/auth/"))
    return c.json({ code: "PASSWORD_CHANGE_REQUIRED" }, 403);
  c.set("user", user);
  return next();
});

/* ---------- Sessions ---------- */

const bearer = (c, kind) => {
  const h = c.req.header("authorization") ?? "";
  if (h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  const cookie = kind === "tenant" ? "baydo_tenant_session" : "baydo_session";
  const escaped = cookie.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (c.req.header("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]+)`))?.[1] ?? null;
};

async function staffSession(c, token) {
  const sql = c.get("db");
  const hash = await sha256(token);
  const [row] = await sql`
    SELECT s.id AS session_id, s.expires_at, u.id, u.email, u.full_name,
           u.role_code, u.is_active, u.must_change_password, u.password_expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${hash} AND s.revoked_at IS NULL`;
  if (!row || !row.is_active) return null;
  if (new Date(row.expires_at) < new Date()) return null;

  // Permissions are read on every request rather than carried in the token,
  // so a role change takes effect now instead of when the session expires.
  const perms = row.role_code === "admin"
    ? await sql`SELECT code AS p FROM permissions`
    : await sql`
      SELECT permission_code AS p FROM role_permissions WHERE role_code = ${row.role_code}
      UNION
      SELECT permission AS p FROM user_permissions
        WHERE user_id = ${row.id} AND effect = 'grant'
          AND (expires_at IS NULL OR expires_at > now())
      EXCEPT
      SELECT permission AS p FROM user_permissions
        WHERE user_id = ${row.id} AND effect = 'revoke'
          AND (expires_at IS NULL OR expires_at > now())`;

  const passwordExpired = row.password_expires_at && new Date(row.password_expires_at) < new Date();
  return { id: row.id, email: row.email, name: row.full_name, role: row.role_code,
           perms: new Set(perms.map((x) => x.p)), sessionId: row.session_id,
           mustChangePassword: !!row.must_change_password || !!passwordExpired,
           passwordExpiresAt: row.password_expires_at ?? null };
}

async function tenantSession(c, token) {
  const hash = await sha256(token);
  const [row] = await c.get("db")`
    SELECT s.id AS session_id, s.expires_at, a.id, a.email, a.phone, a.full_name,
           a.unit_number, a.lease_id, a.locale, a.is_active
    FROM tenant_sessions s JOIN tenant_accounts a ON a.id = s.account_id
    WHERE s.token_hash = ${hash} AND s.revoked_at IS NULL`;
  if (!row || !row.is_active) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  return { id: row.id, email: row.email, phone:row.phone, name: row.full_name, unit: row.unit_number,
           leaseId: row.lease_id, locale: row.locale, sessionId: row.session_id };
}




/* ---------- Rate limiting ----------

   Separate buckets, because the limits are protecting different things.

   Browsing costs money — every availability call is a database query, and a
   loop can spend a month of budget in an afternoon. Sixty in fifteen minutes
   is generous for a person and useless for a script.

   Password attempts cost an account. Ten in fifteen minutes across every
   account from one address, on top of the five-attempt lock on each account,
   so somebody working through a list of emails runs out of address before
   they run out of guesses.

   Sharing one bucket would mean a busy public page consuming the login
   allowance, and a locked-out tenant would look identical to an attack.

   KV is eventually consistent, so a limit is briefly generous across edges.
   That is fine here: this stops loops and lists, not a determined attacker
   with a botnet. */
const RATE_BUCKETS = {
  browse: { limit: 60, window: 900 },
  auth:   { limit: 10, window: 900 },
  write:  { limit: 30, window: 900 },
};

function bucketFor(path, method) {
  if (path.includes("/auth/") ||
      /\/public\/(?:tenant\/(?:login|forgot|reset)|signup|verify)/.test(path))
    return "auth";
  if (method !== "GET") return "write";
  return "browse";
}

async function withinRate(env, ip, bucket = "browse") {
  if (!env.SESSIONS) return true;
  const { limit, window } = RATE_BUCKETS[bucket] ?? RATE_BUCKETS.browse;
  const key = `rate:${bucket}:${ip}`;
  const current = Number((await env.SESSIONS.get(key)) ?? 0);
  if (current >= limit) return false;
  await env.SESSIONS.put(key, String(current + 1), { expirationTtl: window });
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
app.route("/api", auth);
app.route("/api", core);
app.route("/api", accounting);
app.route("/api", accountingWorkspace);
app.route("/api", tenant);
app.route("/api", signup);
app.route("/api", renewals);
app.route("/api", increases);
app.route("/api", leases);
app.route("/api", payments);
app.route("/api", operations);
app.route("/api", messages);
app.route("/api", notifications);
app.route("/api", ai);
app.route("/api", website);
app.route("/api", moveBookings);

/* Re-exported so a route can import either from here or from lib/auth.js.
   The definitions live in lib so nothing imports the app. */
export { require_, tenantUnit, mustBeTheirs, audit };

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
    const at = new Date(event.scheduledTime);
    const daily = at.getUTCHours() === 7 && at.getUTCMinutes() === 0;
    const morningMoves = at.getUTCHours() === 14 && at.getUTCMinutes() === 0;
    const job = daily ? runDailyJobs(sql, env)
      : morningMoves ? runMorningMoveJobs(sql, env) : runHourlyJobs(sql, env);
    ctx.waitUntil(job.finally(() => sql.end({ timeout: 5 }).catch(() => {})));
  },
};
