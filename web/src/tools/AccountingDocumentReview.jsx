import React, { useCallback, useEffect, useMemo, useState } from "react";
import api from "../lib/api.js";

const money = (n) => n == null || Number.isNaN(Number(n)) ? "—"
  : new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(Number(n));
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (date, days) => {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + Number(days || 30));
  return value.toISOString().slice(0, 10);
};
const cents = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const stamp = (s) => s ? String(s).slice(0, 16).replace("T", " ") : "—";

const STATUS = {
  pending: ["Waiting for review", "#8892A0"],
  awaiting_other: ["One review complete", "#C98A15"],
  changes_requested: ["Changes requested", "#B23A54"],
  approved: ["PM + Accounting approved", "#0E8577"],
};

export default function AccountingDocumentReview({ session, onData }) {
  const [data, setData] = useState({ invoices: [], reports: [], vendors: [], accounts: [] });
  const [kind, setKind] = useState("invoice");
  const [showNew, setShowNew] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [noteFor, setNoteFor] = useState(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const result = await api.accountingReviewCenter();
      setData(result);
      onData?.(result);
    } catch (e) {
      setError(e?.code === "INTERNAL_ERROR"
        ? "Run 016_accounting_document_review.sql in Supabase before using this page."
        : "The shared review queue could not be loaded.");
    }
  }, [onData]);

  useEffect(() => { load(); }, [load]);

  const replace = (type, document) => {
    const key = type === "invoice" ? "invoices" : "reports";
    const next = { ...data,
      [key]: data[key].map((item) => item.id === document.id ? document : item) };
    setData(next);
    onData?.(next);
  };

  const run = async (key, work) => {
    setBusy(key); setError("");
    try { await work(); }
    catch (e) {
      const messages = {
        CURRENT_FILE_REQUIRED: "Upload the vendor invoice or generate the system PDF before reviewing.",
        TWO_DIFFERENT_REVIEWERS_REQUIRED: "PM and Accounting must be two different users.",
        ACCOUNTING_PERIOD_CLOSED: "This invoice date is in a closed accounting period.",
        DUPLICATE_VENDOR_INVOICE: "That vendor invoice number already exists.",
        FILE_TYPE_NOT_ALLOWED: "Only PDF, JPG and PNG files are accepted.",
        FILE_SIZE_NOT_ALLOWED: "The file must be 10 MB or smaller.",
        FINAL_PM_DOWNLOAD_NOT_AVAILABLE: "Final download is available to PM only after both reviews.",
      };
      setError(messages[e?.code] ?? e?.code ?? "The action could not be completed.");
    }
    setBusy("");
  };

  const upload = (type, item, file) => run(`upload:${item.id}`, async () => {
    const result = await api.uploadAccountingDocument(type, item.id, file);
    replace(type === "invoice" ? "invoice" : "report", result.document);
  });

  const generate = (type, item) => run(`generate:${item.id}`, async () => {
    const result = await api.generateAccountingDocument(type, item.id);
    replace(type === "invoice" ? "invoice" : "report", result.document);
  });

  const review = (type, item, decision, lane = null, note = "") =>
    run(`review:${item.id}:${lane ?? session?.role}`, async () => {
      const result = await api.reviewAccountingDocument(type, item.id, decision, note, lane);
      replace(type === "invoice" ? "invoice" : "report", result.document);
      setNoteFor(null);
    });

  const waitingInvoices = data.invoices.filter((x) => x.review_state !== "approved").length;
  const waitingReports = data.reports.filter((x) => x.review_state !== "approved").length;

  return (
    <div className="adr">
      <style>{CSS}</style>
      <section className="adr-intro">
        <div>
          <h2>Invoice & report review</h2>
          <p>Accounting and PM each confirm the same file. Replacing a file resets both confirmations.</p>
        </div>
        <button className="adr-btn" onClick={load} disabled={busy}>Refresh</button>
      </section>

      <div className="adr-seg">
        <button className={kind === "invoice" ? "on" : ""} onClick={() => setKind("invoice")}>
          Vendor invoices {waitingInvoices > 0 && <i>{waitingInvoices}</i>}
        </button>
        <button className={kind === "report" ? "on" : ""} onClick={() => setKind("report")}>
          Reports {waitingReports > 0 && <i>{waitingReports}</i>}
        </button>
      </div>

      {error && <div className="adr-error">{error}</div>}

      {kind === "invoice" && (
        <>
          <div className="adr-bar">
            <span>{data.invoices.length} invoice{data.invoices.length === 1 ? "" : "s"}</span>
            {["accounting", "admin"].includes(session?.role) && (
              <button className="adr-btn" onClick={() => setShowNew((v) => !v)}>
                {showNew ? "Close" : "Enter invoice"}
              </button>
            )}
          </div>
          {showNew && <NewInvoice vendors={data.vendors} accounts={data.accounts}
            busy={busy === "new"} onCancel={() => setShowNew(false)}
            onCreate={(invoice, source) => run("new", async () => {
              const result = await api.createVendorInvoice(invoice);
              let created = result.invoice;
              if (source.mode === "upload") {
                created = (await api.uploadAccountingDocument("invoice", created.id, source.file)).document;
              } else {
                created = (await api.generateAccountingDocument("invoice", created.id)).document;
              }
              const next = { ...data, invoices: [created, ...data.invoices] };
              setData(next); onData?.(next); setShowNew(false);
            })} />}
          <DocumentList type="invoice" items={data.invoices} session={session} busy={busy}
            noteFor={noteFor} setNoteFor={setNoteFor} upload={upload}
            generate={generate} review={review} />
        </>
      )}

      {kind === "report" && (
        <DocumentList type="report" items={data.reports} session={session} busy={busy}
          noteFor={noteFor} setNoteFor={setNoteFor} upload={upload}
          generate={generate} review={review} />
      )}
    </div>
  );
}

