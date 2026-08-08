import { db, cents } from "./db.js";

/* ============================================================
   Formula engine

   A fee is built from components. Each has its own basis, and the
   total is their sum after any cap.

   That shape covers the arrangements property agreements actually
   use — a straight percentage, a percentage with a floor, a per-unit
   wage, a base retainer plus a percentage, a banded rate — without
   the calculation living in code that has to be edited when the
   arrangement changes.

   What it deliberately does not support is a free-text expression.
   A formula somebody can type is a formula somebody can typo into a
   number nobody notices until an owner queries it.
   ============================================================ */

const parse = (s, f) => { try { return s ? JSON.parse(s) : f; } catch { return f; } };
const money = (n) => new Intl.NumberFormat("en-CA",
  { style: "currency", currency: "CAD" }).format(n ?? 0);
const pct = (n) => `${(n * 100).toFixed(2).replace(/\.00$/, "")}%`;

export const BASES = {
  percent_of_income: {
    label: "Percentage of income",
    describe: "A share of what came in. The usual arrangement, and the one owners understand without explanation.",
  },
  per_unit: {
    label: "Amount per unit",
    describe: "Scales with the building rather than with how well it is doing. Common for wages, because the work is there whether the suite is let or not.",
  },
  flat: {
    label: "Flat amount",
    describe: "The same every month. Often a retainer sitting under a percentage, so a bad month still covers the cost of turning up.",
  },
  per_lease: {
    label: "Amount per lease signed",
    describe: "A leasing fee. Paid on work done rather than on the rent roll, so it rewards filling a suite rather than holding one.",
  },
  hourly: {
    label: "Hourly",
    describe: "Rate times hours. Needs the hours entered each period, so it is the one most likely to be forgotten.",
  },
  tiered: {
    label: "Banded percentage",
    describe: "A different rate in each band. Used where the owner wants the rate to fall as income rises.",
  },
};

/* ---------- Inputs ---------- */

/** Income in scope for a period. Collected means receipts applied to charges
 *  in the month; billed means charges raised. Collected is the fairer basis —
 *  a percentage of rent that has not arrived pays a manager on arrears they
 *  have not recovered. */
export function incomeFor(period, scope, basis, buildingCode) {
  if (!scope?.length) return { total: 0, lines: [] };
  const holes = scope.map(() => "?").join(",");

  const lines = basis === "billed"
    ? db.prepare(`SELECT c.gl_code, g.name_en, SUM(c.amount) amount, COUNT(*) n
        FROM ar_charges c JOIN gl_accounts g ON g.code = c.gl_code
        WHERE c.period = ? AND c.state <> 'void' AND c.gl_code IN (${holes})
          ${buildingCode ? "AND c.building_code = ?" : ""}
        GROUP BY c.gl_code`)
        .all(...(buildingCode ? [period, ...scope, buildingCode] : [period, ...scope]))
    : db.prepare(`SELECT c.gl_code, g.name_en, SUM(a.amount) amount, COUNT(*) n
        FROM ar_applications a
        JOIN ar_receipts rc ON rc.id = a.receipt_id
        JOIN ar_charges c ON c.id = a.charge_id
        JOIN gl_accounts g ON g.code = c.gl_code
        WHERE strftime('%Y-%m', rc.received_date) = ? AND c.gl_code IN (${holes})
          ${buildingCode ? "AND rc.building_code = ?" : ""}
        GROUP BY c.gl_code`)
        .all(...(buildingCode ? [period, ...scope, buildingCode] : [period, ...scope]));

  return { total: cents(lines.reduce((t, l) => t + l.amount, 0)), lines };
}

export function unitsFor(scope, buildingCode) {
  const where = scope === "occupied" ? "status IN ('occupied','signed')"
    : scope === "leased" ? "status = 'signed'"
    : scope === "vacant" ? "status = 'available'" : null;
  const clauses = [where, buildingCode ? "building_code = ?" : null].filter(Boolean);
  const sql = `SELECT COUNT(*) n FROM units${clauses.length ? " WHERE " + clauses.join(" AND ") : ""}`;
  return db.prepare(sql).get(...(buildingCode ? [buildingCode] : [])).n;
}

