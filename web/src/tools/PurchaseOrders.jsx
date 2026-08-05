import React, { useState, useEffect, useMemo, useCallback } from "react";

/* ============================================================
   BAYDO POINTE — purchase orders

   A purchase order is a commitment, not a liability, so it never
   touches the ledger. It becomes a bill when the work is done and
   the amount is confirmed.

   The two steps exist because the amount changes. A vendor quotes
   $680, opens the wall and finds something else, and invoices $745.
   One step would mean either booking a number nobody has agreed to
   or re-entering the whole thing.

       BM raises          →  estimate, AI can draft it
       BM confirms actual →  variance needs a reason
       → copied to a bill →  Accounting approves, and that posts
   ============================================================ */

const STATE = {
  draft:     { label: "Draft",          color: "#8892A0" },
  issued:    { label: "Issued",         color: "#1C6FA6" },
  work_done: { label: "Ready to bill",  color: "#C98A15" },
  billed:    { label: "Billed",         color: "#0E8577" },
  cancelled: { label: "Cancelled",      color: "#8892A0" },
};

const EXPENSE_ACCOUNTS = [
  ["5010", "Repairs and maintenance"],
  ["5020", "Utilities — electricity"],
  ["5021", "Utilities — gas and heat"],
  ["5022", "Utilities — water and sewer"],
  ["5060", "Cleaning and turnover"],
  ["5070", "Landscaping and snow removal"],
  ["5130", "Security and access"],
  ["5140", "Elevator maintenance"],
  ["5150", "Waste removal"],
  ["5160", "Pest control"],
  ["5900", "Other operating expenses"],
];

const money = (n) => (n == null || isNaN(n) ? "—"
  : new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(n));
const cents = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const nowISO = () => new Date().toISOString();
const stamp = (s) => (s ? String(s).slice(0, 16).replace("T", " ") : "—");