function DocumentList({ type, items, session, busy, noteFor, setNoteFor, upload, generate, review }) {
  if (!items.length) return <div className="adr-empty">
    {type === "invoice" ? "No vendor invoices yet." : "Generate reports under Reports first."}
  </div>;
  return <div className="adr-list">{items.map((item) => (
    <DocumentCard key={item.id} {...{ type, item, session, busy, noteFor, setNoteFor,
      upload, generate, review }} />
  ))}</div>;
}

function DocumentCard({ type, item, session, busy, noteFor, setNoteFor, upload, generate, review }) {
  const status = STATUS[item.review_state] ?? STATUS.pending;
  const isPM = session?.role === "property_manager";
  const isAccounting = session?.role === "accounting";
  const isAdmin = session?.role === "admin";
  const canReview = isPM || isAccounting || isAdmin;
  const ownLane = isPM ? "property_manager" : isAccounting ? "accounting" : null;
  const canDownload = (isPM || isAdmin) && item.review_state === "approved" && item.file?.id;
  const typePath = type === "invoice" ? "invoice" : "report";
  const active = busy.includes(item.id);
  const changes = (item.reviews ?? []).find((x) => x.decision === "changes_requested"
    && Number(x.document_version) === Number(item.document_version));

  const lane = (code, name, at) => (
    <div className={`adr-check ${name ? "done" : ""}`}>
      <span>{code === "accounting" ? "Accounting" : "Property Manager"}</span>
      <strong>{name ? `✓ ${name}` : "Pending"}</strong>
      {at && <small>{stamp(at)}</small>}
    </div>
  );

  const heading = type === "invoice"
    ? <><strong>{item.vendor_name}</strong><span className="adr-mono">{item.invoice_no}</span></>
    : <><strong>Building {item.building_code}</strong><span className="adr-mono">{item.period}</span></>;

  return <article className={`adr-card ${item.review_state === "approved" ? "approved" : ""}`}>
    <header>
      <div className="adr-title">{heading}</div>
      <span className="adr-status" style={{ "--status": status[1] }}>{status[0]}</span>
    </header>

    <div className="adr-summary">
      {type === "invoice" ? <>
        <span>Total <b>{money(item.total)}</b></span>
        <span>Invoice date <b>{String(item.invoice_date).slice(0, 10)}</b></span>
        <span>Due <b>{String(item.due_date).slice(0, 10)}</b></span>
        <span>Location <b>{item.unit_number || item.building_code || "Shared"}</b></span>
      </> : <>
        <span>Revenue <b>{money(item.figures?.revenue_total)}</b></span>
        <span>Expenses <b>{money(item.figures?.expense_total)}</b></span>
        <span>NOI <b>{money(item.figures?.net_operating_income)}</b></span>
        <span>Arrears <b>{money(item.figures?.arrears_total)}</b></span>
      </>}
    </div>

    <div className="adr-file">
      {item.file ? <>
        <div>
          <strong>{item.file.filename}</strong>
          <span>v{item.file.document_version} · {item.file.source} · {stamp(item.file.uploaded_at)}</span>
        </div>
        <a className="adr-btn adr-btn--ghost" href={api.accountingFileUrl(item.file.id)}
           target="_blank" rel="noreferrer">Preview</a>
        {canDownload && <a className="adr-btn" href={api.accountingFileUrl(item.file.id, true)}>
          Download final
        </a>}
      </> : <div className="adr-no-file">No invoice/report file attached yet.</div>}
    </div>

    {changes && <div className="adr-change">
      <b>Changes requested by {changes.reviewed_name}:</b> {changes.note}
    </div>}

    <div className="adr-checks">
      {lane("accounting", item.accounting_reviewed_name, item.accounting_reviewed_at)}
      {lane("property_manager", item.pm_reviewed_name, item.pm_reviewed_at)}
    </div>

    {canReview && <div className="adr-actions">
      <label className="adr-btn adr-btn--ghost">
        Upload new version
        <input type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
          disabled={active} onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload(typePath, item, file);
            e.target.value = "";
          }} />
      </label>
      <button className="adr-btn adr-btn--ghost" disabled={active}
        onClick={() => generate(typePath, item)}>Generate PDF</button>

      {item.file && (isAdmin ? ["accounting", "property_manager"] : [ownLane]).filter(Boolean).map((laneCode) => {
        const already = laneCode === "accounting" ? item.accounting_reviewed_by : item.pm_reviewed_by;
        return <React.Fragment key={laneCode}>
          {!already && <button className="adr-btn" disabled={active}
            onClick={() => review(typePath, item, "approved", isAdmin ? laneCode : null)}>
            Confirm as {laneCode === "accounting" ? "Accounting" : "PM"}
          </button>}
          <button className="adr-btn adr-btn--danger" disabled={active}
            onClick={() => setNoteFor({ id: item.id, lane: isAdmin ? laneCode : null, text: "" })}>
            Return
          </button>
        </React.Fragment>;
      })}
    </div>}

    {noteFor?.id === item.id && <div className="adr-return">
      <textarea value={noteFor.text} placeholder="What needs to be corrected?"
        onChange={(e) => setNoteFor({ ...noteFor, text: e.target.value })} />
      <button className="adr-btn adr-btn--danger" disabled={!noteFor.text.trim() || active}
        onClick={() => review(typePath, item, "changes_requested", noteFor.lane, noteFor.text.trim())}>
        Send back
      </button>
      <button className="adr-btn adr-btn--ghost" onClick={() => setNoteFor(null)}>Cancel</button>
    </div>}

    {(item.reviews ?? []).length > 0 && <details className="adr-history">
      <summary>Review history ({item.reviews.length})</summary>
      {item.reviews.map((entry) => <div key={entry.id}>
        <span>{stamp(entry.reviewed_at)}</span>
        <b>{entry.reviewed_name}</b>
        <span>{entry.reviewer_lane === "accounting" ? "Accounting" : "PM"}</span>
        <strong>{entry.decision === "approved" ? "Approved" : "Returned"}</strong>
        {entry.note && <em>{entry.note}</em>}
      </div>)}
    </details>}
  </article>;
}

