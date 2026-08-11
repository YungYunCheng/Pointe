import React, { useState, useMemo } from "react";

/* ============================================================
   Month end: management fee, payroll, GST, depreciation and
   what the owner can take out.

   Everything here posts through the same double-entry path as the
   rest of the ledger. A fee recorded as a note somewhere is a fee
   the bank reconciliation will not find.

   Formulas are versioned by effective date rather than edited in
   place. Change the rate in June and May still calculates at the
   old one — a rate that applies retroactively rewrites months
   somebody has already been paid on.
   ============================================================ */

const money = (n) => (n == null || isNaN(n) ? "—"
  : new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(n));
const cents = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const nowISO = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);
const thisPeriod = () => new Date().toISOString().slice(0, 7);

/* What a component can be worked out from. These cover the arrangements
   property agreements actually use — the shape is configuration, not code. */
const BASES = [
  ["percent_of_income", "Percentage of income",
   "A share of what came in. The usual arrangement, and the one owners understand without explanation."],
  ["per_unit", "Amount per unit",
   "Scales with the building rather than with how well it is doing. Common for wages, because the work is there whether the suite is let or not."],
  ["flat", "Flat amount",
   "The same every month. Often a retainer under a percentage, so a bad month still covers the cost of turning up."],
  ["per_lease", "Per lease signed",
   "A leasing fee. Paid on work done, so it rewards filling a suite rather than holding one."],
  ["hourly", "Hourly",
   "Rate times hours. Needs the hours entered each period, so it is the one most likely to be forgotten."],
  ["tiered", "Banded percentage",
   "A different rate in each band, where the owner wants the rate to fall as income rises."],
];

const STATE = {
  draft:    { label: "Draft",    color: "#8892A0" },
  approved: { label: "Approved", color: "#C98A15" },
  posted:   { label: "Posted",   color: "#1C6FA6" },
  paid:     { label: "Paid",     color: "#0E8577" },
  void:     { label: "Void",     color: "#8892A0" },
};

/* Which income the management fee is charged on. Late fees and damage
   recovery are left out: charging a percentage on a penalty rewards the
   penalty, and an owner will ask why the manager profited from an arrear. */
const DEFAULT_SCOPE = ["4010", "4020", "4030", "4040", "4080"];
const INCOME_ACCOUNTS = [
  ["4010", "Rental income"], ["4020", "Parking income"], ["4030", "Storage income"],
  ["4040", "Pet rent"], ["4050", "Application fees"], ["4060", "Late fees"],
  ["4070", "Damage recovery"], ["4080", "Laundry and vending"], ["4090", "Other income"],
];

