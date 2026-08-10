import { Router } from "express";
import { db, uid, nowISO, cents, txn } from "../db.js";
import { authenticate, require_, audit, notify } from "../rbac.js";
import { postEntry } from "./accounting.js";
import { evaluateFormula, remunerationTotal, BASES, incomeFor, unitsFor } from "../formula.js";

const r = Router();
r.use(authenticate);

/* ============================================================
   Management fee, payroll, GST filing, depreciation posting
   and owner distributions.

   Everything here posts through the same double-entry path as the
   rest of the ledger. A fee that lands as a note somewhere is a fee
   the bank reconciliation will not find.

   Formulas are versioned by effective date. Change the rate in June
   and May still calculates at the old one — a rate that applies
   retroactively rewrites months somebody has already been paid on.
   ============================================================ */

const period = (d = new Date()) => d.toISOString().slice(0, 7);
const today = () => new Date().toISOString().slice(0, 10);
const parse = (s, f) => { try { return s ? JSON.parse(s) : f; } catch { return f; } };
const money = (n) => new Intl.NumberFormat("en-CA",
  { style: "currency", currency: "CAD" }).format(n ?? 0);

/** The formula in force for a period. Not the current one — the one that
 *  applied when the work was done. */
function formulaFor(code, forPeriod, buildingCode = null) {
  const monthEnd = `${forPeriod}-28`;
  return db.prepare(`SELECT * FROM fee_formulas
    WHERE code = ? AND effective_from <= ?
      AND (effective_to IS NULL OR effective_to >= ?)
      AND (building_code IS ? OR building_code = ?)
    ORDER BY effective_from DESC LIMIT 1`)
    .get(code, monthEnd, `${forPeriod}-01`, buildingCode, buildingCode);
}

/* ================= Formulas ================= */

r.get("/fees/formulas", require_("accounting.view"), (req, res) => {
  const rows = db.prepare("SELECT * FROM fee_formulas ORDER BY code, effective_from DESC").all();
  res.json({ formulas: rows.map((f) => ({ ...f, income_scope: parse(f.income_scope, []) })),
    current: ["management_fee", "bm_payroll"]
      .map((c) => formulaFor(c, period()))
      .filter(Boolean)
      .map((f) => ({ ...f, income_scope: parse(f.income_scope, []) })) });
});

/** Changing a rate closes the old version and opens a new one from a date.
 *  Editing in place would silently restate every month already calculated. */
