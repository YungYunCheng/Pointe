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

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return { algo: "scrypt", salt: salt.toString("base64"), hash: hash.toString("base64") };
}

export function verifyPassword(password, user) {
  try {
    const salt = Buffer.from(user.password_salt, "base64");
    const expected = Buffer.from(user.password_hash, "base64");
    const actual = crypto.scryptSync(password, salt, expected.length, SCRYPT);
    return crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

export const randToken = () => crypto.randomBytes(32).toString("base64url");
export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("base64");
export const fileHash = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/* ---------- Password policy ---------- */
export function passwordIssues(pw) {
  const out = [];
  if (!pw || pw.length < 10) out.push("MIN_LENGTH_10");
  if (!/[a-z]/.test(pw)) out.push("NEEDS_LOWERCASE");
  if (!/[A-Z]/.test(pw)) out.push("NEEDS_UPPERCASE");
  if (!/\d/.test(pw)) out.push("NEEDS_DIGIT");
  if (!/[^A-Za-z0-9]/.test(pw)) out.push("NEEDS_SYMBOL");
  return out;
}

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