export default function MonthEnd({ period: initialPeriod, charges, receipts, entries,
                                   invoices, coa, formulas, calculations, payroll,
                                   distributions, gstReturns, assets, depreciationRuns,
                                   save, canPost, session }) {
  const [period, setPeriod] = useState(initialPeriod || thisPeriod());
  const [editing, setEditing] = useState(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(""), 3500); };

  /** The formula in force for this period — not the current one, the one that
   *  applied when the work was done. */
  const formulaFor = (code) => {
    const end = `${period}-28`, start = `${period}-01`;
    return (formulas ?? [])
      .filter((f) => f.code === code && f.effective_from <= end
        && (!f.effective_to || f.effective_to >= start))
      .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0];
  };

  const feeFormula = formulaFor("management_fee");
  const payFormula = formulaFor("bm_payroll");

  /* ---------- Management fee ---------- */
  const feeCalc = useMemo(() => {
    if (!feeFormula) return null;
    const scope = feeFormula.income_scope ?? DEFAULT_SCOPE;

    // Collected, not billed. Charging a percentage of rent that has not
    // arrived pays the manager on arrears they have not recovered.
    const lines = [];
    for (const gl of scope) {
      const amount = feeFormula.income_basis === "billed"
        ? cents((charges ?? []).filter((c) => c.period === period && c.gl_code === gl
            && c.state !== "void").reduce((t, c) => t + c.amount, 0))
        : cents((receipts ?? []).filter((r) => r.received_date?.startsWith(period))
            .reduce((t, r) => t + (r.applied_gl === gl ? r.amount
              : gl === "4010" ? r.amount : 0), 0));
      if (amount > 0)
        lines.push({ gl, name: INCOME_ACCOUNTS.find(([c]) => c === gl)?.[1] ?? gl, amount });
    }

    const base = cents(lines.reduce((t, l) => t + l.amount, 0));
    const subtotal = cents(base * (feeFormula.rate ?? 0));
    const gst = feeFormula.gst_applies ? cents(subtotal * (feeFormula.gst_rate ?? 0.05)) : 0;
    return { base, lines, subtotal, gst, total: cents(subtotal + gst) };
  }, [feeFormula, charges, receipts, period]);

  /* ---------- Payroll ---------- */
  const [group, setGroup] = useState({ wages_included: false,
    agreed_note: "Recorded as: the percentage is the management company's fee, and staff wages are charged on top. Confirm against the signed management agreement before the first month is posted — if the percentage was meant to cover wages, charging both pays twice." });
  const [engagement, setEngagement] = useState("contractor");
  const [gstRegistered, setGstRegistered] = useState(false);
  const [deductions, setDeductions] = useState({ cpp: "", ei: "", tax: "" });

  const payCalc = useMemo(() => {
    if (!payFormula) return null;
    const units = 330;   // from the unit table once wired
    const gross = cents(units * (payFormula.per_unit_rate ?? 0));

    if (engagement === "employee") {
      const cpp = cents(Number(deductions.cpp) || 0);
      const ei = cents(Number(deductions.ei) || 0);
      const tax = cents(Number(deductions.tax) || 0);
      // The employer’s share sits on top of the wage, not inside it. Treating
      // it as included understates what the position costs by about a tenth.
      const cppEmployer = cpp;
      const eiEmployer = cents(ei * 1.4);
      return { units, gross, withheld: cents(cpp + ei + tax),
        employerShare: cents(cppEmployer + eiEmployer),
        net: cents(gross - cpp - ei - tax),
        cost: cents(gross + cppEmployer + eiEmployer), gst: 0 };
    }
    const gst = gstRegistered ? cents(gross * 0.05) : 0;
    return { units, gross, withheld: 0, employerShare: 0,
      net: cents(gross + gst), cost: cents(gross + gst), gst };
  }, [payFormula, engagement, deductions, gstRegistered]);

  /* ---------- What can be taken out ---------- */
  const distributable = useMemo(() => {
    const bal = (gl) => cents((entries ?? []).filter((e) => e.state === "posted")
      .flatMap((e) => e.lines ?? [])
      .filter((l) => l.gl === gl)
      .reduce((t, l) => t + l.debit - l.credit, 0));

    const cash = bal("1010");
    const payables = cents((invoices ?? [])
      .filter((i) => ["approved", "partial"].includes(i.state))
      .reduce((t, i) => t + (i.total - i.paid_amount), 0));
    const feesDue = cents((calculations ?? []).filter((c) => c.state === "posted")
      .reduce((t, c) => t + c.total, 0));
    const payDue = cents((payroll ?? []).filter((p) => p.state === "posted")
      .reduce((t, p) => t + p.net_pay, 0));
    // Prepaid rent is a tenant’s money sitting in the account until the charge
    // it belongs to exists. Distributing it spends next month’s rent.
    const prepaid = cents(-bal("2200"));

    const commitments = cents(payables + feesDue + payDue + prepaid);
    return { cash, payables, feesDue, payDue, prepaid, commitments,
      available: Math.max(0, cents(cash - commitments)) };
  }, [entries, invoices, calculations, payroll]);

  const existing = (code) => (calculations ?? [])
    .find((c) => c.code === code && c.period === period);
  const existingPayroll = (payroll ?? []).find((p) => p.period === period);

  /* ---------- Posting ---------- */
  const postFee = () => {
    setErr("");
    if (!feeCalc || feeCalc.total <= 0) { setErr("Nothing to charge for this period."); return; }
    const rec = { id: uid("fc_"), code: "management_fee", formula_id: feeFormula.id,
      period, base_amount: feeCalc.base, rate_used: feeFormula.rate,
      subtotal: feeCalc.subtotal, gst: feeCalc.gst, total: feeCalc.total,
      base_detail: feeCalc.lines, state: "posted",
      approved_name: session?.name, approved_at: nowISO(),
      method: buildFeeMethod(period, feeFormula, feeCalc) };
    save.calculations([rec, ...(calculations ?? []).filter((c) =>
      !(c.code === "management_fee" && c.period === period))]);
    flash(`Management fee posted: ${money(feeCalc.total)}.`);
  };

  const postPayroll = () => {
    setErr("");
    if (!payCalc) { setErr("No payroll formula for this period."); return; }
    if (engagement === "employee" && !deductions.cpp && !deductions.ei && !deductions.tax) {
      setErr("Enter the deductions. Employment means withholding CPP, EI and income tax, and posting a wage without them understates what is owed to CRA.");
      return;
    }
    const rec = { id: uid("pr_"), period, person_name: "Building Manager",
      engagement, unit_count: payCalc.units, rate_per_unit: payFormula.per_unit_rate,
      gross: payCalc.gross, cpp_employee: cents(deductions.cpp || 0),
      ei_employee: cents(deductions.ei || 0), tax_withheld: cents(deductions.tax || 0),
      cpp_employer: engagement === "employee" ? cents(deductions.cpp || 0) : 0,
      ei_employer: engagement === "employee" ? cents((deductions.ei || 0) * 1.4) : 0,
      gst: payCalc.gst, net_pay: payCalc.net, employer_cost: payCalc.cost,
      state: "posted", approved_name: session?.name, approved_at: nowISO() };
    save.payroll([rec, ...(payroll ?? []).filter((p) => p.period !== period)]);
    flash(`Payroll posted: ${money(payCalc.cost)}.`);
  };

  return (
    <div className="ac-body">
      <section className="ac-card">
        <div className="ac-cardh">
          <h2>Month end</h2>
          <input className="ac-in ac-in--sm" type="month" value={period}
                 onChange={(e) => setPeriod(e.target.value)} />
        </div>
        <p className="ac-note-p">
          Fees, payroll and depreciation are expenses of the month. They have to be
          posted before the figures in a report or an owner statement are final —
          a statement issued before the management fee lands overstates the income
          by exactly that fee.
        </p>
        {err && <div className="ac-err">{err}</div>}
        {msg && <div className="ac-ok-box">{msg}</div>}
      </section>

      <RemunerationTotal period={period} feeCalc={feeCalc} payCalc={payCalc}
        wagesIncluded={group.wages_included} income={feeCalc?.base ?? 0}
        agreedNote={group.agreed_note} canPost={canPost}
        onUpdate={(g) => setGroup({ ...group, ...g })} />

      {/* ── Management fee ── */}
      <section className="ac-card">
        <div className="ac-cardh">
          <h2>
            Management fee
            {existing("management_fee") && (
              <span className="ac-tag" style={{ "--c": STATE[existing("management_fee").state].color }}>
                {STATE[existing("management_fee").state].label}
              </span>
            )}
          </h2>
          <div className="ac-cardh-r">
            {feeFormula && (
              <span className="ac-dim">
                {(feeFormula.rate * 100).toFixed(2)}%
                {feeFormula.gst_applies ? " + GST" : ""} · from {feeFormula.effective_from}
              </span>
            )}
            {canPost && (
              <button className="ac-btn ac-btn--sm ac-btn--ghost"
                      onClick={() => setEditing(editing === "fee" ? null : "fee")}>
                Change the rate
              </button>
            )}
          </div>
        </div>

        {!feeFormula ? (
          <div className="ac-empty">No formula set for this period.</div>
        ) : editing === "fee" ? (
          <FormulaEditor formula={feeFormula} period={period}
            calculations={calculations}
            onCancel={() => setEditing(null)}
            onSave={(f) => { save.formulas([f, ...(formulas ?? []).map((x) =>
              x.id === feeFormula.id
                ? { ...x, effective_to: prevDay(f.effective_from) } : x)]);
              setEditing(null); flash("New rate saved. Earlier months keep the old one."); }} />
        ) : (
          <>
            <div className="ac-feelines">
              <div className="ac-feelines-h">
                Income counted · {feeFormula.income_basis === "billed" ? "billed" : "collected"}
              </div>
              {(feeCalc?.lines ?? []).length === 0 ? (
                <div className="ac-empty">Nothing in scope for this period.</div>
              ) : (feeCalc.lines.map((l) => (
                <div className="ac-feeline" key={l.gl}>
                  <span className="ac-mono ac-dim">{l.gl}</span>
                  <span>{l.name}</span>
                  <span className="ac-mono">{money(l.amount)}</span>
                </div>
              )))}
              <div className="ac-feeline ac-feeline--t">
                <span /><span>Total income</span>
                <span className="ac-mono">{money(feeCalc?.base)}</span>
              </div>
            </div>

            <div className="ac-tally">
              <div>
                <span>{money(feeCalc?.base)} × {(feeFormula.rate * 100).toFixed(2)}%</span>
                <span className="ac-mono">{money(feeCalc?.subtotal)}</span>
              </div>
              {feeFormula.gst_applies && (
                <div>
                  <span>GST {(feeFormula.gst_rate * 100).toFixed(0)}%</span>
                  <span className="ac-mono">{money(feeCalc?.gst)}</span>
                </div>
              )}
              <div className="ac-tally-t">
                <span>Total</span><span className="ac-mono">{money(feeCalc?.total)}</span>
              </div>
            </div>

            <p className="ac-note-p">
              {feeFormula.income_basis === "collected"
                ? "Charged on what was collected, not billed. A percentage of rent that has not arrived pays the manager on arrears they have not recovered."
                : "Charged on what was billed. This takes a fee on rent that may never be collected — worth checking against the arrears figure."}
              {" "}Late fees and damage recovery are outside the scope: a percentage
              of a penalty rewards the penalty.
            </p>

            {canPost && !existing("management_fee") && (
              <div className="ac-actions">
                <button className="ac-btn" onClick={postFee}
                        disabled={!feeCalc || feeCalc.total <= 0}>
                  Post {money(feeCalc?.total)}
                </button>
                <span className="ac-dim">
                  Posts to management expense with the GST as an input tax credit.
                </span>
              </div>
            )}
          </>
        )}
      </section>

      {/* ── Payroll ── */}
      <section className="ac-card">
        <div className="ac-cardh">
          <h2>
            Building manager
            {existingPayroll && (
              <span className="ac-tag" style={{ "--c": STATE[existingPayroll.state].color }}>
                {STATE[existingPayroll.state].label}
              </span>
            )}
          </h2>
          <div className="ac-cardh-r">
            {payFormula && (
              <span className="ac-dim">
                {money(payFormula.per_unit_rate)} per unit · from {payFormula.effective_from}
              </span>
            )}
            {canPost && (
              <button className="ac-btn ac-btn--sm ac-btn--ghost"
                      onClick={() => setEditing(editing === "pay" ? null : "pay")}>
                Change the rate
              </button>
            )}
          </div>
        </div>

        {!payFormula ? (
          <div className="ac-empty">No formula set for this period.</div>
        ) : editing === "pay" ? (
          <FormulaEditor formula={payFormula} period={period}
            calculations={payroll}
            onCancel={() => setEditing(null)}
            onSave={(f) => { save.formulas([f, ...(formulas ?? []).map((x) =>
              x.id === payFormula.id
                ? { ...x, effective_to: prevDay(f.effective_from) } : x)]);
              setEditing(null); flash("New rate saved."); }} />
        ) : (
          <>
            {/* This is the question that matters, and the system will not
                decide it. Getting it wrong is a CRA assessment. */}
            <div className="ac-engagement">
              <div className="ac-eng-h">How is this person engaged?</div>
              <div className="ac-opts">
                {[["contractor", "Contractor"], ["employee", "Employee"]].map(([k, l]) => (
                  <button key={k} className={engagement === k ? "on" : ""}
                          onClick={() => setEngagement(k)}>{l}</button>
                ))}
              </div>
              <p className="ac-note-p">
                {engagement === "employee"
                  ? "Employment means withholding CPP, EI and income tax from the wage, matching CPP and EI as the employer, and remitting all of it to CRA. The employer’s share is a cost on top of the wage, not part of it."
                  : "A contractor invoices and remits their own. But if this person works set hours under direction and cannot send somebody else, CRA may treat it as employment whatever the agreement calls it — that is a question for your accountant, and the assessment lands on you, not on them."}
              </p>
            </div>

            <div className="ac-tally">
              <div>
                <span>{payCalc?.units} units × {money(payFormula.per_unit_rate)}</span>
                <span className="ac-mono">{money(payCalc?.gross)}</span>
              </div>

              {engagement === "employee" ? (
                <>
                  <div className="ac-deductions">
                    <span className="ac-dim">
                      Deductions for the period — from CRA’s payroll calculator, not worked
                      out here
                    </span>
                    <div className="ac-row">
                      {[["cpp", "CPP"], ["ei", "EI"], ["tax", "Income tax"]].map(([k, l]) => (
                        <label className="ac-f" key={k}>
                          <span>{l}</span>
                          <input className="ac-in" type="number" step="0.01"
                                 value={deductions[k]}
                                 onChange={(e) => setDeductions({ ...deductions,
                                   [k]: e.target.value })} />
                        </label>
                      ))}
                    </div>
                  </div>
                  <div><span>Withheld</span>
                    <span className="ac-mono">−{money(payCalc?.withheld)}</span></div>
                  <div><span>Employer CPP and EI</span>
                    <span className="ac-mono">{money(payCalc?.employerShare)}</span></div>
                </>
              ) : (
                <>
                  <label className="ac-check" style={{ margin: "6px 0" }}>
                    <input type="checkbox" checked={gstRegistered}
                           onChange={(e) => setGstRegistered(e.target.checked)} />
                    <span>They are GST registered</span>
                  </label>
                  {gstRegistered && (
                    <div><span>GST</span><span className="ac-mono">{money(payCalc?.gst)}</span></div>
                  )}
                </>
              )}

              <div><span>Net to pay them</span>
                <span className="ac-mono">{money(payCalc?.net)}</span></div>
              <div className="ac-tally-t">
                <span>Total cost to the property</span>
                <span className="ac-mono">{money(payCalc?.cost)}</span>
              </div>
            </div>

            {canPost && !existingPayroll && (
              <div className="ac-actions">
                <button className="ac-btn" onClick={postPayroll}>
                  Post {money(payCalc?.cost)}
                </button>
              </div>
            )}
          </>
        )}
      </section>

      <GstReturn period={period} entries={entries} returns={gstReturns}
        canPost={canPost} session={session} onSave={save.gstReturns} />

      <Assets period={period} assets={assets} runs={depreciationRuns} canPost={canPost}
        onSaveAssets={save.assets} onSaveRuns={save.depreciationRuns} flash={flash} />

      {/* ── Distribution ── */}
      <section className="ac-card">
        <h2>What the owner can take out</h2>
        <p className="ac-note-p">
          Cash basis, not profit. Distributing the accrual profit out of an account
          holding rent that has not arrived writes a cheque the bank will not honour.
        </p>

        <div className="ac-dist">
          <div className="ac-dist-r"><span>Operating cash</span>
            <span className="ac-mono">{money(distributable.cash)}</span></div>
          <div className="ac-dist-r ac-dim"><span>Less unpaid vendor invoices</span>
            <span className="ac-mono">−{money(distributable.payables)}</span></div>
          <div className="ac-dist-r ac-dim"><span>Less management fee posted and unpaid</span>
            <span className="ac-mono">−{money(distributable.feesDue)}</span></div>
          <div className="ac-dist-r ac-dim"><span>Less payroll posted and unpaid</span>
            <span className="ac-mono">−{money(distributable.payDue)}</span></div>
          <div className="ac-dist-r ac-dim">
            <span>Less prepaid rent held<em> — a tenant’s money until the charge exists</em></span>
            <span className="ac-mono">−{money(distributable.prepaid)}</span>
          </div>
          <div className="ac-dist-r ac-dist-t"><span>Available</span>
            <span className="ac-mono">{money(distributable.available)}</span></div>
        </div>

        {canPost && distributable.available > 0 && (
          <Distribute available={distributable.available} period={period} session={session}
            onSave={(d) => { save.distributions([d, ...(distributions ?? [])]);
                             flash(`Distribution of ${money(d.amount)} recorded.`); }} />
        )}
      </section>
    </div>
  );
}

