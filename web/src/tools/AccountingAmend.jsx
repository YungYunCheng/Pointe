import React, { useState, useMemo } from "react";
import { ai } from "../lib/ai.js";

/* ============================================================
   Amendments, the change log, and the deposit interest rate

   Nothing posted is edited in place and nothing is deleted. Amending
   reverses the original entry and posts a replacement, keeping both.
   The document keeps its number and gains a version, so a keying
   error is a correction rather than an evening spent re-entering an
   invoice and its payments.

   The interest rate is not set by the AI. Alberta publishes it
   annually, and a wrong rate makes every refund wrong without anyone
   noticing until a tenant moves out. The AI researches and proposes
   with a source; a person confirms.
   ============================================================ */

const money = (n) =>
  n == null || isNaN(n) ? "—"
    : new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(n);
const cents = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const today = () => new Date().toISOString().slice(0, 10);
const stamp = (iso) => (iso ? String(iso).slice(0, 16).replace("T", " ") : "—");

/** Computed, not described. The record of what changed must not depend on
 *  anyone remembering to say what they changed. */
export function diffFields(before, after) {
  const out = [];
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const k of keys) {
    const b = before?.[k], a = after?.[k];
    if (JSON.stringify(b) === JSON.stringify(a)) continue;
    out.push({ field: k, from: b ?? null, to: a ?? null });
  }
  return out;
}

const show = (v) => {
  if (v == null) return "—";
  if (Array.isArray(v)) return `${v.length} line(s)`;
  if (typeof v === "object") return JSON.stringify(v);
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : money(v);
  return String(v);
};

const FIELD_LABEL = {
  amount: "Amount", total: "Total", subtotal: "Subtotal", gst: "GST",
  invoice_no: "Invoice number", invoice_date: "Invoice date", due_date: "Due date",
  received_date: "Received", description: "Description", gl_code: "Account",
  building_code: "Building", unit_number: "Unit", method: "Method",
  reference: "Reference", lines: "Lines", applications: "Applied to", state: "Status",
};

/* ══════════════════ Amend dialog ══════════════════ */

/** Works for an invoice, a receipt or a charge. A posted document needs a
 *  reason before it will amend: six months later the number matters less
 *  than why it moved. */