r.post("/fees/formulas", require_("accounting.coa"), (req, res) => {
  const { code, label_en, label_zh, basis, rate, per_unit_rate, flat_amount,
          income_scope, income_basis, unit_scope, gst_applies, gst_rate,
          expense_gl, gst_gl, payable_gl, building_code, effective_from, note } = req.body ?? {};
  if (!code || !basis || !effective_from)
    return res.status(400).json({ code: "MISSING_FORMULA_FIELDS" });

  const from = effective_from;
  const current = formulaFor(code, from.slice(0, 7), building_code ?? null);

  // Cannot change a rate for a month already calculated. That figure has been
  // reported and possibly paid.
  const calculated = db.prepare(`SELECT period FROM fee_calculations
    WHERE code = ? AND period >= ? AND state IN ('posted','paid')
    ORDER BY period LIMIT 1`).get(code, from.slice(0, 7));
  if (calculated)
    return res.status(409).json({ code: "PERIOD_ALREADY_POSTED", period: calculated.period,
      detail: "That month has been posted. Set the new rate from a later date." });

  const id = uid("ff_");
  db.transaction(() => {
    if (current) {
      const dayBefore = new Date(new Date(from).getTime() - 864e5).toISOString().slice(0, 10);
      db.prepare("UPDATE fee_formulas SET effective_to = ? WHERE id = ?")
        .run(dayBefore, current.id);
    }
    db.prepare(`INSERT INTO fee_formulas (id, code, label_en, label_zh, basis, rate,
      per_unit_rate, flat_amount, income_scope, income_basis, unit_scope, gst_applies,
      gst_rate, expense_gl, gst_gl, payable_gl, building_code, effective_from, note,
      created_by, created_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, code, label_en ?? current?.label_en ?? code, label_zh ?? current?.label_zh ?? code,
           basis, rate ?? null, per_unit_rate ?? null, flat_amount ?? null,
           JSON.stringify(income_scope ?? parse(current?.income_scope, [])),
           income_basis ?? current?.income_basis ?? "collected",
           unit_scope ?? current?.unit_scope ?? "all",
           gst_applies === undefined ? (current?.gst_applies ?? 1) : (gst_applies ? 1 : 0),
           gst_rate ?? current?.gst_rate ?? 0.05,
           expense_gl ?? current?.expense_gl, gst_gl ?? current?.gst_gl,
           payable_gl ?? current?.payable_gl, building_code ?? null, from, note ?? null,
           req.user.id, req.user.name);
  })();

  audit(req, { action: "fee.formula", entityType: "fee_formula", entityId: id,
               before: current ? { rate: current.rate, per_unit_rate: current.per_unit_rate,
                 effective_from: current.effective_from } : null,
               after: { code, basis, rate, per_unit_rate, effective_from: from } });
  res.status(201).json({ id, supersedes: current?.id ?? null });
});

/* ================= Building manager payroll ================= */

/**
 * A rate per unit. All units by default: the manager looks after an empty
 * suite as much as a full one, arguably more during a turnover.
 *
 * Whether this is employment or a contract is the thing that matters here,
 * and the system will not decide it. An employee means withholding CPP, EI
 * and income tax and remitting them, plus the employer's share. A contractor
 * invoices and remits their own. Getting it wrong is a CRA assessment, not a
 * bookkeeping tidy-up.
 */
function calculatePayroll(forPeriod, formula, { engagement = "contractor",
                                                cpp = 0, ei = 0, tax = 0,
                                                gstRegistered = false } = {}) {
  const where = formula.unit_scope === "occupied"
    ? "WHERE status IN ('occupied','signed')"
    : formula.unit_scope === "leased" ? "WHERE status = 'signed'" : "";
  const units = db.prepare(`SELECT COUNT(*) n FROM units ${where}
    ${formula.building_code ? (where ? "AND" : "WHERE") + " building_code = ?" : ""}`)
    .get(...(formula.building_code ? [formula.building_code] : [])).n;

  const gross = cents(units * formula.per_unit_rate);

  let deductions = 0, employerCost = gross, gst = 0;
  const notes = [];

  if (engagement === "employee") {
    deductions = cents(Number(cpp) + Number(ei) + Number(tax));
    // The employer's share is a cost on top of the wage, not part of it.
    // Treating it as included understates what the position costs by roughly
    // a tenth.
    const cppEmployer = cents(Number(cpp));
    const eiEmployer = cents(Number(ei) * 1.4);
    employerCost = cents(gross + cppEmployer + eiEmployer);
    notes.push(
      `Employment. CPP and EI are withheld from the wage and matched by the employer, and both halves are remitted to CRA with the income tax.`,
      `Employer share: CPP ${money(cppEmployer)} + EI ${money(eiEmployer)} = ${money(cents(cppEmployer + eiEmployer))}.`,
      `The deduction figures above are entered, not calculated here. Use CRA's payroll deductions calculator for the period.`);
    return { units, gross, deductions, cpp_employer: cppEmployer, ei_employer: eiEmployer,
      net: cents(gross - deductions), employer_cost: employerCost, gst: 0,
      method: buildPayrollMethod(forPeriod, formula, units, gross, notes,
        { deductions, net: cents(gross - deductions), employerCost }) };
  }

  if (gstRegistered) {
    gst = cents(gross * 0.05);
    notes.push(`Contractor is GST registered, so GST is added and recoverable as an input tax credit.`);
  } else {
    notes.push(`Contractor is not GST registered, so no GST is charged.`);
  }
  notes.push(
    `Contract, not employment. Nothing is withheld — they invoice and remit their own.`,
    `If this person works set hours under direction and cannot subcontract, CRA may treat it as employment regardless of what the agreement calls it. That is a question for your accountant, not for this system.`);

  return { units, gross, deductions: 0, cpp_employer: 0, ei_employer: 0,
    net: cents(gross + gst), employer_cost: cents(gross + gst), gst,
    method: buildPayrollMethod(forPeriod, formula, units, gross, notes,
      { gst, net: cents(gross + gst), employerCost: cents(gross + gst) }) };
}

function buildPayrollMethod(forPeriod, formula, units, gross, notes, totals) {
  return [
    `${formula.label_en} for ${forPeriod}.`,
    ``,
    `Units counted: ${units} (${formula.unit_scope === "all" ? "every unit"
      : formula.unit_scope === "occupied" ? "occupied and signed only" : "signed only"}).`,
    `${units} × ${money(formula.per_unit_rate)} = ${money(gross)}`,
    totals.deductions ? `Less deductions: ${money(totals.deductions)}` : ``,
    totals.gst ? `Plus GST: ${money(totals.gst)}` : ``,
    `Net to be paid: ${money(totals.net)}`,
    totals.employerCost !== gross ? `Total cost to the property: ${money(totals.employerCost)}` : ``,
    ``,
    ...notes,
  ].filter(Boolean).join("\n");
}

/* ================= Calculating ================= */

/** Any formula, whatever it is built from. The engine handles the shape; this
 *  just supplies the period and anything the components need. */
r.get("/fees/calculate", require_("accounting.view"), (req, res) => {
  const p = req.query.period || period();
  const building = req.query.building || null;
  const code = req.query.code || "management_fee";

  const formula = formulaFor(code, p, building);
  if (!formula) return res.status(404).json({ code: "NO_FORMULA", for: code, period: p });

  try {
    const hours = req.query.hours ? JSON.parse(req.query.hours) : {};
    const out = evaluateFormula(formula, { period: p, buildingCode: building, hours });
    res.json({ period: p, building,
      formula: { ...formula, income_scope: parse(formula.income_scope, []) }, ...out });
  } catch (e) {
    res.status(e.status ?? 500).json({ code: e.message });
  }
});

/* ---------- Building the formula ---------- */

r.get("/fees/bases", require_("accounting.view"), (req, res) => {
  res.json({ bases: Object.entries(BASES).map(([code, b]) => ({ code, ...b })) });
});

r.get("/fees/formulas/:id/components", require_("accounting.view"), (req, res) => {
  const components = db.prepare(`SELECT * FROM formula_components WHERE formula_id=?
    ORDER BY seq`).all(req.params.id);
  const cap = db.prepare("SELECT * FROM formula_caps WHERE formula_id=?").get(req.params.id);
  res.json({ components: components.map((c) => ({ ...c,
    income_scope: parse(c.income_scope, []), tiers: parse(c.tiers, []) })), cap: cap ?? null });
});

/** Components are replaced as a set rather than edited one by one. Half an
 *  update applied is a fee nobody can explain. */
r.put("/fees/formulas/:id/components", require_("accounting.coa"), (req, res) => {
  const f = db.prepare("SELECT * FROM fee_formulas WHERE id=?").get(req.params.id);
  if (!f) return res.status(404).json({ code: "FORMULA_NOT_FOUND" });

  const posted = db.prepare(`SELECT period FROM fee_calculations WHERE formula_id=?
    AND state IN ('posted','paid') ORDER BY period DESC LIMIT 1`).get(f.id);
  if (posted)
    return res.status(409).json({ code: "FORMULA_ALREADY_USED", period: posted.period,
      detail: "This formula has been posted against. Create a new version from a later date instead of editing it." });

  const { components = [], cap } = req.body ?? {};
  db.transaction(() => {
    db.prepare("DELETE FROM formula_components WHERE formula_id=?").run(f.id);
    const ins = db.prepare(`INSERT INTO formula_components (id, formula_id, seq, label,
      basis, rate, per_unit_rate, flat_amount, hourly_rate, hours, income_scope,
      income_basis, unit_scope, tiers, gst_applies, expense_gl, note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    components.forEach((c, i) => ins.run(uid("fcp_"), f.id, i + 1, c.label ?? `Part ${i + 1}`,
      c.basis, c.rate ?? null, c.per_unit_rate ?? null, c.flat_amount ?? null,
      c.hourly_rate ?? null, c.hours ?? null,
      JSON.stringify(c.income_scope ?? []), c.income_basis ?? "collected",
      c.unit_scope ?? "all", JSON.stringify(c.tiers ?? []),
      c.gst_applies ? 1 : 0, c.expense_gl ?? f.expense_gl, c.note ?? null));

    db.prepare("DELETE FROM formula_caps WHERE formula_id=?").run(f.id);
    if (cap && (cap.minimum || cap.maximum || cap.max_percent_of_income))
      db.prepare(`INSERT INTO formula_caps (formula_id, minimum, maximum,
        max_percent_of_income, note) VALUES (?,?,?,?,?)`)
        .run(f.id, cap.minimum ?? null, cap.maximum ?? null,
             cap.max_percent_of_income ?? null, cap.note ?? null);
  })();

  audit(req, { action: "fee.components", entityType: "fee_formula", entityId: f.id,
               after: { components: components.length, cap: cap ?? null } });
  res.json({ ok: true, components: components.length });
});

/* ---------- The total ---------- */

/** Everything the property pays to the management side, in one figure. Adding
 *  two numbers from two screens is how somebody gets it wrong. */
r.get("/remuneration/:period", require_("accounting.view"), (req, res) => {
  const out = remunerationTotal(req.query.group ?? "management",
    req.params.period, req.query.building ?? null);
  if (!out) return res.status(404).json({ code: "GROUP_NOT_FOUND" });
  res.json(out);
});

/** Records what the arrangement says. The system cannot read the agreement,
 *  but it can tell you when the charging disagrees with what was recorded. */
r.patch("/remuneration/:code", require_("accounting.coa"), (req, res) => {
  const { wages_included, agreed_note, label_en, label_zh } = req.body ?? {};
  const g = db.prepare("SELECT * FROM remuneration_groups WHERE code=?").get(req.params.code);
  if (!g) return res.status(404).json({ code: "GROUP_NOT_FOUND" });

  db.prepare(`UPDATE remuneration_groups SET wages_included=COALESCE(?,wages_included),
    agreed_note=COALESCE(?,agreed_note), label_en=COALESCE(?,label_en),
    label_zh=COALESCE(?,label_zh), updated_by=?, updated_at=datetime('now')
    WHERE code=?`)
    .run(wages_included === undefined ? null : (wages_included ? 1 : 0),
         agreed_note ?? null, label_en ?? null, label_zh ?? null, req.user.id, g.code);

  audit(req, { action: "remuneration.update", entityType: "remuneration_group",
               entityId: g.code,
               before: { wages_included: g.wages_included, agreed_note: g.agreed_note },
               after: { wages_included, agreed_note } });
  res.json({ ok: true });
});

/** Records the calculation as a draft. Nothing posts until somebody approves
 *  it, because a fee that posts itself is a fee nobody checked. */
r.post("/fees/calculations", require_("accounting.post"), (req, res) => {
  const { code, period: p, building_code, engagement, cpp, ei, tax, gst_registered } = req.body ?? {};
  const forPeriod = p || period();
  const formula = formulaFor(code, forPeriod, building_code ?? null);
  if (!formula) return res.status(404).json({ code: "NO_FORMULA" });

  const existing = db.prepare(`SELECT * FROM fee_calculations
    WHERE code=? AND period=? AND building_code IS ?`).get(code, forPeriod, building_code ?? null);
  if (existing && ["posted", "paid"].includes(existing.state))
    return res.status(409).json({ code: "ALREADY_POSTED", period: forPeriod });

  try {
    const evaluated = evaluateFormula(formula, {
      period: forPeriod, buildingCode: building_code ?? null,
      hours: req.body?.hours ?? {} });
    const out = {
      base: evaluated.components[0]?.base ?? 0,
      subtotal: evaluated.subtotal, gst: evaluated.gst, total: evaluated.total,
      method: evaluated.method,
      rate_used: formula.rate ?? formula.per_unit_rate ?? null,
    };
    const baseDetail = { components: evaluated.components.map((c) => ({
      label: c.component.label, basis: c.component.basis, base: c.base,
      amount: c.amount, gst: c.gst, expense_gl: c.expense_gl, detail: c.detail })),
      capped: evaluated.capped, cap_notes: evaluated.cap_notes };

    const id = existing?.id ?? uid("fc_");
    db.prepare(`INSERT INTO fee_calculations (id, formula_id, code, period, building_code,
      base_amount, base_detail, rate_used, subtotal, gst, total, method)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(code, period, building_code) DO UPDATE SET base_amount=excluded.base_amount,
      base_detail=excluded.base_detail, rate_used=excluded.rate_used,
      subtotal=excluded.subtotal, gst=excluded.gst, total=excluded.total,
      method=excluded.method, state='draft'`)
      .run(id, formula.id, code, forPeriod, building_code ?? null, out.base,
           JSON.stringify(baseDetail), out.rate_used, out.subtotal, out.gst,
           out.total, out.method);

    audit(req, { action: "fee.calculate", entityType: "fee_calculation", entityId: id,
                 after: { code, period: forPeriod, total: out.total } });
    res.status(201).json({ id, ...out });
  } catch (e) {
    res.status(e.status ?? 500).json({ code: e.message });
  }
});

r.get("/fees/calculations", require_("accounting.view"), (req, res) => {
  const rows = db.prepare(`SELECT fc.*, ff.label_en, ff.label_zh, ff.basis
    FROM fee_calculations fc JOIN fee_formulas ff ON ff.id = fc.formula_id
    ORDER BY fc.period DESC, fc.code`).all();
  res.json({ calculations: rows.map((c) => ({ ...c, base_detail: parse(c.base_detail, null) })) });
});

/** Approving posts it. A management fee is an expense to the property and a
 *  payable until it is paid; the GST on it is an input tax credit. */
r.post("/fees/calculations/:id/post", require_("accounting.post"), (req, res) => {
  try {
    const out = txn(() => {
      const c = db.prepare("SELECT * FROM fee_calculations WHERE id=?").get(req.params.id);
      if (!c) throw Object.assign(new Error("NOT_FOUND"), { status: 404 });
      if (["posted", "paid"].includes(c.state))
        throw Object.assign(new Error("ALREADY_POSTED"), { status: 409 });
      const f = db.prepare("SELECT * FROM fee_formulas WHERE id=?").get(c.formula_id);

      // One debit per component, because a management fee and a wage hit
      // different expense accounts. Collapsing them into one line makes the
      // expense report useless for the question "what did management cost".
      const detail = parse(c.base_detail, null);
      const lines = [];
      if (detail?.components?.length) {
        const byGl = {};
        for (const comp of detail.components) {
          const gl = comp.expense_gl ?? f.expense_gl;
          byGl[gl] = cents((byGl[gl] ?? 0) + comp.amount);
        }
        for (const [gl, amount] of Object.entries(byGl))
          if (amount > 0) lines.push({ gl, debit: amount, buildingCode: c.building_code,
            memo: `${f.label_en} ${c.period}` });
      } else {
        lines.push({ gl: f.expense_gl, debit: c.subtotal,
          buildingCode: c.building_code, memo: `${f.label_en} ${c.period}` });
      }
      if (c.gst > 0) lines.push({ gl: f.gst_gl ?? "1210", debit: c.gst,
        memo: "GST input tax credit" });
      lines.push({ gl: f.payable_gl ?? "2400", credit: cents(c.subtotal + c.gst),
        buildingCode: c.building_code, memo: `${f.label_en} ${c.period}` });

      const entry = postEntry({ date: `${c.period}-28`, buildingCode: c.building_code,
        source: "manual", sourceId: c.id,
        memo: `${f.label_en} — ${c.period}`, lines, userId: req.user.id });

      db.prepare(`UPDATE fee_calculations SET state='posted', entry_id=?, approved_by=?,
        approved_name=?, approved_at=? WHERE id=?`)
        .run(entry.id, req.user.id, req.user.name, nowISO(), c.id);
      return { entry_no: entry.entry_no, total: c.total };
    })();
    audit(req, { action: "fee.post", entityType: "fee_calculation", entityId: req.params.id,
                 after: out });
    res.json(out);
  } catch (e) {
    res.status(e.status ?? 500).json({ code: e.message, period: e.period });
  }
});

r.post("/fees/calculations/:id/pay", require_("accounting.ap"), (req, res) => {
  try {
    const out = txn(() => {
      const c = db.prepare("SELECT * FROM fee_calculations WHERE id=?").get(req.params.id);
      if (!c) throw Object.assign(new Error("NOT_FOUND"), { status: 404 });
      if (c.state !== "posted") throw Object.assign(new Error("NOT_POSTED"), { status: 409 });
      const f = db.prepare("SELECT * FROM fee_formulas WHERE id=?").get(c.formula_id);
      const from = req.body?.paid_from ?? "1010";

      const entry = postEntry({ date: req.body?.date || today(),
        buildingCode: c.building_code, source: "ap_payment", sourceId: c.id,
        memo: `Paid ${f.label_en} ${c.period}`, userId: req.user.id,
        lines: [{ gl: f.payable_gl ?? "2400", debit: cents(c.subtotal + c.gst) },
                { gl: from, credit: cents(c.subtotal + c.gst) }] });

      db.prepare("UPDATE fee_calculations SET state='paid', paid_at=? WHERE id=?")
        .run(nowISO(), c.id);
      return { entry_no: entry.entry_no, amount: cents(c.subtotal + c.gst) };
    })();
    audit(req, { action: "fee.pay", entityType: "fee_calculation", entityId: req.params.id,
                 after: out });
    res.json(out);
  } catch (e) { res.status(e.status ?? 500).json({ code: e.message }); }
});

/* ================= Payroll ================= */

r.post("/payroll/runs", require_("accounting.post"), (req, res) => {
  const { period: p, person_name, engagement = "contractor", cpp = 0, ei = 0,
          tax = 0, gst_registered } = req.body ?? {};
  const forPeriod = p || period();
  if (!person_name?.trim()) return res.status(400).json({ code: "NAME_REQUIRED" });

  const formula = formulaFor("bm_payroll", forPeriod);
  if (!formula) return res.status(404).json({ code: "NO_FORMULA" });

  const out = calculatePayroll(forPeriod, formula, { engagement, cpp, ei, tax,
    gstRegistered: !!gst_registered });

  const id = uid("pr_");
  db.prepare(`INSERT INTO payroll_runs (id, period, person_name, engagement, unit_count,
    rate_per_unit, gross, cpp_employee, ei_employee, tax_withheld, cpp_employer,
    ei_employer, gst, net_pay, employer_cost, method) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(period, person_name) DO UPDATE SET gross=excluded.gross,
    unit_count=excluded.unit_count, net_pay=excluded.net_pay,
    employer_cost=excluded.employer_cost, method=excluded.method, state='draft'`)
    .run(id, forPeriod, person_name.trim(), engagement, out.units, formula.per_unit_rate,
         out.gross, cents(cpp), cents(ei), cents(tax), out.cpp_employer, out.ei_employer,
         out.gst, out.net, out.employer_cost, out.method);

  audit(req, { action: "payroll.calculate", entityType: "payroll_run", entityId: id,
               after: { period: forPeriod, person: person_name, gross: out.gross } });
  res.status(201).json({ id, ...out });
});

r.get("/payroll/runs", require_("accounting.view"), (req, res) => {
  res.json({ runs: db.prepare("SELECT * FROM payroll_runs ORDER BY period DESC").all() });
});

r.post("/payroll/runs/:id/post", require_("accounting.post"), (req, res) => {
  try {
    const out = txn(() => {
      const p = db.prepare("SELECT * FROM payroll_runs WHERE id=?").get(req.params.id);
      if (!p) throw Object.assign(new Error("NOT_FOUND"), { status: 404 });
      if (["posted", "paid"].includes(p.state))
        throw Object.assign(new Error("ALREADY_POSTED"), { status: 409 });

      const lines = [{ gl: "5170", debit: p.gross, memo: `Wages ${p.period}` }];

      if (p.engagement === "employee") {
        const employerShare = cents(p.cpp_employer + p.ei_employer);
        if (employerShare > 0)
          lines.push({ gl: "5175", debit: employerShare, memo: "Employer CPP and EI" });
        const remittable = cents(p.cpp_employee + p.ei_employee + p.tax_withheld
          + employerShare);
        if (remittable > 0)
          lines.push({ gl: "2410", credit: remittable, memo: "Due to CRA" });
        lines.push({ gl: "2400", credit: p.net_pay, memo: `Net pay ${p.person_name}` });
      } else {
        if (p.gst > 0) lines.push({ gl: "1210", debit: p.gst, memo: "GST input tax credit" });
        lines.push({ gl: "2400", credit: cents(p.gross + p.gst),
          memo: `Due to ${p.person_name}` });
      }

      const entry = postEntry({ date: `${p.period}-28`, source: "manual", sourceId: p.id,
        memo: `Payroll ${p.period} — ${p.person_name}`, lines, userId: req.user.id });

      db.prepare(`UPDATE payroll_runs SET state='posted', entry_id=?, approved_by=?,
        approved_name=?, approved_at=? WHERE id=?`)
        .run(entry.id, req.user.id, req.user.name, nowISO(), p.id);
      return { entry_no: entry.entry_no, gross: p.gross, net: p.net_pay,
               cost: p.employer_cost };
    })();
    audit(req, { action: "payroll.post", entityType: "payroll_run", entityId: req.params.id,
                 after: out });
    res.json(out);
  } catch (e) { res.status(e.status ?? 500).json({ code: e.message }); }
});

/* ================= GST filing ================= */

/** Filing posts the settlement: what was collected comes off 2300, the input
 *  credits come off 1210, and the difference becomes payable or receivable. */
r.post("/gst/returns/:id/post", require_("accounting.close"), (req, res) => {
  try {
    const out = txn(() => {
      const g = db.prepare("SELECT * FROM gst_returns WHERE id=?").get(req.params.id);
      if (!g) throw Object.assign(new Error("RETURN_NOT_FOUND"), { status: 404 });
      if (g.entry_id) throw Object.assign(new Error("ALREADY_POSTED"), { status: 409 });

      const lines = [];
      if (g.collected > 0) lines.push({ gl: "2300", debit: cents(g.collected),
        memo: `GST collected ${g.period_from} to ${g.period_to}` });
      if (g.input_credits > 0) lines.push({ gl: "1210", credit: cents(g.input_credits),
        memo: "Input tax credits claimed" });

      const net = cents(g.collected - g.input_credits);
      // Positive is owed to CRA, negative is a refund coming back. Both are
      // real balances and neither should sit in the GST accounts afterwards.
      if (net > 0) lines.push({ gl: "2400", credit: net, memo: "GST payable to CRA" });
      else if (net < 0) lines.push({ gl: "1200", debit: Math.abs(net),
        memo: "GST refund receivable" });

      if (!lines.length) throw Object.assign(new Error("NOTHING_TO_POST"), { status: 400 });

      const entry = postEntry({ date: g.period_to, source: "manual", sourceId: g.id,
        memo: `GST return ${g.period_from} to ${g.period_to}`, lines, userId: req.user.id });

      db.prepare("UPDATE gst_returns SET entry_id=?, state='filed', filed_at=?, filed_by=? WHERE id=?")
        .run(entry.id, nowISO(), req.user.id, g.id);
      return { entry_no: entry.entry_no, net };
    })();
    audit(req, { action: "gst.post", entityType: "gst_return", entityId: req.params.id,
                 after: out });
    res.json(out);
  } catch (e) { res.status(e.status ?? 500).json({ code: e.message }); }
});

/* ================= Depreciation posting ================= */

r.post("/depreciation/:period/post", require_("accounting.post"), (req, res) => {
  try {
    const out = txn(() => {
      const p = req.params.period;
      const runs = db.prepare(`SELECT dr.*, fa.name, fa.building_code, fa.expense_gl,
        fa.accum_gl FROM depreciation_runs dr JOIN fixed_assets fa ON fa.id = dr.asset_id
        WHERE dr.period = ? AND dr.entry_id IS NULL`).all(p);
      if (!runs.length) throw Object.assign(new Error("NOTHING_TO_POST"), { status: 400 });

      // One entry for the month rather than one per asset. Twenty lines in the
      // ledger for the same monthly charge makes the account unreadable.
      const byGl = {};
      for (const r_ of runs) {
        const ex = r_.expense_gl ?? "5200", acc = r_.accum_gl ?? "1510";
        byGl[ex] = cents((byGl[ex] ?? 0) + r_.amount);
        byGl[`~${acc}`] = cents((byGl[`~${acc}`] ?? 0) + r_.amount);
      }
      const lines = Object.entries(byGl).map(([k, amount]) =>
        k.startsWith("~") ? { gl: k.slice(1), credit: amount, memo: "Accumulated depreciation" }
                          : { gl: k, debit: amount, memo: `Depreciation ${p}` });

      const entry = postEntry({ date: `${p}-28`, source: "manual", sourceId: p,
        memo: `Depreciation ${p} — ${runs.length} asset${runs.length === 1 ? "" : "s"}`,
        lines, userId: req.user.id });

      const up = db.prepare("UPDATE depreciation_runs SET entry_id=? WHERE id=?");
      for (const r_ of runs) up.run(entry.id, r_.id);
      return { entry_no: entry.entry_no, assets: runs.length,
               total: cents(runs.reduce((t, x) => t + x.amount, 0)) };
    })();
    audit(req, { action: "depreciation.post", entityType: "period",
                 entityId: req.params.period, after: out });
    res.json(out);
  } catch (e) { res.status(e.status ?? 500).json({ code: e.message }); }
});

/* ================= Owner distributions ================= */

/**
 * What can actually be taken out, which is not the profit.
 *
 * Cash in the bank, less what is owed and about to leave, less a reserve. An
 * owner who takes the accrual profit out of an account holding rent that has
 * not arrived writes a cheque the bank will not honour.
 */
r.get("/distributions/available", require_("accounting.view"), (req, res) => {
  const p = req.query.period || period();
  const building = req.query.building || null;

  const cash = db.prepare(`SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) t
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
    WHERE jl.gl_code = '1010' AND je.state='posted'`).get().t;

  // Deposits are in the trust account, not here, but the check is worth doing:
  // if operating cash somehow includes deposit money, distributing it is
  // spending the tenants'.
  const trustOk = db.prepare(`SELECT
    (SELECT COALESCE(SUM(debit)-SUM(credit),0) FROM journal_lines WHERE gl_code='1020') a,
    (SELECT COALESCE(SUM(credit)-SUM(debit),0) FROM journal_lines
      WHERE gl_code IN ('2100','2110')) b`).get();

  const payables = db.prepare(`SELECT COALESCE(SUM(total - paid_amount), 0) t
    FROM ap_invoices WHERE state IN ('approved','partial')`).get().t;
  const feesDue = db.prepare(`SELECT COALESCE(SUM(subtotal + gst), 0) t
    FROM fee_calculations WHERE state = 'posted'`).get().t;
  const payrollDue = db.prepare(`SELECT COALESCE(SUM(net_pay), 0) t FROM payroll_runs
    WHERE state = 'posted'`).get().t;
  const prepaid = db.prepare(`SELECT COALESCE(SUM(credit) - SUM(debit), 0) t
    FROM journal_lines WHERE gl_code = '2200'`).get().t;

  const reserve = Number(req.query.reserve ?? 0);
  const commitments = cents(payables + feesDue + payrollDue + prepaid);
  const available = cents(cash - commitments - reserve);

  res.json({
    period: p, building,
    cash: cents(cash),
    commitments: {
      vendor_invoices: cents(payables),
      management_fees: cents(feesDue),
      payroll: cents(payrollDue),
      // Prepaid rent is a tenant's money sitting in the account until the
      // charge it belongs to exists. Distributing it spends next month's rent.
      prepaid_rent: cents(prepaid),
      total: commitments,
    },
    reserve: cents(reserve),
    available: Math.max(0, available),
    trust_in_agreement: cents(trustOk.a) === cents(trustOk.b),
    method: [
      `Operating cash: ${money(cash)}`,
      `Less unpaid vendor invoices: ${money(payables)}`,
      `Less management fees posted and unpaid: ${money(feesDue)}`,
      `Less payroll posted and unpaid: ${money(payrollDue)}`,
      `Less prepaid rent held: ${money(prepaid)} — this is a tenant's money until the charge it belongs to exists.`,
      reserve ? `Less reserve held back: ${money(reserve)}` : ``,
      `Available: ${money(Math.max(0, available))}`,
      ``,
      `This is cash basis. It will differ from net operating income whenever rent has been billed and not collected, and distributing the accrual profit out of an account that has not received it writes a cheque the bank will not honour.`,
      cents(trustOk.a) === cents(trustOk.b) ? `` :
        `WARNING: the trust account and the deposit liability do not agree. Resolve that before distributing anything.`,
    ].filter(Boolean).join("\n"),
  });
});

r.post("/distributions", require_("accounting.close"), (req, res) => {
  const { period: p, building_code, amount, reserve_held, note, statement_id } = req.body ?? {};
  if (!amount || Number(amount) <= 0) return res.status(400).json({ code: "AMOUNT_REQUIRED" });

  const id = uid("od_");
  db.prepare(`INSERT INTO owner_distributions (id, period, building_code, amount,
    reserve_held, method, statement_id, note) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, p || period(), building_code ?? null, cents(amount), cents(reserve_held ?? 0),
         req.body?.method ?? "Manual", statement_id ?? null, note ?? null);
  audit(req, { action: "distribution.draft", entityType: "owner_distribution", entityId: id,
               after: { period: p, amount: cents(amount) } });
  res.status(201).json({ id });
});

/** Posting a distribution reduces equity, not profit. Booking it as an expense
 *  understates what the property actually earned, which is the number the
 *  owner is trying to see. */
r.post("/distributions/:id/pay", require_("accounting.close"), (req, res) => {
  try {
    const out = txn(() => {
      const d = db.prepare("SELECT * FROM owner_distributions WHERE id=?").get(req.params.id);
      if (!d) throw Object.assign(new Error("NOT_FOUND"), { status: 404 });
      if (d.state === "paid") throw Object.assign(new Error("ALREADY_PAID"), { status: 409 });

      const cash = db.prepare(`SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) t
        FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
        WHERE jl.gl_code = ? AND je.state='posted'`).get(d.paid_from ?? "1010").t;
      if (cents(d.amount) > cents(cash))
        throw Object.assign(new Error("INSUFFICIENT_CASH"), { status: 409,
          cash: cents(cash), requested: cents(d.amount) });

      const entry = postEntry({ date: req.body?.date || today(),
        buildingCode: d.building_code, source: "manual", sourceId: d.id,
        memo: `Owner distribution ${d.period}`, userId: req.user.id,
        lines: [{ gl: "3020", debit: cents(d.amount), memo: "Owner draws" },
                { gl: d.paid_from ?? "1010", credit: cents(d.amount) }] });

      db.prepare(`UPDATE owner_distributions SET state='paid', entry_id=?, approved_by=?,
        approved_name=?, approved_at=?, paid_at=?, reference=? WHERE id=?`)
        .run(entry.id, req.user.id, req.user.name, nowISO(), nowISO(),
             req.body?.reference ?? null, d.id);
      return { entry_no: entry.entry_no, amount: cents(d.amount) };
    })();
    audit(req, { action: "distribution.pay", entityType: "owner_distribution",
                 entityId: req.params.id, after: out });
    res.json(out);
  } catch (e) {
    res.status(e.status ?? 500).json({ code: e.message, cash: e.cash,
                                        requested: e.requested });
  }
});

r.get("/distributions", require_("accounting.view"), (req, res) => {
  res.json({ distributions: db.prepare(`SELECT * FROM owner_distributions
    ORDER BY period DESC, created_at DESC`).all() });
});

/* ================= Month-end checklist ================= */

/** What is outstanding before the month can close. Order matters: fees and
 *  payroll are expenses of the month and have to be in before the figures a
 *  report quotes are final. */
r.get("/month-end/:period", require_("accounting.view"), (req, res) => {
  const p = req.params.period;
  const per = db.prepare("SELECT * FROM accounting_periods WHERE period=?").get(p);

  const steps = [
    { key: "rent_run", label: "Rent raised",
      done: db.prepare("SELECT COUNT(*) n FROM ar_charges WHERE period=?").get(p).n > 0 },
    { key: "management_fee", label: "Management fee calculated and posted",
      done: !!db.prepare(`SELECT 1 FROM fee_calculations WHERE code='management_fee'
        AND period=? AND state IN ('posted','paid')`).get(p) },
    { key: "payroll", label: "Payroll posted",
      done: !!db.prepare(`SELECT 1 FROM payroll_runs WHERE period=?
        AND state IN ('posted','paid')`).get(p) },
    { key: "depreciation", label: "Depreciation posted",
      done: !!db.prepare(`SELECT 1 FROM depreciation_runs WHERE period=?
        AND entry_id IS NOT NULL`).get(p) },
    { key: "bank", label: "Bank statements reconciled",
      done: db.prepare(`SELECT COUNT(*) n FROM bank_statements WHERE period=?
        AND state<>'reconciled'`).get(p).n === 0
        && db.prepare("SELECT COUNT(*) n FROM bank_statements WHERE period=?").get(p).n > 0 },
    { key: "reconciled", label: "Period reconciled",
      done: ["reconciled", "closed"].includes(per?.state) },
    { key: "reports", label: "Reports generated",
      done: !!db.prepare("SELECT 1 FROM monthly_reports WHERE period=?").get(p) },
    { key: "statements", label: "Owner statements generated",
      done: !!db.prepare("SELECT 1 FROM owner_statements WHERE period=?").get(p) },
    { key: "closed", label: "Period closed", done: per?.state === "closed" },
  ];

  const next = steps.find((s) => !s.done);
  res.json({ period: p, state: per?.state ?? "open", steps,
    complete: steps.every((s) => s.done), next_step: next?.label ?? null,
    note: "Fees, payroll and depreciation are expenses of the month. They have to be posted before the figures a report quotes are final." });
});

export default r;
