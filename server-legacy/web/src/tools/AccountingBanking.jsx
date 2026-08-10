import React, { useState, useMemo } from "react";

/* ============================================================
   Banking and the period close

   Reconciling is where the books meet reality. Two rules hold it
   together and neither is negotiable:

   Every statement line must be matched to something in the ledger.
   An unexplained line is not a rounding issue, it is a transaction
   nobody has accounted for.

   The statement closing balance must equal the ledger balance to
   the cent. Reconciling "with a small difference" is how a small
   difference becomes permanent and untraceable.

   Only once every statement for a period reconciles can the period
   be marked reconciled, and only then can a report be generated.
   That ordering is the whole point: a report written from open
   figures describes numbers that are still moving.
   ============================================================ */

const money = (n) =>
  n == null || isNaN(n) ? "—"
    : new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(n);
const cents = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const today = () => new Date().toISOString().slice(0, 10);
const thisPeriod = () => new Date().toISOString().slice(0, 7);
const daysApart = (a, b) =>
  Math.abs(Math.round((new Date(a + "T12:00") - new Date(b + "T12:00")) / 864e5));

export default function Banking({ statements, entries, receipts, invoices, periods,
                                  balances, save, canPost, session, coa }) {
  const [period, setPeriod] = useState(thisPeriod());
  const [openId, setOpenId] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const bankAccounts = coa.filter((a) => a.is_bank === 1 || a.is_bank === true);
  const periodState = periods.find((p) => p.period === period)?.state ?? "open";
  const forPeriod = statements.filter((s) => s.period === period);
  const allReconciled = forPeriod.length > 0 && forPeriod.every((s) => s.state === "reconciled");

  /* Ledger balance for a bank account up to a date. What the books say the
     account holds, before anyone looks at the statement. */
  const ledgerTo = (glCode, endDate) => {
    let bal = 0;
    for (const e of entries) {
      if (e.state !== "posted" || e.entry_date > endDate) continue;
      for (const l of e.lines) {
        if (l.gl !== glCode) continue;
        bal = cents(bal + l.debit - l.credit);
      }
    }
    return bal;
  };

  const reconcilePeriod = () => {
    setErr(""); setMsg("");
    if (forPeriod.length === 0)
      return setErr("No statements uploaded for this period. There is nothing to reconcile against.");
    const outstanding = forPeriod.filter((s) => s.state !== "reconciled");
    if (outstanding.length)
      return setErr(`${outstanding.length} statement(s) still open. Every account has to agree before the period does.`);
    save.periods([...periods.filter((p) => p.period !== period),
      { period, state: "reconciled", by: session?.name, at: new Date().toISOString() }]);
    setMsg(`${period} reconciled. Reports can now be generated.`);
  };

  const closePeriod = () => {
    setErr(""); setMsg("");
    if (periodState !== "reconciled")
      return setErr("Reconcile the period first. Closing an unreconciled period locks in whatever was wrong with it.");
    save.periods(periods.map((p) => p.period === period
      ? { ...p, state: "closed", closed_by: session?.name, closed_at: new Date().toISOString() } : p));
    setMsg(`${period} closed. Nothing further can post into it.`);
  };

  const reopenPeriod = () => {
    save.periods(periods.map((p) => p.period === period
      ? { ...p, state: "reconciled", closed_by: null, closed_at: null } : p));
    setMsg(`${period} reopened.`);
  };

  const statement = statements.find((s) => s.id === openId);

  return (
    <div className="ac-body">
      <section className="ac-card">
        <div className="ac-cardh">
          <h2>Period</h2>
          <div className="ac-cardh-r">
            <input className="ac-in ac-in--sm" type="month" value={period}
                   onChange={(e) => { setPeriod(e.target.value); setOpenId(null);
                                      setErr(""); setMsg(""); }} />
            <span className="ac-tag" style={{ "--c": periodState === "closed" ? "#0E8577"
              : periodState === "reconciled" ? "#1C6FA6" : "#8892A0" }}>
              {periodState}
            </span>
          </div>
        </div>

        <div className="ac-steps">
          <Step n={1} label="Statements uploaded"
                done={forPeriod.length > 0}
                detail={forPeriod.length ? `${forPeriod.length} account(s)` : "Nothing yet"} />
          <Step n={2} label="Every line matched"
                done={allReconciled}
                detail={forPeriod.length === 0 ? "—"
                  : `${forPeriod.filter((s) => s.state === "reconciled").length} of ${forPeriod.length} agreed`} />
          <Step n={3} label="Period reconciled"
                done={periodState !== "open"}
                detail={periodState === "open" ? "Not yet" : "Reports can be generated"} />
          <Step n={4} label="Period closed"
                done={periodState === "closed"}
                detail={periodState === "closed" ? "Locked" : "Optional until year end"} />
        </div>

        {canPost && (
          <div className="ac-actions">
            <button className="ac-btn" disabled={!allReconciled || periodState !== "open"}
                    onClick={reconcilePeriod}>
              Mark {period} reconciled
            </button>
            {periodState === "reconciled" && (
              <button className="ac-btn ac-btn--ghost" onClick={closePeriod}>Close the period</button>
            )}
            {periodState === "closed" && (
              <button className="ac-btn ac-btn--ghost" onClick={reopenPeriod}>Reopen</button>
            )}
            <button className="ac-btn ac-btn--ghost" onClick={() => setUploading(!uploading)}>
              Upload a statement
            </button>
          </div>
        )}

        {err && <div className="ac-err">{err}</div>}
        {msg && <div className="ac-ok-box">{msg}</div>}

        <p className="ac-note-p">
          A closed period rejects new postings. If something turns up afterwards it is
          posted to the current month with a note, not backdated — backdating a closed
          month changes a report someone has already read.
        </p>
      </section>

      {uploading && canPost && (
        <UploadStatement accounts={bankAccounts} period={period}
          existing={statements}
          onAdd={(s) => { save.statements([s, ...statements]); setUploading(false); setOpenId(s.id); }}
          onCancel={() => setUploading(false)} />
      )}

      <section className="ac-card">
        <h2>Statements <span className="ac-n">{forPeriod.length}</span></h2>
        {forPeriod.length === 0 ? (
          <div className="ac-empty">
            Nothing uploaded for {period}. Accounting uploads each bank statement here,
            including the trust account.
          </div>
        ) : (
          <div className="ac-table">
            <div className="ac-tr ac-tr--h" style={{ gridTemplateColumns: "1fr 1fr 110px 110px 90px 110px" }}>
              <span>Account</span><span>File</span><span>Closing</span>
              <span>Ledger</span><span>Lines</span><span />
            </div>
            {forPeriod.map((s) => {
              const ledger = ledgerTo(s.gl_code, s.end_date);
              const diff = cents(s.closing_balance - ledger);
              const unmatched = s.transactions.filter((t) => !t.matched_id).length;
              return (
                <div className="ac-tr" key={s.id}
                     style={{ gridTemplateColumns: "1fr 1fr 110px 110px 90px 110px" }}>
                  <span>
                    <span className="ac-mono ac-strong">{s.gl_code}</span>{" "}
                    {coa.find((a) => a.code === s.gl_code)?.name}
                    {coa.find((a) => a.code === s.gl_code)?.is_trust === 1 &&
                      <span className="ac-pill ac-pill--trust">trust</span>}
                  </span>
                  <span className="ac-dim ac-cut">{s.filename || "keyed by hand"}</span>
                  <span className="ac-mono">{money(s.closing_balance)}</span>
                  <span className={`ac-mono ${Math.abs(diff) >= 0.01 ? "ac-bad" : ""}`}>
                    {money(ledger)}
                  </span>
                  <span className="ac-mono">
                    {unmatched > 0
                      ? <span className="ac-bad">{unmatched} left</span>
                      : <span className="ac-ok">all</span>}
                  </span>
                  <span className="ac-actions">
                    <span className="ac-tag" style={{ "--c": s.state === "reconciled"
                      ? "#0E8577" : "#C98A15" }}>{s.state}</span>
                    <button className="ac-btn ac-btn--xs" onClick={() => setOpenId(s.id)}>Open</button>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {statement && (
        <Reconcile statement={statement} ledger={ledgerTo(statement.gl_code, statement.end_date)}
          receipts={receipts} invoices={invoices} entries={entries} canPost={canPost}
          session={session} coa={coa}
          onClose={() => setOpenId(null)}
          onUpdate={(next) => save.statements(statements.map((s) => s.id === next.id ? next : s))} />
      )}
    </div>
  );
}

function Step({ n, label, done, detail }) {
  return (
    <div className={`ac-step ${done ? "done" : ""}`}>
      <span className="ac-step-n">{done ? "✓" : n}</span>
      <div>
        <strong>{label}</strong>
        <span className="ac-dim">{detail}</span>
      </div>
    </div>
  );
}

/* ---------- upload ---------- */

function UploadStatement({ accounts, period, existing, onAdd, onCancel }) {
  const [glCode, setGlCode] = useState(accounts[0]?.code ?? "1010");
  const [file, setFile] = useState(null);
  const [opening, setOpening] = useState("");
  const [closing, setClosing] = useState("");
  const [start, setStart] = useState(`${period}-01`);
  const [end, setEnd] = useState("");
  const [csv, setCsv] = useState("");
  const [err, setErr] = useState("");

  const dup = existing.some((s) => s.period === period && s.gl_code === glCode);

  /* Rows are pasted as CSV. Parsing a bank PDF in the browser is a guess
     dressed up as a feature; pasting the export is boring and correct. */
  const rows = useMemo(() => {
    const out = [];
    for (const line of csv.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const parts = t.split(/[,\t]/).map((x) => x.trim().replace(/^["']|["']$/g, ""));
      if (parts.length < 3) continue;
      const [date, description, debit, credit, balance] = parts;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      out.push({ id: uid("bt_"), txn_date: date, description: description || "",
        debit: cents(Number(debit) || 0), credit: cents(Number(credit) || 0),
        balance: balance === undefined || balance === "" ? null : cents(Number(balance)),
        matched_type: null, matched_id: null });
    }
    return out;
  }, [csv]);

  const sum = useMemo(() => ({
    debit: cents(rows.reduce((t, r) => t + r.debit, 0)),
    credit: cents(rows.reduce((t, r) => t + r.credit, 0)),
  }), [rows]);

  const impliedClose = cents(Number(opening || 0) + sum.credit - sum.debit);
  const declaredClose = cents(Number(closing || 0));
  const closeMatches = !closing || Math.abs(impliedClose - declaredClose) < 0.01;

  const submit = () => {
    setErr("");
    if (dup) return setErr("A statement for this account and period is already uploaded.");
    if (!end) return setErr("Enter the statement end date.");
    if (rows.length === 0) return setErr("No transaction rows found. Paste the CSV export.");
    if (!closeMatches)
      return setErr(`Opening ${money(Number(opening))} plus the rows gives ${money(impliedClose)}, but the closing balance says ${money(declaredClose)}. A row is missing or mistyped.`);
    onAdd({ id: uid("bs_"), gl_code: glCode, period, start_date: start, end_date: end,
      opening_balance: cents(opening || 0), closing_balance: declaredClose,
      filename: file?.name ?? null, transactions: rows, state: "uploading" });
  };

  return (
    <section className="ac-card">
      <h2>Upload a statement</h2>
      <div className="ac-row">
        <label className="ac-f"><span>Account</span>
          <select className="ac-sel" value={glCode} onChange={(e) => setGlCode(e.target.value)}>
            {accounts.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
          </select></label>
        <label className="ac-f"><span>From</span>
          <input className="ac-in" type="date" value={start}
                 onChange={(e) => setStart(e.target.value)} /></label>
        <label className="ac-f"><span>To</span>
          <input className="ac-in" type="date" value={end}
                 onChange={(e) => setEnd(e.target.value)} /></label>
      </div>
      <div className="ac-row">
        <label className="ac-f"><span>Opening balance</span>
          <input className="ac-in" type="number" step="0.01" value={opening}
                 onChange={(e) => setOpening(e.target.value)} /></label>
        <label className="ac-f"><span>Closing balance</span>
          <input className="ac-in" type="number" step="0.01" value={closing}
                 onChange={(e) => setClosing(e.target.value)} /></label>
        <label className="ac-f"><span>Statement file <em>kept as the record</em></span>
          <input className="ac-in" type="file" accept=".pdf,.csv,.txt"
                 onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
      </div>

      <label className="ac-f">
        <span>Transaction rows</span>
        <textarea className="ac-in ac-ta" rows={7} value={csv}
                  placeholder={"2026-08-01, Rent 370-412 e-transfer, , 1450.00\n2026-08-03, Northgate Plumbing, 682.50, \n2026-08-05, Monthly account fee, 12.00,"}
                  onChange={(e) => setCsv(e.target.value)} />
        <em className="ac-hint">
          Paste the CSV export: date, description, money out, money in, balance.
          The browser cannot read a bank PDF reliably, and a wrong guess here is
          worse than typing it.
        </em>
      </label>

      {rows.length > 0 && (
        <div className="ac-tally">
          <div><span>Rows found</span><span className="ac-mono">{rows.length}</span></div>
          <div><span>Money in</span><span className="ac-mono">{money(sum.credit)}</span></div>
          <div><span>Money out</span><span className="ac-mono">{money(sum.debit)}</span></div>
          <div className={closeMatches ? "" : "ac-warnrow"}>
            <span>Implied closing</span><span className="ac-mono">{money(impliedClose)}</span>
          </div>
        </div>
      )}

      {err && <div className="ac-err">{err}</div>}
      <div className="ac-actions">
        <button className="ac-btn" onClick={submit} disabled={rows.length === 0}>
          Upload {rows.length ? `${rows.length} rows` : ""}
        </button>
        <button className="ac-btn ac-btn--ghost" onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
}

/* ---------- reconcile ---------- */

function Reconcile({ statement, ledger, receipts, invoices, entries, canPost,
                     session, coa, onClose, onUpdate }) {
  const [err, setErr] = useState("");
  const txns = statement.transactions;
  const unmatched = txns.filter((t) => !t.matched_id);
  const diff = cents(statement.closing_balance - ledger);
  const account = coa.find((a) => a.code === statement.gl_code);

  /* Suggestions only. Same amount within a few days is a good hint and a
     poor decision: in a building where forty tenants pay the same rent on
     the same day, an exact match means very little on its own. */
  const suggestFor = (t) => {
    if (t.credit > 0) {
      return receipts
        .filter((r) => Math.abs(r.amount - t.credit) < 0.005 && daysApart(r.received_date, t.txn_date) <= 5)
        .slice(0, 4)
        .map((r) => ({ type: "ar_receipt", id: r.id,
          label: `Receipt ${r.receipt_no} · ${r.unit_number ?? "—"} · ${r.received_date}` }));
    }
    return invoices
      .filter((i) => Math.abs(i.total - t.debit) < 0.005)
      .slice(0, 4)
      .map((i) => ({ type: "ap_invoice", id: i.id, label: `${i.invoice_no} · ${i.invoice_date}` }));
  };

  const match = (txnId, choice) => {
    onUpdate({ ...statement, transactions: txns.map((t) => t.id === txnId
      ? { ...t, matched_type: choice?.type ?? null, matched_id: choice?.id ?? null,
          matched_by: choice ? session?.name : null } : t) });
  };

  const finish = () => {
    setErr("");
    if (unmatched.length)
      return setErr(`${unmatched.length} line(s) still unexplained. An unmatched line is a transaction nobody has accounted for, not a rounding issue.`);
    if (Math.abs(diff) >= 0.01)
      return setErr(`The statement says ${money(statement.closing_balance)} and the ledger says ${money(ledger)} — out by ${money(diff)}. Find it rather than reconciling around it.`);
    onUpdate({ ...statement, state: "reconciled",
      reconciled_by: session?.name, reconciled_at: new Date().toISOString() });
    onClose();
  };

  return (
    <section className="ac-card">
      <div className="ac-cardh">
        <h2>
          {statement.gl_code} · {account?.name}
          {account?.is_trust === 1 && <span className="ac-pill ac-pill--trust">trust</span>}
        </h2>
        <div className="ac-cardh-r">
          <span className="ac-dim">{statement.start_date} → {statement.end_date}</span>
          <button className="ac-btn ac-btn--xs ac-btn--ghost" onClick={onClose}>Close</button>
        </div>
      </div>

      <div className="ac-recon">
        <div><em>Statement closing</em><strong>{money(statement.closing_balance)}</strong></div>
        <div><em>Ledger</em><strong>{money(ledger)}</strong></div>
        <div><em>Difference</em>
          <strong className={Math.abs(diff) >= 0.01 ? "ac-bad" : "ac-ok"}>{money(diff)}</strong></div>
        <div><em>Unmatched</em>
          <strong className={unmatched.length ? "ac-bad" : "ac-ok"}>{unmatched.length}</strong></div>
      </div>

      {account?.is_trust === 1 && (
        <p className="ac-note-p">
          This is the trust account. Nothing but deposits, deposit interest and
          refunds belongs here. An operating expense on this statement is a
          problem to fix, not a line to match.
        </p>
      )}

      <div className="ac-table">
        <div className="ac-tr ac-tr--h" style={{ gridTemplateColumns: "95px 1fr 100px 100px 1fr" }}>
          <span>Date</span><span>Description</span><span>Out</span><span>In</span><span>Matched to</span>
        </div>
        {txns.map((t) => {
          const suggestions = t.matched_id ? [] : suggestFor(t);
          return (
            <div className={`ac-tr ${t.matched_id ? "" : "late"}`} key={t.id}
                 style={{ gridTemplateColumns: "95px 1fr 100px 100px 1fr" }}>
              <span className="ac-mono">{t.txn_date}</span>
              <span className="ac-cut">{t.description}</span>
              <span className="ac-mono">{t.debit > 0 ? money(t.debit) : ""}</span>
              <span className="ac-mono">{t.credit > 0 ? money(t.credit) : ""}</span>
              <span className="ac-actions">
                {t.matched_id ? (
                  <>
                    <span className="ac-tag" style={{ "--c": "#0E8577" }}>matched</span>
                    {canPost && (
                      <button className="ac-x" title="Unmatch"
                              onClick={() => match(t.id, null)}>×</button>
                    )}
                  </>
                ) : canPost ? (
                  <select className="ac-sel ac-sel--xs"
                          onChange={(e) => {
                            const s = suggestions[Number(e.target.value)];
                            if (s) match(t.id, s);
                          }}
                          defaultValue="">
                    <option value="" disabled>
                      {suggestions.length ? `${suggestions.length} possible` : "Nothing obvious"}
                    </option>
                    {suggestions.map((s, i) => <option key={s.id} value={i}>{s.label}</option>)}
                  </select>
                ) : <span className="ac-dim">unmatched</span>}
              </span>
            </div>
          );
        })}
      </div>

      {err && <div className="ac-err">{err}</div>}

      {canPost && statement.state !== "reconciled" && (
        <div className="ac-actions">
          <button className="ac-btn" onClick={finish}
                  disabled={unmatched.length > 0 || Math.abs(diff) >= 0.01}>
            Mark this account reconciled
          </button>
          {(unmatched.length > 0 || Math.abs(diff) >= 0.01) && (
            <span className="ac-dim">
              {unmatched.length > 0
                ? `${unmatched.length} line(s) to explain first`
                : `Out by ${money(diff)}`}
            </span>
          )}
        </div>
      )}

      {statement.state === "reconciled" && (
        <div className="ac-ok-box">
          Reconciled by {statement.reconciled_by} · {statement.reconciled_at?.slice(0, 16).replace("T", " ")}
        </div>
      )}

      <style>{EXTRA_CSS}</style>
    </section>
  );
}

const EXTRA_CSS = `
.ac-steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:1px;
  background:var(--rule);border:1px solid var(--rule);border-radius:3px;overflow:hidden}
.ac-step{display:flex;gap:10px;align-items:flex-start;padding:11px 13px;background:var(--paper)}
.ac-step.done{background:#F6FBF8}
.ac-step-n{flex:0 0 21px;height:21px;border-radius:50%;display:flex;align-items:center;
  justify-content:center;font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:700;
  background:var(--ground);color:var(--dim)}
.ac-step.done .ac-step-n{background:var(--green);color:#fff}
.ac-step>div{display:flex;flex-direction:column;gap:1px;min-width:0}
.ac-step strong{font-size:12.5px}
.ac-recon{display:flex;gap:26px;flex-wrap:wrap;padding:12px 14px;border:1px solid var(--rule);
  border-radius:3px;background:#FCFDFE}
.ac-recon>div{display:flex;flex-direction:column;gap:2px}
.ac-recon em{font-style:normal;font-size:10.5px;color:var(--dim);text-transform:uppercase;
  letter-spacing:.05em;font-family:'IBM Plex Mono',monospace}
.ac-recon strong{font-family:'IBM Plex Mono',monospace;font-size:17px}
.ac-ta{font-family:'IBM Plex Mono',monospace;font-size:12px;line-height:1.7;resize:vertical}
.ac-sel--xs{padding:3px 6px;font-size:11.5px}
`;
