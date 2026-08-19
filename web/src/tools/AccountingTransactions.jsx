import React, { useCallback, useEffect, useMemo, useState } from "react";
import api from "../lib/api.js";

const money = (value) => new Intl.NumberFormat("en-CA", {
  style: "currency", currency: "CAD",
}).format(Number(value) || 0);
const today = () => new Date().toISOString().slice(0, 10);
const errorText = (error) => {
  if (error?.code === "INTERNAL_ERROR")
    return "Accounting Workspace database tables are not installed yet. Run 021_accounting_workspace.sql in Supabase, then reload.";
  return error?.code || error?.message || "Could not load the accounting workspace.";
};

export default function AccountingTransactions({ canPost, role }) {
  const [section, setSection] = useState("transactions");
  const [workspace, setWorkspace] = useState({ transactions: [], counts: {}, accounts: [], vendors: [] });
  const [rules, setRules] = useState([]);
  const [captures, setCaptures] = useState([]);
  const [integrations, setIntegrations] = useState(null);
  const [status, setStatus] = useState("review");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [quickOpen, setQuickOpen] = useState(false);

  const load = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const [workspaceData, rulesData, capturesData, integrationData] = await Promise.all([
        api.accountingWorkspace(), api.accountingBankRules(), api.accountingCaptures(),
        api.accountingIntegrations(),
      ]);
      setWorkspace(workspaceData);
      setRules(rulesData.rules || []);
      setCaptures(capturesData.captures || []);
      setIntegrations(integrationData);
    } catch (nextError) { setError(errorText(nextError)); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const visible = useMemo(() => workspace.transactions.filter((item) => {
    if (status !== "all" && item.status !== status) return false;
    const haystack = `${item.name || ""} ${item.description || ""} ${item.source_id || ""}`.toLowerCase();
    return !query.trim() || haystack.includes(query.trim().toLowerCase());
  }), [workspace.transactions, status, query]);

  const act = async (transaction, action, extra = {}) => {
    setBusy(true); setError(""); setNotice("");
    try {
      await api.reviewBankTransaction(transaction.source_id, { action, ...extra });
      setNotice(action === "post" ? "Transaction posted to the ledger."
        : action === "match" ? "Match confirmed." : "Review status updated.");
      await load();
    } catch (nextError) { setError(errorText(nextError)); setBusy(false); }
  };

  const applyRules = async () => {
    setBusy(true); setError("");
    try {
      const result = await api.applyAccountingBankRules();
      setNotice(`${result.suggested} suggestions created; ${result.exact} exact amount/date matches found.`);
      await load();
    } catch (nextError) { setError(errorText(nextError)); setBusy(false); }
  };

  return (
    <div className="ac-body ac-workspace">
      <section className="ac-card">
        <div className="ac-cardh">
          <div>
            <h2>Transactions centre</h2>
            <p className="ac-note-p">Review first, then match or post. Imported bank lines remain unchanged and every decision is audited.</p>
          </div>
          <div className="ac-cardh-r">
            <button className="ac-btn ac-btn--ghost ac-btn--sm" onClick={load} disabled={busy}>Refresh</button>
            {canPost && <button className="ac-btn ac-btn--sm" onClick={() => setQuickOpen((value) => !value)}>
              + Quick add
            </button>}
          </div>
        </div>

        <div className="ac-seg">
          {[['transactions', 'Transactions'], ['rules', 'Bank rules'], ['capture', 'Receipts & invoices']].map(([key, label]) => (
            <button key={key} className={section === key ? "on" : ""} onClick={() => setSection(key)}>{label}</button>
          ))}
        </div>

        {error && <div className="ac-err">{error}</div>}
        {notice && <div className="ac-ok-box">{notice}</div>}
        {quickOpen && canPost && <QuickAdd workspace={workspace} onDone={async () => {
          setQuickOpen(false); setNotice("Saved to Supabase and added to the ledger queue."); await load();
        }} onError={(nextError) => setError(errorText(nextError))} />}

        {section === "transactions" && <>
          <div className="ac-ws-statuses">
            {[['review', 'For review'], ['matched', 'Matched'], ['posted', 'Posted'], ['excluded', 'Excluded'], ['all', 'All']]
              .map(([key, label]) => <button key={key} className={status === key ? "on" : ""} onClick={() => setStatus(key)}>
                <span>{label}</span><b>{key === "all" ? workspace.transactions.length : workspace.counts?.[key] || 0}</b>
              </button>)}
          </div>
          <div className="ac-row">
            <input className="ac-in" value={query} onChange={(event) => setQuery(event.target.value)}
              placeholder="Search description, vendor, unit or reference" />
            {canPost && <button className="ac-btn ac-btn--ghost" onClick={applyRules} disabled={busy}>Find matches & apply rules</button>}
          </div>
          {busy && !workspace.transactions.length ? <div className="ac-empty">Loading transactions…</div>
            : visible.length === 0 ? <div className="ac-empty">No transactions in this view.</div>
              : <div className="ac-ws-list">
                {visible.map((transaction) => <TransactionRow key={`${transaction.source_type}:${transaction.source_id}`}
                  transaction={transaction} accounts={workspace.accounts} canPost={canPost} busy={busy} onAct={act} />)}
              </div>}
        </>}

        {section === "rules" && <BankRules rules={rules} accounts={workspace.accounts}
          canPost={canPost} busy={busy} onReload={load} onError={(nextError) => setError(errorText(nextError))} />}

        {section === "capture" && <Capture captures={captures} canPost={canPost}
          busy={busy} onReload={load} onError={(nextError) => setError(errorText(nextError))} />}
      </section>

      <section className="ac-card ac-provider">
        <div className="ac-cardh"><h2>Connections</h2><span className="ac-dim">Provider credentials stay in Cloudflare secrets.</span></div>
        <div className="ac-provider-grid">
          <Provider label="Bank feed" value={integrations?.bank_feed} />
          <Provider label="Online tenant payments" value={integrations?.online_payments} />
          <div className="ac-provider-note">Supabase is connected as the accounting system of record. A bank or card provider only imports or settles money; it never replaces the ledger.</div>
        </div>
        {!canPost && <p className="ac-note-p">{role === "property_manager"
          ? "PM can see every transaction and use the figures in monthly reports. Accounting confirms matches and posts entries."
          : "Read-only accounting access."}</p>}
      </section>
    </div>
  );
}

