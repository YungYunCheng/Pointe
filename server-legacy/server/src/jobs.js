import fs from "node:fs";
import { db, uid, nowISO, addDays, daysBetween, prevBusinessDay } from "./db.js";
import { notify } from "./rbac.js";
import { makeBackup } from "./routes/admin.js";
import { drainOutbox, overdueMessages, queue } from "./outbox.js";
import { run as runRetention } from "./retention.js";

const HOUR = 3600e3;
const RENEWAL_LEAD_DAYS = 30;

/* ---------- Hourly backup, only when something changed ---------- */
let lastAuditId = 0;
export function startBackupJob() {
  lastAuditId = db.prepare("SELECT COALESCE(MAX(id),0) AS m FROM audit_log").get().m;
  setInterval(() => {
    const cur = db.prepare("SELECT COALESCE(MAX(id),0) AS m FROM audit_log").get().m;
    if (cur === lastAuditId) return;      // nothing happened this hour, skip the snapshot
    lastAuditId = cur;
    try {
      const b = makeBackup("hourly");
      console.log(`[backup] ${b.path} (${(b.size / 1024).toFixed(0)} KB)`);
    } catch (e) { console.error("[backup] failed:", e.message); }
  }, HOUR);
}

/* ---------- Renewals: raise a task 30 days before expiry ---------- */
export function scanRenewals() {
  const today = new Date().toISOString().slice(0, 10);
  const target = addDays(today, RENEWAL_LEAD_DAYS);

  const due = db.prepare(`
    SELECT l.* FROM leases l
    WHERE l.status='active' AND l.end_date IS NOT NULL
      AND l.end_date <= ? AND l.end_date >= ?
      AND NOT EXISTS (SELECT 1 FROM renewal_tasks rt
                      WHERE rt.lease_id = l.id AND rt.state <> 'cancelled')
  `).all(target, today);

  for (const l of due) {
    const since = l.last_increase_at ?? l.start_date;
    const daysSince = daysBetween(since, today);
    const canRaise = daysSince >= 365;
    const code = canRaise
      ? (l.term_type === "periodic" ? "INCREASE_PERIODIC_NOTICE" : "INCREASE_AT_NEW_TERM")
      : "INCREASE_TOO_SOON";
    const params = canRaise ? { months: 3 } : { days: daysSince };

    const id = uid("rn_");
    db.prepare(`INSERT INTO renewal_tasks (id, lease_id, unit_number, end_date,
      current_rent, increase_ok, increase_code, increase_params) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, l.id, l.unit_number, l.end_date, l.rent, canRaise ? 1 : 0, code,
           JSON.stringify(params));

    const p = { unit: l.unit_number, end_date: l.end_date,
                days: daysBetween(today, l.end_date), increase_code: code, ...params };
    notify("property_manager", "renewal", "LEASE_EXPIRING", p, `/renewals/${id}`);
    notify("admin", "renewal", "LEASE_EXPIRING", p, `/renewals/${id}`);
    console.log(`[renewal] ${l.unit_number} -> ${id}`);
  }
  return due.length;
}

/* ---------- Reminders on the previous business day ---------- */
export function scanReminders() {
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = db.prepare(`SELECT * FROM events
    WHERE state='booked' AND date(starts_at) >= ?`).all(today);

  let sent = 0;
  for (const e of upcoming) {
    const day = e.starts_at.slice(0, 10);
    if (prevBusinessDay(day) !== today) continue;
    const exists = db.prepare(`SELECT 1 FROM notifications
      WHERE kind='reminder' AND link=? AND date(created_at)=?`).get(`/events/${e.id}`, today);
    if (exists) continue;

    notify(e.assignee_id ?? "building_manager", "reminder", "EVENT_REMINDER",
           { type: e.type, unit: e.unit_number, at: e.starts_at,
             days: daysBetween(today, day) }, `/events/${e.id}`);
    sent++;
  }
  return sent;
}

/* ---------- Deposit refund deadlines ---------- */
export function scanRefundDeadlines() {
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT * FROM moveouts
    WHERE state='open' AND refund_deadline IS NOT NULL`).all();
  let n = 0;
  for (const m of rows) {
    const done = db.prepare(`SELECT 1 FROM moveout_steps
      WHERE moveout_id=? AND step='refunded'`).get(m.id);
    if (done) continue;
    const left = daysBetween(today, m.refund_deadline);
    if (left > 3) continue;
    const exists = db.prepare(`SELECT 1 FROM notifications
      WHERE kind='refund' AND link=? AND date(created_at)=?`).get(`/moveouts/${m.id}`, today);
    if (exists) continue;
    const p = { unit: m.unit_number, deadline: m.refund_deadline, days: left };
    notify("property_manager", "refund", "REFUND_DEADLINE", p, `/moveouts/${m.id}`);
    notify("admin", "refund", "REFUND_DEADLINE", p, `/moveouts/${m.id}`);
    n++;
  }
  return n;
}

/** Warns before the morning somebody cannot get in. An expiry that arrives
 *  unannounced is a support call; two weeks of notice is a nuisance nobody
 *  minds. */
export function passwordExpiryWarnings() {
  const soon = new Date(Date.now() + 14 * 864e5).toISOString();
  const rows = db.prepare(`SELECT id, email, full_name, password_expires_at FROM users
    WHERE is_active = 1 AND password_expires_at IS NOT NULL
      AND password_expires_at <= ? AND password_expires_at > datetime('now')`).all(soon);

  let sent = 0;
  for (const u of rows) {
    const exists = db.prepare(`SELECT 1 FROM outbox WHERE kind='password_expiry'
      AND ref_id=? AND date(created_at) > date('now','-7 day')`).get(u.id);
    if (exists) continue;
    const days = Math.ceil((new Date(u.password_expires_at) - Date.now()) / 864e5);
    queue({ kind: "password_expiry", channel: "email", toEmail: u.email, toName: u.full_name,
      subject: `Your Baydo Pointe password expires in ${days} days`,
      body: [`Hello ${u.full_name},`, "",
        `Your password expires in ${days} days. Change it from your account settings before then.`,
        "", "If it expires you can still sign in, but nothing will work until you set a new one.",
      ].join("\n"),
      refType: "user", refId: u.id });
    sent++;
  }

  const expired = db.prepare(`SELECT COUNT(*) n FROM users WHERE is_active=1
    AND password_expires_at IS NOT NULL AND password_expires_at < datetime('now')`).get().n;
  if (expired > 0) notify("admin", "security", "PASSWORDS_EXPIRED", { count: expired },
                          "/admin/users");
  return sent;
}

/** The queue growing is the thing to notice. A notice of entry that never
 *  left is worse than one sent late, because nobody knows. */
export function outboxHealth() {
  const overdue = overdueMessages();
  if (!overdue.length) return 0;
  const exists = db.prepare(`SELECT 1 FROM notifications WHERE kind='outbox'
    AND date(created_at)=date('now')`).get();
  if (exists) return overdue.length;
  notify("admin", "outbox", "MESSAGES_OVERDUE",
         { count: overdue.length, oldest: overdue[0]?.required_by }, "/admin/outbox");
  return overdue.length;
}

/* ---------- Audit retention ----------

   Two different things with two different rules.

   Snapshots are for rolling back a mistake, and a month is long enough
   for a mistake to surface. They are large, so keeping them forever
   trades real storage for a case that does not arise.

   Audit entries are the record of who did what. They are small, and the
   reason they exist is precisely that somebody will ask in two years.
   Nothing prunes them.
*/
const SNAPSHOT_RETENTION_DAYS = 31;

export function pruneSnapshots() {
  const cutoff = new Date(Date.now() - SNAPSHOT_RETENTION_DAYS * 864e5).toISOString();
  const old = db.prepare(`SELECT * FROM backups WHERE created_at < ?
    ORDER BY created_at`).all(cutoff);
  if (!old.length) return 0;

  // The most recent is always kept, even if it is older than the window.
  // A gap with nothing to restore from is worse than one stale file.
  const newest = db.prepare("SELECT id FROM backups ORDER BY created_at DESC LIMIT 1").get();
  let removed = 0;
  for (const b of old) {
    if (b.id === newest?.id) continue;
    try { if (b.file_path && fs.existsSync(b.file_path)) fs.unlinkSync(b.file_path); }
    catch (e) { console.error("[retention] could not remove", b.file_path, e.message); }
    db.prepare("DELETE FROM backups WHERE id=?").run(b.id);
    removed++;
  }
  if (removed) {
    // Pruning is itself a change to the record and belongs in it.
    db.prepare(`INSERT INTO audit_log (actor_name, action, entity_type, after_value)
      VALUES ('system','backup.prune','backup',?)`)
      .run(JSON.stringify({ removed, older_than_days: SNAPSHOT_RETENTION_DAYS }));
    console.log(`[retention] pruned ${removed} snapshot(s) older than ${SNAPSHOT_RETENTION_DAYS} days`);
  }
  return removed;
}

/** Audit entries are never pruned. This reports the size so it is a decision
 *  somebody makes rather than something that happens. */
export function auditSize() {
  const r = db.prepare(`SELECT COUNT(*) n, MIN(date(created_at)) first,
    MAX(date(created_at)) last FROM audit_log`).get();
  const unattributed = db.prepare(`SELECT COUNT(*) n FROM audit_log
    WHERE actor_name IS NULL AND actor_user_id IS NULL`).get().n;
  // An entry with no actor cannot answer the question the log exists for.
  if (unattributed > 0)
    console.warn(`[audit] ${unattributed} entries have no actor recorded`);
  return { ...r, unattributed };
}

/** Retention runs weekly rather than daily. A policy that fires every night
 *  is a policy nobody watches; once a week it is still timely and somebody
 *  notices the log entry. */
export function weeklyRetention() {
  if (new Date().getDay() !== 0) return null;      // Sundays
  const done = db.prepare(`SELECT 1 FROM audit_log WHERE action='retention.run'
    AND date(created_at) = date('now')`).get();
  if (done) return null;
  return runRetention({ actor: "system" });
}

export function startDailyJobs() {
  const run = () => {
    try {
      const a = scanRenewals(), b = scanReminders(), c = scanRefundDeadlines();
      const d = passwordExpiryWarnings();
      const e = outboxHealth();
      const p = pruneSnapshots();
      auditSize();
      weeklyRetention();
      drainOutbox(100).catch((err) => console.error("[outbox]", err.message));
      console.log(`[jobs] renewals ${a} / reminders ${b} / refunds ${c} / pw ${d} / overdue ${e} / pruned ${p} @ ${nowISO()}`);
    } catch (e) { console.error("[jobs] failed:", e.message); }
  };
  run();
  setInterval(run, 6 * HOUR);
}
