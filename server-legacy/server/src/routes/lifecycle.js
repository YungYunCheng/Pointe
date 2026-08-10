import { Router } from "express";
import { db, uid, nowISO, cents, txn, daysBetween } from "../db.js";
import { authenticate, require_, audit, notify } from "../rbac.js";
import { queue } from "../outbox.js";
import { preview as retentionPreview, run as runRetention, POLICIES } from "../retention.js";
import { health as storageHealth } from "../storage.js";

const r = Router();
r.use(authenticate);

/* ============================================================
   Renewals, turnover, pricing signals, GST, depreciation,
   owner statements, shadow mode, retention
   ============================================================ */

const today = () => new Date().toISOString().slice(0, 10);
const period = (d = new Date()) => d.toISOString().slice(0, 7);
const parse = (s, f) => { try { return s ? JSON.parse(s) : f; } catch { return f; } };

/* ================= Renewals ================= */
/*
   A lease running out is the cheapest tenant you will ever have.
   Finding a new one costs a vacancy, a turnover and a leasing fee;
   keeping this one costs a conversation eight weeks early.
*/

const RENEWAL_LEAD_DAYS = 90;
const NOTICE_DAYS = { fixed: 60, periodic: 90 };   // confirm with your manager

r.get("/renewals", require_("units.view"), (req, res) => {
  const horizon = new Date(Date.now() + RENEWAL_LEAD_DAYS * 864e5).toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT l.*, u.unit_type_code, c.full_name tenant_name, c.email tenant_email,
           c.phone tenant_phone, c.locale,
           rt.id task_id, rt.decision, rt.new_rent, rt.decided_at, rt.sent_at, rt.state
    FROM leases l
    JOIN units u ON u.unit_number = l.unit_number
    LEFT JOIN contacts c ON c.id = l.primary_contact_id
    LEFT JOIN renewal_tasks rt ON rt.lease_id = l.id
    WHERE l.status = 'active' AND l.end_date IS NOT NULL AND l.end_date <= ?
    ORDER BY l.end_date`).all(horizon);

  const enriched = rows.map((l) => {
    const daysLeft = daysBetween(today(), l.end_date);
    // The last increase matters: Alberta requires 365 days between one and the
    // next, and a renewal at a higher rent inside that window is not valid.
    const lastIncrease = db.prepare(`SELECT MAX(effective_from) d FROM unit_type_rents r
      JOIN pricing_profiles p ON p.id = r.pricing_profile_id
      WHERE r.unit_type_code = ?`).get(l.unit_type_code)?.d;
    const sinceIncrease = lastIncrease ? daysBetween(lastIncrease, today()) : null;
    const canRaise = sinceIncrease == null || sinceIncrease >= 365;

    return { ...l, days_left: daysLeft,
      notice_due_in: daysLeft - (NOTICE_DAYS[l.term_type === "periodic" ? "periodic" : "fixed"]),
      last_increase: lastIncrease, days_since_increase: sinceIncrease,
      can_raise_rent: canRaise,
      raise_blocked_reason: canRaise ? null
        : `Only ${sinceIncrease} days since the last increase. Alberta requires 365.`,
      urgency: daysLeft <= 30 ? "urgent" : daysLeft <= 60 ? "soon" : "planned" };
  });

  res.json({ renewals: enriched,
    urgent: enriched.filter((x) => x.urgency === "urgent" && !x.decided_at).length });
});

r.post("/renewals/:leaseId/decide", require_("renewals.decide"), (req, res) => {
  const { decision, new_rent, note } = req.body ?? {};
  if (!["offer", "not_renewing", "month_to_month"].includes(decision))
    return res.status(400).json({ code: "INVALID_DECISION" });

  const lease = db.prepare("SELECT * FROM leases WHERE id=?").get(req.params.leaseId);
  if (!lease) return res.status(404).json({ code: "LEASE_NOT_FOUND" });

  // The 365-day rule is checked here rather than trusted to whoever is typing.
  // An invalid increase is not just refused later — it can invalidate the
  // notice entirely.
  if (new_rent && cents(new_rent) > cents(lease.rent)) {
    const u = db.prepare("SELECT unit_type_code FROM units WHERE unit_number=?")
      .get(lease.unit_number);
    const last = db.prepare(`SELECT MAX(effective_from) d FROM unit_type_rents r
      JOIN pricing_profiles p ON p.id = r.pricing_profile_id
      WHERE r.unit_type_code = ?`).get(u?.unit_type_code)?.d;
    if (last && daysBetween(last, today()) < 365)
      return res.status(409).json({ code: "INCREASE_TOO_SOON",
        last_increase: last, days: daysBetween(last, today()) });
  }

  const id = uid("rt_");
  db.prepare(`INSERT INTO renewal_tasks (id, lease_id, unit_number, decision, new_rent,
    note, decided_by, decided_at, state) VALUES (?,?,?,?,?,?,?,?, 'decided')
    ON CONFLICT(lease_id) DO UPDATE SET decision=excluded.decision,
    new_rent=excluded.new_rent, note=excluded.note, decided_by=excluded.decided_by,
    decided_at=excluded.decided_at, state='decided'`)
    .run(id, lease.id, lease.unit_number, decision,
         new_rent == null ? null : cents(new_rent), note ?? null, req.user.id, nowISO());

  audit(req, { action: "renewal.decide", entityType: "lease", entityId: lease.id,
               before: { rent: lease.rent },
               after: { decision, new_rent, by: req.user.name } });
  res.json({ ok: true });
});

r.post("/renewals/:leaseId/send", require_("renewals.decide"), (req, res) => {
  const task = db.prepare("SELECT * FROM renewal_tasks WHERE lease_id=?").get(req.params.leaseId);
  if (!task?.decided_at) return res.status(409).json({ code: "NOT_DECIDED" });
  const lease = db.prepare("SELECT * FROM leases WHERE id=?").get(req.params.leaseId);
  const c = lease?.primary_contact_id
    ? db.prepare("SELECT * FROM contacts WHERE id=?").get(lease.primary_contact_id) : null;
  if (!c?.email) return res.status(400).json({ code: "NO_EMAIL" });

  const money = (n) => new Intl.NumberFormat("en-CA",
    { style: "currency", currency: "CAD" }).format(n);
  const zh = c.locale === "zh";
  const body = task.decision === "offer" ? [
    `Hello ${c.full_name},`, "",
    `Your lease for ${lease.unit_number} ends on ${lease.end_date}. We would like you to stay.`,
    task.new_rent ? `The rent from ${lease.end_date} would be ${money(task.new_rent)} a month.`
                  : `The rent would stay at ${money(lease.rent)} a month.`,
    "", "Reply to let us know, and we will send the paperwork.",
    "", `你好 ${c.full_name}，`, "",
    `${lease.unit_number} 的租約於 ${lease.end_date} 到期，我們希望你續住。`,
    task.new_rent ? `續約後月租為 ${money(task.new_rent)}。` : `月租維持 ${money(lease.rent)}。`,
    "", "回覆告訴我們，我們會把文件寄給你。",
  ] : [
    `Hello ${c.full_name},`, "",
    `Your lease for ${lease.unit_number} ends on ${lease.end_date} and will not be renewed.`,
    "We will be in touch about the move-out inspection and the return of your deposit.",
    "", `你好 ${c.full_name}，`, "",
    `${lease.unit_number} 的租約將於 ${lease.end_date} 到期，不會續約。`,
    "我們會另外聯絡你安排遷出檢查與押金退還。",
  ];

  const msg = queue({ kind: "renewal", channel: "email", toEmail: c.email,
    toName: c.full_name, locale: c.locale,
    subject: zh ? `${lease.unit_number} 續約` : `Your lease at ${lease.unit_number}`,
    body: body.join("\n"), refType: "lease", refId: lease.id, userId: req.user.id });

  db.prepare("UPDATE renewal_tasks SET state='sent', sent_at=? WHERE lease_id=?")
    .run(nowISO(), lease.id);
  audit(req, { action: "renewal.send", entityType: "lease", entityId: lease.id,
               after: { decision: task.decision, to: c.email } });
  res.json({ ok: true, message: msg });
});

/* ================= Turnover ================= */
/*
   Between a tenant leaving and the unit being back on the market is
   pure vacancy loss. It is the number nobody measures because no
   single person owns it.
*/

r.post("/turnovers", require_("units.status.edit"), (req, res) => {
  const { unit_number, moveout_id, vacated_at } = req.body ?? {};
  if (!unit_number) return res.status(400).json({ code: "UNIT_REQUIRED" });
  if (db.prepare(`SELECT 1 FROM turnovers WHERE unit_number=? AND state<>'occupied'`)
        .get(unit_number))
    return res.status(409).json({ code: "TURNOVER_ALREADY_OPEN" });

  const u = db.prepare("SELECT unit_type_code FROM units WHERE unit_number=?").get(unit_number);
  const rent = db.prepare(`SELECT r.base_rent FROM unit_type_rents r
    JOIN pricing_profiles p ON p.id = r.pricing_profile_id
    WHERE r.unit_type_code=? ORDER BY p.effective_from DESC LIMIT 1`).get(u?.unit_type_code);

  const id = uid("to_");
  db.prepare(`INSERT INTO turnovers (id, unit_number, moveout_id, vacated_at, daily_rent)
    VALUES (?,?,?,?,?)`)
    .run(id, unit_number, moveout_id ?? null, vacated_at ?? today(),
         rent?.base_rent ? cents(rent.base_rent / 30.44) : null);

  // A standard list, so the same things get done every time rather than
  // whatever the person remembers.
  const tasks = ["Inspection", "Clean", "Paint touch-up", "Repairs", "Locks rekeyed",
                 "Photographs", "Listed"];
  const ins = db.prepare(`INSERT INTO turnover_tasks (id, turnover_id, label) VALUES (?,?,?)`);
  for (const t of tasks) ins.run(uid("tt_"), id, t);

  audit(req, { action: "turnover.open", entityType: "unit", entityId: unit_number,
               after: { turnover: id, vacated_at } });
  res.status(201).json({ id });
});

r.get("/turnovers", require_("units.view"), (req, res) => {
  const rows = db.prepare(`SELECT * FROM turnovers
    ${req.query.open === "1" ? "WHERE state <> 'occupied'" : ""}
    ORDER BY vacated_at DESC LIMIT 200`).all();
  const tasks = db.prepare("SELECT * FROM turnover_tasks").all();

  const enriched = rows.map((t) => {
    const end = t.occupied_at ?? nowISO().slice(0, 10);
    const days = daysBetween(t.vacated_at, end);
    return { ...t, tasks: tasks.filter((x) => x.turnover_id === t.id),
      days_vacant: days,
      // The number worth seeing: what the empty unit has cost so far.
      lost_rent: t.daily_rent ? cents(days * t.daily_rent) : null,
      days_to_list: t.listed_at ? daysBetween(t.vacated_at, t.listed_at) : null,
      days_to_lease: t.leased_at ? daysBetween(t.vacated_at, t.leased_at) : null };
  });

  const open = enriched.filter((t) => t.state !== "occupied");
  res.json({ turnovers: enriched,
    open_count: open.length,
    lost_rent_running: cents(open.reduce((s, t) => s + (t.lost_rent ?? 0), 0)),
    avg_days: enriched.filter((t) => t.occupied_at).length
      ? Number((enriched.filter((t) => t.occupied_at)
          .reduce((s, t) => s + t.days_vacant, 0)
          / enriched.filter((t) => t.occupied_at).length).toFixed(1)) : null });
});

r.patch("/turnovers/:id", require_("units.status.edit"), (req, res) => {
  const t = db.prepare("SELECT * FROM turnovers WHERE id=?").get(req.params.id);
  if (!t) return res.status(404).json({ code: "TURNOVER_NOT_FOUND" });
  const { state, inspected_at, work_started_at, work_done_at, listed_at,
          leased_at, occupied_at, note, task_id, done } = req.body ?? {};

  if (task_id) {
    db.prepare(`UPDATE turnover_tasks SET done=?, done_at=?, done_by=? WHERE id=?`)
      .run(done ? 1 : 0, done ? nowISO() : null, done ? req.user.name : null, task_id);
  }

  db.prepare(`UPDATE turnovers SET state=COALESCE(?,state),
    inspected_at=COALESCE(?,inspected_at), work_started_at=COALESCE(?,work_started_at),
    work_done_at=COALESCE(?,work_done_at), listed_at=COALESCE(?,listed_at),
    leased_at=COALESCE(?,leased_at), occupied_at=COALESCE(?,occupied_at),
    note=COALESCE(?,note) WHERE id=?`)
    .run(state ?? null, inspected_at ?? null, work_started_at ?? null, work_done_at ?? null,
         listed_at ?? null, leased_at ?? null, occupied_at ?? null, note ?? null, t.id);

  audit(req, { action: "turnover.update", entityType: "turnover", entityId: t.id,
               before: { state: t.state }, after: req.body });
  res.json({ ok: true });
});

/* ================= Pricing signals ================= */
/*
   A unit shown twelve times without an application is telling you
   something. Nobody was listening, so this listens.
*/

r.get("/pricing-signals", require_("units.view"), (req, res) => {
  const months = Number(req.query.months) || 3;
  const from = new Date(Date.now() - months * 30.44 * 864e5).toISOString().slice(0, 10);

  const rows = db.prepare(`
    SELECT u.unit_type_code type,
      COUNT(DISTINCT e.id) showings,
      SUM(CASE WHEN so.outcome = 'not_interested' THEN 1 ELSE 0 END) not_interested,
      SUM(CASE WHEN so.reason LIKE '%rice%' OR so.reason LIKE '%價%' THEN 1 ELSE 0 END) price_reason
    FROM events e
    JOIN units u ON u.unit_number = e.unit_number
    LEFT JOIN showing_outcomes so ON so.event_id = e.id
    WHERE e.type = 'showing' AND date(e.starts_at) >= ?
    GROUP BY u.unit_type_code`).all(from);

  const apps = db.prepare(`SELECT unit_type, COUNT(*) n FROM applications
    WHERE date(created_at) >= ? GROUP BY unit_type`).all(from);
  const byType = Object.fromEntries(apps.map((a) => [a.unit_type, a.n]));

  const rents = db.prepare(`SELECT r.unit_type_code, r.base_rent FROM unit_type_rents r
    JOIN pricing_profiles p ON p.id = r.pricing_profile_id
    WHERE p.effective_from <= date('now')
      AND (p.effective_to IS NULL OR p.effective_to >= date('now'))`).all();
  const rentBy = Object.fromEntries(rents.map((x) => [x.unit_type_code, x.base_rent]));

  const vacancy = db.prepare(`SELECT u.unit_type_code type, AVG(
      julianday(COALESCE(t.occupied_at, date('now'))) - julianday(t.vacated_at)) days
    FROM turnovers t JOIN units u ON u.unit_number = t.unit_number
    GROUP BY u.unit_type_code`).all();
  const vacBy = Object.fromEntries(vacancy.map((v) => [v.type, v.days]));

  const signals = rows.map((x) => {
    const applications = byType[x.type] ?? 0;
    const rate = x.showings > 0 ? applications / x.showings : null;
    return { ...x, applications, current_rent: rentBy[x.type] ?? null,
      avg_days_vacant: vacBy[x.type] ? Number(vacBy[x.type].toFixed(1)) : null,
      conversion: rate == null ? null : Number((rate * 100).toFixed(1)),
      // Deliberately a flag rather than a suggested rent. What a unit should
      // cost depends on things this system cannot see, and a number here
      // would be treated as an answer.
      signal: x.showings >= 8 && applications === 0 ? "shown_often_no_applications"
        : x.price_reason >= 3 ? "price_named_repeatedly"
        : vacBy[x.type] > 45 ? "slow_to_fill"
        : rate != null && rate > 0.4 ? "converting_well"
        : null };
  });

  res.json({ from, signals,
    // Saying what this is not, because a dashboard that looks like advice gets
    // treated as advice.
    note: "These are counts, not a recommendation. What a unit should rent for depends on the local market, which this system cannot see." });
});

/* ================= GST ================= */

r.get("/gst/periods", require_("accounting.view"), (req, res) => {
  res.json({ returns: db.prepare("SELECT * FROM gst_returns ORDER BY period_from DESC").all() });
});

/** Calculated from posted entries, not typed. 2300 is what was charged out,
 *  1210 is what was paid on purchases, and the net is what CRA gets or gives
 *  back. */
r.post("/gst/calculate", require_("accounting.view"), (req, res) => {
  const { from, to } = req.body ?? {};
  if (!from || !to) return res.status(400).json({ code: "PERIOD_REQUIRED" });

  const collected = db.prepare(`SELECT COALESCE(SUM(jl.credit) - SUM(jl.debit), 0) t
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.gl_code = '2300' AND je.state='posted'
      AND je.entry_date BETWEEN ? AND ?`).get(from, to).t;
  const credits = db.prepare(`SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) t
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.gl_code = '1210' AND je.state='posted'
      AND je.entry_date BETWEEN ? AND ?`).get(from, to).t;

  res.json({
    period_from: from, period_to: to,
    collected: cents(collected), input_credits: cents(credits),
    net: cents(collected - credits),
    method: [
      `GST collected: credits less debits on 2300, posted entries from ${from} to ${to}.`,
      `Input tax credits: debits less credits on 1210, same basis.`,
      `Net: ${cents(collected)} less ${cents(credits)} = ${cents(collected - credits)}.`,
      `A positive figure is owed to CRA; a negative one is a refund.`,
      `Most residential rent is exempt from GST. If this figure looks large, check what has been coded to 2300 before filing.`,
    ].join("\n"),
  });
});

r.post("/gst/returns", require_("accounting.close"), (req, res) => {
  const { period_from, period_to, collected, input_credits, note } = req.body ?? {};
  const net = cents((collected ?? 0) - (input_credits ?? 0));
  const id = uid("gst_");
  db.prepare(`INSERT INTO gst_returns (id, period_from, period_to, collected, input_credits,
    net, note) VALUES (?,?,?,?,?,?,?)`)
    .run(id, period_from, period_to, cents(collected ?? 0), cents(input_credits ?? 0),
         net, note ?? null);
  audit(req, { action: "gst.draft", entityType: "gst_return", entityId: id,
               after: { period_from, period_to, net } });
  res.status(201).json({ id, net });
});

r.post("/gst/returns/:id/file", require_("accounting.close"), (req, res) => {
  const g = db.prepare("SELECT * FROM gst_returns WHERE id=?").get(req.params.id);
  if (!g) return res.status(404).json({ code: "RETURN_NOT_FOUND" });
  if (g.state !== "draft") return res.status(409).json({ code: "ALREADY_FILED" });
  db.prepare(`UPDATE gst_returns SET state='filed', filed_at=?, filed_by=?, confirmation=?
    WHERE id=?`).run(nowISO(), req.user.id, req.body?.confirmation ?? null, g.id);
  audit(req, { action: "gst.file", entityType: "gst_return", entityId: g.id,
               after: { net: g.net, confirmation: req.body?.confirmation } });
  res.json({ ok: true });
});

/* ================= Depreciation ================= */

r.get("/assets", require_("accounting.view"), (req, res) => {
  const assets = db.prepare("SELECT * FROM fixed_assets WHERE is_active=1 ORDER BY name").all();
  const runs = db.prepare(`SELECT asset_id, SUM(amount) total, COUNT(*) periods
    FROM depreciation_runs GROUP BY asset_id`).all();
  const byAsset = Object.fromEntries(runs.map((r) => [r.asset_id, r]));
  res.json({ assets: assets.map((a) => {
    const acc = byAsset[a.id];
    return { ...a, accumulated: cents(acc?.total ?? 0),
      periods_run: acc?.periods ?? 0,
      net_book_value: cents(a.cost - (acc?.total ?? 0)) };
  }) });
});

r.post("/assets", require_("accounting.post"), (req, res) => {
  const { name, building_code, asset_class, cost, in_service_on, useful_life_years,
          method, rate, salvage } = req.body ?? {};
  if (!name || !cost || !in_service_on)
    return res.status(400).json({ code: "MISSING_ASSET_FIELDS" });
  const id = uid("fa_");
  db.prepare(`INSERT INTO fixed_assets (id, name, building_code, asset_class, cost,
    in_service_on, useful_life_years, method, rate, salvage) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, name, building_code ?? null, asset_class ?? null, cents(cost), in_service_on,
         useful_life_years ?? null, method ?? "straight_line", rate ?? null,
         cents(salvage ?? 0));
  audit(req, { action: "asset.create", entityType: "fixed_asset", entityId: id,
               after: { name, cost } });
  res.status(201).json({ id });
});