export function leasesSignedIn(period, buildingCode) {
  return db.prepare(`SELECT COUNT(*) n FROM agreement_issues ai
    JOIN agreements ag ON ag.id = ai.agreement_id
    WHERE ag.code = 'lease' AND ai.state = 'signed'
      AND strftime('%Y-%m', ai.signed_at) = ?
      ${buildingCode ? "AND ai.unit_number LIKE ?" : ""}`)
    .get(...(buildingCode ? [period, `${buildingCode}%`] : [period])).n;
}

/* ---------- Components ---------- */

function tieredAmount(base, tiers) {
  // Each band applies only to the part of the base inside it, which is how
  // agreements are almost always meant even when loosely worded. A flat rate
  // on the whole amount at the highest band reached would step sharply at the
  // boundary, and nobody agrees to that once they see the number.
  let remaining = base, previous = 0, total = 0;
  const steps = [];
  for (const t of tiers ?? []) {
    if (remaining <= 0) break;
    const ceiling = t.upto == null ? Infinity : t.upto;
    const band = Math.min(remaining, ceiling - previous);
    if (band <= 0) { previous = ceiling; continue; }
    const amount = cents(band * t.rate);
    steps.push({ from: previous, to: t.upto, band: cents(band), rate: t.rate, amount });
    total = cents(total + amount);
    remaining = cents(remaining - band);
    previous = ceiling;
  }
  return { total, steps };
}

/**
 * One component. Returns the amount and a sentence saying how it got there —
 * the sentence is the point, because a figure without its derivation is
 * something to argue about later.
 */
export function evaluateComponent(c, ctx) {
  const { period, buildingCode, hours } = ctx;

  if (c.basis === "percent_of_income") {
    const scope = parse(c.income_scope, []);
    const income = incomeFor(period, scope, c.income_basis ?? "collected", buildingCode);
    const amount = cents(income.total * (c.rate ?? 0));
    return { amount, base: income.total, detail: income.lines,
      method: [
        `${c.label}: ${pct(c.rate ?? 0)} of income ${c.income_basis === "billed" ? "billed" : "collected"} in ${period}.`,
        ...income.lines.map((l) => `    ${l.gl_code} ${l.name_en}: ${money(l.amount)}`),
        `    Income counted: ${money(income.total)}`,
        `    ${money(income.total)} × ${pct(c.rate ?? 0)} = ${money(amount)}`,
      ].join("\n") };
  }

  if (c.basis === "per_unit") {
    const units = unitsFor(c.unit_scope ?? "all", buildingCode);
    const amount = cents(units * (c.per_unit_rate ?? 0));
    return { amount, base: units,
      method: `${c.label}: ${units} ${c.unit_scope === "all" ? "units" : `${c.unit_scope} units`} × ${money(c.per_unit_rate)} = ${money(amount)}` };
  }

  if (c.basis === "flat") {
    const amount = cents(c.flat_amount ?? 0);
    return { amount, base: 1, method: `${c.label}: ${money(amount)} flat` };
  }

  if (c.basis === "per_lease") {
    const n = leasesSignedIn(period, buildingCode);
    const amount = cents(n * (c.flat_amount ?? 0));
    return { amount, base: n,
      method: `${c.label}: ${n} lease${n === 1 ? "" : "s"} signed in ${period} × ${money(c.flat_amount)} = ${money(amount)}` };
  }

  if (c.basis === "hourly") {
    const h = Number(hours?.[c.id] ?? c.hours ?? 0);
    const amount = cents(h * (c.hourly_rate ?? 0));
    return { amount, base: h,
      method: `${c.label}: ${h} hour${h === 1 ? "" : "s"} × ${money(c.hourly_rate)} = ${money(amount)}`,
      needs_input: h === 0 };
  }

  if (c.basis === "tiered") {
    const scope = parse(c.income_scope, []);
    const income = incomeFor(period, scope, c.income_basis ?? "collected", buildingCode);
    const { total, steps } = tieredAmount(income.total, parse(c.tiers, []));
    return { amount: total, base: income.total, detail: steps,
      method: [
        `${c.label}: banded on ${money(income.total)} of income.`,
        ...steps.map((s) => `    ${money(s.from)}–${s.to == null ? "above" : money(s.to)}: ${money(s.band)} × ${pct(s.rate)} = ${money(s.amount)}`),
        `    Total: ${money(total)}`,
      ].join("\n") };
  }

  return { amount: 0, base: 0, method: `${c.label}: unknown basis, treated as zero` };
}

