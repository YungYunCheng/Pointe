import React, { useState, useEffect, useMemo, useCallback } from "react";
import { ROLE_THEME } from "../lib/theme.jsx";

/* ============================================================
   BAYDO POINTE — Confirmations

   Everything an automation has produced that needs somebody to say yes.

   One page rather than a badge on each tool. The question people
   actually have is "what is waiting on me", and a confirmation list
   spread across six screens is one nobody works through.

   Sorted by consequence, not by date. Anything that reaches a
   tenant or moves money comes first — those are the ones where a
   wrong yes is expensive, and the ones somebody should be reading
   carefully rather than clicking through.
   ============================================================ */

const money = (n) => (n == null || isNaN(n) ? null
  : new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(n));
const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const nowISO = () => new Date().toISOString();
const stamp = (s) => (s ? String(s).slice(0, 16).replace("T", " ") : "—");
const daysLeft = (iso) => (iso ? Math.ceil((new Date(iso) - Date.now()) / 864e5) : null);

/* Each kind, who confirms it, and why it is safe enough to propose at all.
   The "why" is shown on the card: somebody confirming twenty bank matches
   should know what happens if one is wrong. */
export const KINDS = {
  bank_match: {
    label: "Bank statement matches", roles: ["accounting"], ttl: 14, area: "Accounting",
    why: "A wrong match shows up as an out-of-balance reconciliation, so it cannot hide.",
  },
  invoice_extract: {
    label: "Invoice read from a PDF", roles: ["accounting"], ttl: 30, area: "Accounting",
    money: true,
    why: "Entered as a draft bill with the invoice beside it. Nothing posts until the bill is approved in the usual way.",
  },
  csv_mapping: {
    label: "Bank export layout", roles: ["accounting"], ttl: 7, area: "Accounting",
    why: "Opening plus movement must equal closing. A wrong mapping fails that immediately.",
  },
  ap_anomaly: {
    label: "Payables worth a look", roles: ["accounting"], ttl: 30, area: "Accounting",
    why: "Things to check, not findings. Most will be routine — the ones that are not are what this is for.",
  },
  variance_commentary: {
    label: "Month-on-month commentary", roles: ["accounting"], ttl: 60, area: "Accounting",
    why: "Written from figures already computed. It explains movement and never recalculates.",
  },
  maintenance_triage: {
    label: "Repair sorted", roles: ["building_manager"], ttl: 7, area: "On site",
    why: "Category and who to send. Urgency is not set here — that stays with whoever can see the leak.",
  },
  quote_comparison: {
    label: "Quotes compared", roles: ["building_manager"], ttl: 30, area: "On site",
    why: "What each includes and excludes. No recommendation: the cheapest quote is often the one excluding the most.",
  },
  nl_query: {
    label: "Question answered from the ledger", roles: ["accounting"], ttl: 7,
    area: "Accounting",
    why: "The SQL is shown with the answer. A query nobody can see is an answer nobody can check.",
  },
  lease_abstract: {
    label: "Lease terms extracted", roles: ["property_manager", "admin"], ttl: 30,
    area: "Leasing", money: true,
    why: "Populates a draft. The signed file stays the authority — this is an index of it. Two people because a wrong end date propagates into every renewal reminder after it.",
  },
  turnover_estimate: {
    label: "Turnover cost estimated", roles: ["building_manager", "admin"], ttl: 30,
    area: "On site",
    why: "A range from this property's own history, with the sample size shown. The Building Manager has seen the suite — an estimate confirmed without that is an estimate from a spreadsheet.",
  },
  arrears_sequence: {
    label: "Arrears message", roles: ["property_manager", "admin"], ttl: 7, area: "Leasing",
    tenant: true,
    why: "Two people because one knows the tenant and the other owns the consequence. Collections only — nothing about ending a tenancy.",
  },
};