/** Monthly depreciation, posted like anything else. Safe to run twice: the
 *  unique index on (asset, period) means a second run adds nothing. */
r.post("/depreciation/run", require_("accounting.post"), (req, res) => {
  const p = req.body?.period || period();
  const assets = db.prepare(`SELECT * FROM fixed_assets WHERE is_active=1
    AND in_service_on <= ? AND (disposed_on IS NULL OR disposed_on > ?)`)
    .all(`${p}-28`, `${p}-01`);

  const created = [];
  for (const a of assets) {
    if (db.prepare("SELECT 1 FROM depreciation_runs WHERE asset_id=? AND period=?")
          .get(a.id, p)) continue;

    let amount;
    if (a.method === "declining_balance") {
      const acc = db.prepare(`SELECT COALESCE(SUM(amount),0) t FROM depreciation_runs
        WHERE asset_id=?`).get(a.id).t;
      amount = cents((a.cost - acc) * (a.rate ?? 0.04) / 12);
    } else {
      const life = a.useful_life_years || 25;
      amount = cents((a.cost - (a.salvage ?? 0)) / life / 12);
    }
    if (amount <= 0) continue;

    // Never depreciate below salvage. Left unchecked, a long-lived asset ends
    // up with a negative book value and the balance sheet stops making sense.
    const acc = db.prepare(`SELECT COALESCE(SUM(amount),0) t FROM depreciation_runs
      WHERE asset_id=?`).get(a.id).t;
    const remaining = cents(a.cost - (a.salvage ?? 0) - acc);
    if (remaining <= 0) continue;
    amount = Math.min(amount, remaining);

    db.prepare(`INSERT INTO depreciation_runs (id, asset_id, period, amount)
      VALUES (?,?,?,?)`).run(uid("dr_"), a.id, p, amount);
    created.push({ asset: a.name, amount });
  }

  audit(req, { action: "depreciation.run", entityType: "period", entityId: p,
               after: { assets: created.length,
                        total: cents(created.reduce((t, c) => t + c.amount, 0)) } });
  res.json({ period: p, assets: created.length,
    total: cents(created.reduce((t, c) => t + c.amount, 0)), detail: created,
    note: "Recorded. Post the journal entry from the accounting console to put it in the ledger." });
});