/* ---------- GST ---------- */

/** Worked out from posted entries: 2300 is what was charged out, 1210 is what
 *  was paid on purchases, and the difference goes to CRA or comes back.
 *
 *  Most residential rent is exempt. If the collected figure looks large,
 *  something has been coded to 2300 that should not have been — worth saying
 *  rather than leaving to be noticed on the return. */
function GstReturn({ period, entries, returns, canPost, session, onSave }) {
  const [from, setFrom] = useState(`${period}-01`);
  const [to, setTo] = useState(`${period}-28`);
  const [confirmation, setConfirmation] = useState("");

  const calc = useMemo(() => {
    const lines = (entries ?? []).filter((e) => e.state === "posted"
      && e.entry_date >= from && e.entry_date <= to).flatMap((e) => e.lines ?? []);
    const collected = cents(lines.filter((l) => l.gl === "2300")
      .reduce((t, l) => t + l.credit - l.debit, 0));
    const credits = cents(lines.filter((l) => l.gl === "1210")
      .reduce((t, l) => t + l.debit - l.credit, 0));
    return { collected, credits, net: cents(collected - credits) };
  }, [entries, from, to]);

  const filed = (returns ?? []).find((r) => r.period_from === from && r.period_to === to);

  return (
    <section className="ac-card">
      <div className="ac-cardh">
        <h2>
          GST
          {filed && <span className="ac-tag" style={{ "--c": "#0E8577" }}>{filed.state}</span>}
        </h2>
        <div className="ac-cardh-r">
          <input className="ac-in ac-in--sm" type="date" value={from}
                 onChange={(e) => setFrom(e.target.value)} />
          <input className="ac-in ac-in--sm" type="date" value={to}
                 onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>

      <div className="ac-tally">
        <div><span>Collected on sales (2300)</span>
          <span className="ac-mono">{money(calc.collected)}</span></div>
        <div><span>Input tax credits (1210)</span>
          <span className="ac-mono">−{money(calc.credits)}</span></div>
        <div className="ac-tally-t">
          <span>{calc.net >= 0 ? "Owed to CRA" : "Refund due back"}</span>
          <span className="ac-mono">{money(Math.abs(calc.net))}</span>
        </div>
      </div>

      {calc.collected > 0 && (
        <div className="ac-warnbox">
          Most residential rent is exempt from GST. {money(calc.collected)} has been
          coded to 2300 — check what it is before filing, because the usual cause is
          a coding error rather than a taxable supply.
        </div>
      )}

      <p className="ac-note-p">
        Filing posts the settlement, so neither account carries a balance belonging
        to a period already filed.
      </p>

      {canPost && !filed && (
        <div className="ac-actions">
          <input className="ac-in ac-in--sm" value={confirmation}
                 placeholder="CRA confirmation number"
                 onChange={(e) => setConfirmation(e.target.value)} />
          <button className="ac-btn"
                  onClick={() => { onSave([{ id: uid("gst_"), period_from: from,
                    period_to: to, collected: calc.collected, input_credits: calc.credits,
                    net: calc.net, state: "filed", confirmation: confirmation.trim() || null,
                    filed_at: nowISO(), filed_by: session?.name }, ...(returns ?? [])]); }}>
            Record as filed
          </button>
        </div>
      )}
      {filed?.confirmation && (
        <div className="ac-dim">CRA confirmation {filed.confirmation} · {filed.filed_by}</div>
      )}
    </section>
  );
}