function Provider({ label, value }) {
  const configured = !!value?.configured;
  return <div className={`ac-provider-state ${configured ? "ok" : "wait"}`}>
    <i>{configured ? "✓" : "!"}</i><div><strong>{label}</strong>
      <span>{configured ? `${value.provider} configured` : "Provider not configured"}</span></div>
  </div>;
}

function TransactionRow({ transaction, accounts, canPost, busy, onAct }) {
  const [gl, setGl] = useState(transaction.suggested_gl || "");
  const bankLine = transaction.source_type === "bank_transaction";
  return <article className="ac-ws-row">
    <div className="ac-ws-date"><strong>{transaction.date}</strong><span>{transaction.source_type.replaceAll("_", " ")}</span></div>
    <div className="ac-ws-main"><strong>{transaction.name || "Transaction"}</strong>
      <span>{transaction.description || transaction.review_note || "—"}</span>
      {transaction.suggested_id && <small>Suggested exact match: {transaction.suggested_type} · {transaction.suggested_id}</small>}
      {transaction.rule_id && <small>{transaction.review_note || "Bank rule suggestion"}</small>}
    </div>
    <div className={`ac-ws-amount ${Number(transaction.amount) < 0 ? "out" : "in"}`}>
      {Number(transaction.amount) < 0 ? "−" : "+"}{money(Math.abs(Number(transaction.amount)))}
      <span className={`ac-ws-state ${transaction.status}`}>{transaction.status}</span>
    </div>
    {bankLine && canPost && <div className="ac-ws-actions">
      {transaction.status === "review" && <>
        {transaction.suggested_id && <button className="ac-btn ac-btn--xs" disabled={busy}
          onClick={() => onAct(transaction, "match", { matched_type: transaction.suggested_type, matched_id: transaction.suggested_id })}>Accept match</button>}
        <select className="ac-sel" value={gl} onChange={(event) => setGl(event.target.value)}>
          <option value="">Choose category…</option>
          {accounts.filter((account) => !account.is_bank).map((account) =>
            <option key={account.code} value={account.code}>{account.code} · {account.name}</option>)}
        </select>
        <button className="ac-btn ac-btn--xs" disabled={busy || !gl}
          onClick={() => onAct(transaction, "post", { gl_code: gl })}>Post</button>
        <button className="ac-btn ac-btn--ghost ac-btn--xs" disabled={busy}
          onClick={() => onAct(transaction, "exclude")}>Exclude</button>
      </>}
      {transaction.status === "matched" && <button className="ac-btn ac-btn--xs" disabled={busy}
        onClick={() => onAct(transaction, "post", transaction.suggested_gl && !transaction.review_matched_id
          ? { gl_code: transaction.suggested_gl }
          : { matched_type: transaction.review_matched_type || transaction.matched_type,
            matched_id: transaction.review_matched_id || transaction.matched_id })}>Confirm & post</button>}
      {transaction.status === "excluded" && <button className="ac-btn ac-btn--ghost ac-btn--xs" disabled={busy}
        onClick={() => onAct(transaction, "restore")}>Restore</button>}
    </div>}
  </article>;
}

