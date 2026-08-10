import { Hono } from "hono";
import { hashPassword, verifyPassword, needsRehash, randToken, sha256 }
  from "../lib/crypto.js";
import { uid } from "../lib/auth.js";

/* ============================================================
   Sign in

   The first thing to port, because everything else needs a
   session. When this works, the database, the password hashing,
   KV and the routing all work — there is no way to sign in with
   any one of them broken.
   ============================================================ */

const r = new Hono();

const LOCK_AFTER = 5;
const LOCK_MINUTES = 15;
const SESSION_HOURS = 12;
const PASSWORD_MAX_AGE_DAYS = 182;
const PASSWORD_WARN_DAYS = 14;
const PASSWORD_HISTORY = 5;
const RESET_TTL_MINUTES = 30;

const addHours = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const addDays = (d) => new Date(Date.now() + d * 864e5).toISOString();
const daysUntil = (iso) => (iso ? Math.ceil((new Date(iso) - Date.now()) / 864e5) : null);

/* ---------- Sign in ---------- */

r.post("/public/auth/login", async (c) => {
  const sql = c.get("db");
  const { email, password } = await c.req.json().catch(() => ({}));
  if (!email || !password) return c.json({ code: "MISSING_CREDENTIALS" }, 400);

  const [u] = await sql`SELECT * FROM users
    WHERE lower(email) = ${String(email).trim().toLowerCase()}`;

  if (u?.locked_until && new Date(u.locked_until) > new Date())
    return c.json({ code: "ACCOUNT_LOCKED", locked_until: u.locked_until }, 423);

  let ok = false;
  let needsReset = false;
  if (u?.is_active && u.password_hash) {
    try {
      ok = await verifyPassword(password, u, sql);
    } catch (e) {
      // A hash made by the old container under Argon2id or scrypt. Neither can
      // be checked in this runtime, so say that rather than letting it read as
      // a wrong password — somebody would try the same password all afternoon.
      if (e.code === "PASSWORD_NEEDS_RESET") needsReset = true;
      else throw e;
    }
  }

  if (needsReset)
    return c.json({
      code: "PASSWORD_NEEDS_RESET",
      detail: "This password was set on the previous server and cannot be checked here. Use the reset link.",
    }, 409);

  if (!ok) {
    if (u) {
      await sql`UPDATE users
        SET failed_attempts = failed_attempts + 1,
            locked_until = CASE WHEN failed_attempts + 1 >= ${LOCK_AFTER}
              THEN now() + (${LOCK_MINUTES} * INTERVAL '1 minute')
              ELSE locked_until END
        WHERE id = ${u.id}`;
    }
    // The same message whether the account exists or the password was wrong.
    // Anything else turns the login into an account checker.
    return c.json({ code: "INVALID_CREDENTIALS" }, 401);
  }

  const token = randToken();
  const expires = addHours(Number(c.env.SESSION_HOURS) || SESSION_HOURS);

  await sql.begin(async (tx) => {
    await tx`INSERT INTO sessions (id, user_id, token_hash, expires_at, ip, user_agent)
      VALUES (${uid("ses_")}, ${u.id}, ${await sha256(token)}, ${expires},
              ${c.req.header("cf-connecting-ip") ?? null},
              ${(c.req.header("user-agent") ?? "").slice(0, 300)})`;
    await tx`UPDATE users SET failed_attempts = 0, locked_until = NULL,
      last_login_at = now() WHERE id = ${u.id}`;

    // The password was verified, so the plaintext is in hand. This is the one
    // moment it can be upgraded without asking anybody to do anything.
    if (needsRehash(u)) {
      const h = await hashPassword(password, tx);
      await tx`UPDATE users SET password_algo = ${h.algo}, password_salt = ${h.salt},
        password_hash = ${h.hash}, password_params = ${h.params} WHERE id = ${u.id}`;
    }
  });

  const perms = await sql`
    SELECT permission_code AS p FROM role_permissions WHERE role_code = ${u.role_code}`;

  const expired = u.password_expires_at && new Date(u.password_expires_at) < new Date();
  const left = daysUntil(u.password_expires_at);

  // Session cookie as well as the token. The cookie is what a browser sends
  // without the front end having to remember to; the token is for anything
  // that is not a browser.
  c.header("Set-Cookie",
    `baydo_session=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${
      (Number(c.env.SESSION_HOURS) || SESSION_HOURS) * 3600}${
      c.env.ENVIRONMENT === "production" ? "; Secure" : ""}`);

  return c.json({
    expires_at: expires,
    user: {
      id: u.id, email: u.email, phone: u.phone, name: u.full_name,
      role: u.role_code, locale: u.locale,
      permissions: perms.map((x) => x.p),
      // An expired password still signs in, but nothing works until it is
      // changed. Locking the account outright turns a routine expiry into a
      // Monday morning support call.
      must_change_password: !!u.must_change_password || !!expired,
      password_expired: !!expired,
      password_days_left: left,
      password_warning: left != null && left <= PASSWORD_WARN_DAYS && left > 0,
    },
  });
});

