import { db, nowISO } from "./db.js";
import { notify } from "./rbac.js";
import { runRent, periodFigures, figuresMethod } from "./routes/accounting.js";

const HOUR = 3600e3;

/* ============================================================
   Accounting jobs

   The rent run is the one that has to be right. It is idempotent —
   the unique index on (schedule, period) means running it twice adds
   nothing — so a retry after a crash is safe rather than a disaster
   involving 330 double charges.
   ============================================================ */

const period = (d = new Date()) => d.toISOString().slice(0, 7);
const today = () => new Date().toISOString().slice(0, 10);

/** Runs daily. Schedules with today's charge_day get billed, so a landlord
 *  can have some units bill on the 1st and others on the 15th without any
 *  of it being manual. */
export function dailyRentRun() {
  const day = new Date().getDate();
  if (day > 28) return { skipped: "charge days are capped at 28" };

  const due = db.prepare(`SELECT COUNT(*) n FROM charge_schedules
    WHERE is_active = 1 AND charge_day = ?`).get(day).n;
  if (due === 0) return { day, due: 0 };

  const p = period();
  const out = runRent(p, null);
  if (out.created > 0) {
    notify("accounting", "accounting", "RENT_RUN_COMPLETE",
           { period: p, count: out.created, total: out.total }, "/accounting/ar");
    console.log(`[rent] ${p} day ${day}: ${out.created} charges, ${out.total}`);
  }
  return { day, ...out };
}

/** Leases end. Their charge schedules should end with them, or a tenant who
 *  moved out in March is still being billed in June and nobody notices until
 *  the arrears report looks wrong. */
export function closeExpiredSchedules() {
  const rows = db.prepare(`
    SELECT cs.id, cs.unit_number, l.end_date
    FROM charge_schedules cs
    JOIN leases l ON l.id = cs.lease_id
    WHERE cs.is_active = 1 AND cs.end_date IS NULL
      AND l.end_date IS NOT NULL AND l.status IN ('ended','terminated')
  `).all();

  for (const r of rows) {
    db.prepare("UPDATE charge_schedules SET end_date = ?, is_active = 0 WHERE id = ?")
      .run(r.end_date, r.id);
  }
  if (rows.length)
    console.log(`[rent] closed ${rows.length} schedules for ended leases`);
  return rows.length;
}

/** Arrears notice to accounting, once a day, not once per overdue charge. */
export function arrearsSummary() {
  const a = db.prepare(`SELECT SUM(amount - paid_amount) t, COUNT(*) n,
    COUNT(DISTINCT unit_number) units FROM ar_charges
    WHERE state IN ('open','partial') AND due_date < date('now')`).get();
  if (!a?.n) return 0;

  const exists = db.prepare(`SELECT 1 FROM notifications
    WHERE kind='arrears' AND date(created_at)=date('now')`).get();
  if (exists) return 0;

  notify("accounting", "arrears", "ARREARS_SUMMARY",
         { count: a.n, units: a.units, total: Math.round(a.t * 100) / 100 }, "/accounting/ar");
  return a.n;
}

/** Prompts the close. Nothing closes itself: a period is reconciled by a
 *  person who has agreed the bank, and only then can a report be generated. */
export function monthEndPrompt() {
  const d = new Date();
  if (d.getDate() !== 1) return null;

  const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1).toISOString().slice(0, 7);
  const per = db.prepare("SELECT * FROM accounting_periods WHERE period=?").get(prev);
  if (per?.state === "closed") return null;

  const exists = db.prepare(`SELECT 1 FROM notifications
    WHERE kind='month_end' AND link LIKE ?`).get(`%${prev}%`);
  if (exists) return null;

  db.prepare(`INSERT OR IGNORE INTO accounting_periods (period, state) VALUES (?, 'open')`).run(prev);

  const f = periodFigures(prev, null);
  notify("accounting", "month_end", "MONTH_END_DUE",
         { period: prev, revenue: f.revenue_total, expenses: f.expense_total,
           noi: f.net_operating_income },
         `/accounting/banking?period=${prev}`);
  console.log(`[accounting] month end prompt for ${prev}`);
  return prev;
}

/* ---------- AI narrative for a monthly report ----------
   The figures are computed in SQL and passed in. The model is told, in
   the prompt, not to recalculate anything: its job is to say what the
   numbers show. A report that quietly disagrees with the ledger is
   worse than no report.                                              */

