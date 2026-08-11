import React, { useState, useEffect, useMemo, useCallback } from "react";
import Banking from "./AccountingBanking.jsx";
import { AmendDialog, VersionHistory, ChangeLog, InterestRates } from "./AccountingAmend.jsx";
import MonthEnd, { MONTH_END_CSS } from "./MonthEnd.jsx";
import AccountingDocumentReview from "./AccountingDocumentReview.jsx";
import { ai } from "../lib/ai.js";
import api from "../lib/api.js";

/* ============================================================
   BAYDO POINTE — Accounting

   Double entry throughout. Nothing here edits a posted entry: a
   correction is a reversal plus a replacement, which is what makes
   a month closable and an audit survivable.

   Two things in this screen are not stylistic choices.

   A security deposit is the tenant's money held in trust. It shows
   as a liability against a separate bank account, never as revenue,
   and the two balances must agree. The dashboard says so out loud
   when they do not.

   A vendor invoice sits in draft until someone approves it. Draft
   invoices are outside the ledger, so a bill keyed by mistake never
   touches the accounts.
   ============================================================ */

const PERIOD_STATE = {
  open:       { label: "Open",       color: "#8892A0" },
  reconciled: { label: "Reconciled", color: "#1C6FA6" },
  closed:     { label: "Closed",     color: "#0E8577" },
};

const AR_STATE = {
  open:        { label: "Open",        color: "#C98A15" },
  partial:     { label: "Part paid",   color: "#1C6FA6" },
  paid:        { label: "Paid",        color: "#0E8577" },
  written_off: { label: "Written off", color: "#8892A0" },
  void:        { label: "Void",        color: "#8892A0" },
};

const AP_STATE = {
  draft:    { label: "Draft",     color: "#8892A0" },
  approved: { label: "Approved",  color: "#C98A15" },
  partial:  { label: "Part paid", color: "#1C6FA6" },
  paid:     { label: "Paid",      color: "#0E8577" },
  void:     { label: "Void",      color: "#8892A0" },
};

const money = (n) =>
  n == null || isNaN(n) ? "—"
    : new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(n);
const money0 = (n) =>
  n == null || isNaN(n) ? "—"
    : new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD",
                                       maximumFractionDigits: 0 }).format(n);
const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const today = () => new Date().toISOString().slice(0, 10);
const thisPeriod = () => new Date().toISOString().slice(0, 7);
const addDays = (d, n) => {
  const x = new Date(d + "T12:00:00"); x.setDate(x.getDate() + n);
  return x.toISOString().slice(0, 10);
};
const daysBetween = (a, b) =>
  Math.round((new Date(b + "T12:00") - new Date(a + "T12:00")) / 864e5);
const cents = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/* ---------- demo data, replaced by the API ---------- */
const COA_SEED = [
  ["1010", "Operating bank account", "asset", "debit", 1, 0],
  ["1020", "Trust account — security deposits", "asset", "debit", 1, 1],
  ["1100", "Accounts receivable — tenants", "asset", "debit", 0, 0],
  ["1210", "GST receivable", "asset", "debit", 0, 0],
  ["2010", "Accounts payable — vendors", "liability", "credit", 0, 0],
  ["2100", "Security deposits held", "liability", "credit", 0, 1],
  ["2110", "Deposit interest payable", "liability", "credit", 0, 1],
  ["2200", "Prepaid rent", "liability", "credit", 0, 0],
  ["4010", "Rental income", "revenue", "credit", 0, 0],
  ["4020", "Parking income", "revenue", "credit", 0, 0],
  ["4030", "Storage income", "revenue", "credit", 0, 0],
  ["4040", "Pet rent", "revenue", "credit", 0, 0],
  ["4060", "Late fees", "revenue", "credit", 0, 0],
  ["5010", "Repairs and maintenance", "expense", "debit", 0, 0],
  ["5020", "Utilities — electricity", "expense", "debit", 0, 0],
  ["5021", "Utilities — gas and heat", "expense", "debit", 0, 0],
  ["5022", "Utilities — water and sewer", "expense", "debit", 0, 0],
  ["5040", "Insurance", "expense", "debit", 0, 0],
  ["5050", "Property taxes", "expense", "debit", 0, 0],
  ["5060", "Cleaning and turnover", "expense", "debit", 0, 0],
  ["5070", "Landscaping and snow removal", "expense", "debit", 0, 0],
  ["5100", "Deposit interest expense", "expense", "debit", 0, 0],
  ["5120", "Bank charges", "expense", "debit", 0, 0],
  ["5900", "Other operating expenses", "expense", "debit", 0, 0],
].map(([code, name, type, side, bank, trust]) =>
  ({ code, name, type, normal_side: side, is_bank: bank, is_trust: trust }));

/* Starting formulas. Both are editable and versioned by effective date — these
   are what was described, not what an accountant has confirmed. */
const SEED_FORMULAS = [
  { id: "ff_mgmt", code: "management_fee", label_en: "Property management fee",
    label_zh: "物業管理費", basis: "percent_of_income", rate: 0.04,
    income_scope: ["4010", "4020", "4030", "4040", "4080"], income_basis: "collected",
    gst_applies: 1, gst_rate: 0.05, expense_gl: "5030", gst_gl: "1210",
    payable_gl: "2420", effective_from: `${new Date().getFullYear()}-01-01`,
    note: "4% of rent, parking, storage, pet rent and laundry collected, plus GST." },
  { id: "ff_bm", code: "bm_payroll", label_en: "Building manager", label_zh: "管理員薪資",
    basis: "per_unit", per_unit_rate: 30, unit_scope: "all", gst_applies: 0,
    expense_gl: "5170", payable_gl: "2410",
    effective_from: `${new Date().getFullYear()}-01-01`,
    note: "$30 per unit per month across all 330 units." },
];

const VENDOR_SEED = [
  { id: "vn_1", name: "Northgate Plumbing", email: "ap@northgateplumbing.ca",
    phone: "780-555-0301", default_gl: "5010", payment_terms: 30 },
  { id: "vn_2", name: "EPCOR", email: "billing@epcor.com", default_gl: "5020", payment_terms: 21 },
  { id: "vn_3", name: "Clareview Landscaping", email: "info@clareviewland.ca",
    phone: "780-555-0344", default_gl: "5070", payment_terms: 30 },
  { id: "vn_4", name: "SureLock Security", email: "accounts@surelock.ca",
    default_gl: "5130", payment_terms: 15 },
];

export default function Accounting() {
  const [session, setSession] = useState(undefined);
  const [tab, setTab] = useState("dashboard");
  const [saveState, setSaveState] = useState("idle");

  const [coa, setCoa] = useState(COA_SEED);
  const [vendors, setVendors] = useState(VENDOR_SEED);
  const [invoices, setInvoices] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [charges, setCharges] = useState([]);
  const [receipts, setReceipts] = useState([]);
  const [entries, setEntries] = useState([]);
  const [periods, setPeriods] = useState([]);
  const [statements, setStatements] = useState([]);
  const [reports, setReports] = useState([]);
  const [amendments, setAmendments] = useState([]);
  const [rates, setRates] = useState([]);
  const [proposals, setProposals] = useState([]);
  const [formulas, setFormulas] = useState([]);
  const [calculations, setCalculations] = useState([]);
  const [payrollRuns, setPayrollRuns] = useState([]);
  const [distributions, setDistributions] = useState([]);
  const [gstReturns, setGstReturns] = useState([]);
  const [assets, setAssets] = useState([]);
  const [depreciationRuns, setDepreciationRuns] = useState([]);
  const [arrearsFiles, setArrearsFiles] = useState([]);
  const [loading, setLoading] = useState(true);

  const canPost = session?.role === "accounting" || session?.role === "admin";

  /* ---------- load ---------- */
  useEffect(() => {
    (async () => {
      const read = async (k, d) => {
        try { const r = await window.storage.get(k); return r?.value ? JSON.parse(r.value) : d; }
        catch { return d; }
      };
      setSession(await read("baydo:session", null));
      setVendors(await read("acct:vendors", VENDOR_SEED));
      setInvoices(await read("acct:invoices", []));
      setSchedules(await read("acct:schedules", []));
      setCharges(await read("acct:charges", []));
      setReceipts(await read("acct:receipts", []));
      setEntries(await read("acct:entries", []));
      setPeriods(await read("acct:periods", []));
      setStatements(await read("acct:statements", []));
      setReports(await read("acct:reports", []));
      setAmendments(await read("acct:amendments", []));
      setRates(await read("acct:rates", []));
      setProposals(await read("acct:proposals", []));
      setFormulas(await read("acct:formulas", SEED_FORMULAS));
      setCalculations(await read("acct:calculations", []));
      setPayrollRuns(await read("acct:payroll", []));
      setDistributions(await read("acct:distributions", []));
      setGstReturns(await read("acct:gst", []));
      setAssets(await read("acct:assets", []));
      setDepreciationRuns(await read("acct:depreciation", []));
      setArrearsFiles(await read("acct:arrears", []));
      try {
        const shared = await api.accountingReviewCenter();
        setVendors(shared.vendors?.length ? shared.vendors : VENDOR_SEED);
        setInvoices(shared.invoices ?? []);
        setReports(shared.reports ?? []);
        if (shared.accounts?.length) setCoa(shared.accounts);
      } catch {
        // The local prototype remains readable while the migration or API is
        // unavailable. The review page explains what needs to be connected.
      }
      setLoading(false);
    })();
  }, []);

  const persist = useCallback(async (key, value) => {
    setSaveState("saving");
    try {
      const ok = await window.storage.set(key, JSON.stringify(value));
      setSaveState(ok ? "saved" : "error");
    } catch { setSaveState("error"); }
    setTimeout(() => setSaveState((s) => (s === "saved" ? "idle" : s)), 1500);
  }, []);

  const save = {
    vendors: (v) => { setVendors(v); persist("acct:vendors", v); },
    invoices: (v) => { setInvoices(v); persist("acct:invoices", v); },
    schedules: (v) => { setSchedules(v); persist("acct:schedules", v); },
    charges: (v) => { setCharges(v); persist("acct:charges", v); },
    receipts: (v) => { setReceipts(v); persist("acct:receipts", v); },
    entries: (v) => { setEntries(v); persist("acct:entries", v); },
    periods: (v) => { setPeriods(v); persist("acct:periods", v); },
    statements: (v) => { setStatements(v); persist("acct:statements", v); },
    reports: (v) => { setReports(v); persist("acct:reports", v); },
    amendments: (v) => { setAmendments(v); persist("acct:amendments", v); },
    rates: (v) => { setRates(v); persist("acct:rates", v); },
    proposals: (v) => { setProposals(v); persist("acct:proposals", v); },
    formulas: (v) => { setFormulas(v); persist("acct:formulas", v); },
    calculations: (v) => { setCalculations(v); persist("acct:calculations", v); },
    payroll: (v) => { setPayrollRuns(v); persist("acct:payroll", v); },
    distributions: (v) => { setDistributions(v); persist("acct:distributions", v); },
    gstReturns: (v) => { setGstReturns(v); persist("acct:gst", v); },
    assets: (v) => { setAssets(v); persist("acct:assets", v); },
    depreciationRuns: (v) => { setDepreciationRuns(v); persist("acct:depreciation", v); },
    arrears: (v) => { setArrearsFiles(v); persist("acct:arrears", v); },
  };

  const syncReviewData = useCallback((shared) => {
    if (shared.vendors) setVendors(shared.vendors);
    if (shared.invoices) setInvoices(shared.invoices);
    if (shared.reports) setReports(shared.reports);
    if (shared.accounts?.length) setCoa(shared.accounts);
  }, []);

  /* ---------- posting ----------
     Mirrors the server. Balanced or it does not post, and a closed
     period rejects everything. */
  const periodStateOf = useCallback(
    (p) => periods.find((x) => x.period === p)?.state ?? "open", [periods]);

  const post = useCallback(({ date, building, source, sourceId, memo, lines }) => {
    const p = date.slice(0, 7);
    if (periodStateOf(p) === "closed")
      throw new Error(`Period ${p} is closed. Post to an open period, or reopen it.`);
    const d = cents(lines.reduce((s, l) => s + (l.debit || 0), 0));
    const c = cents(lines.reduce((s, l) => s + (l.credit || 0), 0));
    if (d !== c) throw new Error(`Entry does not balance: debits ${money(d)}, credits ${money(c)}.`);
    if (d === 0) throw new Error("Entry has no value.");

    const entry = {
      id: uid("je_"),
      entry_no: entries.reduce((m, e) => Math.max(m, e.entry_no || 0), 0) + 1,
      entry_date: date, period: p, building_code: building ?? null,
      source, source_id: sourceId ?? null, memo: memo ?? null, state: "posted",
      by: session?.name ?? "unsigned", at: new Date().toISOString(),
      lines: lines.map((l, i) => ({ line_no: i + 1, gl: l.gl,
        debit: cents(l.debit || 0), credit: cents(l.credit || 0),
        unit: l.unit ?? null, vendor_id: l.vendorId ?? null, memo: l.memo ?? null })),
    };
    save.entries([entry, ...entries]);
    return entry;
  }, [entries, periods, periodStateOf, session]);

  /* ---------- derived ---------- */
  const glName = useCallback((code) => coa.find((a) => a.code === code)?.name ?? code, [coa]);

  const balances = useMemo(() => {
    const b = {};
    for (const e of entries) {
      if (e.state !== "posted") continue;
      for (const l of e.lines) {
        b[l.gl] ||= { d: 0, c: 0 };
        b[l.gl].d = cents(b[l.gl].d + l.debit);
        b[l.gl].c = cents(b[l.gl].c + l.credit);
      }
    }
    const out = {};
    for (const a of coa) {
      const x = b[a.code] || { d: 0, c: 0 };
      out[a.code] = { ...x,
        balance: a.normal_side === "debit" ? cents(x.d - x.c) : cents(x.c - x.d) };
    }
    return out;
  }, [entries, coa]);

  const stats = useMemo(() => {
    const open = charges.filter((c) => ["open", "partial"].includes(c.state));
    const overdue = open.filter((c) => c.due_date < today());
    const ap = invoices.filter((i) => ["approved", "partial"].includes(i.state));
    const apOver = ap.filter((i) => i.due_date < today());
    const trustLedger = balances["1020"]?.balance ?? 0;
    const depositLiability = cents((balances["2100"]?.balance ?? 0) + (balances["2110"]?.balance ?? 0));
    return {
      arOpen: cents(open.reduce((t, c) => t + (c.amount - c.paid_amount), 0)),
      arCount: open.length,
      arOverdue: cents(overdue.reduce((t, c) => t + (c.amount - c.paid_amount), 0)),
      arOverdueCount: overdue.length,
      apOpen: cents(ap.reduce((t, i) => t + (i.total - i.paid_amount), 0)),
      apCount: ap.length,
      apOverdue: cents(apOver.reduce((t, i) => t + (i.total - i.paid_amount), 0)),
      drafts: invoices.filter((i) => i.state === "draft").length,
      operating: balances["1010"]?.balance ?? 0,
      trustLedger, depositLiability,
      trustAgrees: cents(trustLedger) === depositLiability,
    };
  }, [charges, invoices, balances]);

  if (loading || session === undefined)
    return <div className="ac"><style>{CSS}</style><div className="ac-load">Loading…</div></div>;

  if (session && !["accounting", "admin", "property_manager"].includes(session.role))
    return (
      <div className="ac"><style>{CSS}</style>
        <div className="ac-deny">
          <h2>No access</h2>
          <p>Accounting is limited to the accounting and admin roles.
             You are signed in as {session.name}.</p>
        </div>
      </div>
    );

  const TABS = [
    ["dashboard", "Overview"],
    ["ar", "Rent and AR"],
    ["ap", "Bills and AP"],
    ["review", "Invoice & report review"],
    ["search", "Transactions"],
    ["banking", "Banking"],
    ["reports", "Reports"],
    ["coa", "Accounts"],
    ["arrears", "Arrears files"],
    ["monthend", "Month end"],
    ["changelog", "Change log"],
    ["settings", "Settings"],
  ];

  return (
    <div className="ac">
      <style>{CSS}</style>

      <header className="ac-head">
        <div>
          <div className="ac-eyebrow">Baydo Pointe · Accounting</div>
          <h1>{TABS.find((t) => t[0] === tab)?.[1]}</h1>
        </div>
        <div className="ac-headr">
          {session && (
            <span className="ac-who">
              <span className="ac-chip" style={{
                background: session.role === "accounting" ? "#0E8577"
                  : session.role === "admin" ? "#131C25" : "#1C6FA6" }}>
                {session.role === "accounting" ? "Accounting"
                  : session.role === "admin" ? "Admin" : "Read only"}
              </span>
              {session.name}
            </span>
          )}
          <span className={`ac-save ac-save--${saveState}`}>
            {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved"
              : saveState === "error" ? "Save failed" : "Autosaves"}
          </span>
        </div>
      </header>

      <nav className="ac-tabs">
        {TABS.map(([k, label]) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
            {label}
            {k === "ap" && stats.drafts > 0 && <i className="ac-b">{stats.drafts}</i>}
            {k === "ar" && stats.arOverdueCount > 0 && <i className="ac-b">{stats.arOverdueCount}</i>}
          </button>
        ))}
      </nav>

      {!canPost && (
        <div className="ac-note">
          Read only. Posting, approving and reconciling belong to the accounting role;
          arrears are here because leasing needs to see them.
        </div>
      )}

      {tab === "dashboard" && <Dashboard {...{ stats, balances, coa, charges, invoices,
        periods, periodStateOf, glName }} />}
      {tab === "ar" && <AR {...{ schedules, charges, receipts, save, post, canPost,
        session, glName, coa, periodStateOf, amendments }} />}
      {tab === "ap" && <AP {...{ vendors, invoices, save, post, canPost, coa, glName,
        session, amendments }} onOpenReview={() => setTab("review")} />}
      {tab === "review" && <AccountingDocumentReview session={session} onData={syncReviewData} />}
      {tab === "search" && <Search {...{ entries, glName, vendors }} />}
      {tab === "banking" && <Banking {...{ statements, entries, receipts, invoices, periods,
        balances, save, canPost, session, coa }} />}
      {tab === "reports" && <Reports {...{ reports, periods, entries, charges, receipts,
        coa, save, canPost, session }} onOpenReview={() => setTab("review")} />}
      {tab === "coa" && <ChartOfAccounts {...{ coa, balances, setCoa, canPost }} />}
      {tab === "arrears" && <ArrearsFiles {...{ charges, files: arrearsFiles,
        canPost, session, save, flash: (t) => setSaveState("saved") }} />}
      {tab === "monthend" && <MonthEnd {...{ period: thisPeriod(), charges, receipts,
        entries, invoices, coa, formulas, calculations, payroll: payrollRuns,
        distributions, gstReturns, assets, depreciationRuns,
        save, canPost, session }} />}
      {tab === "changelog" && <ChangeLog {...{ amendments, entries, save, canPost }} />}
      {tab === "settings" && <InterestRates {...{ rates, proposals, save, canPost, session }} />}

      <footer className="ac-foot">
        Accrual basis: revenue is recognised when billed, expenses when incurred.
        A security deposit is never revenue — it is the tenant’s money held in trust,
        and the balance on 2100 must agree with the trust bank account 1020 at all times.
        Confirm the deposit interest rate and the refund deadline with your manager
        before relying on either.
      </footer>
    </div>
  );
}