/* ---------- Fixed assets ---------- */

/** Straight line or declining balance, monthly. It will not take an asset
 *  below salvage — unchecked, a long-lived asset ends up with a negative book
 *  value and the balance sheet stops making sense. */
function Assets({ period, assets, runs, canPost, onSaveAssets, onSaveRuns, flash }) {
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: "", cost: "", in_service_on: today(),
    useful_life_years: 25, method: "straight_line", rate: "4", salvage: "0",
    asset_class: "1" });
  const set = (p) => setF({ ...f, ...p });

  const withAccum = useMemo(() => (assets ?? []).map((a) => {
    const mine = (runs ?? []).filter((r) => r.asset_id === a.id);
    const accum = cents(mine.reduce((t, r) => t + r.amount, 0));
    return { ...a, accumulated: accum, net_book: cents(a.cost - accum),
      periods: mine.length, run_this_period: mine.some((r) => r.period === period) };
  }), [assets, runs, period]);

  const monthly = (a) => {
    const accum = a.accumulated ?? 0;
    const remaining = cents(a.cost - (a.salvage ?? 0) - accum);
    if (remaining <= 0) return 0;
    const raw = a.method === "declining_balance"
      ? cents((a.cost - accum) * (a.rate ?? 0.04) / 12)
      : cents((a.cost - (a.salvage ?? 0)) / (a.useful_life_years || 25) / 12);
    return Math.min(raw, remaining);
  };

  const due = withAccum.filter((a) => !a.run_this_period && monthly(a) > 0);
  const total = cents(due.reduce((t, a) => t + monthly(a), 0));

  return (
    <section className="ac-card">
      <div className="ac-cardh">
        <h2>Depreciation</h2>
        <div className="ac-cardh-r">
          <span className="ac-dim">{withAccum.length} asset(s)</span>
          {canPost && (
            <button className="ac-btn ac-btn--sm ac-btn--ghost"
                    onClick={() => setAdding(!adding)}>Add an asset</button>
          )}
        </div>
      </div>

      {adding && canPost && (
        <div className="ac-panel">
          <div className="ac-row">
            <label className="ac-f"><span>What it is</span>
              <input className="ac-in" value={f.name} placeholder="Roof, 378"
                     onChange={(e) => set({ name: e.target.value })} /></label>
            <label className="ac-f"><span>Cost</span>
              <input className="ac-in" type="number" step="0.01" value={f.cost}
                     onChange={(e) => set({ cost: e.target.value })} /></label>
            <label className="ac-f"><span>In service from</span>
              <input className="ac-in" type="date" value={f.in_service_on}
                     onChange={(e) => set({ in_service_on: e.target.value })} /></label>
          </div>
          <div className="ac-row">
            <label className="ac-f"><span>Method</span>
              <select className="ac-sel" value={f.method}
                      onChange={(e) => set({ method: e.target.value })}>
                <option value="straight_line">Straight line</option>
                <option value="declining_balance">Declining balance</option>
              </select></label>
            {f.method === "straight_line" ? (
              <label className="ac-f"><span>Useful life (years)</span>
                <input className="ac-in" type="number" value={f.useful_life_years}
                       onChange={(e) => set({ useful_life_years: e.target.value })} /></label>
            ) : (
              <label className="ac-f"><span>Rate (% per year)</span>
                <input className="ac-in" type="number" step="0.5" value={f.rate}
                       onChange={(e) => set({ rate: e.target.value })} />
                <em className="ac-hint">CCA class 1 buildings are 4%.</em></label>
            )}
            <label className="ac-f"><span>Salvage value</span>
              <input className="ac-in" type="number" step="0.01" value={f.salvage}
                     onChange={(e) => set({ salvage: e.target.value })} />
              <em className="ac-hint">Depreciation stops here, never below.</em></label>
          </div>
          <div className="ac-actions">
            <button className="ac-btn" disabled={!f.name.trim() || !(Number(f.cost) > 0)}
                    onClick={() => { onSaveAssets([...(assets ?? []),
                      { id: uid("fa_"), ...f, cost: cents(f.cost),
                        salvage: cents(f.salvage || 0), rate: Number(f.rate) / 100,
                        useful_life_years: Number(f.useful_life_years),
                        expense_gl: "5200", accum_gl: "1510", is_active: true }]);
                      setAdding(false); setF({ ...f, name: "", cost: "" }); }}>
              Add
            </button>
            <button className="ac-btn ac-btn--ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {withAccum.length === 0 ? (
        <div className="ac-empty">No assets recorded.</div>
      ) : (
        <div className="ac-table">
          <div className="ac-tr ac-tr--h" style={{ gridTemplateColumns: "1fr 110px 110px 110px 100px" }}>
            <span>Asset</span><span>Cost</span><span>Accumulated</span>
            <span>Net book value</span><span>This month</span>
          </div>
          {withAccum.map((a) => (
            <div className="ac-tr" key={a.id}
                 style={{ gridTemplateColumns: "1fr 110px 110px 110px 100px" }}>
              <span>
                <strong>{a.name}</strong>
                <span className="ac-dim"> {a.method === "declining_balance"
                  ? `declining ${(a.rate * 100).toFixed(0)}%`
                  : `${a.useful_life_years} years`}</span>
              </span>
              <span className="ac-mono">{money(a.cost)}</span>
              <span className="ac-mono ac-dim">{money(a.accumulated)}</span>
              <span className="ac-mono">{money(a.net_book)}</span>
              <span className="ac-mono">
                {a.run_this_period ? <span className="ac-ok">run</span> : money(monthly(a))}
              </span>
            </div>
          ))}
        </div>
      )}

      {canPost && due.length > 0 && (
        <div className="ac-actions">
          <button className="ac-btn"
                  onClick={() => { onSaveRuns([...(runs ?? []),
                    ...due.map((a) => ({ id: uid("dr_"), asset_id: a.id, period,
                      amount: monthly(a), created_at: nowISO() }))]);
                    flash(`Depreciation recorded: ${money(total)}.`); }}>
            Record {money(total)} for {period}
          </button>
          <span className="ac-dim">
            One entry for the month, not one per asset — twenty lines for the same
            charge makes the account unreadable.
          </span>
        </div>
      )}
    </section>
  );
}

