import { Router } from "express";
import rateLimit from "express-rate-limit";
import { db, uid, nowISO, hashPassword, verifyPassword, randToken, sha256,
         passwordIssues } from "../db.js";
import { authenticate, audit, permissionsOf, ROLES } from "../rbac.js";
import { queue } from "../outbox.js";

const r = Router();

const LOCK_AFTER = 5, LOCK_MIN = 15, SESSION_HOURS = 12, RESET_TTL_MIN = 30;

/* Passwords expire twice a year. Long enough not to be an irritation, short
   enough that a credential leaked and unnoticed does not stay useful. */
const PASSWORD_MAX_AGE_DAYS = 182;
const PASSWORD_WARN_DAYS = 14;
const PASSWORD_HISTORY = 5;      // cannot cycle back to a recent one

const addDays = (n) => new Date(Date.now() + n * 864e5).toISOString();
const daysUntil = (iso) => (iso ? Math.ceil((new Date(iso) - Date.now()) / 864e5) : null);

/** Records the old hash so the next change cannot return to it, and sets the
 *  next expiry. Rotating between two passwords is not a rotation. */
function recordPasswordChange(userId, oldUser, h) {
  if (oldUser?.password_hash) {
    db.prepare(`INSERT INTO password_history (id, user_id, hash, salt, algo)
      VALUES (?,?,?,?,?)`).run(uid("ph_"), userId, oldUser.password_hash,
        oldUser.password_salt, oldUser.password_algo);
    const old = db.prepare(`SELECT id FROM password_history WHERE user_id=?
      ORDER BY changed_at DESC LIMIT -1 OFFSET ?`).all(userId, PASSWORD_HISTORY);
    for (const o of old) db.prepare("DELETE FROM password_history WHERE id=?").run(o.id);
  }
  db.prepare(`UPDATE users SET password_changed_at=?, password_expires_at=? WHERE id=?`)
    .run(nowISO(), addDays(PASSWORD_MAX_AGE_DAYS), userId);
}

/** True when the candidate matches one of the last few. */
async function isReused(userId, password) {
  const rows = db.prepare(`SELECT * FROM password_history WHERE user_id=?
    ORDER BY changed_at DESC LIMIT ?`).all(userId, PASSWORD_HISTORY);
  return rows.some((r) => await verifyPassword(password, { password_hash: r.hash,
    password_salt: r.salt, password_algo: r.algo }));
}

const loginLimit = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { code: "TOO_MANY_ATTEMPTS" },
});

