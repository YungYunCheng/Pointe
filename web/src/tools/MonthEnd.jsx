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
const thisPeriod = () => new Date().toISOString().slice(0, 7);

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
                                   distributions, save, canPost, session }) {
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
          <FormulaEditor formula={feeFormula} kind="fee" period={period}
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
          <FormulaEditor formula={payFormula} kind="pay" period={period}
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

/* ---------- Formula editor ---------- */

/** Changing a rate opens a new version from a date rather than editing in
 *  place. Editing would silently restate every month already calculated. */
function FormulaEditor({ formula, kind, period, calculations, onCancel, onSave }) {
  const [rate, setRate] = useState(kind === "fee"
    ? String((formula.rate ?? 0) * 100) : String(formula.per_unit_rate ?? 0));
  const [from, setFrom] = useState(nextMonthStart());
  const [scope, setScope] = useState(formula.income_scope ?? DEFAULT_SCOPE);
  const [basis, setBasis] = useState(formula.income_basis ?? "collected");
  const [unitScope, setUnitScope] = useState(formula.unit_scope ?? "all");
  const [gstApplies, setGstApplies] = useState(!!formula.gst_applies);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");

  // A month already posted cannot be restated: that figure has been reported
  // and possibly paid.
  const posted = (calculations ?? []).filter((c) =>
    ["posted", "paid"].includes(c.state) && c.period >= from.slice(0, 7));

  const submit = () => {
    setErr("");
    if (posted.length)
      return setErr(`${posted[0].period} has already been posted. Set the new rate from a later date.`);
    const value = Number(rate);
    if (!value || value <= 0) return setErr("Enter a rate.");
    onSave({ id: uid("ff_"), code: formula.code, label_en: formula.label_en,
      label_zh: formula.label_zh, basis: formula.basis,
      rate: kind === "fee" ? cents(value) / 100 : null,
      per_unit_rate: kind === "fee" ? null : cents(value),
      income_scope: scope, income_basis: basis, unit_scope: unitScope,
      gst_applies: gstApplies ? 1 : 0, gst_rate: formula.gst_rate ?? 0.05,
      expense_gl: formula.expense_gl, gst_gl: formula.gst_gl,
      payable_gl: formula.payable_gl, effective_from: from, note: note.trim() || null,
      created_name: "you", created_at: nowISO() });
  };

  return (
    <div className="ac-panel">
      <div className="ac-row">
        <label className="ac-f">
          <span>{kind === "fee" ? "Rate (%)" : "Per unit ($)"}</span>
          <input className="ac-in" type="number" step="0.01" value={rate}
                 onChange={(e) => setRate(e.target.value)} />
        </label>
        <label className="ac-f">
          <span>Effective from</span>
          <input className="ac-in" type="date" value={from}
                 onChange={(e) => setFrom(e.target.value)} />
          <em className="ac-hint">
            Earlier months keep the old rate. A change that reached backwards would
            restate what has already been paid.
          </em>
        </label>
      </div>

      {kind === "fee" ? (
        <>
          <div className="ac-f">
            <span>Charged on</span>
            <div className="ac-scope">
              {INCOME_ACCOUNTS.map(([code, name]) => (
                <label key={code} className={scope.includes(code) ? "on" : ""}>
                  <input type="checkbox" checked={scope.includes(code)}
                         onChange={(e) => setScope(e.target.checked
                           ? [...scope, code] : scope.filter((c) => c !== code))} />
                  <span className="ac-mono">{code}</span> {name}
                </label>
              ))}
            </div>
            <em className="ac-hint">
              Which income counts is the part owners argue about. Late fees and damage
              recovery are usually left out — a percentage of a penalty rewards the penalty.
            </em>
          </div>
          <div className="ac-row">
            <label className="ac-f"><span>Based on</span>
              <select className="ac-sel" value={basis} onChange={(e) => setBasis(e.target.value)}>
                <option value="collected">What was collected</option>
                <option value="billed">What was billed</option>
              </select>
              <em className="ac-hint">
                Collected is the fairer basis: billed pays a fee on arrears nobody recovered.
              </em>
            </label>
            <label className="ac-check" style={{ alignSelf: "flex-end" }}>
              <input type="checkbox" checked={gstApplies}
                     onChange={(e) => setGstApplies(e.target.checked)} />
              <span>Add GST</span>
            </label>
          </div>
        </>
      ) : (
        <label className="ac-f"><span>Units counted</span>
          <select className="ac-sel" value={unitScope} onChange={(e) => setUnitScope(e.target.value)}>
            <option value="all">Every unit (330)</option>
            <option value="occupied">Occupied and signed only</option>
            <option value="leased">Signed only</option>
          </select>
          <em className="ac-hint">
            All units is the usual basis — a manager looks after an empty suite as much
            as a full one, arguably more during a turnover.
          </em>
        </label>
      )}

      <label className="ac-f"><span>Why it changed <em>the next person will want it</em></span>
        <input className="ac-in" value={note}
               placeholder="Agreed with the owner at the annual review"
               onChange={(e) => setNote(e.target.value)} /></label>

      {err && <div className="ac-err">{err}</div>}
      <div className="ac-actions">
        <button className="ac-btn" onClick={submit}>Save the new rate</button>
        <button className="ac-btn ac-btn--ghost" onClick={onCancel}>Cancel</button>
      </div>
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
`;
