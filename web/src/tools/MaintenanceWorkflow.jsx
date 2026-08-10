import React, { useEffect, useMemo, useState } from "react";
import api from "../lib/api.js";

const money = (n) => n == null ? "—" : new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(Number(n));
const badge = { pending: "#C98A15", approved: "#0E8577", rejected: "#B23A54" };

export default function MaintenanceWorkflow({ session }) {
  const [data, setData] = useState({ tickets: [], notes: [], quotes: [], orders: [], order_lines: [], vendors: [] });
  const [selectedId, setSelectedId] = useState(null); const [error, setError] = useState(""); const [busy, setBusy] = useState("");
  const [vendorId, setVendorId] = useState(""); const [quoteOpen, setQuoteOpen] = useState(false);
  const load = async () => { try { const d = await api.get("/maintenance"); setData(d); setError(""); setSelectedId((id) => id || d.tickets?.[0]?.id || null); }
    catch (e) { setError(e.code || "LOAD_FAILED"); } };
  useEffect(() => { load(); }, []);
  const ticket = data.tickets.find((x) => x.id === selectedId);
  const notes = useMemo(() => data.notes.filter((x) => x.ticket_id === selectedId), [data.notes, selectedId]);
  const quotes = useMemo(() => data.quotes.filter((x) => x.ticket_id === selectedId), [data.quotes, selectedId]);
  const orders = useMemo(() => data.orders.filter((x) => x.ticket_id === selectedId), [data.orders, selectedId]);
  useEffect(() => { setVendorId(ticket?.recommended_vendor_id || ticket?.assigned_vendor_id || ""); }, [ticket?.id, ticket?.recommended_vendor_id, ticket?.assigned_vendor_id]);

  const act = async (key, fn) => { setBusy(key); setError(""); try { await fn(); await load(); } catch (e) { setError(e.code || "ACTION_FAILED"); } setBusy(""); };
  return <section className="mw"><style>{CSS}</style>
    <header><div><span>Maintenance control</span><h1>Repairs → Vendor → Quote → PO → Bill</h1></div><button onClick={load}>Refresh</button></header>
    <p className="mw-rule">The system may recommend a vendor and draft the paperwork. A Building Manager or Admin confirms the assignment before anything is issued.</p>
    {error && <div className="mw-error">{error}</div>}
    <div className="mw-layout"><aside className="mw-list">
      {data.tickets.map((t) => <button key={t.id} className={selectedId === t.id ? "on" : ""} onClick={() => setSelectedId(t.id)}>
        <span><strong>{t.unit_number}</strong><i style={{ background: badge[t.approval_state] }}>{t.approval_state}</i></span>
        <b>{t.category || "other"} · {t.priority || "normal"}</b><small>{t.description}</small>
      </button>)}{!data.tickets.length && <div className="mw-empty">No repair tickets.</div>}
    </aside>
    <main>{ticket && <>
      <section className="mw-card"><div className="mw-cardh"><div><span>{ticket.id}</span><h2>{ticket.unit_number} · {ticket.category}</h2></div><i style={{ "--c": badge[ticket.approval_state] }}>{ticket.approval_state}</i></div>
        <p>{ticket.description}</p><div className="mw-meta"><span>Priority <b>{ticket.priority}</b></span><span>Ticket <b>{ticket.state}</b></span><span>Tenant <b>{ticket.tenant_name || "—"}</b></span></div>
      </section>

      <section className="mw-card"><h3>1 · Recommend and confirm vendor</h3>
        {ticket.recommended_vendor_id ? <div className="mw-reco"><strong>{ticket.recommended_vendor_name}</strong><span>{ticket.recommendation_reason}</span></div> : <p className="mw-dim">No recommendation yet. Vendor service coverage and current workload are used for ranking.</p>}
        <div className="mw-actions"><button disabled={!!busy || ticket.approval_state === "rejected"} onClick={() => act("recommend", () => api.post(`/maintenance/${ticket.id}/recommend-vendor`, {}))}>{busy === "recommend" ? "Ranking…" : "Recommend vendor"}</button>
          <select value={vendorId} onChange={(e) => setVendorId(e.target.value)}><option value="">Choose vendor</option>{data.vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
          <button className="primary" disabled={!vendorId || !!busy || ticket.approval_state === "approved"} onClick={() => act("assign", () => api.post(`/maintenance/${ticket.id}/confirm-assignment`, { vendor_id: vendorId }))}>Confirm & assign</button></div>
        {ticket.approval_state === "approved" && <div className="mw-ok">Confirmed by {ticket.approved_name} · Assigned to {ticket.assigned_vendor_name}</div>}
      </section>

      <section className="mw-card"><div className="mw-row"><h3>2 · Vendor quote</h3><button disabled={ticket.approval_state !== "approved"} onClick={() => setQuoteOpen(!quoteOpen)}>Add quote</button></div>
        {quoteOpen && <QuoteForm ticket={ticket} vendors={data.vendors} defaultVendor={ticket.assigned_vendor_id}
          onCancel={() => setQuoteOpen(false)} onSave={(payload) => act("quote", async () => { await api.post(`/maintenance/${ticket.id}/quotes`, payload); setQuoteOpen(false); })} />}
        {!quotes.length ? <p className="mw-dim">No quote received.</p> : quotes.map((q) => <div className="mw-quote" key={q.id}><div><strong>{q.vendor_name}</strong><span>{q.scope || "No scope entered"}</span></div><b>{money(q.amount)}</b><i>{q.state}</i>{q.state === "received" && <button onClick={() => act("select", () => api.post(`/vendor-quotes/${q.id}/select`, {}))}>Select → create PO</button>}</div>)}
      </section>

      <section className="mw-card"><h3>3 · Purchase order and bill</h3>
        {!orders.length ? <p className="mw-dim">Selecting a quote creates the PO draft automatically.</p> : orders.map((o) => <Order key={o.id} order={o} session={session} busy={busy} act={act} />)}
      </section>

      {!!notes.length && <section className="mw-card"><h3>Ticket notes</h3>{notes.map((n) => <div className="mw-note" key={n.id}><span>{n.by_name}</span><p>{n.body}</p></div>)}</section>}
    </>}</main></div>
  </section>;
}

function QuoteForm({ vendors, defaultVendor, onSave, onCancel }) {
  const [f, setF] = useState({ vendor_id: defaultVendor || "", amount: "", scope: "", lead_time_days: "", notes: "" });
  return <div className="mw-form"><select value={f.vendor_id} onChange={(e) => setF({ ...f, vendor_id: e.target.value })}><option value="">Vendor</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select><input type="number" placeholder="Quoted amount" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /><input type="number" placeholder="Lead time (days)" value={f.lead_time_days} onChange={(e) => setF({ ...f, lead_time_days: e.target.value })} /><textarea placeholder="Scope included in quote" value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })} /><input placeholder="Notes / quote file reference" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /><div><button className="primary" disabled={!f.vendor_id || Number(f.amount) <= 0} onClick={() => onSave(f)}>Save quote</button><button onClick={onCancel}>Cancel</button></div></div>;
}