/* ================= Owner statements ================= */

r.post("/owner-statements/generate", require_("accounting.reports"), (req, res) => {
  const p = req.body?.period || period();
  const per = db.prepare("SELECT * FROM accounting_periods WHERE period=?").get(p);
  if (per?.state !== "reconciled" && per?.state !== "closed")
    return res.status(409).json({ code: "PERIOD_NOT_RECONCILED" });

  const buildings = db.prepare("SELECT code FROM buildings ORDER BY code").all();
  const made = [];

  for (const b of buildings) {
    const rev = db.prepare(`SELECT COALESCE(SUM(jl.credit) - SUM(jl.debit),0) t
      FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
      JOIN gl_accounts g ON g.code=jl.gl_code
      WHERE je.period=? AND je.state='posted' AND g.type='revenue'
        AND (jl.building_code=? OR je.building_code=?)`).get(p, b.code, b.code).t;
    const exp = db.prepare(`SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit),0) t
      FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
      JOIN gl_accounts g ON g.code=jl.gl_code
      WHERE je.period=? AND je.state='posted' AND g.type='expense'
        AND (jl.building_code=? OR je.building_code=?)`).get(p, b.code, b.code).t;
    const cash = db.prepare(`SELECT COALESCE(SUM(amount),0) t FROM ar_receipts
      WHERE building_code=? AND strftime('%Y-%m', received_date)=?`).get(b.code, p).t;

    const figures = { period: p, building: b.code,
      revenue: cents(rev), expenses: cents(exp), noi: cents(rev - exp),
      cash_collected: cents(cash),
      // What the owner can actually take out this month, which is not the same
      // as the profit. Accrual income includes rent billed and not yet paid.
      distributable: cents(cash - exp) };

    const method = [
      `Revenue: credits less debits on revenue accounts for ${p}, building ${b.code}.`,
      `Expenses: debits less credits on expense accounts, same basis.`,
      `Net operating income: ${figures.revenue} less ${figures.expenses} = ${figures.noi}. Accrual basis.`,
      `Cash collected: receipts dated within the period, ${figures.cash_collected}.`,
      `Distributable: cash collected less expenses = ${figures.distributable}. This is cash basis and will differ from net operating income whenever rent has been billed and not yet paid.`,
    ].join("\n");

    const id = uid("os_");
    db.prepare(`INSERT INTO owner_statements (id, period, building_code, figures, method)
      VALUES (?,?,?,?,?) ON CONFLICT(period, building_code) DO UPDATE
      SET figures=excluded.figures, method=excluded.method, state='draft'`)
      .run(id, p, b.code, JSON.stringify(figures), method);
    made.push(figures);
  }

  audit(req, { action: "owner_statement.generate", entityType: "period", entityId: p,
               after: { buildings: made.length } });
  res.status(201).json({ period: p, statements: made });
});