export default function PurchaseOrders({ session, tickets = [], vendors = [], orders = [],
                                         onSave, onBill }) {
  const [view, setView] = useState("open");
  const [drafting, setDrafting] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState("");

  const role = session?.role;
  const canCreate = ["admin", "building_manager"].includes(role);
  const canBill = ["admin", "accounting", "property_manager"].includes(role);

  const shown = useMemo(() => {
    if (view === "open") return orders.filter((o) => ["draft", "issued"].includes(o.state));
    if (view === "tobill") return orders.filter((o) => o.state === "work_done");
    if (view === "billed") return orders.filter((o) => o.state === "billed");
    return orders;
  }, [orders, view]);

  const counts = useMemo(() => ({
    open: orders.filter((o) => ["draft", "issued"].includes(o.state)).length,
    tobill: orders.filter((o) => o.state === "work_done").length,
  }), [orders]);

  /* AI drafts the order from the ticket. Estimates only — the scope says so,
     and the actual is entered by whoever attends. */
  const draftWithAi = async (ticket) => {
    setBusy("draft:" + ticket.id); setErr("");
    try {
      const res = await fetch("/api/ai/purchase_order", {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ input: {
          ticket: ticket.description, unit: ticket.unitId, category: ticket.category,
          priority: ticket.priority, vendor: ticket.vendor,
          history: (ticket.notes ?? []).map((n) => n.text).join("\n"),
          accounts: EXPENSE_ACCOUNTS.map(([c, n]) => `${c} ${n}`).join("\n"),
        }, ref_type: "maintenance", ref_id: ticket.id }),
      });
      if (!res.ok) throw new Error("AI_UNAVAILABLE");
      const { text } = await res.json();
      const out = JSON.parse(String(text).replace(/```json|```/g, "").trim());
      setDrafting({ ticket, ...out, drafted_by_ai: true });
    } catch {
      // The AI being down should not stop the work. An empty order is still
      // an order somebody can fill in.
      setDrafting({ ticket, description: ticket.description, scope: "", gl_code: "5010",
        lines: [{ description: "", gl_code: "5010", quantity: 1, estimated: "" }],
        drafted_by_ai: false });
      setErr("The AI service did not respond. Fill it in by hand.");
    }
    setBusy(null);
  };

  return (
    <div className="po">
      <style>{CSS}</style>

      <div className="po-seg">
        {[["open", "Open", counts.open], ["tobill", "Ready to bill", counts.tobill],
          ["billed", "Billed", null], ["all", "All", null]].map(([k, l, n]) => (
          <button key={k} className={view === k ? "on" : ""} onClick={() => setView(k)}>
            {l}{n > 0 && <i>{n}</i>}
          </button>
        ))}
      </div>

      <p className="po-note">
        An order is a commitment, not a liability — it does not touch the ledger.
        It becomes a bill once the work is done and the amount is confirmed, and
        that bill still goes through the usual approval before it posts.
      </p>

      {err && <div className="po-err">{err}</div>}

      {canCreate && view === "open" && (
        <section className="po-card">
          <div className="po-cardh">
            <h3>Tickets without an order</h3>
            <span className="po-dim">Scheduled work that nobody has costed yet</span>
          </div>
          {(() => {
            const covered = new Set(orders.map((o) => o.ticket_id));
            const pending = tickets.filter((t) => t.scheduledAt && !covered.has(t.id)
              && !["done", "cancelled"].includes(t.state));
            if (!pending.length)
              return <div className="po-empty">Every scheduled ticket has an order.</div>;
            return (
              <div className="po-tickets">
                {pending.map((t) => (
                  <div className="po-ticket" key={t.id}>
                    <div>
                      <strong className="po-mono">{t.unitId}</strong>
                      <span className="po-dim"> {t.category} · {stamp(t.scheduledAt)}</span>
                      <div className="po-cut">{t.description}</div>
                    </div>
                    <button className="po-btn po-btn--sm" disabled={busy === "draft:" + t.id}
                            onClick={() => draftWithAi(t)}>
                      {busy === "draft:" + t.id ? "Drafting…" : "Raise an order"}
                    </button>
                  </div>
                ))}
              </div>
            );
          })()}
        </section>
      )}

      {drafting && (
        <DraftOrder draft={drafting} vendors={vendors} session={session}
          onCancel={() => setDrafting(null)}
          onSave={(po) => { onSave([po, ...orders]); setDrafting(null); }} />
      )}

      {shown.length === 0 ? (
        <div className="po-empty">Nothing here.</div>
      ) : (
        <div className="po-list">
          {shown.map((o) => (
            <OrderRow key={o.id} o={o} canCreate={canCreate} canBill={canBill}
              session={session}
              onConfirm={() => setConfirming(o)}
              onIssue={() => onSave(orders.map((x) => x.id === o.id
                ? { ...x, state: "issued" } : x))}
              onBill={() => onBill?.(o)} />
          ))}
        </div>
      )}

      {confirming && (
        <ConfirmActual po={confirming} session={session}
          onCancel={() => setConfirming(null)}
          onSave={(patch) => { onSave(orders.map((x) => x.id === confirming.id
            ? { ...x, ...patch } : x)); setConfirming(null); }} />
      )}
    </div>
  );
}

/* ---------- Draft ---------- */

