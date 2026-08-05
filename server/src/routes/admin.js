import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { db, uid, nowISO, hashPassword, passwordIssues, BACKUP_DIR, DATA_DIR } from "../db.js";
import { authenticate, require_, audit, ROLES, ROLE_PERMISSIONS, permissionsOf } from "../rbac.js";

const r = Router();
r.use(authenticate);

/* ================= Accounts ================= */

r.get("/users", require_("users.manage"), (req, res) => {
  res.json({
    users: db.prepare(`SELECT id, email, full_name, phone, role_code, locale, is_active,
      must_change_password, last_login_at, created_at FROM users ORDER BY created_at`).all(),
    roles: Object.entries(ROLES).map(([code, label]) => ({
      code, label, permissions: ROLE_PERMISSIONS[code] })),
  });
});

r.post("/users", require_("users.manage"), (req, res) => {
  const { email, full_name, role_code, password, phone, locale } = req.body ?? {};
  if (!email || !full_name || !role_code) return res.status(400).json({ code: "MISSING_USER_FIELDS" });
  // A phone is required, not optional. An account reachable on one channel is
  // an account that gets locked out the day that channel fails.
  if (!phone?.trim()) return res.status(400).json({ code: "PHONE_REQUIRED" });
  if (!ROLES[role_code]) return res.status(400).json({ code: "UNKNOWN_ROLE" });
  const issues = passwordIssues(password);
  if (issues.length) return res.status(400).json({ code: "WEAK_PASSWORD", issues });
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email))
    return res.status(409).json({ code: "EMAIL_TAKEN" });

  const h = hashPassword(password);
  const id = uid("usr_");
  db.prepare(`INSERT INTO users (id, email, full_name, phone, role_code, locale,
    password_algo, password_salt, password_hash) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, String(email).trim(), full_name, phone ?? null, role_code, locale ?? "en",
         h.algo, h.salt, h.hash);

  audit(req, { action: "user.create", entityType: "user", entityId: id,
               after: { email, full_name, role_code } });
  res.status(201).json({ id });
});

r.patch("/users/:id", require_("users.manage"), (req, res) => {
  const before = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!before) return res.status(404).json({ code: "USER_NOT_FOUND" });
  // Guard against locking the last Admin out of the system.
  if (before.id === req.user.id && (req.body?.role_code || req.body?.is_active === false))
    return res.status(409).json({ code: "CANNOT_MODIFY_SELF" });

  const { role_code, is_active, full_name, phone } = req.body ?? {};
  if (role_code && !ROLES[role_code]) return res.status(400).json({ code: "UNKNOWN_ROLE" });

  db.prepare(`UPDATE users SET role_code=COALESCE(?,role_code), is_active=COALESCE(?,is_active),
    full_name=COALESCE(?,full_name), phone=COALESCE(?,phone), updated_at=? WHERE id=?`)
    .run(role_code ?? null, is_active === undefined ? null : (is_active ? 1 : 0),
         full_name ?? null, phone ?? null, nowISO(), before.id);

  // Disabling or re-roling must invalidate existing sessions, or the old token
  // keeps the old permissions until it expires.
  if (is_active === false || role_code)
    db.prepare("UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL")
      .run(nowISO(), before.id);

  const after = db.prepare("SELECT * FROM users WHERE id = ?").get(before.id);
  audit(req, { action: "user.update", entityType: "user", entityId: before.id,
               before: { role: before.role_code, active: before.is_active },
               after: { role: after.role_code, active: after.is_active } });
  res.json({ user: { id: after.id, email: after.email, role_code: after.role_code,
                     is_active: after.is_active } });
});

r.get("/permissions", (req, res) => {
  res.json({ role: req.user.role, role_label: ROLES[req.user.role],
             permissions: permissionsOf(req.user.role) });
});

/* ================= Audit log (read only, no delete path) ================= */

/** Search across the log. Free text matches the action, the record, the person
 *  or anything inside the before and after values, which is where the useful
 *  detail usually is. */
function auditQuery({ q, from, to, action, entity_type, entity_id, actor, limit = 200 }) {
  const args = {};
  let sql = "SELECT * FROM audit_log WHERE 1=1";
  if (from)        { sql += " AND date(created_at) >= @from"; args.from = from; }
  if (to)          { sql += " AND date(created_at) <= @to"; args.to = to; }
  if (action)      { sql += " AND action LIKE @action"; args.action = `${action}%`; }
  if (entity_type) { sql += " AND entity_type = @entity_type"; args.entity_type = entity_type; }
  if (entity_id)   { sql += " AND entity_id = @entity_id"; args.entity_id = entity_id; }
  if (actor)       { sql += " AND (actor_user_id = @actor OR actor_name LIKE @actorLike)";
                     args.actor = actor; args.actorLike = `%${actor}%`; }
  if (q) {
    sql += ` AND (action LIKE @q OR entity_type LIKE @q OR entity_id LIKE @q
             OR actor_name LIKE @q OR before_value LIKE @q OR after_value LIKE @q
             OR ip LIKE @q)`;
    args.q = `%${q}%`;
  }
  sql += " ORDER BY id DESC LIMIT @limit";
  args.limit = Math.min(Number(limit) || 200, 20000);
  return db.prepare(sql).all(args);
}

r.get("/audit", require_("audit.view"), (req, res) => {
  const rows = auditQuery(req.query);
  const counts = db.prepare(`SELECT action, COUNT(*) n FROM audit_log
    GROUP BY action ORDER BY n DESC LIMIT 40`).all();
  const actors = db.prepare(`SELECT actor_name, COUNT(*) n FROM audit_log
    WHERE actor_name IS NOT NULL GROUP BY actor_name ORDER BY n DESC LIMIT 20`).all();
  const range = db.prepare(`SELECT MIN(date(created_at)) first, MAX(date(created_at)) last,
    COUNT(*) total FROM audit_log`).get();
  res.json({ entries: rows, count: rows.length, actions: counts, actors, range });
});

/** Export. The log is evidence, so taking a copy is itself an event: who took
 *  it, covering what, and a hash of exactly what they received. */
r.get("/audit/export", require_("audit.view"), (req, res) => {
  const format = (req.query.format ?? "csv").toLowerCase();
  const rows = auditQuery({ ...req.query, limit: req.query.limit ?? 20000 });

  let body, mime, ext;
  if (format === "json") {
    body = JSON.stringify(rows.map((e) => ({ ...e,
      before_value: e.before_value ? JSON.parse(e.before_value) : null,
      after_value: e.after_value ? JSON.parse(e.after_value) : null })), null, 2);
    mime = "application/json"; ext = "json";
  } else {
    const cell = (v) => {
      if (v == null) return "";
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = ["id", "created_at", "actor_name", "actor_user_id", "action",
                  "entity_type", "entity_id", "before_value", "after_value", "ip"];
    body = [head.join(","), ...rows.map((e) => head.map((h) => cell(e[h])).join(","))].join("\n");
    mime = "text/csv"; ext = "csv";
  }

  const sha = crypto.createHash("sha256").update(body).digest("hex");
  db.prepare(`INSERT INTO log_exports (id, from_date, to_date, query, format, row_count,
    sha256, exported_by, exported_name) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(uid("lx_"), req.query.from ?? null, req.query.to ?? null,
         JSON.stringify({ q: req.query.q ?? null, action: req.query.action ?? null,
                          actor: req.query.actor ?? null }),
         ext, rows.length, sha, req.user.id, req.user.name);
  audit(req, { action: "audit.export", entityType: "audit_log", entityId: null,
               after: { rows: rows.length, from: req.query.from, to: req.query.to,
                        format: ext, sha256: sha } });

  const name = `baydo-audit-${req.query.from ?? "start"}-to-${req.query.to ?? "now"}.${ext}`;
  res.setHeader("Content-Type", `${mime}; charset=utf-8`);
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.setHeader("X-Content-SHA256", sha);
  res.send(body);
});