r.get("/owner-statements", require_("accounting.view"), (req, res) => {
  res.json({ statements: db.prepare(`SELECT * FROM owner_statements
    ORDER BY period DESC, building_code`).all()
    .map((s) => ({ ...s, figures: parse(s.figures, {}) })) });
});

/* ================= Shadow mode ================= */
/*
   The AI runs the whole way through and nothing is sent. Two to four
   weeks of this is how you find the error rate rather than guessing
   it, and the errors that matter are the ones a few samples would
   not have caught.
*/

r.get("/shadow/status", require_("inbox.manage"), (req, res) => {
  const on = process.env.AI_SHADOW_MODE === "1";
  const total = db.prepare("SELECT COUNT(*) n FROM shadow_runs").get().n;
  const reviewed = db.prepare("SELECT COUNT(*) n FROM shadow_runs WHERE verdict IS NOT NULL")
    .get().n;
  const byVerdict = db.prepare(`SELECT verdict, COUNT(*) n FROM shadow_runs
    WHERE verdict IS NOT NULL GROUP BY verdict`).all();
  const wouldSend = db.prepare("SELECT COUNT(*) n FROM shadow_runs WHERE would_send=1").get().n;
  const wrongAndWouldSend = db.prepare(`SELECT COUNT(*) n FROM shadow_runs
    WHERE would_send=1 AND verdict IS NOT NULL AND verdict <> 'correct'`).get().n;

  res.json({
    enabled: on, total, reviewed, unreviewed: total - reviewed,
    by_verdict: byVerdict, would_have_sent: wouldSend,
    // The only number that matters: how often something wrong would have gone
    // out unsupervised. Overall accuracy across drafts a person reviews anyway
    // flatters the result.
    error_rate_on_sends: wouldSend > 0
      ? Number((wrongAndWouldSend / wouldSend * 100).toFixed(1)) : null,
    ready_to_go_live: reviewed >= 100 && wouldSend > 0
      && (wrongAndWouldSend / wouldSend) < 0.02,
    guidance: "Review at least a hundred before drawing a conclusion, and weight the ones that would have sent without anyone looking.",
  });
});