export function AmendDialog({ kind, doc, coa, post, session, onClose, onSave }) {
  const isDraft = doc.state === "draft";
  const [reason, setReason] = useState("");
  const [amendDate, setAmendDate] = useState(today());
  const [err, setErr] = useState("");

  const [f, setF] = useState(() => {
    if (kind === "ap_invoice")
      return { invoice_no: doc.invoice_no, invoice_date: doc.invoice_date,
               due_date: doc.due_date, gst: String(doc.gst ?? 0),
               description: doc.description ?? "",
               lines: (doc.lines ?? []).map((l) => ({ ...l, amount: String(l.amount) })) };
    if (kind === "ar_receipt")
      return { amount: String(doc.amount), received_date: doc.received_date,
               method: doc.method, reference: doc.reference ?? "",
               unit_number: doc.unit_number ?? "" };
    return { amount: String(doc.amount), due_date: doc.due_date,
             description: doc.description ?? "", gl_code: doc.gl_code };
  });
  const set = (p) => setF({ ...f, ...p });

  const expense = coa.filter((a) => a.type === "expense");
  const revenue = coa.filter((a) => a.type === "revenue");

  const computed = useMemo(() => {
    if (kind !== "ap_invoice") return null;
    const subtotal = cents(f.lines.reduce((t, l) => t + Number(l.amount || 0), 0));
    const gst = cents(Number(f.gst) || 0);
    return { subtotal, gst, total: cents(subtotal + gst) };
  }, [f, kind]);

  const proposedTotal = kind === "ap_invoice" ? computed.total : cents(Number(f.amount) || 0);
  const paid = cents(doc.paid_amount ?? 0);
  const belowPaid = proposedTotal < paid;

  const changes = useMemo(() => {
    if (kind === "ap_invoice")
      return diffFields(
        { invoice_no: doc.invoice_no, invoice_date: doc.invoice_date, due_date: doc.due_date,
          gst: doc.gst, total: doc.total, description: doc.description,
          lines: doc.lines?.map((l) => ({ gl_code: l.gl_code, amount: l.amount,
            description: l.description })) },
        { invoice_no: f.invoice_no, invoice_date: f.invoice_date, due_date: f.due_date,
          gst: computed.gst, total: computed.total, description: f.description,
          lines: f.lines.map((l) => ({ gl_code: l.gl_code, amount: cents(l.amount),
            description: l.description })) });
    if (kind === "ar_receipt")
      return diffFields(
        { amount: doc.amount, received_date: doc.received_date, method: doc.method,
          reference: doc.reference, unit_number: doc.unit_number },
        { amount: cents(f.amount), received_date: f.received_date, method: f.method,
          reference: f.reference, unit_number: f.unit_number });
    return diffFields(
      { amount: doc.amount, due_date: doc.due_date, description: doc.description,
        gl_code: doc.gl_code },
      { amount: cents(f.amount), due_date: f.due_date, description: f.description,
        gl_code: f.gl_code });
  }, [f, doc, kind, computed]);

  const submit = () => {
    setErr("");
    if (changes.length === 0) return setErr("Nothing has changed.");
    if (!isDraft && !reason.trim())
      return setErr("Give a reason. Six months from now the reason matters more than the number.");
    if (belowPaid)
      return setErr(`${money(paid)} has already been paid against this. Lowering the total below that is a refund decision, not a correction — handle it separately.`);

    try {
      let reversal = null, replacement = null;

      // A draft has never been posted, so there is nothing to reverse.
      if (!isDraft) {
        reversal = post({ date: amendDate, building: doc.building_code, source: "reversal",
          sourceId: doc.id, memo: `Reversal — amending ${labelOf(kind, doc)}`,
          lines: reverseLinesFor(kind, doc) });
        replacement = post({ date: kind === "ar_charge" ? doc.charge_date : amendDate,
          building: doc.building_code, source: kind, sourceId: doc.id,
          memo: `${labelOf(kind, doc)} — amended: ${reason.trim()}`,
          lines: newLinesFor(kind, doc, f, computed) });
      }

      onSave({
        patch: buildPatch(kind, f, computed, doc),
        amendment: isDraft ? null : {
          id: uid("am_"), entity_type: kind, entity_id: doc.id,
          version_from: doc.version ?? 1, version_to: (doc.version ?? 1) + 1,
          changed: changes, reason: reason.trim(),
          reversal_entry: reversal?.entry_no, replacement_entry: replacement?.entry_no,
          amended_name: session?.name ?? "unsigned", amended_at: new Date().toISOString(),
        },
        replacementEntryId: replacement?.id,
      });
    } catch (e) { setErr(e.message); }
  };

  return (
    <div className="ac-drawer-wrap" onClick={onClose}>
      <aside className="ac-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="ac-drawer-h">
          <h3>
            {isDraft ? "Edit" : "Amend"} {labelOf(kind, doc)}
            {!isDraft && <span className="ac-pill">v{doc.version ?? 1}</span>}
          </h3>
          <button className="ac-x" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="ac-drawer-b">
          {!isDraft && (
            <div className="ac-amendnote">
              This has been posted. Amending reverses the original entry and posts a
              replacement — both stay in the ledger, and the document keeps its number.
              Nothing is deleted and nothing needs re-entering.
            </div>
          )}

          {kind === "ap_invoice" && (
            <>
              <div className="ac-row">
                <label className="ac-f"><span>Invoice number</span>
                  <input className="ac-in" value={f.invoice_no}
                         onChange={(e) => set({ invoice_no: e.target.value })} /></label>
                <label className="ac-f"><span>Invoice date</span>
                  <input className="ac-in" type="date" value={f.invoice_date}
                         onChange={(e) => set({ invoice_date: e.target.value })} /></label>
                <label className="ac-f"><span>Due</span>
                  <input className="ac-in" type="date" value={f.due_date}
                         onChange={(e) => set({ due_date: e.target.value })} /></label>
              </div>

              <div className="ac-lines">
                <div className="ac-lines-h">Lines</div>
                {f.lines.map((l, i) => (
                  <div className="ac-lineRow" key={i}>
                    <select className="ac-sel" value={l.gl_code}
                            onChange={(e) => set({ lines: f.lines.map((x, j) =>
                              j === i ? { ...x, gl_code: e.target.value } : x) })}>
                      {expense.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
                    </select>
                    <input className="ac-in" placeholder="Description" value={l.description ?? ""}
                           onChange={(e) => set({ lines: f.lines.map((x, j) =>
                             j === i ? { ...x, description: e.target.value } : x) })} />
                    <input className="ac-in ac-in--sm" type="number" step="0.01" value={l.amount}
                           onChange={(e) => set({ lines: f.lines.map((x, j) =>
                             j === i ? { ...x, amount: e.target.value } : x) })} />
                    {f.lines.length > 1 && (
                      <button className="ac-x"
                              onClick={() => set({ lines: f.lines.filter((_, j) => j !== i) })}>×</button>
                    )}
                  </div>
                ))}
                <button className="ac-btn ac-btn--xs ac-btn--ghost"
                        onClick={() => set({ lines: [...f.lines,
                          { gl_code: expense[0]?.code ?? "5010", description: "", amount: "" }] })}>
                  + Another line
                </button>
              </div>

              <div className="ac-row">
                <label className="ac-f"><span>GST</span>
                  <input className="ac-in" type="number" step="0.01" value={f.gst}
                         onChange={(e) => set({ gst: e.target.value })} /></label>
                <label className="ac-f" style={{ flex: "2 1 200px" }}><span>Description</span>
                  <input className="ac-in" value={f.description}
                         onChange={(e) => set({ description: e.target.value })} /></label>
              </div>

              <div className="ac-tally">
                <div><span>Subtotal</span><span className="ac-mono">{money(computed.subtotal)}</span></div>
                <div><span>GST</span><span className="ac-mono">{money(computed.gst)}</span></div>
                <div className="ac-tally-t"><span>Total</span>
                  <span className="ac-mono">{money(computed.total)}</span></div>
                {paid > 0 && (
                  <div className={belowPaid ? "ac-warnrow" : ""}>
                    <span>Already paid</span><span className="ac-mono">{money(paid)}</span>
                  </div>
                )}
              </div>
            </>
          )}

          {kind === "ar_receipt" && (
            <>
              <div className="ac-row">
                <label className="ac-f"><span>Amount</span>
                  <input className="ac-in" type="number" step="0.01" value={f.amount}
                         onChange={(e) => set({ amount: e.target.value })} /></label>
                <label className="ac-f"><span>Received</span>
                  <input className="ac-in" type="date" value={f.received_date}
                         onChange={(e) => set({ received_date: e.target.value })} /></label>
              </div>
              <div className="ac-row">
                <label className="ac-f"><span>Unit</span>
                  <input className="ac-in" value={f.unit_number}
                         onChange={(e) => set({ unit_number: e.target.value })} /></label>
                <label className="ac-f"><span>Method</span>
                  <select className="ac-sel" value={f.method}
                          onChange={(e) => set({ method: e.target.value })}>
                    {["etransfer", "cheque", "preauth", "cash", "card"].map((m) =>
                      <option key={m}>{m}</option>)}
                  </select></label>
                <label className="ac-f"><span>Reference</span>
                  <input className="ac-in" value={f.reference}
                         onChange={(e) => set({ reference: e.target.value })} /></label>
              </div>
              <p className="ac-note-p">
                Changing the amount unwinds what this receipt was applied to and
                reapplies it. The charges it was covering go back to open until
                the new amount is allocated.
              </p>
            </>
          )}

          {kind === "ar_charge" && (
            <>
              <div className="ac-row">
                <label className="ac-f"><span>Amount</span>
                  <input className="ac-in" type="number" step="0.01" value={f.amount}
                         onChange={(e) => set({ amount: e.target.value })} /></label>
                <label className="ac-f"><span>Due</span>
                  <input className="ac-in" type="date" value={f.due_date}
                         onChange={(e) => set({ due_date: e.target.value })} /></label>
                <label className="ac-f"><span>Account</span>
                  <select className="ac-sel" value={f.gl_code}
                          onChange={(e) => set({ gl_code: e.target.value })}>
                    {revenue.map((a) => <option key={a.code} value={a.code}>{a.code} · {a.name}</option>)}
                  </select></label>
              </div>
              <label className="ac-f"><span>Description</span>
                <input className="ac-in" value={f.description}
                       onChange={(e) => set({ description: e.target.value })} /></label>
              {doc.prorated && (
                <p className="ac-note-p">
                  This was prorated: {doc.prorate_note}. Changing the amount by hand
                  overrides that calculation, so the note no longer explains the figure —
                  say why in the reason.
                </p>
              )}
            </>
          )}

          {changes.length > 0 && (
            <div className="ac-changes">
              <div className="ac-changes-h">What will change</div>
              {changes.map((c) => (
                <div className="ac-change" key={c.field}>
                  <span>{FIELD_LABEL[c.field] ?? c.field}</span>
                  <span className="ac-from">{show(c.from)}</span>
                  <span className="ac-arrow">→</span>
                  <span className="ac-to">{show(c.to)}</span>
                </div>
              ))}
            </div>
          )}

          {!isDraft && (
            <>
              <label className="ac-f">
                <span>Reason <em>required</em></span>
                <textarea className="ac-in" rows={2} value={reason}
                          placeholder="Coded to the wrong account · vendor sent a corrected invoice · amount keyed wrong"
                          onChange={(e) => setReason(e.target.value)} />
              </label>
              <label className="ac-f" style={{ maxWidth: 180 }}>
                <span>Post the correction on</span>
                <input className="ac-in" type="date" value={amendDate}
                       onChange={(e) => setAmendDate(e.target.value)} />
                <em className="ac-hint">
                  Use today unless the original month is still open
                </em>
              </label>
            </>
          )}

          {err && <div className="ac-err">{err}</div>}
          <div className="ac-actions">
            <button className="ac-btn" onClick={submit} disabled={changes.length === 0}>
              {isDraft ? "Save changes" : "Post the amendment"}
            </button>
            <button className="ac-btn ac-btn--ghost" onClick={onClose}>Cancel</button>
          </div>
        </div>
      </aside>
    </div>
  );
}

function labelOf(kind, doc) {
  if (kind === "ap_invoice") return `invoice ${doc.invoice_no}`;
  if (kind === "ar_receipt") return `receipt ${doc.receipt_no}`;
  return `${doc.kind} ${doc.unit_number} ${doc.period}`;
}

function reverseLinesFor(kind, doc) {
  if (kind === "ap_invoice") {
    const out = (doc.lines ?? []).map((l) => ({ gl: l.gl_code, credit: cents(l.amount),
      unit: l.unit_number, vendorId: doc.vendor_id }));
    if (doc.gst > 0) out.push({ gl: "1210", credit: cents(doc.gst), vendorId: doc.vendor_id });
    out.push({ gl: "2010", debit: cents(doc.total), vendorId: doc.vendor_id });
    return out;
  }
  if (kind === "ar_receipt")
    return [{ gl: "1010", credit: cents(doc.amount), unit: doc.unit_number },
            { gl: "1100", debit: cents(doc.amount), unit: doc.unit_number }];
  return [{ gl: "1100", credit: cents(doc.amount), unit: doc.unit_number },
          { gl: doc.gl_code, debit: cents(doc.amount), unit: doc.unit_number }];
}

function newLinesFor(kind, doc, f, computed) {
  if (kind === "ap_invoice") {
    const out = f.lines.map((l) => ({ gl: l.gl_code, debit: cents(l.amount),
      unit: l.unit_number, vendorId: doc.vendor_id, memo: l.description }));
    if (computed.gst > 0) out.push({ gl: "1210", debit: computed.gst, vendorId: doc.vendor_id });
    out.push({ gl: "2010", credit: computed.total, vendorId: doc.vendor_id,
               memo: f.invoice_no });
    return out;
  }
  if (kind === "ar_receipt")
    return [{ gl: "1010", debit: cents(f.amount), unit: f.unit_number },
            { gl: "1100", credit: cents(f.amount), unit: f.unit_number }];
  return [{ gl: "1100", debit: cents(f.amount), unit: doc.unit_number },
          { gl: f.gl_code, credit: cents(f.amount), unit: doc.unit_number }];
}

function buildPatch(kind, f, computed, doc) {
  if (kind === "ap_invoice")
    return { invoice_no: f.invoice_no, invoice_date: f.invoice_date, due_date: f.due_date,
             description: f.description, gst: computed.gst, subtotal: computed.subtotal,
             total: computed.total,
             lines: f.lines.map((l) => ({ ...l, amount: cents(l.amount) })) };
  if (kind === "ar_receipt")
    return { amount: cents(f.amount), received_date: f.received_date, method: f.method,
             reference: f.reference, unit_number: f.unit_number };
  return { amount: cents(f.amount), due_date: f.due_date, description: f.description,
           gl_code: f.gl_code };
}

/* ══════════════════ Version history ══════════════════ */

export function VersionHistory({ amendments, entityId }) {
  const rows = amendments.filter((a) => a.entity_id === entityId)
    .sort((a, b) => String(b.amended_at).localeCompare(String(a.amended_at)));
  if (!rows.length) return null;
  return (
    <details className="ac-history">
      <summary>{rows.length} amendment{rows.length > 1 ? "s" : ""}</summary>
      {rows.map((a) => (
        <div className="ac-hitem" key={a.id}>
          <div className="ac-hitem-h">
            <span className="ac-pill">v{a.version_from} → v{a.version_to}</span>
            <span className="ac-dim">{stamp(a.amended_at)} · {a.amended_name}</span>
            {a.replacement_entry && (
              <span className="ac-dim ac-mono">
                reversed #{a.reversal_entry} · posted #{a.replacement_entry}
              </span>
            )}
          </div>
          <div className="ac-hreason">{a.reason}</div>
          {(a.changed ?? []).map((c) => (
            <div className="ac-change" key={c.field}>
              <span>{FIELD_LABEL[c.field] ?? c.field}</span>
              <span className="ac-from">{show(c.from)}</span>
              <span className="ac-arrow">→</span>
              <span className="ac-to">{show(c.to)}</span>
            </div>
          ))}
          {a.narrative && <div className="ac-hnarr">{a.narrative}</div>}
        </div>
      ))}
    </details>
  );
}

/* ══════════════════ Change log ══════════════════ */

/** Every accounting change, in order. The computed diff is the record; the AI
 *  sentence beside it is so that reading a month of changes does not mean
 *  reading JSON. If the AI is unavailable the log still works. */
export function ChangeLog({ amendments, entries, save, canPost }) {
  const [busy, setBusy] = useState(null);
  const [filter, setFilter] = useState("all");
  const [err, setErr] = useState("");

  const rows = useMemo(() => {
    const fromAmendments = amendments.map((a) => ({
      id: a.id, at: a.amended_at, by: a.amended_name, kind: "amendment",
      entity: a.entity_type, entity_id: a.entity_id,
      summary: `${a.entity_type.replace("_", " ")} amended to v${a.version_to}`,
      reason: a.reason, changed: a.changed, narrative: a.narrative,
    }));
    const fromEntries = entries.filter((e) => e.source === "manual" || e.state === "reversed")
      .map((e) => ({
        id: e.id, at: e.at, by: e.by, kind: e.state === "reversed" ? "reversed" : "posted",
        entity: "journal", entity_id: e.id,
        summary: `Entry ${e.entry_no} ${e.state === "reversed" ? "reversed" : "posted"}`,
        reason: e.memo, changed: null, narrative: null,
      }));
    return [...fromAmendments, ...fromEntries]
      .filter((r) => filter === "all" || r.kind === filter)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }, [amendments, entries, filter]);

  const writeNarrative = async (row) => {
    setBusy(row.id); setErr("");
    try {
      const text = await ai(taskName, taskInput, taskRef);
      if (text) save.amendments(amendments.map((a) => a.id === row.id
        ? { ...a, narrative: text,
          narrative_model: "@cf/zai-org/glm-4.7-flash" } : a));
    } catch {
      setErr("The AI service did not respond. The recorded change stands on its own.");
    }
    setBusy(null);
  };

  const writeAll = async () => {
    const pending = rows.filter((r) => r.kind === "amendment" && !r.narrative).slice(0, 10);
    for (const r of pending) await writeNarrative(r);
  };

  const pendingCount = rows.filter((r) => r.kind === "amendment" && !r.narrative).length;

  return (
    <div className="ac-body">
      <section className="ac-card">
        <div className="ac-cardh">
          <h2>Change log <span className="ac-n">{rows.length}</span></h2>
          <div className="ac-cardh-r">
            <div className="ac-seg">
              {[["all", "All"], ["amendment", "Amendments"], ["reversed", "Reversals"]]
                .map(([k, l]) => (
                <button key={k} className={filter === k ? "on" : ""}
                        onClick={() => setFilter(k)}>{l}</button>
              ))}
            </div>
            {canPost && pendingCount > 0 && (
              <button className="ac-btn ac-btn--sm" onClick={writeAll} disabled={!!busy}>
                {busy ? "Writing…" : `Describe ${Math.min(pendingCount, 10)}`}
              </button>
            )}
          </div>
        </div>
        <p className="ac-note-p">
          Every change to a posted record, in order. The fields and figures are
          recorded by the system; the sentence beside them is written from those
          facts and adds nothing to them.
        </p>
        {err && <div className="ac-err">{err}</div>}
      </section>

      {rows.length === 0 ? (
        <section className="ac-card"><div className="ac-empty">Nothing changed yet.</div></section>
      ) : (
        <section className="ac-card">
          <div className="ac-log">
            {rows.map((r) => (
              <div className="ac-logitem" key={r.id}>
                <div className="ac-logitem-h">
                  <span className="ac-tag" style={{ "--c": r.kind === "amendment" ? "#1C6FA6"
                    : r.kind === "reversed" ? "#B23A54" : "#8892A0" }}>{r.kind}</span>
                  <strong>{r.summary}</strong>
                  <span className="ac-dim ac-mono">{stamp(r.at)}</span>
                  <span className="ac-dim">{r.by}</span>
                </div>
                {r.reason && <div className="ac-hreason">{r.reason}</div>}
                {(r.changed ?? []).map((c) => (
                  <div className="ac-change" key={c.field}>
                    <span>{FIELD_LABEL[c.field] ?? c.field}</span>
                    <span className="ac-from">{show(c.from)}</span>
                    <span className="ac-arrow">→</span>
                    <span className="ac-to">{show(c.to)}</span>
                  </div>
                ))}
                {r.narrative ? (
                  <div className="ac-hnarr">{r.narrative}</div>
                ) : canPost && r.kind === "amendment" ? (
                  <button className="ac-btn ac-btn--xs ac-btn--ghost"
                          disabled={busy === r.id} onClick={() => writeNarrative(r)}>
                    {busy === r.id ? "Writing…" : "Describe this"}
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      )}
      <style>{AMEND_CSS}</style>
    </div>
  );
}

/* ══════════════════ Deposit interest rate ══════════════════ */

/** Alberta publishes this annually. The AI researches and proposes with a
 *  source; a person confirms. A confident wrong rate here makes every refund
 *  wrong and is not discovered until someone moves out — which is exactly the
 *  kind of error a model is good at producing and nobody is watching for. */
export function InterestRates({ rates, proposals, save, canPost, session }) {
  const [year, setYear] = useState(new Date().getFullYear());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [manual, setManual] = useState("");

  const current = rates.find((r) => r.year === year);
  const pending = proposals.filter((p) => p.year === year && p.state === "proposed");

  const research = async () => {
    setBusy(true); setErr("");
    try {
      const text = await ai(taskName, taskInput, taskRef);
      const json = JSON.parse(text.replace(/```json|```/g, "").trim());
      save.proposals([{ id: uid("irp_"), ...json, state: "proposed",
        model: "@cf/zai-org/glm-4.7-flash",
        created_at: new Date().toISOString() }, ...proposals]);
    } catch {
      setErr("Could not retrieve a rate. Enter it by hand from the regulation.");
    }
    setBusy(false);
  };

  const confirm = (p, rate) => {
    save.proposals(proposals.map((x) => x.id === p.id
      ? { ...x, state: "confirmed", rate, confirmed_by: session?.name,
          confirmed_at: new Date().toISOString() } : x));
    save.rates([...rates.filter((r) => r.year !== p.year),
      { year: p.year, rate, source: p.source_url || p.source_text || "confirmed by accounting",
        set_by: session?.name, set_at: new Date().toISOString() }]);
  };

  return (
    <div className="ac-body">
      <section className="ac-card">
        <div className="ac-cardh">
          <h2>Deposit interest rate</h2>
          <div className="ac-cardh-r">
            <input className="ac-in ac-in--sm" type="number" value={year} style={{ width: 90 }}
                   onChange={(e) => setYear(Number(e.target.value))} />
            {canPost && (
              <button className="ac-btn ac-btn--sm" onClick={research} disabled={busy}>
                {busy ? "Looking it up…" : "Look up the rate"}
              </button>
            )}
          </div>
        </div>

        <div className="ac-ratenote">
          Alberta sets this annually under the Security Deposit Interest Rate Regulation.
          Every deposit held earns it, and every refund includes it. The AI can look the
          figure up and cite where it came from, but it does not set it — a wrong rate
          here is not discovered until a tenant moves out and the refund is short.
        </div>

        <div className="ac-rateNow">
          <div>
            <em>{year}</em>
            <strong>{current ? `${(current.rate * 100).toFixed(2)}%` : "not set"}</strong>
          </div>
          <div className="ac-ratesrc">
            {current
              ? <>Set by {current.set_by ?? "—"} · {current.source}</>
              : <span className="ac-bad">
                  The accrual has nothing to run on. Until this is confirmed,
                  interest is not being credited to any deposit.
                </span>}
          </div>
        </div>

        {err && <div className="ac-err">{err}</div>}

        {pending.map((p) => (
          <div className={`ac-proposal ${p.confidence === "high" ? "" : "low"}`} key={p.id}>
            <div className="ac-proposal-h">
              <strong>{(p.rate * 100).toFixed(2)}%</strong>
              <span className="ac-tag" style={{ "--c": p.confidence === "high" ? "#0E8577"
                : p.confidence === "low" ? "#C98A15" : "#B23A54" }}>
                {p.confidence}
              </span>
              <span className="ac-dim">proposed {stamp(p.created_at)}</span>
            </div>
            {p.source_text && <div className="ac-quote">{p.source_text}</div>}
            {p.reasoning && <p className="ac-note-p">{p.reasoning}</p>}
            {p.source_url && (
              <a className="ac-link" href={p.source_url} target="_blank" rel="noreferrer">
                {p.source_url}
              </a>
            )}
            {p.confidence !== "high" && (
              <div className="ac-warnbox">
                Not verified. Check the regulation before confirming — this figure
                multiplies across every deposit held.
              </div>
            )}
            {canPost && (
              <div className="ac-actions">
                <input className="ac-in ac-in--sm" type="number" step="0.0001"
                       defaultValue={p.rate} style={{ width: 110 }}
                       onChange={(e) => setManual(e.target.value)} />
                <button className="ac-btn ac-btn--sm"
                        onClick={() => confirm(p, Number(manual || p.rate))}>
                  Confirm this rate
                </button>
                <button className="ac-btn ac-btn--sm ac-btn--ghost"
                        onClick={() => save.proposals(proposals.map((x) => x.id === p.id
                          ? { ...x, state: "rejected" } : x))}>
                  Reject
                </button>
              </div>
            )}
          </div>
        ))}
      </section>

      <section className="ac-card">
        <h2>Rate history</h2>
        {rates.length === 0 ? <div className="ac-empty">No rates confirmed yet.</div> : (
          <div className="ac-table">
            <div className="ac-tr ac-tr--h" style={{ gridTemplateColumns: "90px 100px 1fr 1fr" }}>
              <span>Year</span><span>Rate</span><span>Source</span><span>Confirmed by</span>
            </div>
            {rates.slice().sort((a, b) => b.year - a.year).map((r) => (
              <div className="ac-tr" key={r.year} style={{ gridTemplateColumns: "90px 100px 1fr 1fr" }}>
                <span className="ac-mono ac-strong">{r.year}</span>
                <span className="ac-mono">{(r.rate * 100).toFixed(2)}%</span>
                <span className="ac-dim ac-cut">{r.source}</span>
                <span className="ac-dim">{r.set_by ?? "—"}</span>
              </div>
            ))}
          </div>
        )}
        <p className="ac-note-p">
          Rates are kept per year rather than as one setting, because interest on a
          deposit held across several years accrues at each year’s own rate.
        </p>
      </section>
      <style>{AMEND_CSS}</style>
    </div>
  );
}

const AMEND_CSS = `
.ac-amendnote{background:#F2F7FB;border-left:3px solid var(--accent);border-radius:3px;
  padding:10px 13px;font-size:12.5px;color:var(--ink2);line-height:1.7}
.ac-changes{border:1px solid var(--rule);border-radius:3px;padding:10px 12px;background:#FCFDFE}
.ac-changes-h{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.06em;
  text-transform:uppercase;color:var(--dim);margin-bottom:6px}
.ac-change{display:grid;grid-template-columns:minmax(90px,1fr) 1fr 18px 1fr;gap:8px;
  align-items:baseline;font-size:12px;padding:3px 0}
.ac-change>span:first-child{color:var(--dim)}
.ac-from{color:var(--dim);text-decoration:line-through;word-break:break-word}
.ac-arrow{color:var(--dim);text-align:center}
.ac-to{font-weight:600;word-break:break-word}
.ac-history{font-size:12.5px;margin-top:6px}
.ac-history summary{cursor:pointer;color:var(--accent);padding:4px 0}
.ac-hitem{border-left:2px solid var(--rule);padding:8px 0 8px 11px;margin-top:6px}
.ac-hitem-h{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:3px}
.ac-hreason{font-size:12.5px;color:var(--ink2);font-style:italic;margin-bottom:4px}
.ac-hnarr{font-size:12.5px;color:var(--ink2);background:#FAFCFD;border-left:2px solid var(--accent);
  padding:7px 10px;margin-top:6px;line-height:1.7;border-radius:0 3px 3px 0}
.ac-log{display:flex;flex-direction:column;gap:1px;background:var(--rule);
  border:1px solid var(--rule);border-radius:3px;overflow:hidden}
.ac-logitem{background:var(--paper);padding:11px 13px;display:flex;flex-direction:column;gap:4px}
.ac-logitem-h{display:flex;gap:9px;align-items:center;flex-wrap:wrap;font-size:13px}
.ac-ratenote{background:var(--amber);border:1px solid var(--amberline);border-radius:3px;
  padding:11px 14px;font-size:12.5px;color:#6B5410;line-height:1.75}
.ac-rateNow{display:flex;gap:22px;align-items:baseline;flex-wrap:wrap;padding:12px 14px;
  border:1px solid var(--rule);border-radius:3px}
.ac-rateNow>div:first-child{display:flex;flex-direction:column}
.ac-rateNow em{font-style:normal;font-size:10.5px;color:var(--dim);
  font-family:'IBM Plex Mono',monospace;letter-spacing:.05em}
.ac-rateNow strong{font-family:'IBM Plex Mono',monospace;font-size:26px}
.ac-ratesrc{font-size:12.5px;color:var(--dim);line-height:1.6;flex:1}
.ac-proposal{border:1px solid var(--green);border-radius:3px;padding:12px 14px;
  display:flex;flex-direction:column;gap:8px;background:#F6FBF8}
.ac-proposal.low{border-color:var(--amberline);background:#FFFCF3}
.ac-proposal-h{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.ac-proposal-h strong{font-family:'IBM Plex Mono',monospace;font-size:22px}
.ac-quote{font-size:12.5px;color:var(--ink2);border-left:2px solid var(--rule);
  padding-left:10px;line-height:1.7}
.ac-link{font-size:12px;color:var(--accent);word-break:break-all}
.ac-warnbox{font-size:12.5px;color:var(--red);background:#FDF6F7;border:1px solid var(--red);
  border-radius:3px;padding:8px 11px;line-height:1.6}
`;