/* ══════════════════ Dashboard ══════════════════ */

function Dashboard({ stats, balances, coa, charges, invoices, periods, periodStateOf, glName }) {
  const p = thisPeriod();
  const state = periodStateOf(p);

  const pnl = useMemo(() => {
    const rev = coa.filter((a) => a.type === "revenue")
      .map((a) => ({ ...a, amount: balances[a.code]?.balance ?? 0 }))
      .filter((a) => a.amount !== 0);
    const exp = coa.filter((a) => a.type === "expense")
      .map((a) => ({ ...a, amount: balances[a.code]?.balance ?? 0 }))
      .filter((a) => a.amount !== 0);
    const rt = cents(rev.reduce((t, a) => t + a.amount, 0));
    const et = cents(exp.reduce((t, a) => t + a.amount, 0));
    return { rev, exp, rt, et, noi: cents(rt - et) };
  }, [coa, balances]);

  const aging = useMemo(() => {
    const buckets = { current: 0, d30: 0, d60: 0, d90: 0 };
    for (const c of charges) {
      if (!["open", "partial"].includes(c.state)) continue;
      const owing = cents(c.amount - c.paid_amount);
      const late = daysBetween(c.due_date, today());
      if (late <= 0) buckets.current = cents(buckets.current + owing);
      else if (late <= 30) buckets.d30 = cents(buckets.d30 + owing);
      else if (late <= 60) buckets.d60 = cents(buckets.d60 + owing);
      else buckets.d90 = cents(buckets.d90 + owing);
    }
    return buckets;
  }, [charges]);

  return (
    <div className="ac-body">
      <div className="ac-stats">
        <Stat l="Operating bank" v={money0(stats.operating)} />
        <Stat l="Owed by tenants" v={money0(stats.arOpen)} sub={`${stats.arCount} charges`} />
        <Stat l="Overdue" v={money0(stats.arOverdue)} tone={stats.arOverdue > 0 ? "warn" : null}
              sub={`${stats.arOverdueCount} charges`} />
        <Stat l="Owed to vendors" v={money0(stats.apOpen)} sub={`${stats.apCount} invoices`} />
        <Stat l={`Period ${p}`} v={PERIOD_STATE[state].label} small />
      </div>

      {/* The trust check. Out of agreement means operating money has been
          mixed with deposits, which is the fastest way to be unable to
          refund one. */}
      <section className={`ac-card ${stats.trustAgrees ? "" : "ac-card--bad"}`}>
        <h2>Security deposits held in trust</h2>
        <div className="ac-trust">
          <div><em>Trust bank account (1020)</em><strong>{money(stats.trustLedger)}</strong></div>
          <div><em>Owed to tenants (2100 + 2110)</em><strong>{money(stats.depositLiability)}</strong></div>
          <div className={stats.trustAgrees ? "ac-ok" : "ac-bad"}>
            {stats.trustAgrees
              ? "In agreement"
              : `Out by ${money(cents(stats.trustLedger - stats.depositLiability))}`}
          </div>
        </div>
        <p className="ac-note-p">
          {stats.trustAgrees
            ? "These two must always match. Deposits are tenant money and the trust account holds nothing else."
            : "These two must match. A difference means the trust account has been used for something else, or a deposit was posted to the wrong account. Find it before the next refund."}
        </p>
      </section>

      <div className="ac-two">
        <section className="ac-card">
          <h2>This period</h2>
          {pnl.rev.length === 0 && pnl.exp.length === 0 ? (
            <div className="ac-empty">Nothing posted yet.</div>
          ) : (
            <>
              <div className="ac-pl">
                <div className="ac-pl-h">Revenue</div>
                {pnl.rev.map((a) => (
                  <div className="ac-pl-r" key={a.code}>
                    <span className="ac-mono">{a.code}</span><span>{a.name}</span>
                    <span className="ac-mono">{money(a.amount)}</span>
                  </div>
                ))}
                <div className="ac-pl-r ac-pl-t">
                  <span /><span>Total revenue</span><span className="ac-mono">{money(pnl.rt)}</span>
                </div>
              </div>
              <div className="ac-pl">
                <div className="ac-pl-h">Expenses</div>
                {pnl.exp.map((a) => (
                  <div className="ac-pl-r" key={a.code}>
                    <span className="ac-mono">{a.code}</span><span>{a.name}</span>
                    <span className="ac-mono">{money(a.amount)}</span>
                  </div>
                ))}
                <div className="ac-pl-r ac-pl-t">
                  <span /><span>Total expenses</span><span className="ac-mono">{money(pnl.et)}</span>
                </div>
              </div>
              <div className="ac-noi">
                <span>Net operating income</span>
                <strong className={pnl.noi < 0 ? "ac-bad" : ""}>{money(pnl.noi)}</strong>
              </div>
            </>
          )}
        </section>

        <section className="ac-card">
          <h2>Arrears ageing</h2>
          <div className="ac-aging">
            {[["Not yet due", aging.current, "#8892A0"],
              ["1–30 days", aging.d30, "#C98A15"],
              ["31–60 days", aging.d60, "#B26A3A"],
              ["Over 60 days", aging.d90, "#B23A54"]].map(([label, amt, c]) => (
              <div className="ac-age" key={label}>
                <span>{label}</span>
                <strong className="ac-mono" style={{ color: amt > 0 ? c : "#B8C2C9" }}>
                  {money(amt)}
                </strong>
              </div>
            ))}
          </div>
          <p className="ac-note-p">
            Anything past sixty days rarely collects itself. That is the column
            worth acting on, not the total.
          </p>
        </section>
      </div>
    </div>
  );
}

function Stat({ l, v, sub, tone, small }) {
  return (
    <div className="ac-stat">
      <div className="ac-stat-l">{l}</div>
      <div className={`ac-stat-v ${tone === "warn" ? "warn" : ""} ${small ? "sm" : ""}`}>{v}</div>
      {sub && <div className="ac-stat-s">{sub}</div>}
    </div>
  );
}

/* ══════════════════ AR ══════════════════ */