/* ---------- Who am I ---------- */

r.get("/auth/me", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ code: "NOT_AUTHENTICATED" }, 401);
  return c.json({ user: { ...user, perms: [...user.perms] } });
});

r.post("/auth/logout", async (c) => {
  const user = c.get("user");
  if (user)
    await c.get("db")`UPDATE sessions SET revoked_at = now() WHERE id = ${user.sessionId}`;
  c.header("Set-Cookie", "baydo_session=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0");
  return c.json({ ok: true });
});

/* Change a known password without sending email. The current session stays;
   every other session is revoked so a previously copied cookie stops working. */
r.post("/auth/change-password", async (c) => {
  const sql = c.get("db");
  const actor = c.get("user");
  const { current, password } = await c.req.json().catch(() => ({}));
  if (!current || !password) return c.json({ code: "MISSING_FIELDS" }, 400);
  const issues = passwordIssues(password);
  if (issues.length) return c.json({ code: "PASSWORD_TOO_WEAK", issues }, 400);

  const [u] = await sql`SELECT * FROM users WHERE id = ${actor.id}`;
  if (!u || !await verifyPassword(current, u, sql))
    return c.json({ code: "INVALID_CURRENT_PASSWORD" }, 401);

  const history = await sql`SELECT * FROM password_history WHERE user_id = ${u.id}
    ORDER BY changed_at DESC LIMIT ${PASSWORD_HISTORY}`;
  for (const old of [u, ...history.map((x) => ({
    password_hash: x.hash, password_salt: x.salt,
    password_algo: x.algo, password_params: x.params }))]) {
    try {
      if (await verifyPassword(password, old, sql))
        return c.json({ code: "PASSWORD_RECENTLY_USED", within: PASSWORD_HISTORY }, 400);
    } catch { /* an older unsupported hash cannot be compared */ }
  }

  const h = await hashPassword(password, sql);
  await sql.begin(async (tx) => {
    if (u.password_hash)
      await tx`INSERT INTO password_history (id, user_id, hash, salt, algo, params)
        VALUES (${uid("ph_")}, ${u.id}, ${u.password_hash}, ${u.password_salt},
                ${u.password_algo}, ${u.password_params ?? null})`;
    await tx`UPDATE users SET password_algo = ${h.algo}, password_salt = ${h.salt},
      password_hash = ${h.hash}, password_params = ${h.params},
      password_changed_at = now(), password_expires_at = ${addDays(PASSWORD_MAX_AGE_DAYS)},
      must_change_password = FALSE, failed_attempts = 0, locked_until = NULL
      WHERE id = ${u.id}`;
    await tx`UPDATE sessions SET revoked_at = now()
      WHERE user_id = ${u.id} AND id <> ${actor.sessionId} AND revoked_at IS NULL`;
  });
  return c.json({ ok: true, expires_at: addDays(PASSWORD_MAX_AGE_DAYS) });
});