function DraftOrder({ draft, vendors, session, onCancel, onSave }) {
  const [f, setF] = useState({
    vendor_id: "", vendor_name: draft.ticket?.vendor ?? "",
    description: draft.description ?? "", scope: draft.scope ?? "",
    gl_code: draft.gl_code ?? "5010",
    scheduled_at: draft.ticket?.scheduledAt?.slice(0, 16) ?? "",
    lines: (draft.lines ?? []).map((l) => ({ ...l, estimated: String(l.estimated ?? "") })),
  });
  const set = (p) => setF({ ...f, ...p });
  const total = cents(f.lines.reduce((t, l) => t + Number(l.estimated || 0), 0));
  const ok = f.description.trim() && f.lines.some((l) => l.description.trim());

  return (
    <section className="po-card po-card--draft">
      <div className="po-cardh">
        <h3>New order · {draft.ticket?.unitId}</h3>
        {draft.drafted_by_ai && <span className="po-aitag">drafted by AI</span>}
      </div>

      {draft.drafted_by_ai && (
        <p className="po-note">
          Figures are an estimate from the ticket description, not a quote. Whoever
          attends enters the actual before this becomes a bill.
        </p>
      )}
      {draft.needs_quote && (
        <div className="po-warn">A line here needs a quote before it means anything.</div>
      )}
      {draft.note && <div className="po-ainote">{draft.note}</div>}

      <div className="po-row">
        <label className="po-f"><span>Vendor</span>
          <select className="po-sel" value={f.vendor_id}
                  onChange={(e) => {
                    const v = vendors.find((x) => x.id === e.target.value);
                    set({ vendor_id: e.target.value, vendor_name: v?.name ?? "" });
                  }}>
            <option value="">Not chosen yet</option>
            {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select></label>
        <label className="po-f"><span>Scheduled</span>
          <input className="po-in" type="datetime-local" value={f.scheduled_at}
                 onChange={(e) => set({ scheduled_at: e.target.value })} /></label>
      </div>

      <label className="po-f"><span>Description</span>
        <input className="po-in" value={f.description}
               onChange={(e) => set({ description: e.target.value })} /></label>

      <label className="po-f">
        <span>Scope <em>what done looks like, so there is something to check the invoice against</em></span>
        <textarea className="po-in po-ta" rows={3} value={f.scope}
                  onChange={(e) => set({ scope: e.target.value })} />
      </label>

      <div className="po-lines">
        <div className="po-lines-h">Lines</div>
        {f.lines.map((l, i) => (
          <div className="po-lineRow" key={i}>
            <input className="po-in" placeholder="What" value={l.description}
                   onChange={(e) => set({ lines: f.lines.map((x, j) =>
                     j === i ? { ...x, description: e.target.value } : x) })} />
            <select className="po-sel" value={l.gl_code ?? "5010"}
                    onChange={(e) => set({ lines: f.lines.map((x, j) =>
                      j === i ? { ...x, gl_code: e.target.value } : x) })}>
              {EXPENSE_ACCOUNTS.map(([c, n]) => <option key={c} value={c}>{c} · {n}</option>)}
            </select>
            <input className="po-in po-in--sm" type="number" step="0.01" placeholder="0.00"
                   value={l.estimated}
                   onChange={(e) => set({ lines: f.lines.map((x, j) =>
                     j === i ? { ...x, estimated: e.target.value } : x) })} />
            {f.lines.length > 1 && (
              <button className="po-x" onClick={() =>
                set({ lines: f.lines.filter((_, j) => j !== i) })}>×</button>
            )}
          </div>
        ))}
        <button className="po-btn po-btn--xs po-btn--ghost"
                onClick={() => set({ lines: [...f.lines,
                  { description: "", gl_code: f.gl_code, quantity: 1, estimated: "" }] })}>
          + Another line
        </button>
      </div>

      <div className="po-total">
        <span>Estimated</span><strong className="po-mono">{money(total)}</strong>
      </div>

      <div className="po-actions">
        <button className="po-btn" disabled={!ok}
                onClick={() => onSave({ id: uid("po_"),
                  po_number: `PO-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`,
                  ticket_id: draft.ticket?.id, unit_number: draft.ticket?.unitId,
                  ...f, estimated: total,
                  lines: f.lines.map((l) => ({ ...l, estimated: cents(l.estimated) })),
                  drafted_by_ai: draft.drafted_by_ai ? 1 : 0,
                  state: "draft", created_name: session?.name, created_at: nowISO() })}>
          Save as draft
        </button>
        <button className="po-btn po-btn--ghost" onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
}

/* ---------- Row ---------- */

function OrderRow({ o, canCreate, canBill, onConfirm, onIssue, onBill }) {
  const st = STATE[o.state] ?? STATE.draft;
  const variance = o.actual_amount != null ? cents(o.actual_amount - o.estimated) : null;

  return (
    <div className={`po-item ${o.state === "work_done" ? "ready" : ""}`}>
      <div className="po-item-h">
        <span className="po-tag" style={{ "--c": st.color }}>{st.label}</span>
        <strong className="po-mono">{o.po_number}</strong>
        <span className="po-mono">{o.unit_number}</span>
        <span className="po-dim po-cut">{o.description}</span>
        {o.drafted_by_ai === 1 && <span className="po-aitag">AI</span>}
      </div>

      <div className="po-amounts">
        <div><em>Estimated</em><span className="po-mono">{money(o.estimated)}</span></div>
        {o.actual_amount != null && (
          <>
            <div><em>Actual</em><span className="po-mono">{money(o.actual_amount)}</span></div>
            <div>
              <em>Variance</em>
              <span className={`po-mono ${Math.abs(variance) >= 0.01
                ? (variance > 0 ? "po-over" : "po-under") : ""}`}>
                {variance > 0 ? "+" : ""}{money(variance)}
              </span>
            </div>
          </>
        )}
        <div><em>Vendor</em><span>{o.vendor_name || "not chosen"}</span></div>
      </div>

      {o.scope && <div className="po-scope">{o.scope}</div>}
      {o.variance_note && (
        <div className="po-vnote">
          <strong>Why it changed:</strong> {o.variance_note}
          <span className="po-dim"> — {o.confirmed_name}, {stamp(o.confirmed_at)}</span>
        </div>
      )}

      <div className="po-actions">
        {canCreate && o.state === "draft" && (
          <button className="po-btn po-btn--xs" onClick={onIssue}>Issue to vendor</button>
        )}
        {canCreate && ["draft", "issued"].includes(o.state) && (
          <button className="po-btn po-btn--xs" onClick={onConfirm}>
            Work done — confirm the amount
          </button>
        )}
        {canBill && o.state === "work_done" && (
          <button className="po-btn po-btn--xs" onClick={onBill}>Copy to a bill</button>
        )}
        {o.state === "work_done" && !canBill && (
          <span className="po-dim">Waiting for Accounting to bill it</span>
        )}
        {o.state === "billed" && (
          <span className="po-dim">
            Billed as {o.bill_invoice_no ?? o.po_number} · posts when Accounting approves it
          </span>
        )}
      </div>
    </div>
  );
}

/* ---------- Confirm ---------- */

/** Whoever attended enters what it actually cost. A difference from the
 *  estimate needs a reason: an unexplained variance is the one thing an owner
 *  will ask about, and "I do not remember" is not an answer six months on. */
function ConfirmActual({ po, session, onCancel, onSave }) {
  const [lines, setLines] = useState((po.lines ?? []).map((l) =>
    ({ ...l, actual: String(l.actual ?? l.estimated ?? "") })));
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");

  const actual = cents(lines.reduce((t, l) => t + Number(l.actual || 0), 0));
  const variance = cents(actual - po.estimated);
  const needsNote = Math.abs(variance) >= 0.01;
  const pct = po.estimated ? Math.abs(variance / po.estimated * 100) : 0;

  const submit = () => {
    setErr("");
    if (actual <= 0) return setErr("Enter what it cost.");
    if (needsNote && !note.trim())
      return setErr(`This is ${variance > 0 ? "over" : "under"} the estimate by ${money(Math.abs(variance))}. Say why — six months from now nobody will remember.`);
    onSave({ state: "work_done", actual_amount: actual, variance_note: note.trim() || null,
             confirmed_name: session?.name, confirmed_at: nowISO(),
             lines: lines.map((l) => ({ ...l, actual: cents(l.actual) })) });
  };

  return (
    <section className="po-card po-card--confirm">
      <div className="po-cardh">
        <h3>What did {po.po_number} actually cost?</h3>
        <span className="po-dim">{po.unit_number} · {po.vendor_name || "no vendor"}</span>
      </div>

      <div className="po-lines">
        <div className="po-lineRow po-lineRow--h">
          <span>Line</span><span>Estimated</span><span>Actual</span>
        </div>
        {lines.map((l, i) => (
          <div className="po-lineRow po-lineRow--c" key={i}>
            <span className="po-cut">{l.description}</span>
            <span className="po-mono po-dim">{money(l.estimated)}</span>
            <input className="po-in po-in--sm" type="number" step="0.01" value={l.actual}
                   onChange={(e) => setLines(lines.map((x, j) =>
                     j === i ? { ...x, actual: e.target.value } : x))} />
          </div>
        ))}
      </div>

      <div className="po-tally">
        <div><span>Estimated</span><span className="po-mono">{money(po.estimated)}</span></div>
        <div><span>Actual</span><span className="po-mono">{money(actual)}</span></div>
        <div className={needsNote ? "po-tally-v" : ""}>
          <span>Variance</span>
          <span className={`po-mono ${variance > 0 ? "po-over" : variance < 0 ? "po-under" : ""}`}>
            {variance > 0 ? "+" : ""}{money(variance)}
            {pct >= 1 && <em> ({pct.toFixed(0)}%)</em>}
          </span>
        </div>
      </div>

      {needsNote && (
        <label className="po-f">
          <span>Why it changed <em>required</em></span>
          <textarea className="po-in po-ta" rows={2} value={note}
                    placeholder="Opened the wall and found the shut-off valve had gone as well"
                    onChange={(e) => setNote(e.target.value)} />
        </label>
      )}

      {err && <div className="po-err">{err}</div>}

      <div className="po-actions">
        <button className="po-btn" onClick={submit}>Confirm</button>
        <button className="po-btn po-btn--ghost" onClick={onCancel}>Cancel</button>
        <span className="po-dim">
          Accounting copies this into a bill. It posts when they approve it.
        </span>
      </div>
    </section>
  );
}

const CSS = `
.po{--ink:#131C25;--ink2:#3E4C5A;--dim:#78899A;--paper:#fff;--rule:#D3DBE1;
  --amber:#FFF6E0;--amberline:#E8C877;--red:#B23A54;--green:#0E8577;--accent:#1C6FA6;
  display:flex;flex-direction:column;gap:12px;font-size:14px}
.po *{box-sizing:border-box}
.po-mono{font-family:'IBM Plex Mono',monospace;font-variant-numeric:tabular-nums}
.po-dim{color:var(--dim);font-size:12.5px}
.po-cut{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.po-over{color:var(--red)}
.po-under{color:var(--green)}

.po-seg{display:inline-flex;border:1px solid var(--rule);border-radius:3px;overflow:hidden;
  align-self:flex-start;background:var(--paper)}
.po-seg button{font:inherit;font-size:13px;font-weight:600;cursor:pointer;background:var(--paper);
  border:0;border-right:1px solid var(--rule);padding:8px 15px;color:var(--dim);
  display:flex;align-items:center;gap:6px}
.po-seg button:last-child{border-right:0}
.po-seg button.on{background:var(--ink);color:#fff}
.po-seg i{font-style:normal;font-family:'IBM Plex Mono',monospace;font-size:10px;
  background:var(--red);color:#fff;border-radius:8px;padding:1px 6px}

.po-note{color:var(--dim);font-size:12.5px;margin:0;line-height:1.7;max-width:74ch}
.po-card{background:var(--paper);border:1px solid var(--rule);border-radius:4px;
  padding:16px 18px;display:flex;flex-direction:column;gap:11px}
.po-card--draft{border-color:var(--accent);border-left:3px solid var(--accent)}
.po-card--confirm{border-color:var(--amberline);border-left:3px solid var(--amberline);
  background:#FFFDF8}
.po-cardh{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
.po-cardh h3{font-family:'Archivo',sans-serif;font-size:15px;margin:0}
.po-aitag{font-size:10px;font-weight:700;color:var(--accent);border:1px solid var(--accent);
  border-radius:8px;padding:1px 7px}
.po-empty{color:var(--dim);font-size:12.5px;padding:22px 0;text-align:center;
  border:1px dashed var(--rule);border-radius:3px}

.po-tickets{display:flex;flex-direction:column;gap:1px;background:var(--rule);
  border:1px solid var(--rule);border-radius:3px;overflow:hidden}
.po-ticket{display:flex;justify-content:space-between;align-items:center;gap:12px;
  background:var(--paper);padding:10px 13px}
.po-ticket>div{min-width:0}

.po-list{display:flex;flex-direction:column;gap:10px}
.po-item{background:var(--paper);border:1px solid var(--rule);border-radius:4px;
  padding:13px 15px;display:flex;flex-direction:column;gap:7px}
.po-item.ready{border-color:var(--amberline);border-left:3px solid var(--amberline)}
.po-item-h{display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:13.5px}
.po-tag{font-size:10.5px;font-weight:700;color:#fff;background:var(--c);border-radius:9px;
  padding:1px 8px;white-space:nowrap}
.po-amounts{display:flex;gap:22px;flex-wrap:wrap}
.po-amounts>div{display:flex;flex-direction:column;gap:1px}
.po-amounts em{font-style:normal;font-size:10px;color:var(--dim);text-transform:uppercase;
  letter-spacing:.05em;font-family:'IBM Plex Mono',monospace}
.po-amounts span{font-size:14px;font-weight:600}
.po-scope{font-size:12.5px;color:var(--ink2);border-left:2px solid var(--rule);
  padding-left:10px;line-height:1.65}
.po-vnote{font-size:12.5px;color:#6B5410;background:var(--amber);border-radius:3px;
  padding:7px 10px;line-height:1.65}
.po-ainote{font-size:12.5px;color:var(--accent);background:#F4F9FD;border-radius:3px;
  padding:7px 10px;line-height:1.65}
.po-warn{font-size:12.5px;color:#6B5410;background:var(--amber);border:1px solid var(--amberline);
  border-radius:3px;padding:8px 11px}

.po-row{display:flex;gap:10px;flex-wrap:wrap}
.po-row>*{flex:1 1 150px}
.po-f{display:flex;flex-direction:column;gap:4px}
.po-f>span{font-size:12px;font-weight:600;color:var(--ink2)}
.po-f>span em{font-style:normal;font-weight:400;color:var(--dim)}
.po-in,.po-sel{font:inherit;font-size:13px;padding:7px 10px;border:1px solid var(--rule);
  border-radius:3px;background:var(--paper);color:var(--ink);width:100%;min-width:0}
.po-in--sm{padding:5px 8px;font-size:12.5px;text-align:right}
.po-ta{resize:vertical;line-height:1.6;text-align:left}
.po-in:focus,.po-sel:focus{outline:2px solid var(--accent);outline-offset:1px}

.po-lines{display:flex;flex-direction:column;gap:6px}
.po-lines-h{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.06em;
  text-transform:uppercase;color:var(--dim)}
.po-lineRow{display:grid;grid-template-columns:minmax(140px,2fr) minmax(150px,1fr) 110px 26px;
  gap:7px;align-items:center}
.po-lineRow--h{grid-template-columns:minmax(140px,2fr) 110px 110px;
  font-family:'IBM Plex Mono',monospace;font-size:10.5px;text-transform:uppercase;
  color:var(--dim);letter-spacing:.05em}
.po-lineRow--c{grid-template-columns:minmax(140px,2fr) 110px 110px;font-size:12.5px}
.po-lineRow--h>span:not(:first-child),.po-lineRow--c>span:not(:first-child){text-align:right}

.po-total{display:flex;justify-content:space-between;align-items:baseline;
  border-top:1px solid var(--rule);padding-top:9px;font-size:14px}
.po-total strong{font-size:18px}
.po-tally{display:flex;flex-direction:column;gap:4px;border-top:1px solid var(--rule);
  padding-top:9px;max-width:290px;margin-left:auto;width:100%}
.po-tally>div{display:flex;justify-content:space-between;font-size:13px}
.po-tally-v{font-weight:700;border-top:1px solid var(--rule);padding-top:5px}
.po-tally em{font-style:normal;font-size:11px}

.po-btn{font:inherit;font-weight:600;font-size:13px;cursor:pointer;background:var(--ink);
  color:#fff;border:1px solid var(--ink);padding:8px 15px;border-radius:3px}
.po-btn:hover:not(:disabled){background:#000}
.po-btn:disabled{opacity:.4;cursor:not-allowed}
.po-btn--ghost{background:transparent;color:var(--ink2);border-color:var(--rule)}
.po-btn--sm{padding:6px 12px;font-size:12px}
.po-btn--xs{padding:4px 9px;font-size:11.5px}
.po-x{font:inherit;font-size:16px;cursor:pointer;background:none;border:0;color:var(--dim)}
.po-x:hover{color:var(--red)}
.po-actions{display:flex;gap:7px;align-items:center;flex-wrap:wrap}
.po-err{font-size:12.5px;color:var(--red);background:#FDF6F7;border:1px solid var(--red);
  border-radius:3px;padding:9px 12px;line-height:1.6}

@media (max-width:720px){
  .po-lineRow,.po-lineRow--h,.po-lineRow--c{grid-template-columns:1fr}
  .po-lineRow--h{display:none}
}
`;