r.get("/audit/exports", require_("audit.view"), (req, res) => {
  res.json({ exports: db.prepare("SELECT * FROM log_exports ORDER BY exported_at DESC LIMIT 100")
                        .all() });
});

/* ================= Backup and restore ================= */

export function makeBackup(reason = "auto", byName = "system") {
  const id = uid("bk_");
  const file = path.join(BACKUP_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
  // In WAL mode the -wal file must be folded back in first, or the copy is partial.
  db.pragma("wal_checkpoint(TRUNCATE)");
  fs.copyFileSync(path.join(DATA_DIR, "baydo.db"), file);
  const size = fs.statSync(file).size;
  db.prepare(`INSERT INTO backups (id, path, reason, size_bytes, by_name)
              VALUES (?,?,?,?,?)`).run(id, file, reason, size, byName);

  const old = db.prepare("SELECT * FROM backups ORDER BY created_at DESC LIMIT -1 OFFSET 48").all();
  for (const b of old) {
    try { fs.unlinkSync(b.path); } catch {}
    db.prepare("DELETE FROM backups WHERE id = ?").run(b.id);
  }
  return { id, path: file, size };
}

r.get("/backups", require_("backup.restore"), (req, res) => {
  res.json({ backups: db.prepare("SELECT * FROM backups ORDER BY created_at DESC").all() });
});

r.post("/backups", require_("backup.restore"), (req, res) => {
  const b = makeBackup("manual", req.user.name);
  audit(req, { action: "backup.create", entityType: "backup", entityId: b.id, after: { size: b.size } });
  res.status(201).json(b);
});

/**
 * Restore is deliberately two-phase: snapshot the current state, write a flag,
 * then require a restart. Overwriting the database file while connections are
 * open would leave in-flight transactions in an undefined state.
 */
r.post("/backups/:id/restore", require_("backup.restore"), (req, res) => {
  const b = db.prepare("SELECT * FROM backups WHERE id = ?").get(req.params.id);
  if (!b) return res.status(404).json({ code: "BACKUP_NOT_FOUND" });
  if (!fs.existsSync(b.path)) return res.status(410).json({ code: "BACKUP_FILE_MISSING" });

  const safety = makeBackup(`pre-restore snapshot (restoring ${b.created_at})`, req.user.name);
  fs.writeFileSync(path.join(DATA_DIR, "RESTORE_PENDING"),
    JSON.stringify({ from: b.path, requested_by: req.user.name, at: nowISO(),
                     safety_backup: safety.path }, null, 2));

  audit(req, { action: "backup.restore.request", entityType: "backup", entityId: b.id,
               after: { from: b.created_at, safety: safety.id } });

  res.json({ ok: true, restart_required: true, safety_backup: safety.id, code: "RESTORE_SCHEDULED" });
});

export default r;