export default function Confirmations() {
  const [session, setSession] = useState(undefined);
  const [proposals, setProposals] = useState([]);
  const [chatConfirmations, setChatConfirmations] = useState([]);
  const [view, setView] = useState("yours");
  const [open, setOpen] = useState(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    (async () => {
      const read = async (k, d) => {
        try { const r = await window.storage.get(k); return r?.value ? JSON.parse(r.value) : d; }
        catch { return d; }
      };
      setSession(await read("baydo:session", null));
      setProposals(await read("baydo:proposals", []));
      try {
        const response = await fetch("/api/escalations", { credentials:"include" });
        if (response.ok) setChatConfirmations((await response.json()).escalations ?? []);
      } catch { /* Local proposals remain usable if the API is offline. */ }
      setLoading(false);
    })();
  }, []);

  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(""), 3500); };
  const save = useCallback(async (v) => {
    setProposals(v);
    try { await window.storage.set("baydo:proposals", JSON.stringify(v)); } catch {}
  }, []);

  const enriched = useMemo(() => proposals.map((p) => {
    const spec = KINDS[p.kind] ?? {};
    const required = spec.roles ?? [];
    const given = p.confirmations ?? [];
    const outstanding = required.filter((r) => !given.some((c) => c.role_code === r));
    const expired = p.state === "pending" && p.expires_at && p.expires_at < nowISO();
    return { ...p, spec, required, given, outstanding, expired,
      state: expired ? "expired" : p.state,
      // Admin can stand in. With four people somebody is always away, and a
      // queue that stalls on absence gets worked around instead of used.
      yours: outstanding.includes(session?.role) || session?.role === "admin",
      alreadyMine: given.some((c) => c.user_name === session?.name) };
  }), [proposals, session]);

  const shown = useMemo(() => {
    const list = view === "yours"
      ? enriched.filter((p) => p.state === "pending" && p.yours && !p.alreadyMine)
      : view === "pending" ? enriched.filter((p) => p.state === "pending")
      : view === "done" ? enriched.filter((p) => ["applied", "confirmed"].includes(p.state))
      : view === "rejected" ? enriched.filter((p) => p.state === "rejected")
      : enriched;
    // Consequence before date. A message going to a tenant and a category on
    // a work order should not sit in the same position just because they
    // arrived in the same hour.
    return [...list].sort((a, b) => {
      const w = (x) => (x.spec.tenant ? 0 : x.spec.money ? 1 : 2);
      if (w(a) !== w(b)) return w(a) - w(b);
      return String(a.expires_at ?? "").localeCompare(String(b.expires_at ?? ""));
    });
  }, [enriched, view]);

  const counts = useMemo(() => ({
    yours: enriched.filter((p) => p.state === "pending" && p.yours && !p.alreadyMine).length,
    pending: enriched.filter((p) => p.state === "pending").length,
    done: enriched.filter((p) => ["applied", "confirmed"].includes(p.state)).length,
    rejected: enriched.filter((p) => p.state === "rejected").length,
    tenant: enriched.filter((p) => p.state === "pending" && p.spec.tenant).length,
  }), [enriched]);

  const chatShown = useMemo(() => chatConfirmations.filter((item) => {
    const pending = ["open", "claimed"].includes(item.state);
    if (view === "yours" || view === "pending") return pending;
    if (view === "done") return !pending;
    if (view === "rejected") return false;
    return true;
  }), [chatConfirmations, view]);
  const chatPending = chatConfirmations.filter((item) =>
    ["open", "claimed"].includes(item.state));
  const chatDone = chatConfirmations.filter((item) =>
    !["open", "claimed"].includes(item.state));

  const confirmChat = async (item) => {
    try {
      const response = await fetch(`/api/escalations/${item.id}/confirm`, {
        method:"POST", credentials:"include",
        headers:{ "content-type":"application/json" },
        body:JSON.stringify({ note:"Reviewed and confirmed by staff" }),
      });
      if (!response.ok) throw new Error("confirm failed");
      const { escalation } = await response.json();
      setChatConfirmations((items) => items.map((x) =>
        x.id === item.id ? { ...x, ...escalation } : x));
      flash("Confirmed. This item is recorded as handled.");
    } catch { flash("Could not confirm this item. Please try again."); }
  };

  const confirm = (p, edited, note) => {
    const role = p.outstanding.includes(session?.role) ? session.role : p.outstanding[0];
    const given = [...(p.confirmations ?? []), { id: uid("pc_"), role_code: role,
      user_name: session?.name, edited: !!edited,
      edited_payload: edited ?? null, note: note ?? null, at: nowISO() }];
    const outstanding = (p.spec.roles ?? []).filter((r) =>
      !given.some((c) => c.role_code === r));
    save(proposals.map((x) => x.id === p.id
      ? { ...x, confirmations: given,
          state: outstanding.length === 0 ? "confirmed" : "pending" } : x));
    flash(outstanding.length === 0
      ? "Confirmed. Apply it when you are ready."
      : `Confirmed. Still waiting on ${outstanding.map((r) =>
          ROLE_THEME[r]?.label ?? r).join(" and ")}.`);
  };

  const reject = (p, reason) => {
    save(proposals.map((x) => x.id === p.id
      ? { ...x, state: "rejected", rejected_reason: reason,
          rejected_name: session?.name, rejected_at: nowISO() } : x));
    flash("Rejected. The reason is what makes this worth doing.");
  };

  const apply = (p) => {
    save(proposals.map((x) => x.id === p.id
      ? { ...x, state: "applied", applied_at: nowISO() } : x));
    flash(p.spec.tenant ? "Queued to the tenant." : "Applied.");
  };

  if (loading || session === undefined)
    return <div className="cf"><style>{CSS}</style><div className="cf-load">Loading…</div></div>;

  const TABS = [["yours", "Waiting on you", counts.yours + chatPending.length],
                ["pending", "All pending", counts.pending + chatPending.length],
                ["done", "Done", counts.done + chatDone.length],
                ["rejected", "Rejected", counts.rejected]];

  return (
    <div className="cf">
      <style>{CSS}</style>

      <header className="cf-head">
        <div>
          <div className="cf-eyebrow">Baydo Pointe · Confirmations</div>
          <h1>{counts.yours + chatPending.length > 0
            ? `${counts.yours + chatPending.length} waiting on you`
            : "Nothing waiting on you"}</h1>
        </div>
        {msg && <span className="cf-flash">{msg}</span>}
      </header>

      <nav className="cf-tabs">
        {TABS.map(([k, l, n]) => (
          <button key={k} className={view === k ? "on" : ""} onClick={() => setView(k)}>
            {l}{n > 0 && <i className={k === "yours" ? "hot" : ""}>{n}</i>}
          </button>
        ))}
      </nav>

      <div className="cf-body">
        <p className="cf-note">
          Nothing an automation cannot verify applies itself. Everything here is waiting on
          the responsible person, sorted by what it would affect rather than when it arrived —
          anything that reaches a tenant or moves money comes first.
        </p>

        {counts.tenant + chatPending.length > 0 && view !== "done" && (
          <div className="cf-alert">
            <strong>{counts.tenant + chatPending.length} customer items need review.</strong>
            <span>
              {" "}Those are worth reading in full rather than scanning. A message that
              lands wrong is harder to take back than a bookkeeping entry.
            </span>
          </div>
        )}

        {chatShown.length > 0 && (
          <div className="cf-list">
            {chatShown.map((item) => {
              const pending = ["open", "claimed"].includes(item.state);
              const late = pending && item.due_by && new Date(item.due_by) < new Date();
              return (
                <article className="cf-card tenant" key={item.id}>
                  <div className="cf-cardh">
                    <span className="cf-tag" style={{ "--c": late ? "#B93855" : "#C98A15" }}>
                      {late ? "overdue" : pending ? "needs confirmation" : "handled"}
                    </span>
                    <strong>Customer chat · {item.topic || "unrecognised"}</strong>
                    <span>{ROLE_THEME[item.assigned_role]?.label ?? item.assigned_role}</span>
                    <span className="cf-mono">{stamp(item.created_at)}</span>
                  </div>
                  <div style={{ padding:"0 20px 18px" }}>
                    {item.body_included === false || !item.body
                      ? <p>Message content is withheld for this protected-topic rule. Review the original contact directly.</p>
                      : <p>{item.body}</p>}
                    {pending && <button className="cf-btn" onClick={() => confirmChat(item)}>
                      Confirm handled
                    </button>}
                    {!pending && item.claimed_name &&
                      <p className="cf-dim">Handled by {item.claimed_name}.</p>}
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {shown.length === 0 && chatShown.length === 0 ? (
          <div className="cf-empty">
            {view === "yours"
              ? "Nothing waiting on you. Anything needing another role is under All pending."
              : "Nothing here."}
          </div>
        ) : (
          <div className="cf-list">
            {shown.map((p) => (
              <Card key={p.id} p={p} session={session} expanded={open === p.id}
                    onToggle={() => setOpen(open === p.id ? null : p.id)}
                    onConfirm={confirm} onReject={reject} onApply={apply} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ══════════════════ One proposal ══════════════════ */

function Card({ p, session, expanded, onToggle, onConfirm, onReject, onApply }) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const left = daysLeft(p.expires_at);

  const stateColor = { pending: "#C98A15", confirmed: "#1C6FA6", applied: "#0E8577",
                       rejected: "#8892A0", expired: "#8892A0" }[p.state] ?? "#8892A0";

  return (
    <article className={`cf-card ${p.spec.tenant ? "tenant" : p.spec.money ? "money" : ""}
                         ${p.state !== "pending" ? "done" : ""}`}>
      <button className="cf-cardh" onClick={onToggle}>
        <span className="cf-tag" style={{ "--c": stateColor }}>
          {p.state === "pending" && p.given.length > 0 ? "part confirmed" : p.state}
        </span>
        <strong>{p.title ?? p.spec.label}</strong>
        {p.unit_number && <span className="cf-mono">{p.unit_number}</span>}
        {p.amount != null && <span className="cf-mono cf-amt">{money(p.amount)}</span>}
        <span className="cf-area">{p.spec.area}</span>
        {p.spec.tenant && <span className="cf-flag">reaches a tenant</span>}
        {p.spec.money && <span className="cf-flag cf-flag--money">moves money</span>}
        {p.state === "pending" && left != null && (
          <span className={`cf-dim ${left <= 2 ? "cf-bad" : ""}`}>
            {left <= 0 ? "expired" : `${left}d left`}
          </span>
        )}
        <span className="cf-chev">{expanded ? "−" : "+"}</span>
      </button>

      {p.summary && <p className="cf-summary">{p.summary}</p>}

      {/* Who still has to say yes. Two names means two people, not either. */}
      {p.required.length > 1 && (
        <div className="cf-signoff">
          {p.required.map((role) => {
            const has = p.given.find((c) => c.role_code === role);
            return (
              <span key={role} className={`cf-sig ${has ? "on" : ""}`}>
                <i style={{ background: has ? ROLE_THEME[role]?.ink : undefined }} />
                {ROLE_THEME[role]?.label ?? role}
                {has && <em> · {has.user_name}</em>}
              </span>
            );
          })}
        </div>
      )}

      {expanded && (
        <div className="cf-detail">
          <Payload kind={p.kind} payload={p.payload} />

          {p.method && (
            <details className="cf-method">
              <summary>How it worked this out</summary>
              <pre>{p.method}</pre>
            </details>
          )}

          <div className="cf-why">
            <strong>Why this is safe to propose:</strong> {p.spec.why}
          </div>

          {p.confidence && p.confidence !== "high" && (
            <div className="cf-lowconf">
              Confidence: {p.confidence}. Worth checking against the source rather than
              taking on trust.
            </div>
          )}

          {p.given.map((c) => (
            <div className="cf-given" key={c.id}>
              <strong>{c.user_name}</strong> confirmed as {ROLE_THEME[c.role_code]?.label}
              {c.edited && <span className="cf-edited"> · edited before confirming</span>}
              <span className="cf-dim"> · {stamp(c.at)}</span>
              {c.note && <div className="cf-dim">{c.note}</div>}
            </div>
          ))}

          {p.rejected_reason && (
            <div className="cf-rejected">
              <strong>Rejected by {p.rejected_name}:</strong> {p.rejected_reason}
            </div>
          )}

          {p.state === "pending" && p.yours && !p.alreadyMine && (
            rejecting ? (
              <div className="cf-rejectbox">
                <input className="cf-in" value={reason} autoFocus
                       placeholder="Why — this is the part worth having"
                       onChange={(e) => setReason(e.target.value)} />
                <div className="cf-actions">
                  <button className="cf-btn" disabled={!reason.trim()}
                          onClick={() => { onReject(p, reason.trim()); setRejecting(false); }}>
                    Reject
                  </button>
                  <button className="cf-btn cf-btn--ghost" onClick={() => setRejecting(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <input className="cf-in" value={note} placeholder="Note (optional)"
                       onChange={(e) => setNote(e.target.value)} />
                <div className="cf-actions">
                  <button className="cf-btn" onClick={() => onConfirm(p, null, note.trim() || null)}>
                    Confirm
                  </button>
                  <button className="cf-btn cf-btn--ghost" onClick={() => setRejecting(true)}>
                    Reject
                  </button>
                  {p.outstanding.length > 1 && (
                    <span className="cf-dim">
                      Still needs {p.outstanding.filter((r) => r !== session?.role)
                        .map((r) => ROLE_THEME[r]?.label).join(" and ")} after you.
                    </span>
                  )}
                </div>
              </>
            )
          )}

          {p.state === "confirmed" && (
            <div className="cf-actions">
              <button className="cf-btn" onClick={() => onApply(p)}>
                {p.spec.tenant ? "Send it" : "Apply it"}
              </button>
              <span className="cf-dim">
                Confirming said the content is right. This is when it takes effect.
              </span>
            </div>
          )}

          {p.state === "applied" && (
            <div className="cf-appliedbox">
              Applied {stamp(p.applied_at)}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

/* ══════════════════ What each kind looks like ══════════════════ */

function Payload({ kind, payload }) {
  if (!payload) return null;

  if (kind === "bank_match") return (
    <>
      <div className="cf-rows">
        {(payload.matches ?? []).map((m, i) => (
          <div className="cf-row" key={i}>
            <span className={`cf-conf ${m.confidence}`}>{m.confidence}</span>
            <span className="cf-mono">{m.transaction_id}</span>
            <span>→ {m.record_type === "ar_receipt" ? "receipt" : "invoice"} {m.record_id}</span>
            <span className="cf-dim">{m.reason}</span>
          </div>
        ))}
      </div>
      {(payload.unmatched ?? []).length > 0 && (
        <div className="cf-unmatched">
          <strong>{payload.unmatched.length} it could not identify.</strong> Those stay
          for you — an unmatched line is a transaction nobody has accounted for, and a
          guess would be worse than the gap.
          {payload.unmatched.map((u, i) => (
            <div className="cf-dim" key={i}>{u.transaction_id}: {u.why}</div>
          ))}
        </div>
      )}
    </>
  );

  if (kind === "invoice_extract") return (
    <>
      <div className="cf-fields">
        <Field l="Vendor" v={payload.vendor_name} />
        <Field l="Invoice" v={payload.invoice_no} />
        <Field l="Date" v={payload.invoice_date} />
        <Field l="Subtotal" v={money(payload.subtotal)} />
        <Field l="GST" v={money(payload.gst)} />
        <Field l="Total" v={money(payload.total)} strong />
      </div>
      <div className="cf-rows">
        {(payload.lines ?? []).map((l, i) => (
          <div className="cf-row" key={i}>
            <span className="cf-mono cf-dim">{l.gl_code}</span>
            <span>{l.description}</span>
            <span className="cf-mono">{money(l.amount)}</span>
          </div>
        ))}
      </div>
      {payload.discrepancy && (
        <div className="cf-warn">
          <strong>Does not add up:</strong> {payload.discrepancy}. Usually a reading
          error, occasionally the vendor’s — either way check it against the invoice.
        </div>
      )}
      {(payload.unreadable ?? []).length > 0 && (
        <div className="cf-dim">
          Could not read: {payload.unreadable.join(", ")}
        </div>
      )}
    </>
  );

  if (kind === "ap_anomaly") return (
    <div className="cf-rows">
      {(payload.flags ?? []).map((f, i) => (
        <div className={`cf-flagrow ${f.severity}`} key={i}>
          <strong>{f.what}</strong>
          <span className="cf-dim">{f.why}</span>
          <span className="cf-check">Check: {f.check}</span>
        </div>
      ))}
      {(payload.flags ?? []).length === 0 && (
        <div className="cf-dim">Nothing stood out this time.</div>
      )}
    </div>
  );

  if (kind === "maintenance_triage") return (
    <>
      <div className="cf-fields">
        <Field l="Category" v={payload.category} />
        <Field l="Entry needed" v={payload.entry_required ? "Yes" : "No"} />
        <Field l="Suggested" v={(payload.suggested_vendors ?? []).join(", ")} />
      </div>
      {payload.safety_note && (
        <div className="cf-warn"><strong>Safety:</strong> {payload.safety_note}</div>
      )}
      {payload.repeat_issue && (
        <div className="cf-warn">
          <strong>Seen before:</strong> {payload.repeat_issue}. A third visit for the
          same thing is usually a different problem from the first two.
        </div>
      )}
      {payload.entry_required && (
        <div className="cf-dim">
          Somebody has to go inside, so this needs a notice of entry with 24 hours.
        </div>
      )}
      {payload.note && <p className="cf-summary">{payload.note}</p>}
    </>
  );

  if (kind === "quote_comparison") return (
    <>
      {payload.same_scope === false && (
        <div className="cf-warn">
          <strong>These are not quoting the same work.</strong> {payload.scope_note}{" "}
          Comparing prices for different scopes is worse than not comparing.
        </div>
      )}
      <div className="cf-quotes">
        {(payload.comparison ?? []).map((q, i) => (
          <div className="cf-quote" key={i}>
            <div className="cf-quote-h">
              <strong>{q.vendor}</strong>
              <span className="cf-mono cf-amt">{money(q.amount)}</span>
              <span className="cf-dim">{q.lead_time}</span>
            </div>
            <div className="cf-inc">
              <em>Includes</em>
              {(q.includes ?? []).map((x, j) => <span key={j}>{x}</span>)}
            </div>
            <div className="cf-exc">
              <em>Excludes</em>
              {(q.excludes ?? []).map((x, j) => <span key={j}>{x}</span>)}
            </div>
            <div className="cf-dim">
              Strong on {q.strong_on}. Weak on {q.weak_on}.
              {q.warranty && ` Warranty: ${q.warranty}.`}
            </div>
          </div>
        ))}
      </div>
      {(payload.watch_for ?? []).length > 0 && (
        <div className="cf-watch">
          <strong>Ask before deciding:</strong>
          <ul>{payload.watch_for.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      )}
    </>
  );

  if (kind === "nl_query") return (
    <>
      {/* The SQL is not optional. An answer without it is a number nobody
          can check, and text-to-SQL answers nearby questions convincingly. */}
      <div className="cf-sql">
        <div className="cf-sql-h">The query</div>
        <pre>{payload.sql}</pre>
      </div>
      <div className="cf-fields">
        <Field l="Counts" v={payload.explains} />
        <Field l="Does not count" v={payload.excludes} />
      </div>
      {(payload.assumptions ?? []).length > 0 && (
        <div className="cf-warn">
          <strong>Assumed:</strong> {payload.assumptions.join("; ")}
        </div>
      )}
      {payload.answerable === false && (
        <div className="cf-warn">
          This cannot be answered from the tables available. Nothing was run.
        </div>
      )}
      {payload.rows && (
        <div className="cf-rows">
          {payload.rows.slice(0, 10).map((row, i) => (
            <div className="cf-row" key={i}>
              {Object.entries(row).map(([k, v]) => (
                <span key={k}><em className="cf-dim">{k}</em> {String(v)}</span>
              ))}
            </div>
          ))}
        </div>
      )}
    </>
  );

  if (kind === "lease_abstract") return (
    <>
      <div className="cf-abstract">
        {Object.entries(payload.fields ?? {}).map(([k, f]) => (
          <div className={`cf-abrow ${f.confidence}`} key={k}>
            <span className="cf-dim">{k.replace(/_/g, " ")}</span>
            <strong>{Array.isArray(f.value) ? f.value.join(", ") : (f.value ?? "—")}</strong>
            <span className={`cf-conf ${f.confidence}`}>{f.confidence}</span>
          </div>
        ))}
      </div>
      {(payload.unusual ?? []).length > 0 && (
        <div className="cf-warn">
          <strong>Unusual for an Alberta tenancy:</strong>
          <ul>{payload.unusual.map((u, i) => <li key={i}>{u}</li>)}</ul>
        </div>
      )}
      <div className="cf-dim">
        This is an index of the signed file, not a replacement for it. Check anything
        marked low against the document.
      </div>
    </>
  );

  if (kind === "turnover_estimate") return (
    <>
      <div className="cf-fields">
        <Field l="Cost" v={`${money(payload.cost_low)} – ${money(payload.cost_high)}`} strong />
        <Field l="Days" v={`${payload.days_low} – ${payload.days_high}`} strong />
        <Field l="Based on" v={`${payload.based_on} past turnovers`} />
      </div>
      {payload.sample_adequate === false && (
        <div className="cf-warn">
          Only {payload.based_on} past turnovers to go on. That is a small sample and
          the range is wider in reality than it looks here.
        </div>
      )}
      {(payload.outside_usual ?? []).length > 0 && (
        <div className="cf-warn">
          <strong>Outside a usual turnover:</strong> {payload.outside_usual.join("; ")}.
          This is the part that makes an estimate wrong.
        </div>
      )}
      {payload.note && <p className="cf-summary">{payload.note}</p>}
    </>
  );

  if (kind === "arrears_sequence") return (
    <>
      <div className="cf-fields">
        <Field l="Stage" v={payload.stage} />
        <Field l="Subject" v={payload.subject} />
      </div>
      <div className="cf-message">{payload.body}</div>
      {payload.note_for_staff && (
        <div className="cf-dim">{payload.note_for_staff}</div>
      )}
      <div className="cf-dim">
        Read it as the tenant will. Collections only — nothing here mentions ending a
        tenancy, and it should not.
      </div>
    </>
  );

  if (kind === "csv_mapping") return (
    <div className="cf-fields">
      <Field l="Header row" v={payload.has_header ? "Yes" : "No"} />
      <Field l="Date format" v={payload.date_format} />
      <Field l="Date" v={`column ${payload.date_col}`} />
      <Field l="Description" v={`column ${payload.description_col}`} />
      <Field l="Out / In" v={payload.single_amount_col != null
        ? `one signed column ${payload.single_amount_col}`
        : `${payload.debit_col} / ${payload.credit_col}`} />
      {payload.date_format_certain === false && (
        <div className="cf-warn">
          The date format is ambiguous — 03/04 could be either. Getting it backwards
          puts every transaction in the wrong month. Check one row against the
          statement.
        </div>
      )}
    </div>
  );

  if (typeof payload === "string" || payload.text) return (
    <div className="cf-message">{payload.text ?? payload}</div>
  );

  return <pre className="cf-raw">{JSON.stringify(payload, null, 2)}</pre>;
}

function Field({ l, v, strong }) {
  return (
    <div className="cf-field">
      <em>{l}</em>
      <span className={strong ? "cf-strongv" : ""}>{v ?? "—"}</span>
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&family=Archivo:wght@700;800&display=swap');
.cf{--paper:#fff;--ink2:#3E4C5A;--dim:#78899A;--ground:#EDF0F3;--rule:#D3DBE1;
  --red:#B23A54;--green:#0E8577;--amber:#FFF6E0;--amberline:#E8C877;
  background:var(--ground);color:var(--ink,#131C25);min-height:100vh;font-size:14px;
  line-height:1.55;font-family:'IBM Plex Sans',system-ui,sans-serif;padding-bottom:44px}
.cf *{box-sizing:border-box}
.cf-mono{font-family:'IBM Plex Mono',monospace;font-variant-numeric:tabular-nums}
.cf-dim{color:var(--dim);font-size:12.5px}
.cf-bad{color:var(--red)}
.cf-load{padding:80px 20px;text-align:center;color:var(--dim)}

.cf-head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;
  padding:22px 26px 16px;background:var(--paper);border-bottom:1px solid var(--rule)}
.cf-eyebrow{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.13em;
  text-transform:uppercase;color:var(--dim)}
.cf-head h1{font-family:'Archivo',sans-serif;font-weight:800;font-size:23px;
  letter-spacing:-.02em;margin:4px 0 0;color:var(--brand)}
.cf-flash{font-size:12.5px;color:var(--green);background:#F5FAF8;border:1px solid var(--green);
  border-radius:3px;padding:6px 11px}
.cf-tabs{display:flex;padding:0 26px;background:var(--paper);border-bottom:1px solid var(--rule);
  overflow-x:auto}
.cf-tabs button{font:inherit;font-weight:600;font-size:13.5px;cursor:pointer;background:none;
  border:0;padding:12px 16px;color:var(--dim);border-bottom:2px solid transparent;
  margin-bottom:-1px;display:flex;align-items:center;gap:6px;white-space:nowrap}
.cf-tabs button.on{color:var(--brand);border-bottom-color:var(--brand)}
.cf-tabs i{font-style:normal;font-family:'IBM Plex Mono',monospace;font-size:10px;
  background:var(--dim);color:#fff;border-radius:8px;padding:1px 6px}
.cf-tabs i.hot{background:var(--red)}

.cf-body{padding:18px 26px;max-width:1080px;display:flex;flex-direction:column;gap:14px}
.cf-note{color:var(--dim);font-size:12.5px;margin:0;line-height:1.7;max-width:74ch}
.cf-alert{background:var(--amber);border:1px solid var(--amberline);border-radius:4px;
  padding:11px 14px;font-size:12.5px;color:#6B5410;line-height:1.7}
.cf-alert span{color:var(--ink2)}
.cf-empty{color:var(--dim);font-size:12.5px;padding:34px 0;text-align:center;
  border:1px dashed var(--rule);border-radius:3px;background:var(--paper)}

.cf-list{display:flex;flex-direction:column;gap:10px}
.cf-card{background:var(--paper);border:1px solid var(--rule);border-radius:4px;
  display:flex;flex-direction:column;gap:7px;padding:0 0 2px}
.cf-card.tenant{border-left:3px solid var(--amberline)}
.cf-card.money{border-left:3px solid var(--brand)}
.cf-card.done{opacity:.72}
.cf-cardh{font:inherit;text-align:left;cursor:pointer;background:none;border:0;width:100%;
  display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding:12px 15px 4px;
  font-size:13.5px;color:inherit}
.cf-cardh strong{font-size:14px}
.cf-tag{font-size:10.5px;font-weight:700;color:#fff;background:var(--c);border-radius:9px;
  padding:1px 9px;white-space:nowrap}
.cf-area{font-size:10.5px;color:var(--dim);border:1px solid var(--rule);border-radius:9px;
  padding:1px 8px}
.cf-flag{font-size:10px;font-weight:700;color:#6B5410;background:var(--amber);
  border-radius:8px;padding:1px 8px}
.cf-flag--money{color:var(--brand);background:var(--brand-tint,#EEF2F7)}
.cf-amt{font-weight:600}
.cf-chev{margin-left:auto;color:var(--dim);font-size:16px}
.cf-summary{margin:0 15px;font-size:12.5px;color:var(--ink2);line-height:1.7}

.cf-signoff{display:flex;gap:8px;flex-wrap:wrap;padding:0 15px 4px}
.cf-sig{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dim);
  border:1px solid var(--rule);border-radius:11px;padding:2px 10px}
.cf-sig.on{color:var(--ink2);border-color:var(--rule)}
.cf-sig i{width:7px;height:7px;border-radius:50%;background:var(--rule)}
.cf-sig em{font-style:normal;color:var(--dim)}

.cf-detail{padding:4px 15px 13px;display:flex;flex-direction:column;gap:10px;
  border-top:1px solid var(--rule);margin-top:4px}
.cf-fields{display:flex;gap:20px;flex-wrap:wrap}
.cf-field{display:flex;flex-direction:column;gap:1px}
.cf-field em{font-style:normal;font-size:10px;color:var(--dim);text-transform:uppercase;
  letter-spacing:.05em;font-family:'IBM Plex Mono',monospace}
.cf-field span{font-size:13px}
.cf-strongv{font-family:'IBM Plex Mono',monospace;font-size:16px;font-weight:600}

.cf-rows{display:flex;flex-direction:column;gap:1px;background:var(--rule);
  border:1px solid var(--rule);border-radius:3px;overflow:hidden}
.cf-row{background:var(--paper);padding:7px 11px;display:flex;gap:11px;flex-wrap:wrap;
  font-size:12.5px;align-items:baseline}
.cf-conf{font-size:10px;font-weight:700;border-radius:8px;padding:1px 7px;color:#fff}
.cf-conf.high{background:var(--green)}
.cf-conf.medium{background:#C98A15}
.cf-conf.low,.cf-conf.unverified{background:var(--red)}
.cf-unmatched{background:var(--amber);border:1px solid var(--amberline);border-radius:3px;
  padding:9px 12px;font-size:12.5px;color:#6B5410;line-height:1.7}
.cf-flagrow{background:var(--paper);padding:9px 12px;display:flex;flex-direction:column;gap:3px;
  font-size:12.5px}
.cf-flagrow.high{border-left:3px solid var(--red)}
.cf-flagrow.medium{border-left:3px solid var(--amberline)}
.cf-check{color:var(--brand);font-size:12px}

.cf-quotes{display:flex;flex-direction:column;gap:9px}
.cf-quote{border:1px solid var(--rule);border-radius:3px;padding:10px 13px;
  display:flex;flex-direction:column;gap:5px}
.cf-quote-h{display:flex;gap:11px;align-items:baseline;flex-wrap:wrap}
.cf-inc,.cf-exc{display:flex;gap:5px;flex-wrap:wrap;align-items:center;font-size:11.5px}
.cf-inc em,.cf-exc em{font-style:normal;font-size:10px;text-transform:uppercase;
  letter-spacing:.05em;font-family:'IBM Plex Mono',monospace;color:var(--dim);
  min-width:56px}
.cf-inc span{border:1px solid var(--green);color:var(--green);border-radius:9px;padding:1px 8px}
.cf-exc span{border:1px solid var(--red);color:var(--red);border-radius:9px;padding:1px 8px}
.cf-watch{font-size:12.5px;color:var(--ink2)}
.cf-watch ul{margin:4px 0 0;padding-left:18px;line-height:1.7}

.cf-sql{border:1px solid var(--brand);border-radius:3px;overflow:hidden}
.cf-sql-h{background:var(--brand-tint,#EEF2F7);font-size:10.5px;letter-spacing:.06em;
  text-transform:uppercase;color:var(--dim);font-family:'IBM Plex Mono',monospace;
  padding:6px 11px}
.cf-sql pre{font-family:'IBM Plex Mono',monospace;font-size:11.5px;line-height:1.75;
  margin:0;padding:11px;white-space:pre-wrap;background:#FBFCFD;color:var(--ink2)}

.cf-abstract{display:flex;flex-direction:column;gap:1px;background:var(--rule);
  border:1px solid var(--rule);border-radius:3px;overflow:hidden}
.cf-abrow{display:grid;grid-template-columns:150px 1fr 70px;gap:10px;padding:6px 11px;
  background:var(--paper);font-size:12.5px;align-items:center}
.cf-abrow.low{background:#FFFDF8}
.cf-abrow>span:last-child{text-align:right}

.cf-message{background:#FBFCFD;border:1px solid var(--rule);border-radius:3px;
  padding:12px 14px;font-size:13px;line-height:1.8;white-space:pre-wrap;color:var(--ink2)}
.cf-why{font-size:12px;color:var(--dim);line-height:1.7;border-left:2px solid var(--rule);
  padding-left:11px}
.cf-lowconf{font-size:12.5px;color:#6B5410;background:var(--amber);border-radius:3px;
  padding:8px 11px}
.cf-warn{font-size:12.5px;color:#6B5410;background:var(--amber);border:1px solid var(--amberline);
  border-radius:3px;padding:9px 12px;line-height:1.7}
.cf-warn ul{margin:4px 0 0;padding-left:18px}
.cf-given{font-size:12.5px;color:var(--ink2);background:#F7F9FB;border-radius:3px;
  padding:7px 11px}
.cf-edited{color:#6B5410;font-weight:600}
.cf-rejected{font-size:12.5px;color:var(--red);background:#FDF6F7;border-radius:3px;
  padding:8px 11px}
.cf-appliedbox{font-size:12.5px;color:var(--green);background:#F5FAF8;border-radius:3px;
  padding:8px 11px}
.cf-method{font-size:12.5px}
.cf-method summary{cursor:pointer;color:var(--brand);padding:4px 0}
.cf-method pre{font-family:'IBM Plex Mono',monospace;font-size:11px;line-height:1.8;
  background:#F7F9FB;border:1px solid var(--rule);border-radius:3px;padding:10px 12px;
  margin:5px 0 0;white-space:pre-wrap;color:var(--ink2)}
.cf-raw{font-family:'IBM Plex Mono',monospace;font-size:11px;background:#F7F9FB;
  border:1px solid var(--rule);border-radius:3px;padding:10px 12px;white-space:pre-wrap}

.cf-in{font:inherit;font-size:13px;padding:7px 10px;border:1px solid var(--rule);
  border-radius:3px;background:var(--paper);width:100%}
.cf-in:focus{outline:2px solid var(--brand);outline-offset:1px}
.cf-rejectbox{display:flex;flex-direction:column;gap:8px}
.cf-btn{font:inherit;font-weight:600;font-size:13px;cursor:pointer;background:var(--brand);
  color:#fff;border:1px solid var(--brand);padding:8px 15px;border-radius:3px}
.cf-btn:disabled{opacity:.4;cursor:not-allowed}
.cf-btn--ghost{background:transparent;color:var(--ink2);border-color:var(--rule)}
.cf-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}

@media (max-width:760px){
  .cf-head,.cf-tabs,.cf-body{padding-left:16px;padding-right:16px}
  .cf-abrow{grid-template-columns:1fr}
}
`;