r.post("/shadow/runs", require_("inbox.manage"), (req, res) => {
  const { message_id, source, intent, confidence, level, rule_id, draft,
          facts_used, would_send } = req.body ?? {};
  const id = uid("sh_");
  db.prepare(`INSERT INTO shadow_runs (id, message_id, source, intent, confidence, level,
    rule_id, draft, facts_used, would_send) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, message_id ?? null, source ?? "inbox", intent ?? null, confidence ?? null,
         level ?? null, rule_id ?? null, draft ?? null,
         JSON.stringify(facts_used ?? []), would_send ? 1 : 0);
  res.status(201).json({ id });
});

r.get("/shadow/runs", require_("inbox.manage"), (req, res) => {
  const { verdict, limit = 100 } = req.query;
  let sql = "SELECT * FROM shadow_runs WHERE 1=1";
  const args = [];
  if (verdict === "unreviewed") sql += " AND verdict IS NULL";
  else if (verdict) { sql += " AND verdict = ?"; args.push(verdict); }
  sql += " ORDER BY created_at DESC LIMIT ?";
  args.push(Math.min(Number(limit) || 100, 500));
  res.json({ runs: db.prepare(sql).all(...args)
    .map((r) => ({ ...r, facts_used: parse(r.facts_used, []) })) });
});

r.post("/shadow/runs/:id/review", require_("inbox.manage"), (req, res) => {
  const { verdict, note } = req.body ?? {};
  if (!["correct", "wrong_intent", "wrong_content", "should_not_send", "missed_stop"]
      .includes(verdict))
    return res.status(400).json({ code: "INVALID_VERDICT" });
  db.prepare(`UPDATE shadow_runs SET verdict=?, reviewer_note=?, reviewed_by=?,
    reviewed_name=?, reviewed_at=? WHERE id=?`)
    .run(verdict, note ?? null, req.user.id, req.user.name, nowISO(), req.params.id);
  res.json({ ok: true });
});

/* ================= Retention ================= */

r.get("/retention/policy", require_("audit.view"), (req, res) => {
  res.json({ policies: POLICIES, preview: retentionPreview() });
});

r.post("/retention/run", require_("audit.view"), (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ code: "ADMIN_ONLY" });
  const out = runRetention({ dryRun: !!req.body?.dry_run, actor: req.user.name });
  res.json(out);
});

/* ================= Health ================= */

r.get("/system/health", require_("audit.view"), async (req, res) => {
  const storage = await storageHealth();
  const outbox = db.prepare(`SELECT state, COUNT(*) n FROM outbox GROUP BY state`).all();
  const unattributed = db.prepare(`SELECT COUNT(*) n FROM audit_log
    WHERE actor_name IS NULL AND actor_user_id IS NULL`).get().n;
  res.json({
    storage,
    ai_configured: !!process.env.ANTHROPIC_API_KEY,
    email_configured: !!process.env.RESEND_API_KEY,
    sms_configured: !!process.env.TWILIO_ACCOUNT_SID,
    shadow_mode: process.env.AI_SHADOW_MODE === "1",
    outbox,
    audit_unattributed: unattributed,
    database: process.env.DATABASE_URL ? "postgres" : "sqlite",
  });
});

export default r;