/* ---------- Formula ---------- */

/**
 * Every component, plus GST per component, plus any cap.
 *
 * GST is per component because a management fee usually carries it and a wage
 * does not. Applying one rate to the whole total would put GST on a wage.
 */
export function evaluateFormula(formula, ctx) {
  const components = db.prepare(`SELECT * FROM formula_components
    WHERE formula_id = ? ORDER BY seq`).all(formula.id);

  // A formula with no components falls back to the fields on the formula row,
  // so anything configured before components existed still calculates.
  const list = components.length ? components : [{
    id: formula.id, label: formula.label_en, basis: formula.basis,
    rate: formula.rate, per_unit_rate: formula.per_unit_rate,
    flat_amount: formula.flat_amount, income_scope: formula.income_scope,
    income_basis: formula.income_basis, unit_scope: formula.unit_scope,
    gst_applies: formula.gst_applies, expense_gl: formula.expense_gl,
  }];

  const results = list.map((c) => {
    const out = evaluateComponent(c, ctx);
    const gst = c.gst_applies ? cents(out.amount * (formula.gst_rate ?? 0.05)) : 0;
    return { component: c, ...out, gst, total: cents(out.amount + gst),
      expense_gl: c.expense_gl ?? formula.expense_gl };
  });

  let subtotal = cents(results.reduce((t, r) => t + r.amount, 0));
  let gst = cents(results.reduce((t, r) => t + r.gst, 0));
  const capNotes = [];

  const cap = db.prepare("SELECT * FROM formula_caps WHERE formula_id=?").get(formula.id);
  if (cap) {
    let ceiling = cap.maximum ?? null;

    // "Not more than 6% of gross" is how most agreements word a ceiling, so
    // it is supported as written rather than requiring a figure somebody has
    // to recalculate every month.
    if (cap.max_percent_of_income) {
      const scope = parse(formula.income_scope, []) .length
        ? parse(formula.income_scope, [])
        : [...new Set(list.flatMap((c) => parse(c.income_scope, [])))];
      const income = incomeFor(ctx.period, scope, "collected", ctx.buildingCode);
      const byPercent = cents(income.total * cap.max_percent_of_income);
      ceiling = ceiling == null ? byPercent : Math.min(ceiling, byPercent);
      capNotes.push(`Ceiling from the agreement: ${pct(cap.max_percent_of_income)} of ${money(income.total)} = ${money(byPercent)}.`);
    }

    if (cap.minimum && subtotal < cap.minimum) {
      capNotes.push(`Below the minimum of ${money(cap.minimum)}, so the minimum applies. Calculated: ${money(subtotal)}.`);
      // GST is recalculated against the capped figure. Charging the old GST on
      // a new subtotal would be a rate nobody agreed to.
      const ratio = subtotal > 0 ? cap.minimum / subtotal : 1;
      gst = cents(gst * ratio);
      subtotal = cents(cap.minimum);
    }
    if (ceiling != null && subtotal > ceiling) {
      capNotes.push(`Above the ceiling of ${money(ceiling)}, so the ceiling applies. Calculated: ${money(subtotal)}.`);
      const ratio = subtotal > 0 ? ceiling / subtotal : 1;
      gst = cents(gst * ratio);
      subtotal = cents(ceiling);
    }
  }

  const method = [
    `${formula.label_en} for ${ctx.period}${ctx.buildingCode ? `, building ${ctx.buildingCode}` : ""}.`,
    ``,
    ...results.map((r) => r.method),
    ``,
    `Subtotal: ${money(subtotal)}`,
    gst > 0 ? `GST: ${money(gst)}` : `GST: not applied.`,
    `Total: ${money(cents(subtotal + gst))}`,
    ...(capNotes.length ? ["", ...capNotes] : []),
  ].join("\n");

  return {
    components: results, subtotal, gst, total: cents(subtotal + gst),
    capped: capNotes.length > 0, cap_notes: capNotes, method,
    needs_input: results.filter((r) => r.needs_input).map((r) => r.component.label),
  };
}