/* ---------- What management costs in total ---------- */

/** The fee and the wages are both money going to the management side. Adding
 *  two figures from two screens is how somebody gets it wrong, and the total
 *  is the number an owner asks about.
 *
 *  The effective percentage is the useful part: an arrangement that reads as
 *  4% and lands at 11% once wages are in it is the thing an owner notices a
 *  year late. */
function RemunerationTotal({ period, feeCalc, payCalc, wagesIncluded, income,
                             agreedNote, canPost, onUpdate }) {
  const [editing, setEditing] = useState(false);
  const [included, setIncluded] = useState(!!wagesIncluded);
  const [note, setNote] = useState(agreedNote ?? "");

  const fee = feeCalc?.total ?? 0;
  const wages = payCalc?.cost ?? 0;
  const total = cents(fee + wages);
  const effective = income > 0 ? Number((total / income * 100).toFixed(2)) : null;

  // The system cannot read the agreement. It can say when the charging
  // disagrees with what somebody recorded the agreement as saying.
  const doubleCharge = wagesIncluded && wages > 0;

  return (
    <section className="ac-card">
      <div className="ac-cardh">
        <h2>Paid to management this month</h2>
        {canPost && (
          <button className="ac-btn ac-btn--sm ac-btn--ghost"
                  onClick={() => setEditing(!editing)}>
            What does the agreement say?
          </button>
        )}
      </div>

      <div className="ac-remun">
        <div className="ac-remun-r">
          <span>Management fee</span><span className="ac-mono">{money(fee)}</span>
        </div>
        <div className="ac-remun-r">
          <span>
            Staff wages
            {wagesIncluded && <em> — recorded as already covered by the percentage</em>}
          </span>
          <span className="ac-mono">{money(wages)}</span>
        </div>
        <div className="ac-remun-r ac-remun-t">
          <span>Total</span><span className="ac-mono">{money(total)}</span>
        </div>
        {effective != null && (
          <div className="ac-remun-r ac-remun-pct">
            <span>Against {money(income)} collected</span>
            <span className="ac-mono">{effective}% of gross</span>
          </div>
        )}
      </div>

      {doubleCharge && (
        <div className="ac-err">
          <strong>Charged twice.</strong> The agreement is recorded as saying the
          percentage already covers wages, but wages are also being charged this
          month. Check the agreement before posting — one of these two should not
          be there.
        </div>
      )}

      {effective != null && effective > 10 && !doubleCharge && (
        <div className="ac-warnbox">
          {effective}% of gross is high for a residential property of this size.
          Worth confirming against the signed agreement rather than discovering it
          at year end.
        </div>
      )}

      {editing ? (
        <div className="ac-panel">
          <div className="ac-opts">
            {[[false, "Wages are charged on top of the percentage"],
              [true, "The percentage already covers wages"]].map(([v, l]) => (
              <button key={String(v)} className={included === v ? "on" : ""}
                      onClick={() => setIncluded(v)}>{l}</button>
            ))}
          </div>
          <label className="ac-f">
            <span>Note <em>what the agreement actually says</em></span>
            <textarea className="ac-in" rows={2} value={note}
                      onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="ac-actions">
            <button className="ac-btn" onClick={() => {
              onUpdate({ wages_included: included, agreed_note: note.trim() });
              setEditing(false);
            }}>Save</button>
            <button className="ac-btn ac-btn--ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        agreedNote && <p className="ac-note-p">{agreedNote}</p>
      )}
    </section>
  );
}