function QuickAdd({ workspace, onDone, onError }) {
  const [form, setForm] = useState({ kind: "expense", date: today(), due_date: today(),
    amount: "", gst: "", gl_code: "", bank_gl: workspace.accounts.find((a) => a.code === "1010")?.code || "",
    vendor_id: "", invoice_no: "", unit_number: "", memo: "", name: "" });
  const [saving, setSaving] = useState(false);
  const field = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const save = async () => {
    setSaving(true);
    try { await api.accountingQuickAdd(form); await onDone(); }
    catch (error) { onError(error); }
    finally { setSaving(false); }
  };
  const showMoney = ["expense", "income", "bill", "tenant_receipt"].includes(form.kind);
  return <div className="ac-panel ac-quickadd">
    <div className="ac-cardh"><h2>Quick add</h2><span className="ac-dim">Saves to Supabase, not this browser.</span></div>
    <div className="ac-row">
      <label className="ac-f"><span>Type</span><select className="ac-sel" value={form.kind} onChange={(e) => field("kind", e.target.value)}>
        <option value="expense">Expense</option><option value="income">Income</option>
        <option value="tenant_receipt">Tenant receipt</option><option value="bill">Vendor bill</option>
        <option value="vendor">Vendor</option>
      </select></label>
      {form.kind === "vendor" ? <label className="ac-f"><span>Vendor name</span><input className="ac-in" value={form.name} onChange={(e) => field("name", e.target.value)} /></label>
        : <label className="ac-f"><span>Date</span><input className="ac-in" type="date" value={form.date} onChange={(e) => field("date", e.target.value)} /></label>}
      {showMoney && <label className="ac-f"><span>Amount before GST</span><input className="ac-in" type="number" step="0.01" value={form.amount} onChange={(e) => field("amount", e.target.value)} /></label>}
    </div>
    {form.kind !== "vendor" && <div className="ac-row">
      {form.kind === "bill" && <><label className="ac-f"><span>Vendor</span><select className="ac-sel" value={form.vendor_id} onChange={(e) => field("vendor_id", e.target.value)}><option value="">Choose…</option>{workspace.vendors.map((v) => <option value={v.id} key={v.id}>{v.name}</option>)}</select></label>
        <label className="ac-f"><span>Invoice number</span><input className="ac-in" value={form.invoice_no} onChange={(e) => field("invoice_no", e.target.value)} /></label>
        <label className="ac-f"><span>Due date</span><input className="ac-in" type="date" value={form.due_date} onChange={(e) => field("due_date", e.target.value)} /></label></>}
      {form.kind === "tenant_receipt" && <label className="ac-f"><span>Unit</span><input className="ac-in" value={form.unit_number} onChange={(e) => field("unit_number", e.target.value)} placeholder="3A" /></label>}
      {form.kind !== "tenant_receipt" && <label className="ac-f"><span>Category</span><select className="ac-sel" value={form.gl_code} onChange={(e) => field("gl_code", e.target.value)}><option value="">Choose…</option>{workspace.accounts.filter((a) => !a.is_bank).map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}</select></label>}
      {form.kind !== "bill" && <label className="ac-f"><span>Bank account</span><select className="ac-sel" value={form.bank_gl} onChange={(e) => field("bank_gl", e.target.value)}>{workspace.accounts.filter((a) => a.is_bank).map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}</select></label>}
    </div>}
    <label className="ac-f"><span>Memo</span><input className="ac-in" value={form.memo} onChange={(e) => field("memo", e.target.value)} /></label>
    <div className="ac-actions"><button className="ac-btn ac-btn--sm" onClick={save} disabled={saving}>{saving ? "Saving…" : form.kind === "bill" ? "Save for approval" : "Save"}</button></div>
  </div>;
}

