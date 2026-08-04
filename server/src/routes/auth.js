import { Router } from "express";
import rateLimit from "express-rate-limit";
import { db, uid, nowISO, hashPassword, verifyPassword, randToken, sha256,
         passwordIssues } from "../db.js";
import { authenticate, audit, permissionsOf, ROLES } from "../rbac.js";

const r = Router();

const LOCK_AFTER = 5, LOCK_MIN = 15, SESSION_HOURS = 12, RESET_TTL_MIN = 30;

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

  const ok = u && u.is_active && verifyPassword(password, u);

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

  res.json({
    token, expires_at: expires,
    user: {
      id: u.id, email: u.email, name: u.full_name, role: u.role_code,
      role_label: ROLES[u.role_code], locale: u.locale,
      must_change_password: !!u.must_change_password,
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
    // TODO: wire up an email provider. Returned in dev so the flow is testable.
    if (process.env.NODE_ENV !== "production") devToken = raw;
    else console.log(`[reset] sending reset link to ${email}`);
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
  if (verifyPassword(password, u)) return res.status(400).json({ code: "PASSWORD_REUSED" });

  const h = hashPassword(password);
  db.transaction(() => {
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
  if (!verifyPassword(current ?? "", u)) return res.status(400).json({ code: "CURRENT_PASSWORD_WRONG" });
  const issues = passwordIssues(password);
  if (issues.length) return res.status(400).json({ code: "WEAK_PASSWORD", issues });

  const h = hashPassword(password);
  db.prepare(`UPDATE users SET password_salt=?, password_hash=?, must_change_password=0, updated_at=?
              WHERE id=?`).run(h.salt, h.hash, nowISO(), u.id);
  audit(req, { action: "password_change", entityType: "user", entityId: u.id });
  res.json({ ok: true });
});

export default r;