function Order({ order, session, busy, act }) {
  const complete = () => { const actual = window.prompt("Actual amount charged", String(order.estimated)); if (!actual) return; let note = ""; if (Number(actual) !== Number(order.estimated)) note = window.prompt("Why is the amount different?") || ""; act("done:" + order.id, () => api.post(`/purchase-orders/${order.id}/work-done`, { actual_amount: actual, variance_note: note })); };
  return <div className="mw-order"><div><strong>{order.po_number}</strong><span>{order.vendor_name} · {order.description}</span></div><div className="mw-orderamt"><span>Estimate {money(order.estimated)}</span>{order.actual_amount != null && <span>Actual {money(order.actual_amount)}</span>}</div><i>{order.state}</i><div className="mw-actions">{order.state === "draft" && <button className="primary" onClick={() => act("issue:" + order.id, () => api.post(`/purchase-orders/${order.id}/issue`, {}))}>Issue PO</button>}{order.state === "issued" && <button onClick={complete}>Work done · confirm amount</button>}{order.state === "work_done" && ["admin", "property_manager", "accounting"].includes(session?.role) && <button className="primary" onClick={() => act("bill:" + order.id, () => api.post(`/purchase-orders/${order.id}/bill`, {}))}>Convert to Bill draft</button>}{order.state === "billed" && <span className="mw-ok">Bill draft created for Accounting approval</span>}</div></div>;
}