function AR({ schedules, charges, receipts, save, post, canPost, session, coa,
              periodStateOf, amendments }) {
  const [view, setView] = useState("charges");
  const [amendCharge, setAmendCharge] = useState(null);
  const [amendReceipt, setAmendReceipt] = useState(null);
  const [newSched, setNewSched] = useState(false);
  const [runPeriod, setRunPeriod] = useState(thisPeriod());
  const [receiptFor, setReceiptFor] = useState(null);

  /* The tenant's receipt goes out once Accounting has confirmed the money,
     never on the promise of it. A receipt for a payment that later bounces is
     worse than no receipt at all. */
  const issueReceipt = async (rec, applied, balanceAfter) => {
    const number = `R-${new Date().getFullYear()}-${String(receipts.length + 1).padStart(5, "0")}`;
    let queue = [];
    try {
      const r = await window.storage.get("baydo:outbox");
      if (r?.value) queue = JSON.parse(r.value);
    } catch (e) {}

    const body = [
      `Hello,`, "",
      `We have received your payment. Receipt ${number}.`, "",
      `Amount: ${money(rec.amount)}`,
      `Received: ${rec.received_date}`,
      `Method: ${rec.method}`,
      rec.unit_number ? `Suite: ${rec.unit_number}` : "",
      applied.length ? "" : null,
      applied.length ? "Applied to:" : null,
      ...applied.map((a) => `  ${a.period ?? ""} ${a.kind ?? ""}  ${money(a.amount)}`),
      "",
      balanceAfter > 0 ? `Balance outstanding: ${money(balanceAfter)}`
                       : "Nothing is outstanding.",
      "", "───────────────", "",
      `已收到你的款項，收據編號 ${number}。`,
      `金額：${money(rec.amount)}`,
      `收款日：${rec.received_date}`,
      balanceAfter > 0 ? `目前尚欠：${money(balanceAfter)}` : "目前無欠款。",
    ].filter((x) => x !== null && x !== "").join("\n");

    try {
      await window.storage.set("baydo:outbox", JSON.stringify([{
        id: uid("ob_"), kind: "rent_receipt", channel: "email",
        to: rec.tenant_email ?? "", to_name: rec.unit_number,
        subject: `Receipt ${number} · ${money(rec.amount)}`,
        body, ref_type: "payment_receipt", ref_id: rec.id,
        state: "queued", created_at: new Date().toISOString(),
      }, ...queue]));
    } catch (e) {}
    return number;
  };
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const KINDS = [["rent", "4010"], ["parking", "4020"], ["storage", "4030"],
                 ["pet", "4040"], ["late_fee", "4060"]];

  /* Preview before posting. 330 ledgers is not somewhere to find out
     afterwards that a schedule was wrong. */
  const preview = useMemo(() => {
    const [y, m] = runPeriod.split("-").map(Number);
    const dim = new Date(y, m, 0).getDate();
    const start = `${runPeriod}-01`, end = `${runPeriod}-${String(dim).padStart(2, "0")}`;
    const already = new Set(charges.filter((c) => c.period === runPeriod).map((c) => c.schedule_id));
    const due = schedules.filter((s) => s.is_active !== false && s.start_date <= end
      && (!s.end_date || s.end_date >= start) && !already.has(s.id));
    return { due, already: already.size,
             total: cents(due.reduce((t, s) => t + Number(s.amount), 0)), dim };
  }, [schedules, charges, runPeriod]);

  const runRent = () => {
    setErr(""); setMsg("");
    const [y, m] = runPeriod.split("-").map(Number);
    const dim = new Date(y, m, 0).getDate();
    const start = `${runPeriod}-01`, end = `${runPeriod}-${String(dim).padStart(2, "0")}`;
    const made = [];
    try {
      for (const s of preview.due) {
        // A tenancy starting or ending mid-month bills for the days it covers.
        // Charging a full month either way is the small unfairness that becomes
        // a forty dollar argument.
        let amount = Number(s.amount), prorated = false, note = null;
        if (s.start_date > start && s.start_date <= end) {
          const days = daysBetween(s.start_date, end) + 1;
          amount = cents(s.amount * days / dim); prorated = true;
          note = `${days}/${dim} days from ${s.start_date} · ${s.amount} × ${days} ÷ ${dim}`;
        } else if (s.end_date && s.end_date >= start && s.end_date < end) {
          const days = daysBetween(start, s.end_date) + 1;
          amount = cents(s.amount * days / dim); prorated = true;
          note = `${days}/${dim} days to ${s.end_date} · ${s.amount} × ${days} ÷ ${dim}`;
        }
        if (amount <= 0) continue;

        const chargeDate = `${runPeriod}-${String(s.charge_day || 1).padStart(2, "0")}`;
        const dueDate = `${runPeriod}-${String(s.due_day || s.charge_day || 1).padStart(2, "0")}`;
        const id = uid("arc_");
        const entry = post({ date: chargeDate, building: s.unit_number?.slice(0, 3),
          source: "rent_run", sourceId: id,
          memo: `${s.kind} ${s.unit_number} ${runPeriod}`,
          lines: [{ gl: "1100", debit: amount, unit: s.unit_number },
                  { gl: s.gl_code, credit: amount, unit: s.unit_number }] });

        made.push({ id, schedule_id: s.id, unit_number: s.unit_number,
          building_code: s.unit_number?.slice(0, 3), period: runPeriod, kind: s.kind,
          gl_code: s.gl_code, amount, prorated, prorate_note: note,
          charge_date: chargeDate, due_date: dueDate, entry_id: entry.id,
          state: "open", paid_amount: 0 });
      }
      save.charges([...made, ...charges]);
      setMsg(`${made.length} charges raised, ${money(cents(made.reduce((t, c) => t + c.amount, 0)))} total.`);
    } catch (e) { setErr(e.message); }
  };

  const openCharges = charges.filter((c) => ["open", "partial"].includes(c.state));

  return (
    <div className="ac-body">
      <div className="ac-seg">
        {[["charges", "Charges"], ["schedules", "Recurring"], ["receipts", "Receipts"]].map(([k, l]) => (
          <button key={k} className={view === k ? "on" : ""} onClick={() => setView(k)}>{l}</button>
        ))}
      </div>

      {view === "schedules" && (
        <>
          <section className="ac-card">
            <div className="ac-cardh">
              <h2>Recurring charges <span className="ac-n">{schedules.length}</span></h2>
              {canPost && <button className="ac-btn ac-btn--sm" onClick={() => setNewSched(!newSched)}>
                Add a charge
              </button>}
            </div>
            <p className="ac-note-p">
              What each lease bills every month, and on which day. The charge day is
              capped at the 28th: a schedule set to the 30th silently skips February
              and nobody notices until year end.
            </p>

            {newSched && <NewSchedule kinds={KINDS} onAdd={(s) => {
              save.schedules([...schedules, s]); setNewSched(false);
            }} onCancel={() => setNewSched(false)} />}

            {schedules.length === 0 ? <div className="ac-empty">Nothing set up yet.</div> : (
              <div className="ac-table">
                <div className="ac-tr ac-tr--h" style={{ gridTemplateColumns: "1fr 1fr 1fr 90px 90px 1fr 60px" }}>
                  <span>Unit</span><span>Kind</span><span>Account</span><span>Amount</span>
                  <span>Bills on</span><span>Ends</span><span />
                </div>
                {schedules.map((s) => (
                  <div className="ac-tr" key={s.id}
                       style={{ gridTemplateColumns: "1fr 1fr 1fr 90px 90px 1fr 60px" }}>
                    <span className="ac-mono ac-strong">{s.unit_number}</span>
                    <span>{s.kind}</span>
                    <span className="ac-mono ac-dim">{s.gl_code}</span>
                    <span className="ac-mono">{money(s.amount)}</span>
                    <span className="ac-mono">{s.charge_day}</span>
                    <span className="ac-dim">{s.end_date || "—"}</span>
                    <span>
                      {canPost && <button className="ac-x" title="Stop this charge"
                        onClick={() => save.schedules(schedules.map((x) =>
                          x.id === s.id ? { ...x, is_active: false, end_date: x.end_date || today() } : x))}>
                        ×</button>}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {canPost && (
            <section className="ac-card">
              <h2>Run the month</h2>
              <div className="ac-row">
                <label className="ac-f" style={{ maxWidth: 160 }}>
                  <span>Period</span>
                  <input className="ac-in" type="month" value={runPeriod}
                         onChange={(e) => setRunPeriod(e.target.value)} />
                </label>
                <div className="ac-preview">
                  <div><em>Would raise</em><strong>{preview.due.length}</strong></div>
                  <div><em>Already billed</em><strong>{preview.already}</strong></div>
                  <div><em>Estimated</em><strong>{money(preview.total)}</strong></div>
                </div>
                <button className="ac-btn" disabled={preview.due.length === 0} onClick={runRent}>
                  Raise {preview.due.length} charges
                </button>
              </div>
              <p className="ac-note-p">
                Running twice is safe. A schedule already billed for this period is
                skipped, so a retry adds nothing rather than double-charging everyone.
              </p>
              {err && <div className="ac-err">{err}</div>}
              {msg && <div className="ac-ok-box">{msg}</div>}
            </section>
          )}
        </>
      )}

      {view === "charges" && (
        <section className="ac-card">
          <div className="ac-cardh">
            <h2>Charges <span className="ac-n">{charges.length}</span></h2>
            <span className="ac-dim">
              {money(cents(openCharges.reduce((t, c) => t + (c.amount - c.paid_amount), 0)))} outstanding
            </span>
          </div>
          {charges.length === 0 ? <div className="ac-empty">Nothing billed yet.</div> : (
            <div className="ac-table">
              <div className="ac-tr ac-tr--h" style={{ gridTemplateColumns: "90px 1fr 1fr 100px 100px 100px 90px" }}>
                <span>Unit</span><span>Period</span><span>Kind</span><span>Amount</span>
                <span>Outstanding</span><span>Due</span><span />
              </div>
              {charges.slice(0, 200).map((c) => {
                const owing = cents(c.amount - c.paid_amount);
                const late = owing > 0 && c.due_date < today();
                const st = AR_STATE[c.state] ?? AR_STATE.open;
                return (
                  <div className={`ac-tr ${late ? "late" : ""}`} key={c.id}
                       style={{ gridTemplateColumns: "90px 1fr 1fr 100px 100px 100px 90px" }}>
                    <span className="ac-mono ac-strong">{c.unit_number}</span>
                    <span className="ac-mono ac-dim">{c.period}</span>
                    <span>
                      {c.kind}
                      {c.prorated && <span className="ac-pill" title={c.prorate_note}>prorated</span>}
                    </span>
                    <span className="ac-mono">{money(c.amount)}</span>
                    <span className="ac-mono">{owing > 0 ? money(owing) : "—"}</span>
                    <span className={`ac-mono ${late ? "ac-bad" : "ac-dim"}`}>{c.due_date}</span>
                    <span className="ac-actions">
                      {owing > 0 && canPost &&
                        <button className="ac-btn ac-btn--xs" onClick={() => setReceiptFor(c)}>Receipt</button>}
                      {owing === 0 && <span className="ac-tag" style={{ "--c": st.color }}>{st.label}</span>}
                      {canPost && <button className="ac-btn ac-btn--xs ac-btn--ghost"
                                          onClick={() => setAmendCharge(c)}>Amend</button>}
                      {(c.version ?? 1) > 1 && <span className="ac-pill">v{c.version}</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {view === "receipts" && (
        <section className="ac-card">
          <div className="ac-cardh">
            <h2>Receipts <span className="ac-n">{receipts.length}</span></h2>
            {canPost && <button className="ac-btn ac-btn--sm" onClick={() => setReceiptFor({})}>
              Record a payment
            </button>}
          </div>
          {receipts.length === 0 ? <div className="ac-empty">Nothing received yet.</div> : (
            <div className="ac-table">
              <div className="ac-tr ac-tr--h" style={{ gridTemplateColumns: "70px 90px 1fr 110px 1fr 1fr" }}>
                <span>No.</span><span>Unit</span><span>Date</span><span>Amount</span>
                <span>Method</span><span>Reference</span>
              </div>
              {receipts.slice(0, 200).map((r) => (
                <div className="ac-tr" key={r.id}
                     style={{ gridTemplateColumns: "70px 90px 1fr 110px 1fr 1fr" }}>
                  <span className="ac-mono ac-dim">{r.receipt_no}</span>
                  <span className="ac-mono ac-strong">{r.unit_number || "—"}</span>
                  <span className="ac-mono">{r.received_date}</span>
                  <span className="ac-mono">{money(r.amount)}</span>
                  <span>{r.method}</span>
                  <span className="ac-dim">
                    {r.reference || "—"}
                    {(r.version ?? 1) > 1 && <span className="ac-pill">v{r.version}</span>}
                    {canPost && <button className="ac-btn ac-btn--xs ac-btn--ghost"
                                        style={{ marginLeft: 8 }}
                                        onClick={() => setAmendReceipt(r)}>Amend</button>}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {amendCharge && (
        <AmendDialog kind="ar_charge" doc={amendCharge} coa={coa} post={post} session={session}
          onClose={() => setAmendCharge(null)}
          onSave={({ patch, amendment, replacementEntryId }) => {
            save.charges(charges.map((c) => c.id === amendCharge.id
              ? { ...c, ...patch, version: (c.version ?? 1) + 1,
                  entry_id: replacementEntryId ?? c.entry_id,
                  state: cents(c.paid_amount) >= cents(patch.amount) ? "paid"
                    : cents(c.paid_amount) > 0 ? "partial" : "open" } : c));
            if (amendment) save.amendments([amendment, ...amendments]);
            setAmendCharge(null);
          }} />
      )}

      {amendReceipt && (
        <AmendDialog kind="ar_receipt" doc={amendReceipt} coa={coa} post={post} session={session}
          onClose={() => setAmendReceipt(null)}
          onSave={({ patch, amendment, replacementEntryId }) => {
            save.receipts(receipts.map((r) => r.id === amendReceipt.id
              ? { ...r, ...patch, version: (r.version ?? 1) + 1,
                  entry_id: replacementEntryId ?? r.entry_id } : r));
            if (amendment) save.amendments([amendment, ...amendments]);
            setAmendReceipt(null);
          }} />
      )}

      {receiptFor && (
        <ReceiptDialog charge={receiptFor.id ? receiptFor : null}
          charges={openCharges} receipts={receipts} post={post}
          onClose={() => setReceiptFor(null)}
          onSave={async (rec, applied) => {
            const remaining = cents(charges.reduce((t, c) => {
              const a = applied.find((x) => x.charge_id === c.id);
              const paid = cents(c.paid_amount + (a?.amount ?? 0));
              return t + Math.max(0, cents(c.amount - paid));
            }, 0));
            const number = await issueReceipt(rec, applied, remaining);
            save.receipts([{ ...rec, receipt_sent: number }, ...receipts]);
            save.charges(charges.map((c) => {
              const a = applied.find((x) => x.charge_id === c.id);
              if (!a) return c;
              const paid = cents(c.paid_amount + a.amount);
              return { ...c, paid_amount: paid, state: paid >= cents(c.amount) ? "paid" : "partial" };
            }));
            setReceiptFor(null);
          }} />
      )}
    </div>
  );
}

function NewSchedule({ kinds, onAdd, onCancel }) {
  const [f, setF] = useState({ unit_number: "", kind: "rent", gl_code: "4010", amount: "",
                               charge_day: 1, due_day: 1, start_date: today(), end_date: "" });
  const set = (p) => setF({ ...f, ...p });
  const ok = f.unit_number.trim() && Number(f.amount) > 0;
  return (
    <div className="ac-panel">
      <div className="ac-row">
        <label className="ac-f"><span>Unit</span>
          <input className="ac-in" value={f.unit_number} placeholder="378-519"
                 onChange={(e) => set({ unit_number: e.target.value })} /></label>
        <label className="ac-f"><span>Kind</span>
          <select className="ac-sel" value={f.kind}
                  onChange={(e) => {
                    const gl = kinds.find(([k]) => k === e.target.value)?.[1];
                    set({ kind: e.target.value, gl_code: gl });
                  }}>
            {kinds.map(([k]) => <option key={k} value={k}>{k}</option>)}
          </select></label>
        <label className="ac-f"><span>Amount</span>
          <input className="ac-in" type="number" step="0.01" value={f.amount}
                 onChange={(e) => set({ amount: e.target.value })} /></label>
        <label className="ac-f"><span>Bills on day</span>
          <input className="ac-in" type="number" min="1" max="28" value={f.charge_day}
                 onChange={(e) => set({ charge_day: Number(e.target.value) })} />
          <em className="ac-hint">1–28</em></label>
      </div>
      <div className="ac-row">
        <label className="ac-f"><span>Starts</span>
          <input className="ac-in" type="date" value={f.start_date}
                 onChange={(e) => set({ start_date: e.target.value })} /></label>
        <label className="ac-f"><span>Ends <em>optional</em></span>
          <input className="ac-in" type="date" value={f.end_date}
                 onChange={(e) => set({ end_date: e.target.value })} />
          <em className="ac-hint">Set this to the lease end so billing stops with the tenancy</em></label>
        <button className="ac-btn" disabled={!ok} style={{ alignSelf: "flex-end" }}
                onClick={() => onAdd({ id: uid("cs_"), ...f, amount: cents(f.amount),
                  due_day: f.charge_day, is_active: true })}>Add</button>
        <button className="ac-btn ac-btn--ghost" style={{ alignSelf: "flex-end" }}
                onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function ReceiptDialog({ charge, charges, receipts, post, onClose, onSave }) {
  const [unit, setUnit] = useState(charge?.unit_number ?? "");
  const [amount, setAmount] = useState(charge ? String(cents(charge.amount - charge.paid_amount)) : "");
  const [date, setDate] = useState(today());
  const [method, setMethod] = useState("etransfer");
  const [reference, setReference] = useState("");
  const [applied, setApplied] = useState(charge
    ? { [charge.id]: cents(charge.amount - charge.paid_amount) } : {});
  const [err, setErr] = useState("");

  const candidates = charges.filter((c) => !unit || c.unit_number === unit);
  const appliedTotal = cents(Object.values(applied).reduce((t, v) => t + Number(v || 0), 0));
  const total = cents(Number(amount) || 0);
  const unapplied = cents(total - appliedTotal);

  const submit = () => {
    setErr("");
    if (total <= 0) return setErr("Enter an amount.");
    if (appliedTotal > total) return setErr("Applied more than the payment.");
    try {
      const id = uid("rc_");
      const lines = [{ gl: "1010", debit: total, unit }];
      if (appliedTotal > 0) lines.push({ gl: "1100", credit: appliedTotal, unit });
      // Anything beyond what is owed is still the tenant's money. It sits in
      // prepaid rent until there is a charge to apply it to.
      if (unapplied > 0) lines.push({ gl: "2200", credit: unapplied, unit, memo: "Prepaid rent" });
      const entry = post({ date, building: unit?.slice(0, 3), source: "ar_receipt",
        sourceId: id, memo: `Receipt ${unit}`, lines });

      onSave({ id, receipt_no: receipts.reduce((m, r) => Math.max(m, r.receipt_no || 0), 0) + 1,
               unit_number: unit, received_date: date, amount: total, method, reference,
               entry_id: entry.id },
             Object.entries(applied).filter(([, v]) => Number(v) > 0)
               .map(([charge_id, v]) => ({ charge_id, amount: cents(v) })));
    } catch (e) { setErr(e.message); }
  };

  return (
    <div className="ac-drawer-wrap" onClick={onClose}>
      <aside className="ac-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="ac-drawer-h">
          <h3>Record a payment</h3>
          <button className="ac-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="ac-drawer-b">
          <div className="ac-row">
            <label className="ac-f"><span>Unit</span>
              <input className="ac-in" value={unit} onChange={(e) => setUnit(e.target.value)} /></label>
            <label className="ac-f"><span>Amount</span>
              <input className="ac-in" type="number" step="0.01" value={amount}
                     onChange={(e) => setAmount(e.target.value)} /></label>
          </div>
          <div className="ac-row">
            <label className="ac-f"><span>Date</span>
              <input className="ac-in" type="date" value={date}
                     onChange={(e) => setDate(e.target.value)} /></label>
            <label className="ac-f"><span>Method</span>
              <select className="ac-sel" value={method} onChange={(e) => setMethod(e.target.value)}>
                {["etransfer", "cheque", "preauth", "cash", "card"].map((m) =>
                  <option key={m} value={m}>{m}</option>)}
              </select></label>
          </div>
          <label className="ac-f"><span>Reference <em>optional</em></span>
            <input className="ac-in" value={reference} placeholder="Cheque number, e-transfer id"
                   onChange={(e) => setReference(e.target.value)} /></label>

          <div className="ac-apply">
            <div className="ac-apply-h">Apply to</div>
            {candidates.length === 0 ? (
              <div className="ac-empty">Nothing outstanding for this unit.</div>
            ) : candidates.slice(0, 12).map((c) => {
              const owing = cents(c.amount - c.paid_amount);
              return (
                <div className="ac-applyrow" key={c.id}>
                  <span className="ac-mono ac-dim">{c.period}</span>
                  <span>{c.kind}</span>
                  <span className="ac-mono">{money(owing)}</span>
                  <input className="ac-in ac-in--xs" type="number" step="0.01" max={owing}
                         value={applied[c.id] ?? ""} placeholder="0.00"
                         onChange={(e) => setApplied({ ...applied, [c.id]: e.target.value })} />
                </div>
              );
            })}
          </div>

          <div className="ac-tally">
            <div><span>Payment</span><span className="ac-mono">{money(total)}</span></div>
            <div><span>Applied</span><span className="ac-mono">{money(appliedTotal)}</span></div>
            <div className={unapplied > 0 ? "ac-warnrow" : ""}>
              <span>{unapplied > 0 ? "To prepaid rent" : "Unapplied"}</span>
              <span className="ac-mono">{money(unapplied)}</span>
            </div>
          </div>
          {unapplied > 0 && (
            <p className="ac-note-p">
              Money beyond what is owed goes to prepaid rent, not income. It is still
              the tenant’s until there is a charge to set it against.
            </p>
          )}

          {err && <div className="ac-err">{err}</div>}
          <button className="ac-btn" onClick={submit}>Post the receipt</button>
        </div>
      </aside>
    </div>
  );
}

/* ══════════════════ AP ══════════════════ */

function AP({ vendors, invoices, save, post, canPost, coa, glName, session, amendments,
              onOpenReview }) {
  const [view, setView] = useState("invoices");
  const [newVendor, setNewVendor] = useState(false);
  const [payFor, setPayFor] = useState(null);
  const [amendFor, setAmendFor] = useState(null);
  const [err, setErr] = useState("");

  /* An amendment reverses and reposts. The invoice keeps its number so
     anything linked to it still resolves, and gains a version. */
  const applyAmendment = ({ patch, amendment, replacementEntryId }) => {
    save.invoices(invoices.map((i) => i.id === amendFor.id
      ? { ...i, ...patch, version: (i.version ?? 1) + (amendment ? 1 : 0),
          entry_id: replacementEntryId ?? i.entry_id,
          state: amendment
            ? (cents(i.paid_amount) >= cents(patch.total) ? "paid"
               : cents(i.paid_amount) > 0 ? "partial" : "approved")
            : i.state } : i));
    if (amendment) save.amendments([amendment, ...amendments]);
    setAmendFor(null);
  };

  const open = invoices.filter((i) => ["approved", "partial"].includes(i.state));

  return (
    <div className="ac-body">
      <div className="ac-seg">
        {[["invoices", "Invoices"], ["vendors", "Vendors"]].map(([k, l]) => (
          <button key={k} className={view === k ? "on" : ""} onClick={() => setView(k)}>{l}</button>
        ))}
      </div>

      {view === "invoices" && (
        <section className="ac-card">
          <div className="ac-cardh">
            <h2>Vendor invoices <span className="ac-n">{invoices.length}</span></h2>
            <div className="ac-cardh-r">
              <span className="ac-dim">{money(cents(open.reduce((t, i) => t + (i.total - i.paid_amount), 0)))} owed</span>
              {canPost && <button className="ac-btn ac-btn--sm" onClick={onOpenReview}>
                Enter an invoice
              </button>}
            </div>
          </div>
          <p className="ac-note-p">
            A draft invoice is outside the ledger. Accounting and PM must confirm
            the same file in Invoice & report review before it posts.
          </p>

          {err && <div className="ac-err">{err}</div>}

          {invoices.length === 0 ? <div className="ac-empty">Nothing entered yet.</div> : (
            <div className="ac-table">
              <div className="ac-tr ac-tr--h" style={{ gridTemplateColumns: "1fr 1fr 100px 100px 100px 130px" }}>
                <span>Vendor</span><span>Invoice</span><span>Total</span>
                <span>Outstanding</span><span>Due</span><span />
              </div>
              {invoices.map((i) => {
                const v = vendors.find((x) => x.id === i.vendor_id);
                const owing = cents(i.total - i.paid_amount);
                const late = owing > 0 && i.due_date < today();
                const st = AP_STATE[i.state] ?? AP_STATE.draft;
                return (
                  <div className={`ac-tr ${late ? "late" : ""}`} key={i.id}
                       style={{ gridTemplateColumns: "1fr 1fr 100px 100px 100px 130px" }}>
                    <span className="ac-strong">{v?.name ?? "—"}</span>
                    <span className="ac-mono ac-dim">{i.invoice_no}</span>
                    <span className="ac-mono">{money(i.total)}</span>
                    <span className="ac-mono">{owing > 0 ? money(owing) : "—"}</span>
                    <span className={`ac-mono ${late ? "ac-bad" : "ac-dim"}`}>{i.due_date}</span>
                    <span className="ac-actions">
                      <span className="ac-tag" style={{ "--c": st.color }}>{st.label}</span>
                      {i.state === "draft" &&
                        <button className="ac-btn ac-btn--xs" onClick={onOpenReview}>Review</button>}
                      {canPost && owing > 0 && i.state !== "draft" &&
                        <button className="ac-btn ac-btn--xs" onClick={() => setPayFor(i)}>Pay</button>}
                      {canPost && i.state !== "void" &&
                        <button className="ac-btn ac-btn--xs ac-btn--ghost"
                                onClick={() => setAmendFor(i)}>
                          {i.state === "draft" ? "Edit" : "Amend"}
                        </button>}
                      {(i.version ?? 1) > 1 && <span className="ac-pill">v{i.version}</span>}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {view === "vendors" && (
        <section className="ac-card">
          <div className="ac-cardh">
            <h2>Vendors <span className="ac-n">{vendors.length}</span></h2>
            {canPost && <button className="ac-btn ac-btn--sm" onClick={() => setNewVendor(!newVendor)}>
              Add a vendor
            </button>}
          </div>
          {newVendor && <NewVendor coa={coa}
            onAdd={(v) => { save.vendors([...vendors, v]); setNewVendor(false); }}
            onCancel={() => setNewVendor(false)} />}
          <div className="ac-table">
            <div className="ac-tr ac-tr--h" style={{ gridTemplateColumns: "1fr 1fr 1fr 90px 110px" }}>
              <span>Name</span><span>Contact</span><span>Default account</span>
              <span>Terms</span><span>Outstanding</span>
            </div>
            {vendors.map((v) => {
              const owed = cents(invoices.filter((i) => i.vendor_id === v.id
                && ["approved", "partial"].includes(i.state))
                .reduce((t, i) => t + (i.total - i.paid_amount), 0));
              return (
                <div className="ac-tr" key={v.id}
                     style={{ gridTemplateColumns: "1fr 1fr 1fr 90px 110px" }}>
                  <span className="ac-strong">{v.name}</span>
                  <span className="ac-dim">{v.email || v.phone || "—"}</span>
                  <span className="ac-dim">{v.default_gl ? `${v.default_gl} ${glName(v.default_gl)}` : "—"}</span>
                  <span className="ac-mono ac-dim">net {v.payment_terms ?? 30}</span>
                  <span className="ac-mono">{owed > 0 ? money(owed) : "—"}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {amendFor && (
        <AmendDialog kind="ap_invoice" doc={amendFor} coa={coa} post={post} session={session}
          onClose={() => setAmendFor(null)} onSave={applyAmendment} />
      )}

      {payFor && (
        <PayDialog invoice={payFor} vendors={vendors} post={post}
          onClose={() => setPayFor(null)}
          onSave={(amount) => {
            const paid = cents(payFor.paid_amount + amount);
            save.invoices(invoices.map((i) => i.id === payFor.id
              ? { ...i, paid_amount: paid, state: paid >= cents(i.total) ? "paid" : "partial" } : i));
            setPayFor(null);
          }} />
      )}
    </div>
  );
}

function NewVendor({ coa, onAdd, onCancel }) {
  const [f, setF] = useState({ name: "", email: "", phone: "", default_gl: "5010", payment_terms: 30 });
  const expense = coa.filter((a) => a.type === "expense");
  return (
    <div className="ac-panel">
      <div className="ac-row">
        <label className="ac-f"><span>Name</span>
          <input className="ac-in" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        <label className="ac-f"><span>Email</span>
          <input className="ac-in" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
        <label className="ac-f"><span>Phone</span>
          <input className="ac-in" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
      </div>
      <div className="ac-row">
        <label className="ac-f"><span>Usual account</span>
          <select className="ac-sel" value={f.default_gl}
                  onChange={(e) => setF({ ...f, default_gl: e.target.value })}>
            {expense.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
          </select></label>
        <label className="ac-f"><span>Terms (days)</span>
          <input className="ac-in" type="number" value={f.payment_terms}
                 onChange={(e) => setF({ ...f, payment_terms: Number(e.target.value) })} /></label>
        <button className="ac-btn" style={{ alignSelf: "flex-end" }} disabled={!f.name.trim()}
                onClick={() => onAdd({ id: uid("vn_"), ...f })}>Add</button>
        <button className="ac-btn ac-btn--ghost" style={{ alignSelf: "flex-end" }}
                onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function NewInvoice({ vendors, coa, onAdd, onCancel }) {
  const [f, setF] = useState({ vendor_id: vendors[0]?.id ?? "", invoice_no: "",
    invoice_date: today(), due_date: "", building_code: "", unit_number: "", gst: "", description: "" });
  const [lines, setLines] = useState([{ gl_code: "5010", description: "", amount: "" }]);
  const expense = coa.filter((a) => a.type === "expense");

  const vendor = vendors.find((v) => v.id === f.vendor_id);
  const subtotal = cents(lines.reduce((t, l) => t + Number(l.amount || 0), 0));
  const total = cents(subtotal + Number(f.gst || 0));
  const due = f.due_date || (f.invoice_date ? addDays(f.invoice_date, vendor?.payment_terms ?? 30) : "");
  const ok = f.vendor_id && f.invoice_no.trim() && subtotal > 0;

  return (
    <div className="ac-panel">
      <div className="ac-row">
        <label className="ac-f"><span>Vendor</span>
          <select className="ac-sel" value={f.vendor_id}
                  onChange={(e) => {
                    const v = vendors.find((x) => x.id === e.target.value);
                    setF({ ...f, vendor_id: e.target.value });
                    if (v?.default_gl) setLines(lines.map((l, i) => i === 0 ? { ...l, gl_code: v.default_gl } : l));
                  }}>
            {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select></label>
        <label className="ac-f"><span>Invoice number</span>
          <input className="ac-in" value={f.invoice_no}
                 onChange={(e) => setF({ ...f, invoice_no: e.target.value })} /></label>
        <label className="ac-f"><span>Date</span>
          <input className="ac-in" type="date" value={f.invoice_date}
                 onChange={(e) => setF({ ...f, invoice_date: e.target.value })} /></label>
        <label className="ac-f"><span>Due</span>
          <input className="ac-in" type="date" value={due}
                 onChange={(e) => setF({ ...f, due_date: e.target.value })} /></label>
      </div>
      <div className="ac-row">
        <label className="ac-f"><span>Building <em>optional</em></span>
          <select className="ac-sel" value={f.building_code}
                  onChange={(e) => setF({ ...f, building_code: e.target.value })}>
            <option value="">All / shared</option>
            {["370", "374", "378"].map((b) => <option key={b} value={b}>{b}</option>)}
          </select></label>
        <label className="ac-f"><span>Unit <em>optional</em></span>
          <input className="ac-in" value={f.unit_number} placeholder="370-412"
                 onChange={(e) => setF({ ...f, unit_number: e.target.value })} /></label>
        <label className="ac-f"><span>GST</span>
          <input className="ac-in" type="number" step="0.01" value={f.gst}
                 onChange={(e) => setF({ ...f, gst: e.target.value })} /></label>
      </div>

      <div className="ac-lines">
        <div className="ac-lines-h">Lines</div>
        {lines.map((l, i) => (
          <div className="ac-lineRow" key={i}>
            <select className="ac-sel" value={l.gl_code}
                    onChange={(e) => setLines(lines.map((x, j) =>
                      j === i ? { ...x, gl_code: e.target.value } : x))}>
              {expense.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
            </select>
            <input className="ac-in" placeholder="Description" value={l.description}
                   onChange={(e) => setLines(lines.map((x, j) =>
                     j === i ? { ...x, description: e.target.value } : x))} />
            <input className="ac-in ac-in--sm" type="number" step="0.01" placeholder="0.00"
                   value={l.amount}
                   onChange={(e) => setLines(lines.map((x, j) =>
                     j === i ? { ...x, amount: e.target.value } : x))} />
            {lines.length > 1 && (
              <button className="ac-x" onClick={() => setLines(lines.filter((_, j) => j !== i))}>×</button>
            )}
          </div>
        ))}
        <button className="ac-btn ac-btn--xs ac-btn--ghost"
                onClick={() => setLines([...lines, { gl_code: "5010", description: "", amount: "" }])}>
          + Another line
        </button>
      </div>

      <div className="ac-tally">
        <div><span>Subtotal</span><span className="ac-mono">{money(subtotal)}</span></div>
        <div><span>GST</span><span className="ac-mono">{money(Number(f.gst) || 0)}</span></div>
        <div className="ac-tally-t"><span>Total</span><span className="ac-mono">{money(total)}</span></div>
      </div>

      <div className="ac-actions">
        <button className="ac-btn" disabled={!ok}
                onClick={() => onAdd({ id: uid("ap_"), ...f, due_date: due,
                  lines: lines.map((l) => ({ ...l, amount: cents(l.amount) })),
                  subtotal, gst: cents(f.gst || 0), total, state: "draft", paid_amount: 0 })}>
          Save as draft
        </button>
        <button className="ac-btn ac-btn--ghost" onClick={onCancel}>Cancel</button>
        <span className="ac-dim">Approving it later is what posts it to the ledger.</span>
      </div>
    </div>
  );
}

function PayDialog({ invoice, vendors, post, onClose, onSave }) {
  const owing = cents(invoice.total - invoice.paid_amount);
  const [amount, setAmount] = useState(String(owing));
  const [date, setDate] = useState(today());
  const [method, setMethod] = useState("etransfer");
  const [reference, setReference] = useState("");
  const [err, setErr] = useState("");
  const v = vendors.find((x) => x.id === invoice.vendor_id);

  const submit = () => {
    setErr("");
    const amt = cents(Number(amount) || 0);
    if (amt <= 0) return setErr("Enter an amount.");
    if (amt > owing) return setErr(`More than the ${money(owing)} outstanding.`);
    try {
      post({ date, building: invoice.building_code, source: "ap_payment", sourceId: invoice.id,
        memo: `Payment to ${v?.name} · ${invoice.invoice_no}`,
        lines: [{ gl: "2010", debit: amt, vendorId: invoice.vendor_id },
                { gl: "1010", credit: amt }] });
      onSave(amt);
    } catch (e) { setErr(e.message); }
  };

  return (
    <div className="ac-drawer-wrap" onClick={onClose}>
      <aside className="ac-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="ac-drawer-h">
          <h3>Pay {v?.name}</h3>
          <button className="ac-x" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="ac-drawer-b">
          <div className="ac-summary">
            <div><span>Invoice</span><span className="ac-mono">{invoice.invoice_no}</span></div>
            <div><span>Total</span><span className="ac-mono">{money(invoice.total)}</span></div>
            <div><span>Outstanding</span><span className="ac-mono">{money(owing)}</span></div>
          </div>
          <div className="ac-row">
            <label className="ac-f"><span>Amount</span>
              <input className="ac-in" type="number" step="0.01" value={amount}
                     onChange={(e) => setAmount(e.target.value)} /></label>
            <label className="ac-f"><span>Date</span>
              <input className="ac-in" type="date" value={date}
                     onChange={(e) => setDate(e.target.value)} /></label>
          </div>
          <div className="ac-row">
            <label className="ac-f"><span>Method</span>
              <select className="ac-sel" value={method} onChange={(e) => setMethod(e.target.value)}>
                {["etransfer", "cheque", "eft", "card"].map((m) => <option key={m}>{m}</option>)}
              </select></label>
            <label className="ac-f"><span>Reference</span>
              <input className="ac-in" value={reference}
                     onChange={(e) => setReference(e.target.value)} /></label>
          </div>
          {err && <div className="ac-err">{err}</div>}
          <button className="ac-btn" onClick={submit}>Post the payment</button>
        </div>
      </aside>
    </div>
  );
}

/* ══════════════════ Transaction search ══════════════════ */

/** One box across the whole ledger. A number matches an amount within a cent,
 *  which is how you find "that $1,847 payment" when nobody remembers the date. */
function Search({ entries, glName, vendors }) {
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [gl, setGl] = useState("");

  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    const num = Number(q.replace(/[$,\s]/g, ""));
    const isAmount = s !== "" && Number.isFinite(num) && num !== 0;
    const out = [];

    for (const e of entries) {
      if (from && e.entry_date < from) continue;
      if (to && e.entry_date > to) continue;
      for (const l of e.lines) {
        if (gl && l.gl !== gl) continue;
        if (s) {
          const vendor = vendors.find((v) => v.id === l.vendor_id)?.name ?? "";
          const hay = [l.unit, vendor, e.memo, l.memo, l.gl, glName(l.gl)]
            .filter(Boolean).join(" ").toLowerCase();
          const amountHit = isAmount
            && (Math.abs(l.debit - num) < 0.005 || Math.abs(l.credit - num) < 0.005);
          if (!hay.includes(s) && !amountHit) continue;
        }
        out.push({ ...e, line: l,
          vendor_name: vendors.find((v) => v.id === l.vendor_id)?.name ?? null });
      }
    }
    return out.slice(0, 300);
  }, [entries, q, from, to, gl, vendors, glName]);

  const totals = useMemo(() => ({
    debit: cents(results.reduce((t, r) => t + r.line.debit, 0)),
    credit: cents(results.reduce((t, r) => t + r.line.credit, 0)),
  }), [results]);

  const accounts = useMemo(() => {
    const seen = new Map();
    for (const e of entries) for (const l of e.lines) seen.set(l.gl, glName(l.gl));
    return [...seen.entries()].sort();
  }, [entries, glName]);

  return (
    <div className="ac-body">
      <section className="ac-card">
        <h2>Find a transaction</h2>
        <p className="ac-note-p">
          Search by vendor, tenant unit, account, memo or amount. Typing a number
          matches to the cent, so an amount alone is enough to find a payment.
        </p>
        <div className="ac-row">
          <label className="ac-f" style={{ flex: "2 1 260px" }}>
            <span>Search</span>
            <input className="ac-in" value={q} autoFocus
                   placeholder="Northgate, 370-412, 1847.50, insurance…"
                   onChange={(e) => setQ(e.target.value)} /></label>
          <label className="ac-f"><span>From</span>
            <input className="ac-in" type="date" value={from}
                   onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="ac-f"><span>To</span>
            <input className="ac-in" type="date" value={to}
                   onChange={(e) => setTo(e.target.value)} /></label>
          <label className="ac-f"><span>Account</span>
            <select className="ac-sel" value={gl} onChange={(e) => setGl(e.target.value)}>
              <option value="">Any</option>
              {accounts.map(([code, name]) =>
                <option key={code} value={code}>{code} · {name}</option>)}
            </select></label>
        </div>
      </section>

      <section className="ac-card">
        <div className="ac-cardh">
          <h2>Results <span className="ac-n">{results.length}</span></h2>
          {results.length > 0 && (
            <span className="ac-dim">
              debits {money(totals.debit)} · credits {money(totals.credit)}
            </span>
          )}
        </div>
        {results.length === 0 ? (
          <div className="ac-empty">
            {q || from || gl ? "Nothing matches." : "Type something to search."}
          </div>
        ) : (
          <div className="ac-table">
            <div className="ac-tr ac-tr--h" style={{ gridTemplateColumns: "60px 90px 1fr 1fr 90px 100px 100px" }}>
              <span>No.</span><span>Date</span><span>Account</span><span>Detail</span>
              <span>Unit</span><span>Debit</span><span>Credit</span>
            </div>
            {results.map((r, i) => (
              <div className="ac-tr" key={`${r.id}-${r.line.line_no}-${i}`}
                   style={{ gridTemplateColumns: "60px 90px 1fr 1fr 90px 100px 100px" }}>
                <span className="ac-mono ac-dim">{r.entry_no}</span>
                <span className="ac-mono">{r.entry_date}</span>
                <span><span className="ac-mono ac-dim">{r.line.gl}</span> {glName(r.line.gl)}</span>
                <span className="ac-dim ac-cut">
                  {r.vendor_name || r.line.memo || r.memo || r.source}
                </span>
                <span className="ac-mono">{r.line.unit || "—"}</span>
                <span className="ac-mono">{r.line.debit > 0 ? money(r.line.debit) : ""}</span>
                <span className="ac-mono">{r.line.credit > 0 ? money(r.line.credit) : ""}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/* ══════════════════ Reports ══════════════════ */

function Reports({ reports, periods, entries, charges, receipts, coa, save, canPost, session,
                   onOpenReview }) {
  const [period, setPeriod] = useState(thisPeriod());
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState("");

  const state = periods.find((p) => p.period === period)?.state ?? "open";
  const BUILDINGS = ["370", "374", "378"];

  /* Figures are computed here, from posted entries. The AI is given them and
     told not to recalculate: a narrative that quietly disagrees with the
     ledger is worse than no narrative. */
  const figuresFor = useCallback((building) => {
    const inPeriod = entries.filter((e) => e.period === period && e.state === "posted");
    const acc = {};
    for (const e of inPeriod) {
      for (const l of e.lines) {
        if (building && l.unit && !l.unit.startsWith(building)) continue;
        if (building && !l.unit && e.building_code && e.building_code !== building) continue;
        acc[l.gl] ||= { d: 0, c: 0 };
        acc[l.gl].d = cents(acc[l.gl].d + l.debit);
        acc[l.gl].c = cents(acc[l.gl].c + l.credit);
      }
    }
    const pick = (type) => coa.filter((a) => a.type === type)
      .map((a) => ({ code: a.code, name: a.name,
        amount: a.normal_side === "debit"
          ? cents((acc[a.code]?.d ?? 0) - (acc[a.code]?.c ?? 0))
          : cents((acc[a.code]?.c ?? 0) - (acc[a.code]?.d ?? 0)) }))
      .filter((a) => a.amount !== 0);

    const revenue = pick("revenue"), expense = pick("expense");
    const rt = cents(revenue.reduce((t, a) => t + a.amount, 0));
    const et = cents(expense.reduce((t, a) => t + a.amount, 0));

    const billedRows = charges.filter((c) => c.period === period
      && (!building || c.unit_number?.startsWith(building)));
    const billed = cents(billedRows.reduce((t, c) => t + c.amount, 0));
    const collected = cents(receipts.filter((r) => r.received_date?.startsWith(period)
      && (!building || r.unit_number?.startsWith(building)))
      .reduce((t, r) => t + r.amount, 0));
    const arrearsRows = charges.filter((c) => ["open", "partial"].includes(c.state)
      && c.due_date < today() && (!building || c.unit_number?.startsWith(building)));

    return {
      period, building: building ?? "all",
      revenue, expense, revenue_total: rt, expense_total: et,
      net_operating_income: cents(rt - et),
      rent_billed: billed, rent_collected: collected,
      charges_raised: billedRows.length,
      collection_rate: billed > 0 ? Number((collected / billed * 100).toFixed(1)) : null,
      arrears_total: cents(arrearsRows.reduce((t, c) => t + (c.amount - c.paid_amount), 0)),
      arrears_count: arrearsRows.length,
    };
  }, [entries, charges, receipts, coa, period]);

  const methodFor = (f) => [
    `Revenue: credits less debits on revenue accounts, posted entries in ${f.period}${f.building !== "all" ? `, building ${f.building}` : ""}.`,
    `Expenses: debits less credits on expense accounts, same basis.`,
    `Net operating income: ${money(f.revenue_total)} less ${money(f.expense_total)} = ${money(f.net_operating_income)}. Accrual basis, so this counts what was billed and incurred, not what moved through the bank.`,
    `Rent billed: ${f.charges_raised} charges raised for the period, ${money(f.rent_billed)}.`,
    `Rent collected: receipts dated within the period, ${money(f.rent_collected)}. A receipt clearing an older arrear counts here, which is why collection can exceed 100%.`,
    f.collection_rate == null ? `Collection rate: not calculable, nothing billed.`
      : `Collection rate: ${money(f.rent_collected)} ÷ ${money(f.rent_billed)} = ${f.collection_rate}%.`,
    `Arrears: charges open or part paid with a due date already past — ${money(f.arrears_total)} across ${f.arrears_count} charges. A running figure, not confined to this period.`,
  ].join("\n");

  const generate = async () => {
    setErr("");
    if (state === "open") {
      setErr("The period is not reconciled. A report written from open figures describes numbers that are still moving.");
      return;
    }
    const made = BUILDINGS.map((b) => {
      const f = figuresFor(b);
      return { period, building_code: b, figures: f, method: methodFor(f),
               narrative: null, state: "draft", generated_at: new Date().toISOString() };
    });
    setBusy("generate");
    try {
      const result = await api.generateMonthlyReports(made);
      save.reports([...(result.reports ?? []), ...reports.filter((r) => r.period !== period)]);
    } catch (e) {
      setErr(e?.code === "INTERNAL_ERROR"
        ? "Run 016_accounting_document_review.sql before generating reports."
        : "The reports could not be saved to the shared review queue.");
    }
    setBusy(null);
  };

  const writeNarrative = async (rep) => {
    setBusy(rep.id); setErr("");
    try {
      const text = await ai("report_narrative",
        { building: rep.building_code, figures: rep.figures, method: rep.method },
        { ref_type: "monthly_report", ref_id: rep.id });
      const result = await api.updateMonthlyReport(rep.id, {
        narrative: text || null, model: "claude-sonnet-4-6",
      });
      save.reports(reports.map((r) => r.id === rep.id ? result.report : r));
    } catch {
      setErr("The AI service did not respond. The figures stand on their own; write the commentary by hand.");
    }
    setBusy(null);
  };

  const forPeriod = reports.filter((r) => r.period === period);

  return (
    <div className="ac-body">
      <section className="ac-card">
        <div className="ac-cardh">
          <h2>Monthly reports</h2>
          <div className="ac-cardh-r">
            <input className="ac-in ac-in--sm" type="month" value={period}
                   onChange={(e) => setPeriod(e.target.value)} />
            <span className="ac-tag" style={{ "--c": PERIOD_STATE[state].color }}>
              {PERIOD_STATE[state].label}
            </span>
            {canPost && <button className="ac-btn ac-btn--sm" onClick={generate}
              disabled={busy === "generate"}>
              {busy === "generate" ? "Generating…" : "Generate for all three"}
            </button>}
          </div>
        </div>
        <p className="ac-note-p">
          One report per building, generated only once the period is reconciled.
          The figures come from the ledger; the commentary is written from those
          figures and never recalculates them.
        </p>
        {err && <div className="ac-err">{err}</div>}
      </section>

      {forPeriod.length === 0 ? (
        <section className="ac-card"><div className="ac-empty">
          {state === "open"
            ? "Reconcile the period first, under Banking."
            : "Nothing generated for this period yet."}
        </div></section>
      ) : forPeriod.map((rep) => (
        <section className="ac-card" key={rep.id}>
          <div className="ac-cardh">
            <h2>Building {rep.building_code}</h2>
            <div className="ac-cardh-r">
              <span className="ac-tag" style={{ "--c": rep.state === "final" ? "#0E8577"
                : rep.state === "review" ? "#C98A15" : "#8892A0" }}>{rep.state}</span>
              {canPost && !rep.narrative && (
                <button className="ac-btn ac-btn--sm" disabled={busy === rep.id}
                        onClick={() => writeNarrative(rep)}>
                  {busy === rep.id ? "Writing…" : "Write the commentary"}
                </button>
              )}
              {rep.state !== "final" && <button className="ac-btn ac-btn--sm"
                onClick={onOpenReview}>PM + Accounting review</button>}
            </div>
          </div>

          <div className="ac-figs">
            <Fig l="Revenue" v={money(rep.figures.revenue_total)} />
            <Fig l="Expenses" v={money(rep.figures.expense_total)} />
            <Fig l="Net operating income" v={money(rep.figures.net_operating_income)}
                 tone={rep.figures.net_operating_income < 0 ? "bad" : "good"} />
            <Fig l="Rent billed" v={money(rep.figures.rent_billed)} />
            <Fig l="Collected" v={money(rep.figures.rent_collected)} />
            <Fig l="Collection" v={rep.figures.collection_rate == null ? "—"
              : `${rep.figures.collection_rate}%`} />
            <Fig l="Arrears" v={money(rep.figures.arrears_total)}
                 tone={rep.figures.arrears_total > 0 ? "bad" : null} />
          </div>

          {rep.narrative && (
            <div className="ac-narr">
              <div className="ac-narr-h">Commentary</div>
              <p>{rep.narrative}</p>
            </div>
          )}

          {/* The method sits with the report on purpose. A number without its
              derivation is something to argue about later. */}
          <details className="ac-method">
            <summary>How each figure was worked out</summary>
            <pre>{rep.method}</pre>
          </details>
        </section>
      ))}
    </div>
  );
}

function Fig({ l, v, tone }) {
  return (
    <div className="ac-fig">
      <div className="ac-fig-l">{l}</div>
      <div className={`ac-fig-v ${tone === "bad" ? "ac-bad" : tone === "good" ? "ac-ok" : ""}`}>{v}</div>
    </div>
  );
}

/* ══════════════════ Chart of accounts ══════════════════ */

function ChartOfAccounts({ coa, balances, setCoa, canPost }) {
  const grouped = useMemo(() => {
    const order = ["asset", "liability", "equity", "revenue", "expense"];
    return order.map((type) => ({ type, accounts: coa.filter((a) => a.type === type) }))
      .filter((g) => g.accounts.length);
  }, [coa]);

  const LABEL = { asset: "Assets", liability: "Liabilities", equity: "Equity",
                  revenue: "Revenue", expense: "Expenses" };

  return (
    <div className="ac-body">
      <section className="ac-card">
        <h2>Chart of accounts</h2>
        <p className="ac-note-p">
          Codes follow the usual blocks so anyone who has seen a set of books can
          find their way: 1000 assets, 2000 liabilities, 3000 equity, 4000 revenue,
          5000 expenses. An account that has been posted to cannot change type or
          side — that would rewrite the meaning of history.
        </p>
        {grouped.map((g) => (
          <div className="ac-coa" key={g.type}>
            <div className="ac-coa-h">{LABEL[g.type]}</div>
            {g.accounts.map((a) => (
              <div className="ac-coa-r" key={a.code}>
                <span className="ac-mono ac-strong">{a.code}</span>
                <span>
                  {a.name}
                  {a.is_trust === 1 && <span className="ac-pill ac-pill--trust">trust</span>}
                  {a.is_bank === 1 && <span className="ac-pill">bank</span>}
                </span>
                <span className="ac-mono ac-dim">{a.normal_side}</span>
                <span className="ac-mono">{money(balances[a.code]?.balance ?? 0)}</span>
              </div>
            ))}
          </div>
        ))}
      </section>
    </div>
  );
}


/* ══════════════════ Arrears files ══════════════════ */

/* Alberta's service rules set when something counts as received, and that date
   is what a notice period runs from. Named constants because they are legal
   figures — confirm each with your lawyer before relying on a deemed date. */
const DEEMED_SERVICE_DAYS = {
  personal: 0, posted_on_door: 0, email: 0, sms: 0, courier: 1, post: 5,
};

const ARREARS_STEPS = {
  reminder: { label: "Reminder", after: 5,
    why: "Rent is late. Most arrears end here, and a reminder that reads as an accusation is what stops that happening." },
  request: { label: "Request", after: 15,
    why: "Clearer, still not threatening. This is where a payment arrangement usually gets made." },
  direct: { label: "Direct request", after: 30,
    why: "States the position and asks for a date. Still collections — nothing here mentions ending the tenancy." },
  notice: { label: "Notice served", after: null,
    why: "The statutory form, from the agreement library. Nothing generates it — a notice with the wrong wording fails the application whatever the arrears show." },
  filing: { label: "Application filed", after: null, why: "Recorded for completeness." },
};

/* These leave no delivery report, so the record has to be made by whoever did
   it. An application turns on this more often than on the debt. */
const NEEDS_PROOF = ["personal", "posted_on_door", "post"];

/** Every demand for rent, with how it was served.
 *
 *  A message queue answers "did we send it". This answers what was owed, what
 *  was demanded, when, and how it reached them — which is what an application
 *  to end a tenancy actually needs. */
function ArrearsFiles({ charges, files, canPost, session, save, flash }) {
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(null);

  const overdue = useMemo(() => {
    const byUnit = {};
    for (const c of charges) {
      if (!["open", "partial"].includes(c.state)) continue;
      if (c.due_date >= today()) continue;
      byUnit[c.unit_number] ||= { unit: c.unit_number, owed: 0, oldest: c.due_date, n: 0 };
      byUnit[c.unit_number].owed = cents(byUnit[c.unit_number].owed
        + (c.amount - c.paid_amount));
      byUnit[c.unit_number].n++;
      if (c.due_date < byUnit[c.unit_number].oldest)
        byUnit[c.unit_number].oldest = c.due_date;
    }
    return Object.values(byUnit).sort((a, b) => b.owed - a.owed);
  }, [charges]);

  const withoutFile = overdue.filter((o) =>
    !files.some((f) => f.unit_number === o.unit && f.state !== "cleared"));

  const openFile = (unit) => {
    const o = overdue.find((x) => x.unit === unit);
    save.arrears([{ id: uid("arf_"), unit_number: unit, tenant_name: "Tenant",
      opened_on: today(), opening_owed: o.owed, current_owed: o.owed, peak_owed: o.owed,
      state: "open", steps: [], payments: [], created_at: nowISO() }, ...files]);
    flash(`File opened for ${unit}.`);
  };

  return (
    <div className="ac-body">
      <p className="ac-note-p">
        Every demand for rent recorded, with how it was served and when it counts as
        received. A message queue answers whether it was sent; this answers what an
        application to end a tenancy needs — what was owed, what was asked for, when,
        and how it reached them.
      </p>

      {withoutFile.length > 0 && (
        <section className="ac-card">
          <h2>Overdue with no file <span className="ac-n">{withoutFile.length}</span></h2>
          <p className="ac-note-p">
            Opening a file starts the record. Doing it late means the early demands
            are not in it, and those are the ones that show the tenant had notice.
          </p>
          <div className="ac-table">
            <div className="ac-tr ac-tr--h" style={{ gridTemplateColumns: "100px 110px 90px 110px 90px" }}>
              <span>Unit</span><span>Owed</span><span>Charges</span>
              <span>Oldest due</span><span /></div>
            {withoutFile.map((o) => (
              <div className="ac-tr" key={o.unit}
                   style={{ gridTemplateColumns: "100px 110px 90px 110px 90px" }}>
                <span className="ac-mono ac-strong">{o.unit}</span>
                <span className="ac-mono">{money(o.owed)}</span>
                <span className="ac-mono ac-dim">{o.n}</span>
                <span className="ac-mono ac-dim">{o.oldest}</span>
                <span>
                  {canPost && (
                    <button className="ac-btn ac-btn--xs" onClick={() => openFile(o.unit)}>
                      Open a file
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {files.length === 0 ? (
        <section className="ac-card"><div className="ac-empty">No files open.</div></section>
      ) : files.map((f) => {
        const steps = f.steps ?? [];
        const last = steps[steps.length - 1];
        const daysOpen = daysBetween(f.opened_on, today());
        const next = Object.entries(ARREARS_STEPS)
          .find(([k, v]) => v.after != null && !steps.some((s) => s.step === k));
        const dueNow = next && daysOpen >= next[1].after;
        const gaps = steps.filter((s) => NEEDS_PROOF.includes(s.method) && !s.evidence_key);

        return (
          <section className={`ac-card ${f.state === "notice_served" ? "ac-card--bad" : ""}`}
                   key={f.id}>
            <div className="ac-cardh">
              <h2>
                {f.unit_number}
                <span className="ac-tag" style={{ "--c": f.state === "cleared" ? "#0E8577"
                  : f.state === "arrangement" ? "#1C6FA6"
                  : f.state === "notice_served" ? "#B23A54" : "#C98A15" }}>
                  {f.state.replace("_", " ")}
                </span>
              </h2>
              <div className="ac-cardh-r">
                <span className="ac-mono ac-strong">{money(f.current_owed)}</span>
                <span className="ac-dim">{daysOpen} days open · {steps.length} demands</span>
              </div>
            </div>

            {f.arrangement_note && (
              <div className="ac-arrbox">
                <strong>Arrangement from {f.arrangement_from}:</strong> {f.arrangement_note}
                <p>
                  A tenant keeping to an agreed schedule is not in the same position as
                  one who has not answered. An application that ignores an arrangement
                  it made is a weak one.
                </p>
              </div>
            )}

            {steps.length > 0 && (
              <div className="ac-steps2">
                {steps.map((s) => (
                  <div className="ac-step2" key={s.id}>
                    <div className="ac-step2-h">
                      <span className="ac-mono ac-dim">{s.seq}</span>
                      <strong>{ARREARS_STEPS[s.step]?.label ?? s.step}</strong>
                      <span className="ac-mono">{s.served_on}</span>
                      <span className="ac-dim">by {s.method}</span>
                      <span className="ac-mono">{money(s.owed_at_time)} owed then</span>
                      {s.deemed_served_on !== s.served_on && (
                        <span className="ac-dim">deemed {s.deemed_served_on}</span>
                      )}
                    </div>
                    {NEEDS_PROOF.includes(s.method) && !s.evidence_key && (
                      <div className="ac-noproof">
                        No proof attached. {s.method === "post" ? "Ordinary mail"
                          : s.method === "personal" ? "Personal service"
                          : "A notice on the door"} leaves no delivery report — add a
                        photograph or a signed note of service.
                      </div>
                    )}
                    {s.delivery_state === "bounced" && (
                      <div className="ac-noproof">
                        Bounced. It did not reach them, and a demand that did not arrive
                        is not a demand.
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {gaps.length > 0 && (
              <div className="ac-err">
                {gaps.length} demand{gaps.length === 1 ? "" : "s"} served without proof.
                Better found now than by an adjudicator.
              </div>
            )}

            {canPost && f.state !== "cleared" && (
              adding === f.id ? (
                <AddStep file={f} step={next?.[0] ?? "direct"}
                  onCancel={() => setAdding(null)}
                  onSave={(step) => {
                    save.arrears(files.map((x) => x.id === f.id
                      ? { ...x, steps: [...(x.steps ?? []), step],
                          state: step.step === "notice" ? "notice_served" : x.state } : x));
                    setAdding(null);
                    flash(step.needs_proof
                      ? "Recorded. Add the proof of service before it matters."
                      : "Recorded.");
                  }} />
              ) : (
                <div className="ac-actions">
                  <button className="ac-btn ac-btn--sm" onClick={() => setAdding(f.id)}>
                    Record a demand
                  </button>
                  {dueNow && (
                    <span className="ac-dim">
                      {ARREARS_STEPS[next[0]].label} would be the next step
                      ({next[1].after} days). Nothing sends itself — a demand that went
                      out because a timer fired is a demand nobody chose to make.
                    </span>
                  )}
                </div>
              )
            )}

            <details className="ac-method">
              <summary>The bundle</summary>
              <p className="ac-note-p">
                Everything about this file in order: what was owed and when, every demand
                with how it was served and when it counts as received, every payment, and
                where the file is weak.
              </p>
              <p className="ac-note-p">
                <strong>It is evidence, not a notice.</strong> The statutory notice to end
                a tenancy is a prescribed form with its own wording and period. It comes
                from the agreement library where a lawyer approved it — nothing here
                generates one, for the same reason nothing here generates a lease.
              </p>
              <p className="ac-note-p">
                Service dates use the deemed-service days configured in this system.
                Confirm those against the Act before relying on one: an application for
                non-payment fails on service far more often than on the debt.
              </p>
            </details>
          </section>
        );
      })}
    </div>
  );
}

/** Recording a demand. The figure owed is captured now rather than read later —
 *  six months on, "what was owed when we sent that" cannot be recomputed from a
 *  ledger that has moved since. */
function AddStep({ file, step: initial, onCancel, onSave }) {
  const [step, setStep] = useState(initial);
  const [method, setMethod] = useState("email");
  const [servedOn, setServedOn] = useState(today());
  const [body, setBody] = useState("");
  const [witness, setWitness] = useState("");
  const [err, setErr] = useState("");

  const deemed = (() => {
    const d = new Date(servedOn + "T12:00:00");
    d.setDate(d.getDate() + (DEEMED_SERVICE_DAYS[method] ?? 0));
    return d.toISOString().slice(0, 10);
  })();
  const needsProof = NEEDS_PROOF.includes(method);

  return (
    <div className="ac-panel">
      <div className="ac-row">
        <label className="ac-f"><span>Which step</span>
          <select className="ac-sel" value={step} onChange={(e) => setStep(e.target.value)}>
            {Object.entries(ARREARS_STEPS).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select></label>
        <label className="ac-f"><span>How it was served</span>
          <select className="ac-sel" value={method} onChange={(e) => setMethod(e.target.value)}>
            {[["email", "Email"], ["sms", "Text"], ["personal", "Handed to them"],
              ["posted_on_door", "Posted on the door"], ["post", "Ordinary mail"],
              ["courier", "Courier"]].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select></label>
        <label className="ac-f"><span>Served on</span>
          <input className="ac-in" type="date" value={servedOn}
                 onChange={(e) => setServedOn(e.target.value)} /></label>
      </div>

      <p className="ac-note-p">{ARREARS_STEPS[step]?.why}</p>

      {deemed !== servedOn && (
        <div className="ac-deemed">
          Deemed received <strong>{deemed}</strong> — {DEEMED_SERVICE_DAYS[method]} days
          after service by this method. A notice period runs from that date, not from
          the day it was sent.
        </div>
      )}

      {step === "notice" && (
        <div className="ac-err">
          The statutory notice comes from the agreement library, approved. Record here
          that it was served and how — do not type one out. A notice with the wrong
          wording fails the application whatever the arrears show.
        </div>
      )}

      {needsProof && (
        <div className="ac-warnbox">
          This method leaves no delivery report. Photograph the notice on the door, keep
          the courier receipt, or have somebody witness it. An application for
          non-payment turns on service more often than on the debt.
        </div>
      )}

      {["personal", "posted_on_door"].includes(method) && (
        <label className="ac-f"><span>Witnessed by <em>strongly recommended</em></span>
          <input className="ac-in" value={witness}
                 onChange={(e) => setWitness(e.target.value)} /></label>
      )}

      <label className="ac-f">
        <span>What was said {step === "notice" ? "" : "· goes to the tenant as written"}</span>
        <textarea className="ac-in" rows={4} value={body}
                  onChange={(e) => setBody(e.target.value)} />
      </label>

      {err && <div className="ac-err">{err}</div>}
      <div className="ac-actions">
        <button className="ac-btn" disabled={!body.trim()}
                onClick={() => onSave({ id: uid("ars_"),
                  seq: (file.steps?.length ?? 0) + 1, step, method,
                  served_on: servedOn, deemed_served_on: deemed,
                  owed_at_time: file.current_owed, body: body.trim(),
                  witness: witness.trim() || null,
                  delivery_state: ["email", "sms"].includes(method) ? "queued" : "delivered",
                  needs_proof: needsProof, created_at: nowISO() })}>
          Record it
        </button>
        <button className="ac-btn ac-btn--ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/* ══════════════════ Styles ══════════════════ */

export const CSS = MONTH_END_CSS + `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=Archivo:wght@700;800&display=swap');
.ac{--ink:#131C25;--ink2:#3E4C5A;--dim:#78899A;--paper:#fff;--ground:#E9EDF0;--rule:#D3DBE1;
  --amber:#FFF6E0;--amberline:#E8C877;--red:#B23A54;--green:#0E8577;--accent:var(--brand,#2A6183);
  background:var(--ground);color:var(--ink);min-height:100vh;font-size:14px;line-height:1.55;
  font-family:'IBM Plex Sans',system-ui,sans-serif;padding-bottom:44px}
.ac *{box-sizing:border-box}
.ac-mono{font-family:'IBM Plex Mono',monospace;font-variant-numeric:tabular-nums}
.ac-dim{color:var(--dim);font-size:12.5px}
.ac-strong{font-weight:600}
.ac-bad{color:var(--red)}
.ac-ok{color:var(--green)}
.ac-cut{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ac-load{padding:80px 20px;text-align:center;color:var(--dim)}
.ac-deny{max-width:440px;margin:70px auto;background:var(--paper);border:1px solid var(--rule);
  border-radius:5px;padding:26px 24px}
.ac-deny h2{font-family:'Archivo',sans-serif;margin:0 0 8px}
.ac-deny p{margin:0;font-size:13px;color:var(--ink2);line-height:1.7}

.ac-head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;
  padding:22px 26px 16px;background:var(--paper);border-bottom:1px solid var(--rule)}
.ac-eyebrow{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.13em;
  text-transform:uppercase;color:var(--dim)}
.ac-head h1{font-family:'Archivo',sans-serif;font-weight:800;font-size:23px;
  letter-spacing:-.02em;margin:4px 0 0}
.ac-headr{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.ac-who{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:600}
.ac-chip{font-size:10.5px;font-weight:700;color:#fff;border-radius:9px;padding:2px 9px}
.ac-save{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--dim);padding:4px 9px;
  border:1px solid var(--rule);border-radius:3px}
.ac-save--saved{color:var(--green);border-color:var(--green)}
.ac-save--error{color:var(--red);border-color:var(--red)}

.ac-tabs{display:flex;padding:0 26px;background:var(--paper);border-bottom:1px solid var(--rule);
  overflow-x:auto}
.ac-tabs button{font:inherit;font-weight:600;font-size:13.5px;cursor:pointer;background:none;border:0;
  padding:12px 16px;color:var(--dim);border-bottom:2px solid transparent;margin-bottom:-1px;
  display:flex;align-items:center;gap:6px;white-space:nowrap}
.ac-tabs button.on{color:var(--ink);border-bottom-color:var(--brand,var(--ink))}
.ac-b{font-style:normal;font-family:'IBM Plex Mono',monospace;font-size:10px;background:var(--red);
  color:#fff;border-radius:8px;padding:1px 6px}
.ac-note{background:#F2F7FB;border-bottom:1px solid #C7D6E2;padding:10px 26px;font-size:12.5px;
  color:var(--ink2);line-height:1.6}

.ac-body{padding:18px 26px;display:flex;flex-direction:column;gap:14px;max-width:1240px}
.ac-card{background:var(--paper);border:1px solid var(--rule);border-radius:4px;padding:18px 20px;
  display:flex;flex-direction:column;gap:12px}
.ac-card--bad{border-color:var(--red);border-left:3px solid var(--red)}
.ac-card h2{font-family:'Archivo',sans-serif;font-weight:700;font-size:15px;margin:0;
  display:flex;align-items:center;gap:8px}
.ac-cardh{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.ac-cardh-r{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ac-n{font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:500;color:var(--dim);
  border:1px solid var(--rule);border-radius:10px;padding:0 8px}
.ac-note-p{color:var(--dim);font-size:12.5px;margin:0;line-height:1.7;max-width:74ch}
.ac-empty{color:var(--dim);font-size:12.5px;padding:22px 0;text-align:center;
  border:1px dashed var(--rule);border-radius:3px}
.ac-two{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px}

.ac-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;
  background:var(--rule);border:1px solid var(--rule);border-radius:4px;overflow:hidden}
.ac-stat{background:var(--paper);padding:14px 16px}
.ac-stat-l{font-size:10.5px;letter-spacing:.06em;color:var(--dim);text-transform:uppercase;
  font-family:'IBM Plex Mono',monospace}
.ac-stat-v{font-family:'IBM Plex Mono',monospace;font-size:20px;font-weight:600;margin-top:3px}
.ac-stat-v.warn{color:var(--red)}
.ac-stat-v.sm{font-size:14px;padding-top:5px}
.ac-stat-s{font-size:11px;color:var(--dim);margin-top:2px}

.ac-btn{font:inherit;font-weight:600;font-size:13px;cursor:pointer;background:var(--brand,var(--ink));color:#fff;
  border:1px solid var(--brand,var(--ink));padding:8px 15px;border-radius:3px}
.ac-btn:hover:not(:disabled){background:#000}
.ac-btn:disabled{opacity:.4;cursor:not-allowed}
.ac-btn--ghost{background:transparent;color:var(--ink2);border-color:var(--rule)}
.ac-btn--ghost:hover:not(:disabled){background:var(--ground);color:var(--ink)}
.ac-btn--sm{padding:6px 12px;font-size:12px}
.ac-btn--xs{padding:4px 9px;font-size:11.5px}
.ac-x{font:inherit;font-size:17px;line-height:1;cursor:pointer;background:none;border:0;
  color:var(--dim);padding:0 4px}
.ac-x:hover{color:var(--red)}
.ac-btn:focus-visible,.ac-in:focus-visible,.ac-sel:focus-visible,.ac-tabs button:focus-visible,
.ac-seg button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

.ac-in,.ac-sel{font:inherit;font-size:13px;padding:7px 10px;border:1px solid var(--amberline);
  border-radius:3px;background:var(--amber);color:var(--ink);width:100%;min-width:0}
.ac-sel{background:var(--paper);border-color:var(--rule);cursor:pointer}
.ac-in--sm{padding:6px 9px;font-size:12.5px;width:auto}
.ac-in--xs{padding:4px 7px;font-size:12px;text-align:right}
.ac-row{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start}
.ac-row>*{flex:1 1 140px}
.ac-f{display:flex;flex-direction:column;gap:4px}
.ac-f>span{font-size:12px;font-weight:600;color:var(--ink2)}
.ac-f>span em{font-style:normal;font-weight:400;color:var(--dim)}
.ac-hint{font-style:normal;font-size:11px;color:var(--dim);line-height:1.5}
.ac-panel{border:1px solid var(--rule);border-radius:4px;padding:14px 16px;background:#FCFDFE;
  display:flex;flex-direction:column;gap:12px}

.ac-seg{display:inline-flex;border:1px solid var(--rule);border-radius:3px;overflow:hidden;
  align-self:flex-start;background:var(--paper)}
.ac-seg button{font:inherit;font-size:13px;font-weight:600;cursor:pointer;background:var(--paper);
  border:0;border-right:1px solid var(--rule);padding:8px 16px;color:var(--dim)}
.ac-seg button:last-child{border-right:0}
.ac-seg button.on{background:var(--brand,var(--ink));color:#fff}

.ac-table{display:flex;flex-direction:column;gap:1px;background:var(--rule);
  border:1px solid var(--rule);border-radius:3px;overflow:hidden}
.ac-tr{display:grid;gap:10px;padding:8px 12px;background:var(--paper);font-size:13px;
  align-items:center}
.ac-tr--h{background:#F5F7F9;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;
  color:var(--dim);font-family:'IBM Plex Mono',monospace;padding:7px 12px}
.ac-tr.late{background:#FFFCFC}
.ac-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.ac-tag{font-size:10.5px;font-weight:700;color:#fff;background:var(--c);border-radius:9px;
  padding:1px 8px;white-space:nowrap}
.ac-pill{font-size:10px;border:1px solid var(--rule);border-radius:8px;padding:0 6px;
  color:var(--dim);margin-left:6px}
.ac-pill--trust{border-color:var(--green);color:var(--green)}

.ac-trust{display:flex;gap:24px;flex-wrap:wrap;align-items:baseline}
.ac-trust>div{display:flex;flex-direction:column;gap:2px}
.ac-trust em{font-style:normal;font-size:11px;color:var(--dim);text-transform:uppercase;
  letter-spacing:.05em;font-family:'IBM Plex Mono',monospace}
.ac-trust strong{font-family:'IBM Plex Mono',monospace;font-size:19px}
.ac-trust .ac-ok,.ac-trust .ac-bad{font-size:13px;font-weight:600;align-self:center}

.ac-pl{border:1px solid var(--rule);border-radius:3px;overflow:hidden}
.ac-pl-h{background:#F5F7F9;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;
  color:var(--dim);font-family:'IBM Plex Mono',monospace;padding:6px 12px;
  border-bottom:1px solid var(--rule)}
.ac-pl-r{display:grid;grid-template-columns:50px 1fr 110px;gap:10px;padding:6px 12px;font-size:13px;
  border-bottom:1px solid #EEF2F4}
.ac-pl-r:last-child{border-bottom:0}
.ac-pl-r>span:last-child{text-align:right}
.ac-pl-t{font-weight:700;background:#FCFDFE}
.ac-noi{display:flex;justify-content:space-between;align-items:baseline;padding:10px 12px;
  border:1px solid var(--ink);border-radius:3px;font-size:14px}
.ac-noi strong{font-family:'IBM Plex Mono',monospace;font-size:20px}

.ac-aging{display:flex;flex-direction:column;gap:1px;background:var(--rule);
  border:1px solid var(--rule);border-radius:3px;overflow:hidden}
.ac-age{display:flex;justify-content:space-between;padding:9px 12px;background:var(--paper);
  font-size:13px}
.ac-age strong{font-size:14px}

.ac-preview{display:flex;gap:18px;flex:2 1 240px}
.ac-preview>div{display:flex;flex-direction:column}
.ac-preview em{font-style:normal;font-size:10.5px;color:var(--dim);text-transform:uppercase;
  letter-spacing:.05em;font-family:'IBM Plex Mono',monospace}
.ac-preview strong{font-family:'IBM Plex Mono',monospace;font-size:17px}

.ac-lines{display:flex;flex-direction:column;gap:7px}
.ac-lines-h{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.06em;
  text-transform:uppercase;color:var(--dim)}
.ac-lineRow{display:grid;grid-template-columns:minmax(180px,1fr) 1fr 110px 28px;gap:8px;
  align-items:center}
.ac-tally{display:flex;flex-direction:column;gap:4px;border-top:1px solid var(--rule);
  padding-top:10px;max-width:280px;margin-left:auto;width:100%}
.ac-tally>div{display:flex;justify-content:space-between;font-size:13px}
.ac-tally-t{font-weight:700;border-top:1px solid var(--rule);padding-top:5px;font-size:14px}
.ac-warnrow{color:#7A5D14}

.ac-err{font-size:12.5px;color:var(--red);background:#FDF6F7;border:1px solid var(--red);
  border-radius:3px;padding:9px 12px;line-height:1.6}
.ac-ok-box{font-size:12.5px;color:var(--green);background:#F5FAF8;border:1px solid var(--green);
  border-radius:3px;padding:9px 12px}

.ac-drawer-wrap{position:fixed;inset:0;background:rgba(19,28,37,.42);display:flex;
  justify-content:flex-end;z-index:50}
.ac-drawer{background:var(--paper);width:min(460px,100%);height:100%;overflow-y:auto;
  border-left:1px solid var(--rule);animation:acIn .2s cubic-bezier(.2,.8,.3,1)}
@keyframes acIn{from{transform:translateX(20px);opacity:.4}to{transform:none;opacity:1}}
@media (prefers-reduced-motion:reduce){.ac-drawer{animation:none}}
.ac-drawer-h{display:flex;justify-content:space-between;align-items:center;gap:12px;
  padding:18px 20px;border-bottom:1px solid var(--rule)}
.ac-drawer-h h3{font-family:'Archivo',sans-serif;font-size:17px;margin:0}
.ac-drawer-b{padding:18px 20px 40px;display:flex;flex-direction:column;gap:14px}
.ac-summary{display:flex;flex-direction:column;gap:4px;border:1px solid var(--rule);
  border-radius:3px;padding:11px 13px;background:#FCFDFE}
.ac-summary>div{display:flex;justify-content:space-between;font-size:13px}

.ac-apply{display:flex;flex-direction:column;gap:5px;border-top:1px solid var(--rule);padding-top:12px}
.ac-apply-h{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.06em;
  text-transform:uppercase;color:var(--dim)}
.ac-applyrow{display:grid;grid-template-columns:70px 1fr 90px 90px;gap:8px;align-items:center;
  font-size:12.5px}

.ac-figs{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:1px;
  background:var(--rule);border:1px solid var(--rule);border-radius:3px;overflow:hidden}
.ac-fig{background:var(--paper);padding:11px 13px}
.ac-fig-l{font-size:10px;letter-spacing:.05em;color:var(--dim);text-transform:uppercase;
  font-family:'IBM Plex Mono',monospace}
.ac-fig-v{font-family:'IBM Plex Mono',monospace;font-size:16px;font-weight:600;margin-top:2px}
.ac-narr{border-left:3px solid var(--accent);background:#FAFCFD;padding:12px 15px;border-radius:3px}
.ac-narr-h{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.06em;
  text-transform:uppercase;color:var(--dim);margin-bottom:5px}
.ac-narr p{margin:0;font-size:13.5px;line-height:1.75;white-space:pre-wrap}
.ac-method{font-size:12.5px}
.ac-method summary{cursor:pointer;color:var(--accent);padding:4px 0}
.ac-method pre{font-family:'IBM Plex Mono',monospace;font-size:11.5px;line-height:1.8;
  background:#F7F9FB;border:1px solid var(--rule);border-radius:3px;padding:11px 13px;margin:6px 0 0;
  white-space:pre-wrap;color:var(--ink2)}

.ac-coa{margin-bottom:14px}
.ac-coa-h{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.06em;
  text-transform:uppercase;color:var(--dim);padding-bottom:4px;border-bottom:1px solid var(--rule);
  margin-bottom:4px}
.ac-coa-r{display:grid;grid-template-columns:70px 1fr 70px 120px;gap:10px;padding:5px 0;
  font-size:13px;border-bottom:1px solid #F0F3F5}
.ac-coa-r>span:last-child{text-align:right}

.ac-arrbox{background:#F2F7FB;border-left:3px solid var(--accent);border-radius:3px;
  padding:11px 13px;font-size:12.5px;color:var(--ink2);line-height:1.7}
.ac-arrbox p{margin:5px 0 0;color:var(--dim)}
.ac-steps2{display:flex;flex-direction:column;gap:1px;background:var(--rule);
  border:1px solid var(--rule);border-radius:3px;overflow:hidden}
.ac-step2{background:var(--paper);padding:9px 12px;display:flex;flex-direction:column;gap:4px}
.ac-step2-h{display:flex;gap:11px;align-items:baseline;flex-wrap:wrap;font-size:12.5px}
.ac-noproof{font-size:12px;color:#6B5410;background:var(--amber);border-radius:3px;
  padding:6px 10px;line-height:1.65}
.ac-deemed{font-size:12.5px;color:var(--accent);background:#F4F9FD;border-radius:3px;
  padding:9px 12px;line-height:1.7}
.ac-foot{padding:6px 26px 0;color:var(--dim);font-size:11.5px;max-width:92ch;line-height:1.75}

@media (max-width:820px){
  .ac-head,.ac-tabs,.ac-body,.ac-note,.ac-foot{padding-left:16px;padding-right:16px}
  .ac-tr{grid-template-columns:1fr !important;gap:3px}
  .ac-tr--h{display:none}
  .ac-lineRow{grid-template-columns:1fr}
}
`;
