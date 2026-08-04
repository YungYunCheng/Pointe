import { db, uid, nowISO, addDays, daysBetween, prevBusinessDay } from "./db.js";
import { notify } from "./rbac.js";
import { makeBackup } from "./routes/admin.js";

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

export function startDailyJobs() {
  const run = () => {
    try {
      const a = scanRenewals(), b = scanReminders(), c = scanRefundDeadlines();
      console.log(`[jobs] renewals ${a} / reminders ${b} / refunds ${c} @ ${nowISO()}`);
    } catch (e) { console.error("[jobs] failed:", e.message); }
  };
  run();
  setInterval(run, 6 * HOUR);
}
