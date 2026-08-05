import { db, sha256, nowISO, uid } from "./db.js";

/* ============================================================
   Permission matrix — the single source of truth for access control.
   Hiding menus in the UI is cosmetic; this is what actually blocks.
   ============================================================ */

export const ROLES = {
  admin:            "Admin",
  property_manager: "Property Manager",
  building_manager: "Building Manager",
  accounting:       "Accounting",
};

export const PERMISSIONS = {
  // Settings: Admin only
  "settings.pricing.edit":  "Edit pricing and fee settings",
  "settings.parking.quota": "Edit parking stall quotas",
  "templates.manage":       "Upload and approve document templates",
  "users.manage":           "Manage accounts and roles",
  "audit.view":             "View the audit log",
  "backup.restore":         "Create backups and restore",
  "process.delete":         "Delete or roll back workflows",

  // All roles
  "units.view":         "View units, vacancy and resulting rent",
  "parking.view":       "View parking quotas and waitlist",
  "parking.allocate":   "Allocate and promote parking stalls",
  "schedule.view":      "View schedule and task lists",
  "leads.view":         "Browse leads",
  "notifications.view": "View notifications",
  "evidence.upload":    "Upload evidence files",
  "units.status.edit":  "Change unit status",

  // Building Manager
  "leads.manage":       "Own leads and showing schedule",
  "showings.manage":    "Book and confirm showings",
  "maintenance.manage": "Maintenance tickets",
  "entrynotice.manage": "Notices of entry",
  "keys.manage":        "Key handover",

  // Accounting
  "accounting.view":     "View ledgers, invoices and reports",
  "accounting.post":     "Post journal entries, charges and receipts",
  "accounting.ap":       "Vendor invoices and payments",
  "accounting.ar":       "Rent charges and receipts",
  "accounting.bank":     "Upload statements and reconcile",
  "accounting.close":    "Reconcile and close a period",
  "accounting.coa":      "Edit the chart of accounts",
  "accounting.reports":  "Generate and approve monthly reports",

  // Property Manager
  "inbox.manage":      "AI inbox",
  "lease.sign":        "Signing and unit locks",
  "documents.approve": "Approve and release documents",
  "moveout.process":   "Move-out workflow",
  "renewals.decide":   "Renewal decisions",
};

const COMMON = ["units.view", "parking.view", "parking.allocate", "schedule.view",
                "leads.view", "notifications.view", "evidence.upload", "units.status.edit"];

export const ROLE_PERMISSIONS = {
  // Admin holds every permission
  admin: Object.keys(PERMISSIONS),

  property_manager: [
    ...COMMON,
    "inbox.manage", "lease.sign", "documents.approve", "moveout.process", "renewals.decide",
    "accounting.view",     // read only: arrears matter to leasing, posting does not
  ],

  building_manager: [
    ...COMMON,
    "leads.manage", "showings.manage", "maintenance.manage", "entrynotice.manage", "keys.manage",
  ],

  // Accounting sees the money and the units it belongs to, and nothing about
  // who the tenants are. Names appear on a receipt because they have to; leads,
  // applications and messages do not concern this role.
  accounting: [
    "units.view", "parking.view", "schedule.view", "notifications.view", "evidence.upload",
    "accounting.view", "accounting.post", "accounting.ap", "accounting.ar",
    "accounting.bank", "accounting.close", "accounting.coa", "accounting.reports",
  ],
};

export function syncRbac() {
  const ins = db.prepare("INSERT OR IGNORE INTO roles (code, name) VALUES (?, ?)");
  for (const [c, n] of Object.entries(ROLES)) ins.run(c, n);
  const insP = db.prepare("INSERT OR IGNORE INTO permissions (code, description) VALUES (?, ?)");
  for (const [c, d] of Object.entries(PERMISSIONS)) insP.run(c, d);
  db.prepare("DELETE FROM role_permissions").run();
  const insRP = db.prepare("INSERT INTO role_permissions (role_code, permission_code) VALUES (?, ?)");
  for (const [role, perms] of Object.entries(ROLE_PERMISSIONS))
    for (const p of perms) insRP.run(role, p);
}

export function permissionsOf(roleCode) {
  return db.prepare("SELECT permission_code FROM role_permissions WHERE role_code = ?")
           .all(roleCode).map((r) => r.permission_code);
}

/* ---------- Authentication ---------- */
export function authenticate(req, res, next) {
  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const token = bearer || req.cookies?.baydo_session;
  if (!token) return res.status(401).json({ code: "NOT_AUTHENTICATED" });

  const row = db.prepare(`
    SELECT s.id AS sid, s.expires_at, u.*
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL
  `).get(sha256(token));

  if (!row) return res.status(401).json({ code: "SESSION_INVALID" });
  if (new Date(row.expires_at) < new Date()) return res.status(401).json({ code: "SESSION_EXPIRED" });
  if (!row.is_active) return res.status(403).json({ code: "ACCOUNT_DISABLED" });

  req.user = {
    id: row.id, email: row.email, name: row.full_name, role: row.role_code,
    sessionId: row.sid, mustChange: !!row.must_change_password,
    perms: new Set(permissionsOf(row.role_code)),
  };
  next();
}

/** Every route declares what it needs. Anything undeclared is denied. */
export function require_(...needed) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ code: "NOT_AUTHENTICATED" });
    const missing = needed.filter((p) => !req.user.perms.has(p));
    if (missing.length)
      return res.status(403).json({ code: "FORBIDDEN", missing, role: req.user.role });
    next();
  };
}

/* ---------- Audit ---------- */
const insAudit = db.prepare(`
  INSERT INTO audit_log (actor_user_id, actor_name, action, entity_type, entity_id,
                         before_value, after_value, ip)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

export function audit(req, { action, entityType, entityId, before, after }) {
  insAudit.run(
    req.user?.id ?? null,
    req.user?.name ?? "system",
    action, entityType, entityId ?? null,
    before === undefined ? null : JSON.stringify(scrub(before)),
    after === undefined ? null : JSON.stringify(scrub(after)),
    req.ip ?? null
  );
}

/** Secrets never enter the audit log. Protected-characteristic content is
 *  referenced by rule id only and is never copied here. */
export const SENSITIVE_KEYS = ["password_hash", "password_salt", "token_hash"];
export function scrub(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj))
    out[k] = SENSITIVE_KEYS.includes(k) ? "***" : (v && typeof v === "object" ? scrub(v) : v);
  return out;
}

/**
 * Notifications carry message codes, not prose. The client renders them in the
 * user's chosen language, so the same record reads correctly for everyone.
 */
export function notify(audience, kind, code, params = {}, link = null) {
  db.prepare(`INSERT INTO notifications (id, audience, kind, code, params, link)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(uid("nt_"), audience, kind, code, JSON.stringify(params), link);
}

export { nowISO };