const CSS = `.mw{padding:26px;max-width:1500px;margin:auto;color:#17212b}.mw *{box-sizing:border-box}.mw button,.mw input,.mw select,.mw textarea{font:inherit}.mw>header{display:flex;justify-content:space-between}.mw>header span{font-size:11px;text-transform:uppercase;color:#718096;letter-spacing:.08em}.mw h1{margin:4px 0}.mw button{border:1px solid #bcc7d0;background:#fff;padding:8px 12px;border-radius:4px;cursor:pointer}.mw button.primary{background:#173b5f;color:#fff;border-color:#173b5f}.mw button:disabled{opacity:.45;cursor:not-allowed}.mw-rule{color:#5d6c78;max-width:85ch}.mw-error{background:#fff0f2;color:#9f2741;padding:10px;margin:12px 0}.mw-layout{display:grid;grid-template-columns:300px 1fr;gap:14px;margin-top:20px}.mw-list{background:#fff;border:1px solid #d5dde3;align-self:start;max-height:75vh;overflow:auto}.mw-list>button{display:block;width:100%;border:0;border-bottom:1px solid #e2e7eb;border-radius:0;text-align:left;padding:13px}.mw-list>button.on{background:#eef5fa;border-left:4px solid #173b5f}.mw-list>button>span{display:flex;justify-content:space-between}.mw-list i,.mw-cardh>i,.mw-quote>i,.mw-order>i{font-style:normal;font-size:10px;text-transform:uppercase}.mw-list i{color:#fff;padding:2px 6px;border-radius:8px}.mw-list b,.mw-list small{display:block}.mw-list b{font-size:12px;margin-top:7px}.mw-list small{color:#718096;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mw main{display:flex;flex-direction:column;gap:12px}.mw-card{background:#fff;border:1px solid #d5dde3;padding:17px}.mw-card h2,.mw-card h3{margin:0}.mw-cardh,.mw-row{display:flex;justify-content:space-between;align-items:center}.mw-cardh span{color:#718096;font-size:11px}.mw-cardh>i{color:var(--c);border:1px solid var(--c);padding:3px 8px}.mw-meta,.mw-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.mw-meta span{background:#f3f5f7;padding:7px 9px;color:#718096}.mw-meta b{color:#17212b}.mw-dim{color:#718096}.mw-reco{background:#edf8f5;padding:10px 12px;margin:12px 0}.mw-reco strong,.mw-reco span{display:block}.mw-reco span{font-size:12px;color:#557067}.mw-actions select{padding:8px;border:1px solid #bcc7d0;min-width:190px}.mw-ok{color:#087365;background:#edf8f5;padding:7px 9px;margin-top:10px}.mw-form{display:grid;grid-template-columns:2fr 1fr 1fr;gap:8px;background:#f5f7f8;padding:12px;margin-top:12px}.mw-form input,.mw-form select,.mw-form textarea{border:1px solid #c5cfd7;padding:9px;background:#fff}.mw-form textarea{grid-column:1/-1}.mw-form>div{display:flex;gap:8px;grid-column:1/-1}.mw-quote,.mw-order{display:grid;grid-template-columns:1fr auto auto auto;gap:12px;align-items:center;border-top:1px solid #e1e6ea;padding:12px 0}.mw-quote>div strong,.mw-quote>div span,.mw-order>div strong,.mw-order>div span{display:block}.mw-quote span,.mw-order span{color:#718096;font-size:12px}.mw-order{grid-template-columns:1fr auto auto}.mw-order .mw-actions{grid-column:1/-1}.mw-orderamt{text-align:right}.mw-note{border-top:1px solid #e1e6ea;padding-top:8px}.mw-note span{font-size:11px;color:#718096}.mw-empty{padding:20px;color:#718096}@media(max-width:800px){.mw{padding:14px}.mw-layout{grid-template-columns:1fr}.mw-list{max-height:250px}.mw-form{grid-template-columns:1fr}.mw-quote,.mw-order{grid-template-columns:1fr}.mw-orderamt{text-align:left}}`;