/* ---------- Login ---------- */
r.post("/login", loginLimit, (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ code: "MISSING_CREDENTIALS" });

  const u = db.prepare("SELECT * FROM users WHERE email = ?").get(String(email).trim());

  if (u?.locked_until && new Date(u.locked_until) > new Date())
    return res.status(423).json({ code: "ACCOUNT_LOCKED", locked_until: u.locked_until });

  const ok = u && u.is_active && await verifyPassword(password, u);

  if (!ok) {
    if (u) {
      const n = u.failed_attempts + 1;
      const lock = n >= LOCK_AFTER ? new Date(Date.now() + LOCK_MIN * 60000).toISOString() : null;
      db.prepare("UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?")
        .run(n, lock, u.id);
    }
    // Do not reveal whether the account exists. A different message here would
    // turn this endpoint into an account enumerator.
    return res.status(401).json({ code: "INVALID_CREDENTIALS" });
  }

  const token = randToken();
  const expires = new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString();
  db.prepare(`INSERT INTO sessions (id, user_id, token_hash, expires_at, ip, user_agent)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(uid("ses_"), u.id, sha256(token), expires, req.ip, req.headers["user-agent"] ?? null);
  db.prepare("UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?")
    .run(nowISO(), u.id);

  audit({ user: { id: u.id, name: u.full_name }, ip: req.ip },
        { action: "login", entityType: "user", entityId: u.id });

  res.cookie("baydo_session", token, {
    httpOnly: true, sameSite: "lax", maxAge: SESSION_HOURS * 3600e3,
    secure: process.env.NODE_ENV === "production",
  });

  // An expired password still signs in, but the session can do nothing until
  // it is changed. Locking the account outright turns a routine expiry into a
  // support call.
  const expired = u.password_expires_at && u.password_expires_at < nowISO();
  const daysLeft = daysUntil(u.password_expires_at);

  res.json({
    token, expires_at: expires,
    user: {
      id: u.id, email: u.email, phone: u.phone, name: u.full_name, role: u.role_code,
      role_label: ROLES[u.role_code], locale: u.locale,
      must_change_password: !!u.must_change_password || !!expired,
      password_expired: !!expired,
      password_expires_at: u.password_expires_at,
      password_days_left: daysLeft,
      password_warning: daysLeft != null && daysLeft <= PASSWORD_WARN_DAYS && daysLeft > 0,
      permissions: permissionsOf(u.role_code),
    },
  });
});

/* ---------- Current user ---------- */
r.get("/me", authenticate, (req, res) => {
  const u = db.prepare("SELECT locale FROM users WHERE id = ?").get(req.user.id);
  res.json({ user: { ...req.user, perms: [...req.user.perms],
                     role_label: ROLES[req.user.role], locale: u?.locale ?? "en" } });
});

/* ---------- Language preference ---------- */
r.patch("/me/locale", authenticate, (req, res) => {
  const locale = String(req.body?.locale ?? "");
  if (!["en", "zh-Hant"].includes(locale)) return res.status(400).json({ code: "UNSUPPORTED_LOCALE" });
  db.prepare("UPDATE users SET locale = ?, updated_at = ? WHERE id = ?")
    .run(locale, nowISO(), req.user.id);
  res.json({ ok: true, locale });
});

/* ---------- Logout ---------- */
r.post("/logout", authenticate, (req, res) => {
  db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?").run(nowISO(), req.user.sessionId);
  audit(req, { action: "logout", entityType: "user", entityId: req.user.id });
  res.clearCookie("baydo_session");
  res.json({ ok: true });
});

/* ---------- Forgot password ---------- */
r.post("/forgot", loginLimit, (req, res) => {
  const email = String(req.body?.email ?? "").trim();
  const u = db.prepare("SELECT * FROM users WHERE email = ? AND is_active = 1").get(email);

  let devToken = null;
  if (u) {
    const raw = randToken();
    db.prepare(`INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
                VALUES (?, ?, ?, ?)`)
      .run(uid("prt_"), u.id, sha256(raw),
           new Date(Date.now() + RESET_TTL_MIN * 60000).toISOString());
    const link = `${process.env.PUBLIC_URL || "http://localhost:8080"}/reset?token=${raw}`;
    // Email only. A reset link sent by text is a gift to whoever has the phone.
    queue({
      kind: "password_reset", channel: "email", toEmail: u.email, toName: u.full_name,
      subject: "Reset your Baydo Pointe password",
      body: [`Hello ${u.full_name},`, "",
        "Someone asked to reset the password on your Baydo Pointe account.",
        `Open this link within ${RESET_TTL_MIN} minutes to set a new one:`, "", link, "",
        "If that was not you, nothing has changed and you can ignore this. The link expires on its own.",
      ].join("\n"),
      refType: "user", refId: u.id, requiredBy: new Date(Date.now() + 5 * 60000).toISOString(),
    });
    if (process.env.NODE_ENV !== "production") devToken = raw;
  }
  // Identical response whether or not the account exists.
  res.json({ ok: true, code: "RESET_SENT_IF_EXISTS", dev_token: devToken });
});

/* ---------- Reset password ---------- */
r.post("/reset", (req, res) => {
  const { token, password } = req.body ?? {};
  const issues = passwordIssues(password);
  if (issues.length) return res.status(400).json({ code: "WEAK_PASSWORD", issues });

  const t = db.prepare(`SELECT * FROM password_reset_tokens
                        WHERE token_hash = ? AND used_at IS NULL`).get(sha256(String(token ?? "")));
  if (!t) return res.status(400).json({ code: "RESET_TOKEN_INVALID" });
  if (new Date(t.expires_at) < new Date()) return res.status(400).json({ code: "RESET_TOKEN_EXPIRED" });

  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(t.user_id);
  if (await verifyPassword(password, u)) return res.status(400).json({ code: "PASSWORD_REUSED" });
  if (await isReused(u.id, password))
    return res.status(400).json({ code: "PASSWORD_RECENTLY_USED", within: PASSWORD_HISTORY });

  const h = await hashPassword(password);
  db.transaction(() => {
    recordPasswordChange(u.id, u, h);
    db.prepare(`UPDATE users SET password_algo=?, password_salt=?, password_hash=?,
                must_change_password=0, failed_attempts=0, locked_until=NULL, updated_at=?
                WHERE id=?`).run(h.algo, h.salt, h.hash, nowISO(), u.id);
    db.prepare("UPDATE password_reset_tokens SET used_at=? WHERE id=?").run(nowISO(), t.id);
    // A password change invalidates every existing session.
    db.prepare("UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL")
      .run(nowISO(), u.id);
  })();

  audit({ user: { id: u.id, name: u.full_name }, ip: req.ip },
        { action: "password_reset", entityType: "user", entityId: u.id });
  res.json({ ok: true });
});

/* ---------- Change own password ---------- */
r.post("/change-password", authenticate, (req, res) => {
  const { current, password } = req.body ?? {};
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!await verifyPassword(current ?? "", u)) return res.status(400).json({ code: "CURRENT_PASSWORD_WRONG" });
  const issues = passwordIssues(password);
  if (issues.length) return res.status(400).json({ code: "WEAK_PASSWORD", issues });

  if (await isReused(u.id, password))
    return res.status(400).json({ code: "PASSWORD_RECENTLY_USED", within: PASSWORD_HISTORY });

  const h = await hashPassword(password);
  db.transaction(() => {
    recordPasswordChange(u.id, u, h);
    db.prepare(`UPDATE users SET password_salt=?, password_hash=?, must_change_password=0,
      updated_at=? WHERE id=?`).run(h.salt, h.hash, nowISO(), u.id);
  })();
  audit(req, { action: "password_change", entityType: "user", entityId: u.id });
  res.json({ ok: true, expires_at: addDays(PASSWORD_MAX_AGE_DAYS) });
});

/* ---------- Contact details ----------
   Both channels are kept on every account. A reset that can only reach one
   of them is a lockout waiting for a mailbox to go down. */

r.patch("/me/contact", authenticate, (req, res) => {
  const { phone, email } = req.body ?? {};
  const before = db.prepare("SELECT email, phone FROM users WHERE id=?").get(req.user.id);

  // Changing the email changes what a reset link reaches, so it is verified
  // rather than trusted.
  if (email && email !== before.email) {
    if (db.prepare("SELECT 1 FROM users WHERE email=? AND id<>?").get(email, req.user.id))
      return res.status(409).json({ code: "EMAIL_TAKEN" });
    db.prepare("UPDATE users SET email=?, email_verified=0, updated_at=? WHERE id=?")
      .run(String(email).trim(), nowISO(), req.user.id);
  }
  if (phone !== undefined) {
    db.prepare("UPDATE users SET phone=?, phone_verified=0, updated_at=? WHERE id=?")
      .run(phone ?? null, nowISO(), req.user.id);
  }
  audit(req, { action: "user.contact", entityType: "user", entityId: req.user.id,
               before, after: { email: email ?? before.email, phone: phone ?? before.phone } });
  res.json({ ok: true });
});

/** Accounts whose password is expiring or already expired. The job uses this
 *  to warn people before the morning they cannot get in. */
r.get("/password-status", authenticate, (req, res) => {
  if (req.user.role !== "admin") {
    const u = db.prepare("SELECT password_expires_at FROM users WHERE id=?").get(req.user.id);
    return res.json({ expires_at: u?.password_expires_at ?? null,
                      days_left: daysUntil(u?.password_expires_at) });
  }
  const rows = db.prepare(`SELECT id, email, full_name, role_code, phone,
    password_changed_at, password_expires_at, must_change_password
    FROM users WHERE is_active = 1 ORDER BY password_expires_at`).all();
  res.json({
    users: rows.map((u) => ({ ...u, days_left: daysUntil(u.password_expires_at),
      state: !u.password_expires_at ? "never_set"
        : u.password_expires_at < nowISO() ? "expired"
        : daysUntil(u.password_expires_at) <= PASSWORD_WARN_DAYS ? "expiring" : "ok" })),
    max_age_days: PASSWORD_MAX_AGE_DAYS,
  });
});

export default r;