function BankRules({ rules, accounts, canPost, busy, onReload, onError }) {
  const [form, setForm] = useState({ name: "", contains: "", direction: "out", gl_code: "", auto_confirm: false });
  const create = async () => {
    try {
      await api.createAccountingBankRule({ name: form.name,
        conditions: { contains: form.contains, direction: form.direction },
        actions: { gl_code: form.gl_code }, auto_confirm: form.auto_confirm });
      setForm({ name: "", contains: "", direction: "out", gl_code: "", auto_confirm: false });
      await onReload();
    } catch (error) { onError(error); }
  };
  return <div className="ac-rules">
    {canPost && <div className="ac-panel">
      <div className="ac-row">
        <label className="ac-f"><span>Rule name</span><input className="ac-in" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="EPCOR utilities" /></label>
        <label className="ac-f"><span>Description contains</span><input className="ac-in" value={form.contains} onChange={(e) => setForm({ ...form, contains: e.target.value })} placeholder="EPCOR" /></label>
        <label className="ac-f"><span>Money</span><select className="ac-sel" value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })}><option value="out">Out</option><option value="in">In</option></select></label>
        <label className="ac-f"><span>Category</span><select className="ac-sel" value={form.gl_code} onChange={(e) => setForm({ ...form, gl_code: e.target.value })}><option value="">Choose…</option>{accounts.filter((a) => !a.is_bank).map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}</select></label>
      </div>
      <label className="ac-check"><input type="checkbox" checked={form.auto_confirm} onChange={(e) => setForm({ ...form, auto_confirm: e.target.checked })} /> Mark as matched automatically; Accounting still confirms before posting.</label>
      <button className="ac-btn ac-btn--sm" disabled={!form.name.trim() || !form.gl_code || busy} onClick={create}>Create rule</button>
    </div>}
    {rules.length === 0 ? <div className="ac-empty">No bank rules yet.</div> : <div className="ac-table">
      {rules.map((rule) => <div className="ac-tr ac-rule-row" key={rule.id}>
        <div><strong>{rule.name}</strong><span>{rule.conditions?.direction || "both"} · contains “{rule.conditions?.contains || "anything"}”</span></div>
        <span className="ac-mono">{rule.actions?.gl_code || "No category"}</span>
        <span className={`ac-ws-state ${rule.is_active ? "posted" : "excluded"}`}>{rule.is_active ? "active" : "off"}</span>
        {canPost && <div className="ac-actions"><button className="ac-btn ac-btn--ghost ac-btn--xs" onClick={async () => { try { await api.updateAccountingBankRule(rule.id, { is_active: !rule.is_active }); await onReload(); } catch (error) { onError(error); } }}>{rule.is_active ? "Turn off" : "Turn on"}</button>
          <button className="ac-btn ac-btn--ghost ac-btn--xs" onClick={async () => { try { await api.deleteAccountingBankRule(rule.id); await onReload(); } catch (error) { onError(error); } }}>Delete</button></div>}
      </div>)}
    </div>}
  </div>;
}

function Capture({ captures, canPost, busy, onReload, onError }) {
  const [type, setType] = useState("receipt");
  const [uploading, setUploading] = useState(false);
  const upload = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setUploading(true);
    try { await api.uploadAccountingCapture(file, type); await onReload(); }
    catch (error) { onError(error); }
    finally { setUploading(false); }
  };
  return <div className="ac-captures">
    {canPost && <div className="ac-row ac-capture-upload">
      <label className="ac-f"><span>Document type</span><select className="ac-sel" value={type} onChange={(e) => setType(e.target.value)}><option value="receipt">Receipt</option><option value="vendor_invoice">Vendor invoice</option><option value="bank_document">Bank document</option><option value="other">Other</option></select></label>
      <label className="ac-upload-btn"><input type="file" accept="application/pdf,image/jpeg,image/png" onChange={upload} disabled={uploading || busy} />{uploading ? "Reading…" : "Upload or photograph document"}</label>
    </div>}
    <p className="ac-note-p">Images are read by Cloudflare Workers AI. Extracted values are drafts only and must be confirmed before posting. Originals stay in R2; fields and workflow status stay in Supabase.</p>
    {captures.length === 0 ? <div className="ac-empty">No captured documents yet.</div> : <div className="ac-ws-list">{captures.map((capture) => <article className="ac-capture" key={capture.id}>
      <div><strong>{capture.filename}</strong><span>{capture.document_type.replaceAll("_", " ")} · {new Date(capture.created_at).toLocaleString("en-CA")}</span></div>
      <div className="ac-capture-fields"><span>{capture.extracted?.vendor || "Vendor not read"}</span><strong>{capture.extracted?.total != null ? money(capture.extracted.total) : "Amount not read"}</strong><span>{capture.extracted?.date || "Date not read"}</span></div>
      <span className={`ac-ws-state ${capture.status === "ready" ? "matched" : capture.status === "converted" ? "posted" : "review"}`}>{capture.status.replaceAll("_", " ")}</span>
      <a className="ac-btn ac-btn--ghost ac-btn--xs" href={api.accountingCaptureUrl(capture.id)} target="_blank" rel="noreferrer">View original</a>
      <small>{capture.extraction_note}</small>
    </article>)}</div>}
  </div>;
}