function NewInvoice({ vendors, accounts, busy, onCancel, onCreate }) {
  const [form, setForm] = useState({ vendor_id: vendors[0]?.id ?? "", invoice_no: "",
    invoice_date: today(), due_date: "", building_code: "", unit_number: "",
    gst: "", description: "" });
  const [lines, setLines] = useState([{ gl_code: "5010", description: "", amount: "" }]);
  const [mode, setMode] = useState("upload");
  const [file, setFile] = useState(null);
  const vendor = vendors.find((x) => x.id === form.vendor_id);
  const expense = accounts.filter((x) => x.type === "expense");
  const subtotal = cents(lines.reduce((sum, line) => sum + Number(line.amount || 0), 0));
  const total = cents(subtotal + Number(form.gst || 0));
  const due = form.due_date || addDays(form.invoice_date, vendor?.payment_terms ?? 30);
  const valid = form.vendor_id && form.invoice_no.trim() && subtotal > 0
    && (mode === "generate" || !!file);

  return <section className="adr-new">
    <h3>New vendor invoice</h3>
    <div className="adr-grid">
      <label><span>Vendor</span><select value={form.vendor_id} onChange={(e) => {
        const selected = vendors.find((x) => x.id === e.target.value);
        setForm({ ...form, vendor_id: e.target.value });
        if (selected?.default_gl) setLines(lines.map((line, index) => index === 0
          ? { ...line, gl_code: selected.default_gl } : line));
      }}>{vendors.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
      <label><span>Invoice number</span><input value={form.invoice_no}
        onChange={(e) => setForm({ ...form, invoice_no: e.target.value })} /></label>
      <label><span>Invoice date</span><input type="date" value={form.invoice_date}
        onChange={(e) => setForm({ ...form, invoice_date: e.target.value })} /></label>
      <label><span>Due date</span><input type="date" value={due}
        onChange={(e) => setForm({ ...form, due_date: e.target.value })} /></label>
      <label><span>Building</span><select value={form.building_code}
        onChange={(e) => setForm({ ...form, building_code: e.target.value })}>
        <option value="">Shared</option>{["370", "374", "378"].map((x) => <option key={x}>{x}</option>)}
      </select></label>
      <label><span>Unit (optional)</span><input value={form.unit_number}
        onChange={(e) => setForm({ ...form, unit_number: e.target.value })} /></label>
      <label><span>GST</span><input type="number" step="0.01" value={form.gst}
        onChange={(e) => setForm({ ...form, gst: e.target.value })} /></label>
      <label className="adr-wide"><span>Description</span><input value={form.description}
        onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
    </div>
    <div className="adr-lines">
      {lines.map((line, index) => <div key={index}>
        <select value={line.gl_code} onChange={(e) => setLines(lines.map((x, i) => i === index
          ? { ...x, gl_code: e.target.value } : x))}>
          {expense.map((x) => <option key={x.code} value={x.code}>{x.code} · {x.name}</option>)}
        </select>
        <input placeholder="Line description" value={line.description}
          onChange={(e) => setLines(lines.map((x, i) => i === index
            ? { ...x, description: e.target.value } : x))} />
        <input type="number" step="0.01" placeholder="0.00" value={line.amount}
          onChange={(e) => setLines(lines.map((x, i) => i === index
            ? { ...x, amount: e.target.value } : x))} />
        {lines.length > 1 && <button onClick={() => setLines(lines.filter((_, i) => i !== index))}>×</button>}
      </div>)}
      <button className="adr-link" onClick={() => setLines([...lines,
        { gl_code: vendor?.default_gl || "5010", description: "", amount: "" }])}>+ Another line</button>
    </div>
    <div className="adr-total"><span>Subtotal {money(subtotal)}</span><span>GST {money(form.gst)}</span>
      <strong>Total {money(total)}</strong></div>
    <div className="adr-source">
      <label><input type="radio" checked={mode === "upload"} onChange={() => setMode("upload")} />
        Upload the vendor's original invoice</label>
      <label><input type="radio" checked={mode === "generate"} onChange={() => setMode("generate")} />
        Generate a system PDF from these details</label>
      {mode === "upload" && <input type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}
    </div>
    <div className="adr-actions">
      <button className="adr-btn" disabled={!valid || busy} onClick={() => onCreate({
        ...form, due_date: due, gst: cents(form.gst || 0), subtotal, total,
        lines: lines.map((line) => ({ ...line, amount: cents(line.amount) })),
      }, { mode, file })}>{busy ? "Saving…" : "Save and send to review"}</button>
      <button className="adr-btn adr-btn--ghost" onClick={onCancel}>Cancel</button>
    </div>
  </section>;
}

const CSS = `
.adr{display:flex;flex-direction:column;gap:13px;color:#131C25;font-size:13px}.adr *{box-sizing:border-box}
.adr-intro,.adr-bar{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.adr-intro{background:#F4F8FB;border:1px solid #D3DBE1;padding:15px 17px;border-radius:5px}
.adr-intro h2,.adr-new h3{margin:0;font-family:Archivo,sans-serif}.adr-intro p{margin:5px 0 0;color:#647586}
.adr-seg{display:flex;align-self:flex-start;border:1px solid #D3DBE1;border-radius:4px;overflow:hidden}
.adr-seg button{border:0;border-right:1px solid #D3DBE1;background:white;padding:8px 14px;font:inherit;font-weight:700;cursor:pointer}
.adr-seg button:last-child{border-right:0}.adr-seg button.on{background:#18364A;color:white}.adr-seg i{font-style:normal;background:#B23A54;color:white;border-radius:9px;padding:1px 6px;margin-left:5px;font-size:10px}
.adr-btn{display:inline-flex;align-items:center;justify-content:center;border:1px solid #18364A;background:#18364A;color:white;border-radius:4px;padding:7px 10px;font:inherit;font-weight:700;text-decoration:none;cursor:pointer;white-space:nowrap}
.adr-btn:disabled{opacity:.5;cursor:not-allowed}.adr-btn--ghost{background:white;color:#18364A;border-color:#B9C6D0}.adr-btn--danger{background:white;color:#B23A54;border-color:#D8A3AF}
.adr-btn input[type=file]{display:none}.adr-error,.adr-change{border:1px solid #E0A8B4;background:#FFF3F5;color:#8D2940;padding:9px 12px;border-radius:4px}.adr-change{font-size:12px}
.adr-empty{padding:28px;border:1px dashed #C7D0D8;color:#78899A;text-align:center}.adr-list{display:flex;flex-direction:column;gap:11px}
.adr-card{background:white;border:1px solid #D3DBE1;border-left:4px solid #C98A15;border-radius:5px;padding:14px 16px;display:flex;flex-direction:column;gap:11px}.adr-card.approved{border-left-color:#0E8577}
.adr-card>header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.adr-title{display:flex;align-items:center;gap:10px;font-size:15px}.adr-mono{font-family:'IBM Plex Mono',monospace;color:#647586}
.adr-status{background:var(--status);color:white;border-radius:10px;padding:3px 9px;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.03em}
.adr-summary{display:grid;grid-template-columns:repeat(4,minmax(110px,1fr));gap:8px}.adr-summary span{display:flex;flex-direction:column;color:#78899A;font-size:10px;text-transform:uppercase;letter-spacing:.04em}.adr-summary b{color:#273644;font-size:12px;text-transform:none;margin-top:2px}
.adr-file{display:flex;align-items:center;gap:8px;background:#F7F9FA;border:1px solid #E0E5E9;border-radius:4px;padding:9px 10px;flex-wrap:wrap}.adr-file>div:first-child{display:flex;flex:1;min-width:180px;flex-direction:column}.adr-file span{font-size:10px;color:#78899A;margin-top:2px}.adr-no-file{color:#8B5C00}
.adr-checks{display:grid;grid-template-columns:1fr 1fr;gap:9px}.adr-check{border:1px solid #D3DBE1;border-radius:4px;padding:9px 11px;display:grid;grid-template-columns:1fr auto;gap:2px;color:#78899A}.adr-check.done{border-color:#83BFB7;background:#F3FBF9}.adr-check strong{color:#4E6070}.adr-check.done strong{color:#0E8577}.adr-check small{grid-column:1/-1}
.adr-actions{display:flex;gap:7px;align-items:center;flex-wrap:wrap}.adr-return{display:flex;gap:7px;align-items:flex-start}.adr-return textarea{flex:1;min-height:55px;border:1px solid #D3DBE1;border-radius:4px;padding:8px;font:inherit}
.adr-history summary{color:#617283;cursor:pointer;font-weight:700}.adr-history>div{display:grid;grid-template-columns:120px 1fr 90px 80px;gap:8px;padding:7px 0;border-bottom:1px solid #EDF0F2;font-size:11px}.adr-history em{grid-column:2/-1;color:#8D2940}
.adr-new{border:1px solid #9CB9CB;border-left:4px solid #2A6183;background:#FBFDFE;border-radius:5px;padding:16px;display:flex;flex-direction:column;gap:12px}.adr-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:9px}.adr-grid label{display:flex;flex-direction:column;gap:4px}.adr-grid label span{font-size:11px;font-weight:700;color:#4E6070}.adr-grid input,.adr-grid select,.adr-lines input,.adr-lines select,.adr-source input[type=file]{border:1px solid #C8D2D9;border-radius:4px;padding:7px 8px;background:white;font:inherit;width:100%}.adr-wide{grid-column:span 2}
.adr-lines{display:flex;flex-direction:column;gap:6px}.adr-lines>div{display:grid;grid-template-columns:210px 1fr 120px 28px;gap:7px}.adr-lines>div>button{border:0;background:transparent;color:#B23A54;font-size:18px;cursor:pointer}.adr-link{align-self:flex-start;border:0;background:transparent;color:#2A6183;font:inherit;font-weight:700;cursor:pointer}.adr-total{display:flex;gap:18px;justify-content:flex-end}.adr-source{display:flex;gap:16px;align-items:center;flex-wrap:wrap;border-top:1px solid #DDE4E8;padding-top:11px}.adr-source label{display:flex;align-items:center;gap:5px;font-weight:600}
@media(max-width:850px){.adr-summary,.adr-grid{grid-template-columns:repeat(2,1fr)}.adr-lines>div{grid-template-columns:1fr 1fr 100px 26px}}@media(max-width:560px){.adr-summary,.adr-grid,.adr-checks{grid-template-columns:1fr}.adr-wide{grid-column:auto}.adr-lines>div{grid-template-columns:1fr}.adr-history>div{grid-template-columns:1fr 1fr}}
`;