/* ---------- The group ---------- */

/**
 * Everything the property pays to the management side, in one figure.
 *
 * Adding two numbers from two screens is how somebody gets it wrong, and the
 * total is what an owner asks about.
 *
 * The check that matters: if the arrangement says the percentage covers wages
 * and wages are also being charged, the property is paying twice. The system
 * cannot read the agreement, so it records which arrangement was agreed and
 * says something when the two disagree.
 */
export function remunerationTotal(groupCode, period, buildingCode = null) {
  const group = db.prepare("SELECT * FROM remuneration_groups WHERE code=?").get(groupCode);
  if (!group) return null;

  const members = db.prepare(`SELECT fee_code FROM remuneration_members
    WHERE group_code=? ORDER BY seq`).all(groupCode).map((m) => m.fee_code);

  const parts = members.map((code) => {
    const calc = db.prepare(`SELECT * FROM fee_calculations WHERE code=? AND period=?
      AND building_code IS ?`).get(code, period, buildingCode);
    const formula = db.prepare(`SELECT * FROM fee_formulas WHERE code=?
      ORDER BY effective_from DESC LIMIT 1`).get(code);
    return { code, label: formula?.label_en ?? code,
      subtotal: calc?.subtotal ?? 0, gst: calc?.gst ?? 0, total: calc?.total ?? 0,
      state: calc?.state ?? "not calculated", calculated: !!calc };
  });

  const total = cents(parts.reduce((t, p) => t + p.total, 0));
  const income = incomeFor(period,
    parse(db.prepare(`SELECT income_scope FROM fee_formulas WHERE code='management_fee'
      ORDER BY effective_from DESC LIMIT 1`).get()?.income_scope, []),
    "collected", buildingCode);

  const wagesPart = parts.find((p) => p.code === "bm_payroll");
  const warnings = [];

  if (group.wages_included && wagesPart?.calculated && wagesPart.total > 0) {
    warnings.push({
      severity: "high",
      message: "The agreement records that the percentage already covers wages, but wages are also being charged. One of the two is being paid twice — check the agreement before posting.",
    });
  }
  if (!group.wages_included && !wagesPart?.calculated) {
    warnings.push({
      severity: "low",
      message: "Wages are charged separately under this arrangement and have not been calculated for this period yet.",
    });
  }

  const missing = parts.filter((p) => !p.calculated);
  if (missing.length && !group.wages_included)
    warnings.push({ severity: "medium",
      message: `Not yet calculated: ${missing.map((m) => m.label).join(", ")}. The total below is incomplete.` });

  return {
    group: { ...group },
    period, building: buildingCode,
    parts, total,
    income_collected: income.total,
    // The figure to compare against the agreement. A percentage that looks
    // like 4% and lands at 11% once wages are in it is the thing an owner
    // notices a year late.
    effective_percent: income.total > 0
      ? Number((total / income.total * 100).toFixed(2)) : null,
    warnings,
    method: [
      `Total paid to management for ${period}${buildingCode ? `, building ${buildingCode}` : ""}.`,
      ``,
      ...parts.map((p) => `  ${p.label}: ${money(p.total)}${p.calculated ? "" : "  (not calculated)"}`),
      `  Total: ${money(total)}`,
      ``,
      income.total > 0
        ? `Against ${money(income.total)} of income collected, that is ${(total / income.total * 100).toFixed(2)}% of gross.`
        : `No income collected in the period, so there is no percentage to compare.`,
      ``,
      group.wages_included
        ? `The agreement records that the management percentage covers wages.`
        : `The agreement records that wages are charged separately, on top of the percentage.`,
      group.agreed_note ? `Noted: ${group.agreed_note}` : ``,
    ].filter(Boolean).join("\n"),
  };
}
