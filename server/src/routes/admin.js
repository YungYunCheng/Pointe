import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
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

r.get("/audit", require_("audit.view"), (req, res) => {
  const { entity_type, entity_id, actor, limit = 200 } = req.query;
  let sql = "SELECT * FROM audit_log WHERE 1=1", args = [];
  if (entity_type) { sql += " AND entity_type = ?"; args.push(entity_type); }
  if (entity_id)   { sql += " AND entity_id = ?";   args.push(entity_id); }
  if (actor)       { sql += " AND actor_user_id = ?"; args.push(actor); }
  sql += " ORDER BY id DESC LIMIT ?"; args.push(Math.min(Number(limit) || 200, 1000));
  res.json({ entries: db.prepare(sql).all(...args) });
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