export function narrativePrompt(figures, method, buildingName) {
  return `You write the commentary on a monthly property report for ${buildingName}, a residential rental building in Edmonton, Alberta.

The figures below were computed from posted, reconciled ledger entries. They are final.

FIGURES
${JSON.stringify(figures, null, 2)}

HOW EACH FIGURE WAS DERIVED
${method}

Rules:
1. Never recalculate, adjust or round anything. Quote the figures exactly as given.
2. Never introduce a number that is not in the figures above.
3. Say what the numbers show and what is worth attention. Do not speculate about causes you cannot see in the data.
4. If arrears or occupancy moved in a direction worth noticing, say so plainly.
5. No recommendations about rent levels or about individual tenants.
6. Four short paragraphs at most. Plain English, no jargon, no bullet points.
7. End with one sentence naming the single thing most worth looking at next month.

Write the commentary only. No heading, no preamble, no markdown.`;
}

export function startAccountingJobs() {
  const run = () => {
    try {
      closeExpiredSchedules();
      const rent = dailyRentRun();
      arrearsSummary();
      monthEndPrompt();
      checkInterestRate();
      if (rent?.created) console.log(`[accounting] jobs ok @ ${nowISO()}`);
    } catch (e) {
      console.error("[accounting] jobs failed:", e.message);
    }
  };
  run();
  setInterval(run, 6 * HOUR);
}

/* ============================================================
   AI-assisted accounting
   ============================================================ */

/** The deposit interest rate is published annually by Alberta. Getting it
 *  wrong makes every refund wrong, and nobody finds out until a tenant
 *  leaves — so this proposes with a source and a person confirms. The model
 *  is told to say it does not know rather than produce a plausible number,
 *  because a plausible number is exactly the failure that would not be
 *  caught here. */
export function interestRatePrompt(year) {
  return `You are helping a residential property manager in Alberta, Canada find the security deposit interest rate for ${year}.

Under the Residential Tenancies Act, a landlord holding a security deposit must pay interest at the rate prescribed by the Security Deposit Interest Rate Regulation. The rate is set annually.

Report what the rate is for ${year}, and where that comes from.

Rules:
1. If you are not certain of the figure for ${year}, say so. Set confidence to "unverified" and explain what should be checked. A confident wrong rate here makes every deposit refund wrong, and it will not be noticed until a tenant moves out.
2. Do not interpolate from other years or estimate. Either you know the published figure or you do not.
3. Give the rate as a decimal: 0.02 for 2%, 0.0 for zero.
4. Note that this rate has been set at zero for a long stretch of recent years. If that is what you find, say so plainly rather than treating zero as an error.
5. Name the source a person can check — the regulation, or the Service Alberta page.

Reply with JSON only, no markdown:
{"year":${year},"rate":0.0,"confidence":"high|low|unverified","source_text":"what the source says","source_url":"where to verify","reasoning":"one or two sentences, including what a person should confirm"}`;
}

/** Turns an audit row into a sentence. The computed diff is the record; this
 *  is so that reading a month of changes does not mean reading JSON. */
export function changeNarrativePrompt(entry) {
  return `Describe one accounting change in a single plain sentence, for a change log a bookkeeper will read.

CHANGE
Action: ${entry.action}
Record: ${entry.entity_type} ${entry.entity_id ?? ""}
By: ${entry.actor_name ?? "system"} at ${entry.created_at}
Before: ${entry.before_value ?? "(nothing)"}
After: ${entry.after_value ?? "(nothing)"}

Rules:
1. State what changed and by how much. Use the exact figures given.
2. Never introduce a number that is not above.
3. If a reason was recorded, include it. If not, do not invent one.
4. One sentence. No preamble, no interpretation of whether it was correct.

Example of the register: "Invoice 4471 from Northgate Plumbing amended from $682.50 to $745.00 and moved from repairs to elevator maintenance, because the original was coded to the wrong account."

Write the sentence only.`;
}

/** Runs after the close, once the numbers are final. Narratives are written
 *  for amendments first: those are the changes someone will ask about. */
export function pendingNarratives(limit = 20) {
  return db.prepare(`SELECT a.* FROM amendments a
    WHERE a.narrative IS NULL ORDER BY a.amended_at DESC LIMIT ?`).all(limit);
}

/** Flags a rate that has not been set for the current year. Without it the
 *  accrual silently does nothing and every refund is short. */
export function checkInterestRate() {
  const year = new Date().getFullYear();
  const rate = db.prepare("SELECT * FROM deposit_interest_rates WHERE year=?").get(year);
  const pending = db.prepare(`SELECT 1 FROM interest_rate_proposals
    WHERE year=? AND state='proposed'`).get(year);
  if (rate && rate.source && !/placeholder/i.test(rate.source)) return null;
  if (pending) return null;

  const exists = db.prepare(`SELECT 1 FROM notifications
    WHERE kind='interest_rate' AND date(created_at) > date('now','-30 day')`).get();
  if (exists) return null;

  notify("accounting", "interest_rate", "INTEREST_RATE_UNSET", { year }, "/accounting/settings");
  console.log(`[accounting] deposit interest rate for ${year} is not confirmed`);
  return year;
}