/* ---------- Reset ---------- */

r.post("/public/auth/forgot", async (c) => {
  const sql = c.get("db");
  const { email } = await c.req.json().catch(() => ({}));
  const [u] = await sql`SELECT * FROM users
    WHERE lower(email) = ${String(email ?? "").trim().toLowerCase()} AND is_active`;

  if (u) {
    const raw = randToken();
    const hash = await sha256(raw);
    const link = `${c.env.PUBLIC_URL}/reset?token=${raw}`;

    // One transaction. A token in the table with no message queued leaves
    // somebody waiting for an email that was never going to arrive; a message
    // queued with no token gives them a link that does not work. Either half
    // alone is worse than neither.
    await sql.begin(async (tx) => {
      await tx`UPDATE password_reset_tokens SET used_at = now()
        WHERE user_id = ${u.id} AND used_at IS NULL`;
      await tx`INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
        VALUES (${uid("prt_")}, ${u.id}, ${hash},
                ${new Date(Date.now() + RESET_TTL_MINUTES * 60000).toISOString()})`;
      await tx`INSERT INTO outbox (id, channel, to_email, to_name, kind, subject, body,
        ref_type, ref_id, required_by)
        VALUES (${uid("ob_")}, 'email', ${u.email}, ${u.full_name},
                'password_reset', 'Reset your Baydo Pointe password',
                ${[`Hello ${u.full_name},`, "",
                   "Someone asked to reset the password on your Baydo Pointe account.",
                   `Open this link within ${RESET_TTL_MINUTES} minutes to set a new one:`,
                   "", link, "",
                   "If that was not you, nothing has changed and the link expires on its own.",
                  ].join("\n")},
                'user', ${u.id}, ${new Date(Date.now() + 5 * 60000).toISOString()})`;
    });
  }

  // Identical response whether or not the account exists.
  return c.json({ ok: true, code: "RESET_SENT_IF_EXISTS" });
});

