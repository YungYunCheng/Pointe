import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
export const DATA_DIR = path.join(ROOT, "data");
export const UPLOAD_DIR = path.join(DATA_DIR, "evidence");
export const BACKUP_DIR = path.join(DATA_DIR, "backups");

for (const d of [DATA_DIR, UPLOAD_DIR, BACKUP_DIR]) fs.mkdirSync(d, { recursive: true });

export const db = new Database(path.join(DATA_DIR, "baydo.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
db.exec(fs.readFileSync(path.join(__dirname, "schema-accounting.sql"), "utf8"));
db.exec(fs.readFileSync(path.join(__dirname, "schema-ops.sql"), "utf8"));
db.exec(fs.readFileSync(path.join(__dirname, "schema-crm.sql"), "utf8"));
db.exec(fs.readFileSync(path.join(__dirname, "schema-agreements.sql"), "utf8"));
db.exec(fs.readFileSync(path.join(__dirname, "schema-ops2.sql"), "utf8"));
db.exec(fs.readFileSync(path.join(__dirname, "schema-signing.sql"), "utf8"));
db.exec(fs.readFileSync(path.join(__dirname, "schema-fees.sql"), "utf8"));
db.exec(fs.readFileSync(path.join(__dirname, "schema-remuneration.sql"), "utf8"));
db.exec(fs.readFileSync(path.join(__dirname, "schema-proposals.sql"), "utf8"));
db.exec(fs.readFileSync(path.join(__dirname, "schema-arrears.sql"), "utf8"));

/** SQLite has no ADD COLUMN IF NOT EXISTS, so columns added after the first
 *  release go through here. Startup must be repeatable: a schema step that
 *  throws on the second run turns every restart into a manual job. */
function addColumn(table, column, definition) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
for (const t of ["ap_invoices", "ar_receipts", "ar_charges"])
  addColumn(t, "version", "INTEGER NOT NULL DEFAULT 1");

// Every account carries a phone as well as an email: a password reset that can
// only reach one channel is a lockout waiting for a mailbox to go down.
addColumn("users", "password_changed_at", "TEXT");
addColumn("users", "password_expires_at", "TEXT");
addColumn("users", "phone_verified", "INTEGER NOT NULL DEFAULT 0");
addColumn("users", "email_verified", "INTEGER NOT NULL DEFAULT 0");
addColumn("contacts", "normalised_email", "TEXT");
addColumn("contacts", "normalised_phone", "TEXT");

/** Money rounds to cents at every boundary. Left as raw floats, a rent run
 *  across 330 units drifts by a few cents a month and the bank never matches. */
export const cents = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export const uid = (p = "") => p + crypto.randomBytes(9).toString("base64url");
export const nowISO = () => new Date().toISOString();

/**
 * Transaction that takes the write lock immediately.
 * SQLite's IMMEDIATE serves the same purpose as Postgres SELECT ... FOR UPDATE:
 * when two requests arrive together, the second waits for the first to commit,
 * so it never reads a stale value.
 */
export function txn(fn) {
  const wrapped = db.transaction(fn);
  return (...args) => wrapped.immediate(...args);
}

/* ---------- Passwords and tokens ---------- */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

/* Password hashing lives in crypto.js: Argon2id where the native module is
   available, scrypt otherwise, with the algorithm stored alongside the hash so
   a switch does not invalidate anyone's password. */
export { hashPassword, verifyPassword, needsRehash, randToken, sha256, fileHash }
  from "./crypto.js";



/* ---------- Business day helpers (used by reminders) ---------- */
const holidaySet = () =>
  new Set(db.prepare("SELECT holiday_date FROM holidays WHERE is_observed = 1").all()
            .map((r) => r.holiday_date));

/** Previous business day. Monday resolves to Friday; observed holidays are skipped. */
export function prevBusinessDay(dateStr) {
  const hol = holidaySet();
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() - 1);
  for (let i = 0; i < 30; i++) {
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6 && !hol.has(iso)) return iso;
    d.setDate(d.getDate() - 1);
  }
  return d.toISOString().slice(0, 10);
}

export const addDays = (dateStr, n) => {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
export const daysBetween = (a, b) =>
  Math.round((new Date(b + "T12:00:00") - new Date(a + "T12:00:00")) / 864e5);