/* ---------- Formula editor ---------- */

/** Changing a rate opens a new version from a date rather than editing in
 *  place. Editing would silently restate every month already calculated. */
/** Changing a formula opens a new version from a date rather than editing in
 *  place. Editing would silently restate every month already calculated.
 *
 *  A formula is a list of parts. That covers a straight percentage, a
 *  percentage with a floor, a per-unit wage, a retainer plus a percentage, a
 *  banded rate — without the calculation living in code somebody has to edit
 *  when the arrangement changes.
 *
 *  What it deliberately is not is a free-text expression. A formula somebody
 *  can type is a formula somebody can typo into a number nobody notices until
 *  an owner queries it. */
function FormulaEditor({ formula, period, calculations, onCancel, onSave }) {
  const [parts, setParts] = useState(() => formula.components?.length
    ? formula.components.map((c) => ({ ...c }))
    : [{ label: formula.label_en, basis: formula.basis,
         rate: formula.rate, per_unit_rate: formula.per_unit_rate,
         flat_amount: formula.flat_amount,
         income_scope: formula.income_scope ?? DEFAULT_SCOPE,
         income_basis: formula.income_basis ?? "collected",
         unit_scope: formula.unit_scope ?? "all",
         gst_applies: !!formula.gst_applies, expense_gl: formula.expense_gl }]);
  const [from, setFrom] = useState(nextMonthStart());
  const [cap, setCap] = useState({ minimum: "", maximum: "", max_percent_of_income: "" });
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");

  const set = (i, patch) => setParts(parts.map((p, j) => j === i ? { ...p, ...patch } : p));

  // A month already posted cannot be restated: that figure has been reported
  // and possibly paid.
  const posted = (calculations ?? []).filter((c) =>
    ["posted", "paid"].includes(c.state) && c.period >= from.slice(0, 7));

  const submit = () => {
    setErr("");
    if (posted.length)
      return setErr(`${posted[0].period} has already been posted. Set the new version from a later date.`);
    if (!parts.length) return setErr("A formula needs at least one part.");
    for (const p of parts) {
      if (p.basis === "percent_of_income" && !(p.rate > 0))
        return setErr(`"${p.label}" needs a rate.`);
      if (p.basis === "per_unit" && !(p.per_unit_rate > 0))
        return setErr(`"${p.label}" needs an amount per unit.`);
      if (p.basis === "percent_of_income" && !(p.income_scope ?? []).length)
        return setErr(`"${p.label}" needs at least one income account.`);
    }

    onSave({
      id: uid("ff_"), code: formula.code, label_en: formula.label_en,
      label_zh: formula.label_zh, basis: parts[0].basis,
      rate: parts[0].rate ?? null, per_unit_rate: parts[0].per_unit_rate ?? null,
      income_scope: parts[0].income_scope ?? [],
      income_basis: parts[0].income_basis ?? "collected",
      unit_scope: parts[0].unit_scope ?? "all",
      gst_applies: parts.some((p) => p.gst_applies) ? 1 : 0,
      gst_rate: formula.gst_rate ?? 0.05,
      expense_gl: formula.expense_gl, gst_gl: formula.gst_gl,
      payable_gl: formula.payable_gl, effective_from: from,
      note: note.trim() || null, created_name: "you", created_at: nowISO(),
      components: parts.map((p, i) => ({ ...p, seq: i + 1 })),
      cap: (cap.minimum || cap.maximum || cap.max_percent_of_income) ? {
        minimum: Number(cap.minimum) || null,
        maximum: Number(cap.maximum) || null,
        max_percent_of_income: cap.max_percent_of_income
          ? Number(cap.max_percent_of_income) / 100 : null } : null,
    });
  };

  return (
    <div className="ac-panel">
      <div className="ac-parts">
        {parts.map((p, i) => {
          const basis = BASES.find(([b]) => b === p.basis);
          return (
            <div className="ac-part" key={i}>
              <div className="ac-part-h">
                <input className="ac-in ac-in--sm" value={p.label ?? ""}
                       placeholder="What this part is"
                       onChange={(e) => set(i, { label: e.target.value })} />
                <select className="ac-sel ac-in--sm" value={p.basis}
                        onChange={(e) => set(i, { basis: e.target.value })}>
                  {BASES.map(([b, l]) => <option key={b} value={b}>{l}</option>)}
                </select>
                {parts.length > 1 && (
                  <button className="ac-x"
                          onClick={() => setParts(parts.filter((_, j) => j !== i))}>×</button>
                )}
              </div>
              {basis && <p className="ac-hint">{basis[2]}</p>}

              {p.basis === "percent_of_income" && (
                <>
                  <div className="ac-row">
                    <label className="ac-f"><span>Rate (%)</span>
                      <input className="ac-in" type="number" step="0.01"
                             value={p.rate != null ? p.rate * 100 : ""}
                             onChange={(e) => set(i, { rate: Number(e.target.value) / 100 })} /></label>
                    <label className="ac-f"><span>Based on</span>
                      <select className="ac-sel" value={p.income_basis ?? "collected"}
                              onChange={(e) => set(i, { income_basis: e.target.value })}>
                        <option value="collected">What was collected</option>
                        <option value="billed">What was billed</option>
                      </select>
                      <em className="ac-hint">
                        Collected is the fairer basis — billed pays a fee on arrears nobody recovered.
                      </em>
                    </label>
                  </div>
                  <div className="ac-f">
                    <span>Charged on</span>
                    <div className="ac-scope">
                      {INCOME_ACCOUNTS.map(([code, name]) => (
                        <label key={code}
                               className={(p.income_scope ?? []).includes(code) ? "on" : ""}>
                          <input type="checkbox"
                                 checked={(p.income_scope ?? []).includes(code)}
                                 onChange={(e) => set(i, { income_scope: e.target.checked
                                   ? [...(p.income_scope ?? []), code]
                                   : (p.income_scope ?? []).filter((c) => c !== code) })} />
                          <span className="ac-mono">{code}</span> {name}
                        </label>
                      ))}
                    </div>
                    <em className="ac-hint">
                      Which income counts is what owners argue about. Late fees and damage
                      recovery are usually left out — a percentage of a penalty rewards
                      the penalty.
                    </em>
                  </div>
                </>
              )}

              {p.basis === "per_unit" && (
                <div className="ac-row">
                  <label className="ac-f"><span>Per unit ($)</span>
                    <input className="ac-in" type="number" step="0.01"
                           value={p.per_unit_rate ?? ""}
                           onChange={(e) => set(i, { per_unit_rate: Number(e.target.value) })} /></label>
                  <label className="ac-f"><span>Units counted</span>
                    <select className="ac-sel" value={p.unit_scope ?? "all"}
                            onChange={(e) => set(i, { unit_scope: e.target.value })}>
                      <option value="all">Every unit</option>
                      <option value="occupied">Occupied and signed</option>
                      <option value="leased">Signed only</option>
                      <option value="vacant">Vacant only</option>
                    </select>
                    <em className="ac-hint">
                      All units is the usual basis for a wage — the work is there whether
                      the suite is let or not.
                    </em>
                  </label>
                </div>
              )}

              {(p.basis === "flat" || p.basis === "per_lease") && (
                <label className="ac-f">
                  <span>{p.basis === "flat" ? "Amount per month ($)" : "Amount per lease ($)"}</span>
                  <input className="ac-in" type="number" step="0.01" value={p.flat_amount ?? ""}
                         onChange={(e) => set(i, { flat_amount: Number(e.target.value) })} />
                </label>
              )}

              {p.basis === "hourly" && (
                <div className="ac-row">
                  <label className="ac-f"><span>Rate per hour ($)</span>
                    <input className="ac-in" type="number" step="0.01" value={p.hourly_rate ?? ""}
                           onChange={(e) => set(i, { hourly_rate: Number(e.target.value) })} /></label>
                  <label className="ac-f"><span>Hours <em>entered each month</em></span>
                    <input className="ac-in" type="number" step="0.5" value={p.hours ?? ""}
                           onChange={(e) => set(i, { hours: Number(e.target.value) })} /></label>
                </div>
              )}

              {p.basis === "tiered" && (
                <TierEditor tiers={p.tiers ?? []} onChange={(t) => set(i, { tiers: t })} />
              )}

              <div className="ac-row">
                <label className="ac-check">
                  <input type="checkbox" checked={!!p.gst_applies}
                         onChange={(e) => set(i, { gst_applies: e.target.checked })} />
                  <span>GST applies to this part</span>
                </label>
                <label className="ac-f" style={{ maxWidth: 220 }}>
                  <span>Expense account</span>
                  <select className="ac-sel" value={p.expense_gl ?? "5030"}
                          onChange={(e) => set(i, { expense_gl: e.target.value })}>
                    {[["5030", "Property management"], ["5170", "Building manager wages"],
                      ["5175", "Employer contributions"], ["5900", "Other operating"]]
                      .map(([c, n]) => <option key={c} value={c}>{c} · {n}</option>)}
                  </select>
                </label>
              </div>
            </div>
          );
        })}

        <button className="ac-btn ac-btn--xs ac-btn--ghost"
                onClick={() => setParts([...parts, { label: "", basis: "flat",
                  flat_amount: 0, gst_applies: true, expense_gl: "5030" }])}>
          + Another part
        </button>
      </div>

      {/* A floor and a ceiling belong to the formula, not to a part. A minimum
          applied per part would guarantee the minimum several times over. */}
      <div className="ac-capbox">
        <div className="ac-panel-h">Floor and ceiling <em>optional</em></div>
        <div className="ac-row">
          <label className="ac-f"><span>Minimum per month ($)</span>
            <input className="ac-in" type="number" step="0.01" value={cap.minimum}
                   onChange={(e) => setCap({ ...cap, minimum: e.target.value })} /></label>
          <label className="ac-f"><span>Maximum per month ($)</span>
            <input className="ac-in" type="number" step="0.01" value={cap.maximum}
                   onChange={(e) => setCap({ ...cap, maximum: e.target.value })} /></label>
          <label className="ac-f"><span>Or not more than (% of income)</span>
            <input className="ac-in" type="number" step="0.01"
                   value={cap.max_percent_of_income}
                   onChange={(e) => setCap({ ...cap, max_percent_of_income: e.target.value })} />
            <em className="ac-hint">How most agreements word a ceiling.</em>
          </label>
        </div>
      </div>

      <div className="ac-row">
        <label className="ac-f"><span>Effective from</span>
          <input className="ac-in" type="date" value={from}
                 onChange={(e) => setFrom(e.target.value)} />
          <em className="ac-hint">
            Earlier months keep the old version. A change reaching backwards would
            restate what has already been paid.
          </em>
        </label>
        <label className="ac-f" style={{ flex: "2 1 260px" }}>
          <span>Why it changed <em>the next person will want it</em></span>
          <input className="ac-in" value={note}
                 placeholder="Agreed with the owner at the annual review"
                 onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>

      {err && <div className="ac-err">{err}</div>}
      <div className="ac-actions">
        <button className="ac-btn" onClick={submit}>Save the new version</button>
        <button className="ac-btn ac-btn--ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/** Bands. Each applies only to the part of the income inside it, which is how
 *  agreements are almost always meant even when loosely worded — a flat rate
 *  on the whole amount would step sharply at the boundary, and nobody agrees
 *  to that once they see the number. */
function TierEditor({ tiers, onChange }) {
  const list = tiers.length ? tiers : [{ upto: 50000, rate: 0.05 }, { upto: null, rate: 0.03 }];
  return (
    <div className="ac-tiers">
      {list.map((t, i) => (
        <div className="ac-tier" key={i}>
          <span className="ac-dim">{i === 0 ? "Up to" : "Then up to"}</span>
          <input className="ac-in ac-in--sm" type="number"
                 value={t.upto ?? ""} placeholder="no limit"
                 onChange={(e) => onChange(list.map((x, j) => j === i
                   ? { ...x, upto: e.target.value ? Number(e.target.value) : null } : x))} />
          <span className="ac-dim">at</span>
          <input className="ac-in ac-in--sm" type="number" step="0.01"
                 value={t.rate * 100}
                 onChange={(e) => onChange(list.map((x, j) => j === i
                   ? { ...x, rate: Number(e.target.value) / 100 } : x))} />
          <span className="ac-dim">%</span>
          {list.length > 2 && (
            <button className="ac-x"
                    onClick={() => onChange(list.filter((_, j) => j !== i))}>×</button>
          )}
        </div>
      ))}
      <button className="ac-btn ac-btn--xs ac-btn--ghost"
              onClick={() => onChange([...list.slice(0, -1),
                { upto: null, rate: list[list.length - 1].rate }])}>
        + Another band
      </button>
      <p className="ac-hint">
        The last band has no upper limit, or income above it would be unpriced.
      </p>
    </div>
  );
}

/* ---------- Distribution ---------- */

function Distribute({ available, period, session, onSave }) {
  const [amount, setAmount] = useState("");
  const [reserve, setReserve] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");

  const value = cents(Number(amount) || 0);
  const held = cents(Number(reserve) || 0);
  const ceiling = cents(available - held);

  return (
    <div className="ac-panel">
      <div className="ac-row">
        <label className="ac-f"><span>Amount</span>
          <input className="ac-in" type="number" step="0.01" value={amount}
                 onChange={(e) => setAmount(e.target.value)} /></label>
        <label className="ac-f"><span>Hold back a reserve <em>optional</em></span>
          <input className="ac-in" type="number" step="0.01" value={reserve}
                 onChange={(e) => setReserve(e.target.value)} />
          <em className="ac-hint">
            A month with a boiler in it costs more than a month without one.
          </em>
        </label>
      </div>
      <label className="ac-f"><span>Note</span>
        <input className="ac-in" value={note} onChange={(e) => setNote(e.target.value)} /></label>

      {value > ceiling && (
        <div className="ac-err">
          More than the {money(ceiling)} available after the reserve. Taking it out
          would leave commitments unpaid.
        </div>
      )}
      {err && <div className="ac-err">{err}</div>}

      <div className="ac-actions">
        <button className="ac-btn" disabled={value <= 0 || value > ceiling}
                onClick={() => onSave({ id: uid("od_"), period, amount: value,
                  reserve_held: held, cash_available: available, note,
                  state: "paid", approved_name: session?.name, paid_at: nowISO(),
                  method: `Cash available ${money(available)} less reserve ${money(held)}. Distributed ${money(value)}.` })}>
          Record {money(value)}
        </button>
        <span className="ac-dim">
          Posts against owner draws, not as an expense — a distribution reduces equity
          rather than profit.
        </span>
      </div>
    </div>
  );
}

/* ---------- helpers ---------- */

function nextMonthStart() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).toISOString().slice(0, 10);
}
function prevDay(iso) {
  return new Date(new Date(iso).getTime() - 864e5).toISOString().slice(0, 10);
}
function buildFeeMethod(period, f, calc) {
  return [
    `${f.label_en} for ${period}.`, ``,
    `Income counted (${f.income_basis}):`,
    ...calc.lines.map((l) => `  ${l.gl} ${l.name}: ${money(l.amount)}`),
    `  Total: ${money(calc.base)}`, ``,
    `Fee: ${money(calc.base)} × ${(f.rate * 100).toFixed(2)}% = ${money(calc.subtotal)}`,
    f.gst_applies ? `GST: ${money(calc.gst)}` : `GST: not applied.`,
    `Total: ${money(calc.total)}`,
  ].join("\n");
}