r.post("/public/auth/reset", async (c) => {
  const sql = c.get("db");
  const { token, password } = await c.req.json().catch(() => ({}));
  if (!token || !password) return c.json({ code: "MISSING_FIELDS" }, 400);

  const issues = passwordIssues(password);
  if (issues.length) return c.json({ code: "PASSWORD_TOO_WEAK", issues }, 400);

  /*
   * This deliberately stays one database round trip. Although bcrypt itself
   * already runs inside PostgreSQL, the previous implementation made seven
   * separate queries around it. Serialising and parsing those queries was
   * enough Worker CPU to cross the Free-plan 10 ms request limit (1102).
   *
   * PostgreSQL data-modifying CTEs keep the claim, history entry, password
   * update and session revocation atomic while the Worker only submits and
   * reads one statement. Unsupported legacy hashes are not compared here;
   * the reset replaces them, as it did before.
   */
  const tokenHash = await sha256(token);
  const historyId = uid("ph_");
  const passwordParams = JSON.stringify({ cost: 12 });
  const passwordExpiresAt = addDays(PASSWORD_MAX_AGE_DAYS);
  const [result] = await sql`
    WITH token_row AS MATERIALIZED (
      SELECT p.id AS token_id, p.user_id, p.expires_at, p.used_at,
             u.password_hash AS old_hash, u.password_salt AS old_salt,
             u.password_algo AS old_algo, u.password_params AS old_params
      FROM password_reset_tokens p
      JOIN users u ON u.id = p.user_id
      WHERE p.token_hash = ${tokenHash}
      ORDER BY p.created_at DESC
      LIMIT 1
    ),
    recent AS MATERIALIZED (
      SELECT EXISTS (
        SELECT 1
        FROM (
          SELECT h.hash, h.algo
          FROM password_history h
          JOIN token_row t ON t.user_id = h.user_id
          ORDER BY h.changed_at DESC
          LIMIT ${PASSWORD_HISTORY}
        ) h
        WHERE h.algo = 'bcrypt-pgcrypto'
          AND extensions.crypt(${password}, h.hash) = h.hash
      ) AS reused
    ),
    new_hash AS MATERIALIZED (
      SELECT extensions.crypt(
        ${password}, extensions.gen_salt('bf', 12)
      ) AS hash
      FROM token_row t, recent r
      WHERE t.used_at IS NULL AND t.expires_at > now() AND NOT r.reused
    ),
    claimed AS (
      UPDATE password_reset_tokens p
      SET used_at = now()
      FROM token_row t, recent r
      WHERE p.id = t.token_id AND p.used_at IS NULL
        AND p.expires_at > now() AND NOT r.reused
      RETURNING p.user_id
    ),
    saved_history AS (
      INSERT INTO password_history (id, user_id, hash, salt, algo, params)
      SELECT ${historyId}, c.user_id, t.old_hash, COALESCE(t.old_salt, ''),
             t.old_algo, t.old_params
      FROM claimed c
      JOIN token_row t ON t.user_id = c.user_id
      WHERE t.old_hash IS NOT NULL
      RETURNING user_id
    ),
    updated_user AS (
      UPDATE users u
      SET password_algo = 'bcrypt-pgcrypto', password_salt = '',
          password_hash = n.hash, password_params = ${passwordParams},
          password_changed_at = now(), password_expires_at = ${passwordExpiresAt},
          must_change_password = FALSE, failed_attempts = 0, locked_until = NULL
      FROM claimed c, new_hash n
      WHERE u.id = c.user_id
      RETURNING u.id
    ),
    revoked AS (
      UPDATE sessions s
      SET revoked_at = now()
      FROM updated_user u
      WHERE s.user_id = u.id AND s.revoked_at IS NULL
      RETURNING s.id
    )
    SELECT CASE
      WHEN NOT EXISTS (SELECT 1 FROM token_row) THEN 'INVALID_TOKEN'
      WHEN (SELECT used_at IS NOT NULL FROM token_row) THEN 'INVALID_TOKEN'
      WHEN (SELECT expires_at <= now() FROM token_row) THEN 'TOKEN_EXPIRED'
      WHEN (SELECT reused FROM recent) THEN 'PASSWORD_RECENTLY_USED'
      WHEN EXISTS (SELECT 1 FROM updated_user) THEN 'OK'
      ELSE 'INVALID_OR_USED_TOKEN'
    END AS code`;

  if (result?.code === "INVALID_TOKEN")
    return c.json({ code: "INVALID_TOKEN" }, 400);
  if (result?.code === "TOKEN_EXPIRED")
    return c.json({ code: "TOKEN_EXPIRED" }, 410);
  if (result?.code === "PASSWORD_RECENTLY_USED")
    return c.json({ code: "PASSWORD_RECENTLY_USED", within: PASSWORD_HISTORY }, 400);
  if (result?.code !== "OK")
    return c.json({ code: "INVALID_OR_USED_TOKEN" }, 409);

  return c.json({ ok: true, expires_at: addDays(PASSWORD_MAX_AGE_DAYS) });
});

/** Length carries more than any composition rule. A twelve-character
 *  passphrase beats eight characters of punctuation somebody wrote on a note,
 *  which is what composition rules produce. */
function passwordIssues(pw) {
  const issues = [];
  if (!pw || pw.length < 12) issues.push("At least 12 characters.");
  if (/^\d+$/.test(pw ?? "")) issues.push("Not only numbers.");
  if (["password", "baydo", "pointe", "mizar", "clareview"]
      .some((w) => (pw ?? "").toLowerCase().includes(w)))
    issues.push("Nothing to do with the property or the word password.");
  return issues;
}

export default r;