export const MONTH_END_CSS = `
.ac-feelines{border:1px solid var(--rule);border-radius:3px;overflow:hidden}
.ac-feelines-h{background:#F5F7F9;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;
  color:var(--dim);font-family:'IBM Plex Mono',monospace;padding:6px 12px;
  border-bottom:1px solid var(--rule)}
.ac-feeline{display:grid;grid-template-columns:52px 1fr 120px;gap:10px;padding:6px 12px;
  font-size:13px;border-bottom:1px solid #EEF2F4}
.ac-feeline:last-child{border-bottom:0}
.ac-feeline>span:last-child{text-align:right}
.ac-feeline--t{font-weight:700;background:#FCFDFE}
.ac-engagement{border:1px solid var(--rule);border-radius:3px;padding:12px 14px;
  display:flex;flex-direction:column;gap:8px;background:#FCFDFE}
.ac-eng-h{font-size:12.5px;font-weight:600;color:var(--ink2)}
.ac-opts{display:flex;gap:7px}
.ac-opts button{font:inherit;font-size:13px;cursor:pointer;background:var(--paper);
  border:1px solid var(--rule);border-radius:3px;padding:8px 16px;color:var(--ink2)}
.ac-opts button.on{background:var(--ink);color:#fff;border-color:var(--ink);font-weight:600}
.ac-deductions{display:flex;flex-direction:column;gap:6px;border-top:1px solid var(--rule);
  padding-top:9px;margin-top:4px}
.ac-scope{display:flex;flex-wrap:wrap;gap:5px}
.ac-scope label{display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;
  border:1px solid var(--rule);border-radius:12px;padding:3px 10px;color:var(--dim)}
.ac-scope label.on{border-color:var(--ink);color:var(--ink);background:#FCFDFE}
.ac-scope input{margin:0}
.ac-dist{display:flex;flex-direction:column;gap:1px;background:var(--rule);
  border:1px solid var(--rule);border-radius:3px;overflow:hidden}
.ac-dist-r{display:flex;justify-content:space-between;gap:12px;padding:8px 13px;
  background:var(--paper);font-size:13px}
.ac-dist-r em{font-style:normal;color:var(--dim);font-size:11.5px}
.ac-dist-t{font-weight:700;background:#FCFDFE;font-size:14px}
.ac-check{display:flex;gap:9px;align-items:center;font-size:13px;color:var(--ink2);cursor:pointer}
.ac-remun{display:flex;flex-direction:column;gap:1px;background:var(--rule);
  border:1px solid var(--rule);border-radius:3px;overflow:hidden}
.ac-remun-r{display:flex;justify-content:space-between;gap:12px;padding:9px 13px;
  background:var(--paper);font-size:13px}
.ac-remun-r em{font-style:normal;color:var(--dim);font-size:11.5px}
.ac-remun-t{font-weight:700;background:#FCFDFE;font-size:15px}
.ac-remun-pct{background:#F7F9FB;color:var(--dim);font-size:12.5px}
.ac-parts{display:flex;flex-direction:column;gap:10px}
.ac-part{border:1px solid var(--rule);border-radius:4px;padding:12px 14px;background:var(--paper);
  display:flex;flex-direction:column;gap:8px}
.ac-part-h{display:flex;gap:7px;align-items:center}
.ac-part-h .ac-in,.ac-part-h .ac-sel{flex:1 1 140px}
.ac-capbox{border:1px dashed var(--rule);border-radius:4px;padding:11px 13px;
  display:flex;flex-direction:column;gap:8px}
.ac-capbox em{font-style:normal;color:var(--dim);font-weight:400}
.ac-tiers{display:flex;flex-direction:column;gap:6px}
.ac-tier{display:flex;gap:7px;align-items:center;font-size:12.5px}
.ac-tier .ac-in{width:100px}
.ac-warnbox{font-size:12.5px;color:#6B5410;background:var(--amber);
  border:1px solid var(--amberline);border-radius:3px;padding:9px 12px;line-height:1.65}
`;
