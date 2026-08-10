import React, { useState, useEffect, useMemo, useCallback } from "react";

/* ============================================================
   BAYDO POINTE — Portfolio

   Four things that lose money quietly, because no single screen
   owned any of them:

     Renewals    a lease running out is the cheapest tenant there is
     Turnover    the gap between vacant and re-let is pure loss
     Pricing     twelve showings and no applications is a message
     Owner       what the property earned, and what can be taken out

   None of these are urgent on any given day, which is exactly why
   they get missed.
   ============================================================ */

const money = (n) => (n == null || isNaN(n) ? "—"
  : new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(n));
const money0 = (n) => (n == null || isNaN(n) ? "—"
  : new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD",
                                     maximumFractionDigits: 0 }).format(n));
const cents = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const nowISO = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);
const days = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);

/* Alberta requires 365 days between one rent increase and the next. This is a
   named constant because it is a legal figure, not a preference — confirm it
   with your manager before relying on it. */
const INCREASE_INTERVAL_DAYS = 365;
const RENEWAL_LEAD_DAYS = 90;
const NOTICE_DAYS = { fixed: 60, periodic: 90 };

const TURNOVER_TASKS = ["Inspection", "Clean", "Paint touch-up", "Repairs",
                        "Locks rekeyed", "Photographs", "Listed"];

export default function Portfolio() {
  const [session, setSession] = useState(undefined);
  const [tab, setTab] = useState("renewals");
  const [leases, setLeases] = useState([]);
  const [turnovers, setTurnovers] = useState([]);
  const [outcomes, setOutcomes] = useState([]);
  const [pricing, setPricing] = useState(null);
  const [statements, setStatements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    (async () => {
      const read = async (k, d) => {
        try { const r = await window.storage.get(k); return r?.value ? JSON.parse(r.value) : d; }
        catch { return d; }
      };
      setSession(await read("baydo:session", null));
      setLeases(await read("baydo:leases", []));
      setTurnovers(await read("baydo:turnovers", []));
      setOutcomes(await read("baydo:showoutcomes", []));
      setPricing(await read("baydo:pricing", null));
      setStatements(await read("acct:ownerstatements", []));
      setLoading(false);
    })();
  }, []);

  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(""), 3500); };
  const save = useCallback(async (key, value, setter) => {
    setter(value);
    try { await window.storage.set(key, JSON.stringify(value)); } catch {}
  }, []);

  const canDecide = ["admin", "property_manager"].includes(session?.role);
  const canEdit = ["admin", "property_manager", "building_manager"].includes(session?.role);

  if (loading || session === undefined)
    return <div className="pf"><style>{CSS}</style><div className="pf-load">Loading…</div></div>;

  const TABS = [["renewals", "Renewals"], ["increases", "Rent increases"],
                ["turnover", "Turnover"],
                ["pricing", "Pricing signals"], ["owner", "Owner"]];

  return (
    <div className="pf">
      <style>{CSS}</style>
      <header className="pf-head">
        <div>
          <div className="pf-eyebrow">Baydo Pointe · Portfolio</div>
          <h1>{TABS.find((t) => t[0] === tab)?.[1]}</h1>
        </div>
        {msg && <span className="pf-flash">{msg}</span>}
      </header>

      <nav className="pf-tabs">
        {TABS.map(([k, l]) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>
        ))}
      </nav>

      {tab === "renewals" && (
        <Renewals leases={leases} canDecide={canDecide} session={session}
          onSave={(v) => save("baydo:leases", v, setLeases)} flash={flash} />
      )}
      {tab === "increases" && (
        <RentIncreases canDecide={canDecide} session={session} flash={flash} />
      )}
      {tab === "increases" && <RentIncreases canDecide={canDecide} flash={flash} />}
      {tab === "turnover" && (
        <Turnover turnovers={turnovers} pricing={pricing} canEdit={canEdit}
          onSave={(v) => save("baydo:turnovers", v, setTurnovers)} flash={flash} />
      )}
      {tab === "pricing" && (
        <PricingSignals outcomes={outcomes} turnovers={turnovers} pricing={pricing} />
      )}
      {tab === "owner" && <OwnerStatements statements={statements} />}
    </div>
  );
}

/* ══════════════════ Renewals ══════════════════ */

/** A lease running out is the cheapest tenant there is. Finding a new one
 *  costs a vacancy, a turnover and the leasing work; keeping this one costs a
 *  conversation eight weeks early. */
function Renewals({ leases, canDecide, session, onSave, flash }) {
  const [deciding, setDeciding] = useState(null);

  const rows = useMemo(() => {
    const horizon = new Date(Date.now() + RENEWAL_LEAD_DAYS * 864e5).toISOString().slice(0, 10);
    return leases
      .filter((l) => l.status === "active" && l.end_date && l.end_date <= horizon)
      .map((l) => {
        const left = days(today(), l.end_date);
        const notice = NOTICE_DAYS[l.term_type === "periodic" ? "periodic" : "fixed"];
        const sinceIncrease = l.last_increase ? days(l.last_increase, today()) : null;
        // Alberta requires 365 days between increases. An increase inside that
        // window does not just get refused later — it can invalidate the notice.
        const canRaise = sinceIncrease == null || sinceIncrease >= INCREASE_INTERVAL_DAYS;
        return { ...l, days_left: left,
          notice_due_in: left - notice,
          can_raise: canRaise, days_since_increase: sinceIncrease,
          urgency: left <= 30 ? "urgent" : left <= 60 ? "soon" : "planned" };
      })
      .sort((a, b) => a.days_left - b.days_left);
  }, [leases]);

  const undecided = rows.filter((r) => !r.renewal_decision);
  const urgent = undecided.filter((r) => r.urgency === "urgent");

  return (
    <div className="pf-body">
      <div className="pf-stats">
        <Stat l="Terms ending" v={rows.filter((r) => !r.periodic).length} />
        <Stat l="Rent review due" v={rows.filter((r) => r.periodic).length}
              sub="month to month, over a year at the same rent" />
        <Stat l="No decision yet" v={undecided.length}
              tone={undecided.length > 0 ? "warn" : null} />
        <Stat l="Under 30 days" v={urgent.length} tone={urgent.length > 0 ? "bad" : null} />
      </div>

      {rows.some((r) => r.periodic) && (
        <p className="pf-note">
          A month-to-month tenancy has no expiry, so it appears on no list of its
          own accord — which is how a suite ends up three years in at the rent it
          started on. Nobody decided that; there was never a moment that raised the
          question. These are here once a review is possible again.
        </p>
      )}

      {urgent.length > 0 && (
        <div className="pf-alert">
          <strong>{urgent.length} lease{urgent.length === 1 ? "" : "s"} ending within a month
          with no decision.</strong>
          <span>
            {" "}Notice periods run from when the notice reaches the tenant, not from
            when it was decided. Past that point the decision makes itself.
          </span>
        </div>
      )}

      <p className="pf-note">
        A renewal costs a conversation. A turnover costs a vacancy, cleaning,
        painting and the leasing work — usually more than a month of the rent
        being argued about.
      </p>

      {rows.length === 0 ? (
        <div className="pf-empty">Nothing ending in the next 90 days.</div>
      ) : (
        <div className="pf-list">
          {rows.map((r) => (
            <div className={`pf-item ${r.urgency}`} key={r.id}>
              <div className="pf-item-h">
                {r.periodic ? (
                  <span className="pf-tag pf-tag--review">
                    {r.months_at_this_rent != null
                      ? `${r.months_at_this_rent} months at this rent`
                      : "rent review"}
                  </span>
                ) : (
                  <span className={`pf-tag pf-tag--${r.urgency}`}>
                    {r.days_left} days
                  </span>
                )}
                <strong className="pf-mono">{r.unit_number}</strong>
                <span>{r.tenant_name}</span>
                <span className="pf-dim">
                  {r.periodic
                    ? "Month to month · no end date"
                    : `Fixed term · ends ${r.end_date}`}
                </span>
                {r.renewal_decision && (
                  <span className="pf-tag pf-tag--done">{r.renewal_decision}</span>
                )}
              </div>

              <div className="pf-figs">
                <div><em>Current rent</em><strong>{money(r.rent)}</strong></div>
                {r.renewal_rent && (
                  <div><em>Proposed</em><strong>{money(r.renewal_rent)}</strong></div>
                )}
                {r.periodic ? (
                  /* No date to work back from. The notice period still
                     applies, but it runs from whenever notice is given rather
                     than from an expiry, so there is nothing to be late for. */
                  <div><em>Notice</em>
                    <strong className="pf-dim">
                      {r.notice_days} days from whenever it is given
                    </strong>
                  </div>
                ) : (
                  <div><em>Notice due</em>
                    <strong className={r.notice_due_in <= 0 ? "pf-bad" : ""}>
                      {r.notice_due_in <= 0 ? "overdue" : `${r.notice_due_in} days`}
                    </strong>
                  </div>
                )}
              </div>

              {!r.can_raise && (
                <div className="pf-block">
                  Rent cannot be raised yet — {r.days_since_increase} days since the last
                  increase and Alberta requires {INCREASE_INTERVAL_DAYS}. A notice inside
                  that window can be invalid, not merely refused.
                </div>
              )}

              {r.offer_id && (
                <OfferProgress lease={r}
                  onSend={async (id) => {
                    await fetch(`/api/renewals/offers/${id}/send`,
                      { method: "POST", credentials: "include" });
                    flash("Sent. They have until the expiry date to answer.");
                  }}
                  onPrepare={() => flash("Prepare it from Agreements — the field placement needs checking against the document.")} />
              )}

              {canDecide && !r.offer_id && (
                deciding === r.id ? (
                  <DecideRenewal lease={r} onCancel={() => setDeciding(null)}
                    onSave={(patch) => {
                      onSave(leases.map((l) => l.id === r.id ? { ...l, ...patch } : l));
                      setDeciding(null);
                      flash("Drafted. Read it over, then send it before the notice date.");
                    }} />
                ) : (
                  <div className="pf-actions">
                    <button className="pf-btn" onClick={() => setDeciding(r.id)}>
                      Decide
                    </button>
                  </div>
                )
              )}

              {r.renewal_decision && !r.renewal_sent_at && canDecide && (
                <div className="pf-actions">
                  <button className="pf-btn pf-btn--sm"
                          onClick={() => { onSave(leases.map((l) => l.id === r.id
                            ? { ...l, renewal_sent_at: nowISO() } : l));
                            flash("Queued to the tenant, in both languages."); }}>
                    Send it to the tenant
                  </button>
                  <span className="pf-dim">Decided {stampShort(r.renewal_decided_at)}</span>
                </div>
              )}
              {r.renewal_sent_at && (
                <div className="pf-dim">Sent {stampShort(r.renewal_sent_at)}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Setting the terms.
 *
 * Terms first, then the offer. "Will you be staying?" with no rent attached
 * is a question nobody can answer, and asking it that way spends the one
 * round of correspondence that might have settled the whole thing.
 *
 * Month to month and a new fixed term are different paperwork. A
 * continuation usually runs on under the existing agreement with nothing
 * signed; a new term is a new agreement. Which applies depends on what the
 * original lease says, so it is a choice here rather than an assumption.
 */
function DecideRenewal({ lease, onCancel, onSave }) {
  const [outcome, setOutcome] = useState("fixed_term");
  const [rent, setRent] = useState(String(lease.rent ?? ""));
  const [months, setMonths] = useState(12);
  const [requiresSig, setRequiresSig] = useState(true);
  const [message, setMessage] = useState("");
  const [internal, setInternal] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const proposed = cents(Number(rent) || 0);
  const change = cents(proposed - lease.rent);
  const pct = lease.rent ? (change / lease.rent) * 100 : 0;
  const raising = change > 0;

  // A continuation is usually not signed. Flipping this with the outcome
  // rather than leaving it stale, because the common case should not need
  // anybody to remember.
  const setOutcomeAndSig = (v) => {
    setOutcome(v);
    setRequiresSig(v === "fixed_term");
  };

  const submit = async () => {
    setErr(""); setBusy(true);
    try {
      const res = await fetch(`/api/renewals/${lease.id}/offer`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ outcome,
          offered_rent: outcome === "not_renewing" ? null : proposed,
          term_months: outcome === "fixed_term" ? Number(months) : null,
          requires_signature: outcome === "not_renewing" ? false : requiresSig,
          message: message.trim() || null,
          internal_note: internal.trim() || null }),
      });
      const d = await res.json();
      if (!res.ok) {
        setErr(d.code === "INCREASE_TOO_SOON"
          ? `${d.detail} The earliest is ${d.earliest}.`
          : d.detail ?? "Could not draft the offer.");
        setBusy(false); return;
      }
      onSave({ offer_id: d.offer?.id, outcome, offered_rent: proposed,
               offer_state: "draft" });
    } catch {
      setErr("Could not reach the server.");
    }
    setBusy(false);
  };

  return (
    <div className="pf-panel">
      <div className="pf-opts">
        {[["fixed_term", "New fixed term"],
          ["month_to_month", "Continue month to month"],
          ["not_renewing", "Not renewing"]].map(([k, l]) => (
          <button key={k} className={outcome === k ? "on" : ""}
                  onClick={() => setOutcomeAndSig(k)}>{l}</button>
        ))}
      </div>

      {outcome !== "not_renewing" && (
        <>
          <div className="pf-row">
            <label className="pf-f"><span>Rent from {lease.end_date}</span>
              <input className="pf-in" type="number" step="0.01" value={rent}
                     onChange={(e) => setRent(e.target.value)} /></label>
            {outcome === "fixed_term" && (
              <label className="pf-f"><span>Term</span>
                <select className="pf-in" value={months}
                        onChange={(e) => setMonths(e.target.value)}>
                  {[6, 12, 18, 24].map((m) => (
                    <option key={m} value={m}>{m} months</option>
                  ))}
                </select></label>
            )}
            <div className="pf-change">
              {change === 0 ? <span className="pf-dim">No change</span> : (
                <>
                  <em>{change > 0 ? "Increase" : "Decrease"}</em>
                  <strong className={change > 0 ? "pf-up" : "pf-down"}>
                    {change > 0 ? "+" : ""}{money(change)} ({pct.toFixed(1)}%)
                  </strong>
                </>
              )}
            </div>
          </div>

          {raising && !lease.increase_permitted && (
            <div className="pf-block">
              {lease.increase_blocked_reason}
              {" "}This will be refused rather than warned about — a notice served
              inside the window can be invalid, and then the renewal starts again
              with less time than it had.
            </div>
          )}

          {raising && pct > 5 && lease.increase_permitted && (
            <div className="pf-warn">
              {pct.toFixed(1)}% is a large increase. It is legal with proper notice,
              and it is also the most common reason a tenant who would have stayed
              does not — a turnover usually costs more than the difference being
              argued about.
            </div>
          )}

          <label className="pf-check">
            <input type="checkbox" checked={requiresSig}
                   onChange={(e) => setRequiresSig(e.target.checked)} />
            <span>
              A new agreement has to be signed
              <em>
                {" "}— a new fixed term does. A month-to-month continuation usually
                runs on under the existing agreement, but check what that agreement
                actually says before relying on it.
              </em>
            </span>
          </label>
        </>
      )}

      <label className="pf-f">
        <span>Note to the tenant <em>appears in the email and on the page</em></span>
        <textarea className="pf-in" rows={2} value={message}
                  onChange={(e) => setMessage(e.target.value)} /></label>

      <label className="pf-f">
        <span>Internal note <em>they never see this</em></span>
        <input className="pf-in" value={internal}
               onChange={(e) => setInternal(e.target.value)} /></label>

      {err && <div className="pf-err">{err}</div>}

      <div className="pf-actions">
        <button className="pf-btn" disabled={busy || (raising && !lease.increase_permitted)}
                onClick={submit}>
          {busy ? "Drafting…" : "Draft the offer"}
        </button>
        <button className="pf-btn pf-btn--ghost" onClick={onCancel}>Cancel</button>
        <span className="pf-dim">Nothing reaches the tenant until you send it.</span>
      </div>
    </div>
  );
}

/** Where an offer has got to, once it has gone out. */
function OfferProgress({ lease, onSend, onPrepare }) {
  const stages = [
    ["draft", "Drafted"], ["sent", "Sent"], ["viewed", "Opened"],
    ["accepted", "Accepted"], ["signing", "Signing"], ["completed", "Done"],
  ];
  const at = stages.findIndex(([k]) => k === lease.offer_state);
  const declined = lease.offer_state === "declined";

  return (
    <>
      {declined ? (
        <div className="pf-declined">
          <strong>They are not renewing.</strong>
          {lease.response_note && <p>“{lease.response_note}”</p>}
          <span>
            If that is about price, a repair, or something fixable, it is usually
            still worth a call — this is less final than the button made it sound.
          </span>
        </div>
      ) : (
        <div className="pf-track">
          {stages.map(([k, label], i) => (
            <div className={`pf-step ${i <= at ? "on" : ""}`} key={k}>
              <span /><em>{label}</em>
            </div>
          ))}
        </div>
      )}

      <div className="pf-actions">
        {lease.offer_state === "draft" && (
          <button className="pf-btn pf-btn--sm" onClick={() => onSend(lease.offer_id)}>
            Send it to the tenant
          </button>
        )}
        {lease.offer_state === "signing" && (
          <button className="pf-btn pf-btn--sm" onClick={() => onPrepare(lease.offer_id)}>
            Prepare the agreement to sign
          </button>
        )}
        {["sent", "viewed"].includes(lease.offer_state) && (
          <span className="pf-dim">
            Waiting on them. The notice date is {lease.notice_due_by} — past that,
            the decision makes itself.
          </span>
        )}
      </div>
    </>
  );
}


/* ══════════════════ Rent increases ══════════════════ */

/**
 * Three steps, each by a person: draft, confirm, serve.
 *
 * Split because they are different acts. Drafting is arithmetic. Confirming
 * is the decision. Serving starts a legal clock, and none of those should be
 * the same click.
 */
function RentIncreases({ canDecide, session, flash }) {
  const [data, setData] = useState(null);
  const [live, setLive] = useState([]);
  const [drafting, setDrafting] = useState(null);

  const load = async () => {
    try {
      const [e, l] = await Promise.all([
        fetch("/api/increases/eligible", { credentials: "include" }).then((r) => r.json()),
        fetch("/api/increases", { credentials: "include" }).then((r) => r.json()),
      ]);
      setData(e); setLive(l.increases ?? []);
    } catch { setData(false); }
  };
  useEffect(() => { load(); }, []);

  if (data === null) return <div className="pf-body"><p>Loading…</p></div>;
  if (data === false) return <div className="pf-body"><p>Could not load this.</p></div>;

  const inProgress = live.filter((x) =>
    ["draft", "confirmed", "served"].includes(x.state));

  return (
    <div className="pf-body">
      <div className="pf-stats">
        <Stat l="Can be increased" v={data.eligible?.length ?? 0} />
        <Stat l="In progress" v={inProgress.length}
              tone={inProgress.some((x) => x.state === "confirmed") ? "warn" : null} />
        <Stat l="Cannot yet" v={data.blocked?.length ?? 0} />
      </div>

      {/* Said plainly because it changes what the screen is for. Alberta puts
          no ceiling on the amount, so nothing here refuses a figure for being
          large — the constraint is whether they stay, and that is a judgement
          rather than a rule. */}
      <p className="pf-note">
        Alberta has no rent control, so there is no cap on the amount. What the
        legislation controls is timing and service — {data.rules?.interval_days} days
        since the last increase, {data.rules?.notice_months} months notice, in
        writing, served properly. A notice fails on those far more often than on
        the number. Confirm all of them with your lawyer before the first one.
      </p>

      {inProgress.length > 0 && (
        <section className="pf-card">
          <h3>In progress</h3>
          {inProgress.map((x) => (
            <div className={`pf-inc ${x.state}`} key={x.id}>
              <div className="pf-inc-h">
                <span className={`pf-tag pf-tag--${
                  x.state === "served" ? "done" : x.state === "confirmed" ? "soon" : "planned"
                }`}>{x.state}</span>
                <strong className="pf-mono">{x.unit_number}</strong>
                <span className="pf-mono">
                  {money(x.current_rent)} → {money(x.new_rent)}
                </span>
                <span className="pf-dim">
                  {Number(x.percent_change).toFixed(1)}% · from {x.effective_on}
                </span>
              </div>

              {x.state === "served" && (
                <div className="pf-dim">
                  Deemed received {x.deemed_served_on}. The rent changes on its own
                  on {x.effective_on} — nothing else to do.
                </div>
              )}

              {canDecide && x.state === "draft" && (
                <ConfirmStep increase={x} onDone={() => { load(); flash("Confirmed."); }} />
              )}
              {canDecide && x.state === "confirmed" && (
                <div className="pf-actions">
                  <button className="pf-btn pf-btn--sm"
                          onClick={async () => {
                            const res = await fetch(`/api/increases/${x.id}/serve`, {
                              method: "POST", credentials: "include",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({}) });
                            const d = await res.json();
                            flash(res.ok
                              ? `Served. The rent changes on ${d.effective_on}.`
                              : d.detail ?? "Could not serve it.");
                            load();
                          }}>
                    Serve the notice
                  </button>
                  <span className="pf-dim">
                    This starts the notice period. Attach the approved notice from
                    Agreements first — a notice with the wrong wording fails whatever
                    the figures say.
                  </span>
                </div>
              )}
            </div>
          ))}
        </section>
      )}

      <section className="pf-card">
        <h3>Can be increased <span className="pf-n">{data.eligible?.length ?? 0}</span></h3>
        {(data.eligible ?? []).length === 0 ? (
          <div className="pf-empty">None right now.</div>
        ) : data.eligible.map((l) => (
          <div className="pf-inc" key={l.id}>
            <div className="pf-inc-h">
              <strong className="pf-mono">{l.unit_number}</strong>
              <span>{l.tenant_name}</span>
              <span className="pf-mono">{money(l.rent)}</span>
              <span className="pf-dim">
                {l.months_at_this_rent != null
                  ? `${l.months_at_this_rent} months at this rent`
                  : "never increased"}
              </span>
              {l.below_market > 0 && (
                <span className="pf-below">
                  {money(l.below_market)} under the current list rent
                </span>
              )}
            </div>
            {canDecide && (
              drafting === l.id
                ? <DraftIncrease lease={l} onCancel={() => setDrafting(null)}
                    onDone={() => { setDrafting(null); load();
                                    flash("Drafted. Confirm it when the dates look right."); }} />
                : <div className="pf-actions">
                    <button className="pf-btn pf-btn--sm"
                            onClick={() => setDrafting(l.id)}>Work out an increase</button>
                    <span className="pf-dim">
                      Earliest it could take effect: {l.earliest_effective}
                    </span>
                  </div>
            )}
          </div>
        ))}
      </section>

      {(data.blocked ?? []).length > 0 && (
        <section className="pf-card">
          <h3>Cannot yet <span className="pf-n">{data.blocked.length}</span></h3>
          <p className="pf-note">
            The reason matters more than the count. A fixed term is not a waiting
            problem — it is handled at renewal, as a new agreement.
          </p>
          {data.blocked.map((l) => (
            <div className="pf-blocked" key={l.id}>
              <strong className="pf-mono">{l.unit_number}</strong>
              <div>
                <div>{l.blocked.why}</div>
                <div className="pf-dim">{l.blocked.fix}</div>
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

function DraftIncrease({ lease, onCancel, onDone }) {
  const [rent, setRent] = useState(String(lease.rent ?? ""));
  const [method, setMethod] = useState("email");
  const [calc, setCalc] = useState(null);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const calculate = async () => {
    setErr(""); setBusy(true);
    try {
      const res = await fetch("/api/increases/calculate", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lease_id: lease.id, new_rent: Number(rent), method }),
      });
      const d = await res.json();
      if (!res.ok) { setErr(d.detail ?? "Could not work it out."); setBusy(false); return; }
      setCalc(d);
    } catch { setErr("Could not reach the server."); }
    setBusy(false);
  };

  const save = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/increases", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lease_id: lease.id, new_rent: Number(rent), method,
          effective_on: calc?.timing?.earliest_effective, reason: reason.trim() || null }),
      });
      const d = await res.json();
      if (!res.ok) { setErr(d.detail ?? "Could not save it."); setBusy(false); return; }
      onDone();
    } catch { setErr("Could not reach the server."); }
    setBusy(false);
  };

  return (
    <div className="pf-panel">
      <div className="pf-row">
        <label className="pf-f"><span>New rent</span>
          <input className="pf-in" type="number" step="0.01" value={rent}
                 onChange={(e) => { setRent(e.target.value); setCalc(null); }} /></label>
        <label className="pf-f"><span>How it will be served</span>
          <select className="pf-in" value={method}
                  onChange={(e) => { setMethod(e.target.value); setCalc(null); }}>
            {[["email", "Email"], ["personal", "Handed to them"],
              ["posted_on_door", "Posted on the door"], ["post", "Ordinary mail"],
              ["courier", "Courier"]].map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <em className="pf-hint">
            This changes the effective date — the notice period runs from when
            service counts as received, not from today.
          </em></label>
        <div className="pf-f" style={{ justifyContent: "flex-end" }}>
          <button className="pf-btn pf-btn--sm pf-btn--ghost" disabled={busy}
                  onClick={calculate}>Work out the dates</button>
        </div>
      </div>

      {calc && (
        <>
          <div className="pf-figs">
            <div><em>Change</em>
              <strong className="pf-up">
                +{money(calc.proposed.amount_change)} ({calc.proposed.percent_change}%)
              </strong></div>
            <div><em>Over a year</em>
              <strong>{money(calc.proposed.annual_gain)}</strong></div>
            <div><em>Deemed received</em>
              <strong>{calc.timing.deemed_served_on}</strong></div>
            <div><em>Earliest effective</em>
              <strong>{calc.timing.earliest_effective}</strong></div>
          </div>

          <div className="pf-explain">{calc.timing.explain}</div>

          {/* The two numbers next to each other. They live on different
              screens otherwise, so nobody makes the comparison. */}
          {calc.context?.note && (
            <div className="pf-warn">{calc.context.note}</div>
          )}

          <label className="pf-f">
            <span>Reason <em>appears in the notice</em></span>
            <input className="pf-in" value={reason}
                   onChange={(e) => setReason(e.target.value)} /></label>
        </>
      )}

      {err && <div className="pf-err">{err}</div>}
      <div className="pf-actions">
        <button className="pf-btn" disabled={!calc || busy} onClick={save}>
          Save as a draft
        </button>
        <button className="pf-btn pf-btn--ghost" onClick={onCancel}>Cancel</button>
        <span className="pf-dim">Nothing is served and no clock starts.</span>
      </div>
    </div>
  );
}

/** The checkpoint. An explicit acknowledgement rather than a bare button:
 *  what is being confirmed is that somebody read the dates, and a click on
 *  "Confirm" does not evidence that. */
function ConfirmStep({ increase, onDone }) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  return (
    <div className="pf-panel">
      <div className="pf-figs">
        <div><em>From</em><strong>{money(increase.current_rent)}</strong></div>
        <div><em>To</em><strong>{money(increase.new_rent)}</strong></div>
        <div><em>Effective</em><strong>{increase.effective_on}</strong></div>
        <div><em>Earliest allowed</em>
          <strong className="pf-dim">{increase.earliest_effective}</strong></div>
      </div>

      <label className="pf-check">
        <input type="checkbox" checked={checked}
               onChange={(e) => setChecked(e.target.checked)} />
        <span>
          I have checked the effective date against the notice period
          <em>
            {" "}— {increase.effective_on} is on or after {increase.earliest_effective},
            which is {increase.deemed_served_on} plus the notice period. This is the
            date an adjudicator looks at first.
          </em>
        </span>
      </label>

      {err && <div className="pf-err">{err}</div>}
      <div className="pf-actions">
        <button className="pf-btn" disabled={!checked || busy}
                onClick={async () => {
                  setBusy(true);
                  const res = await fetch(`/api/increases/${increase.id}/confirm`, {
                    method: "POST", credentials: "include",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ acknowledged: true }) });
                  const d = await res.json();
                  if (!res.ok) { setErr(d.detail ?? "Could not confirm."); setBusy(false); return; }
                  onDone();
                }}>
          Confirm the figures
        </button>
        <span className="pf-dim">Still nothing served.</span>
      </div>
    </div>
  );
}


/* ══════════════════ Rent increases ══════════════════ */

/**
 * Every tenancy has its own clock.
 *
 * The 365 days run from that tenant's last increase, or from the day their
 * tenancy started. There is no date on which everybody can be increased, and
 * picking one serves some notices too early to be valid and the rest months
 * late — losses in both directions at once.
 *
 * So this is a queue sorted by when serving becomes possible, not a batch.
 */
function RentIncreases({ canDecide, flash }) {
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [rents, setRents] = useState({});
  const [filter, setFilter] = useState("serve_now");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const res = await fetch("/api/increases/eligibility", { credentials: "include" });
      setData(res.ok ? await res.json() : false);
    } catch { setData(false); }
  };
  useEffect(() => { load(); }, []);

  if (data === null)
    return <div className="pf-body"><p className="pf-note">Loading…</p></div>;
  if (data === false)
    return <div className="pf-body"><p className="pf-note">Could not load this.</p></div>;

  const rows = (data.eligibility ?? []).filter((x) =>
    filter === "all" ? true : x.status === filter);
  const counts = data.counts ?? {};
  const policy = data.policy;

  const toggle = (id) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  const prepare = async () => {
    setBusy(true);
    const ids = [...selected];
    const newRents = {};
    for (const id of ids) {
      const row = data.eligibility.find((x) => x.lease_id === id);
      newRents[id] = rents[id] ?? row?.proposed_rent;
    }
    try {
      const res = await fetch("/api/increases/prepare", {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ lease_ids: ids, new_rents: newRents }),
      });
      const d = await res.json();
      flash(d.skipped?.length
        ? `${d.prepared.length} drafted, ${d.skipped.length} could not be — see the reasons.`
        : `${d.prepared.length} drafted. Nothing has been served yet.`);
      setSelected(new Set());
      load();
    } catch { flash("Could not reach the server."); }
    setBusy(false);
  };

  return (
    <div className="pf-body">
      <div className="pf-stats">
        <Stat l="Can be served today" v={counts.serve_now ?? 0}
              tone={counts.serve_now > 0 ? "warn" : null} />
        <Stat l="Coming up" v={counts.coming_up ?? 0} sub="within 120 days" />
        <Stat l="Notice already out" v={counts.notice_out ?? 0} />
        <Stat l="Fixed term" v={counts.fixed_term ?? 0} sub="increase goes in the renewal" />
      </div>

      <p className="pf-note">{data.note}</p>

      {policy ? (
        <div className="pf-policy">
          <strong>
            {policy.method === "percent"
              ? `${(Number(policy.percent) * 100).toFixed(2)}%`
              : policy.method === "fixed" ? money(policy.fixed_amount)
              : "To market"}
          </strong>
          <span className="pf-dim">
            {" "}from {policy.effective_from}
            {policy.max_percent && `, capped at ${(Number(policy.max_percent) * 100).toFixed(1)}%`}
            {policy.rounding !== "none" && `, rounded to the ${policy.rounding.replace("nearest_", "nearest ")}`}
          </span>
        </div>
      ) : (
        <div className="pf-warn">
          No policy set. Figures below are blank until one exists — a percentage
          typed per suite is a percentage that differs per suite, and a tenant
          asking why theirs is higher deserves the same answer everybody else got.
        </div>
      )}

      <div className="pf-seg">
        {[["serve_now", "Serve now"], ["coming_up", "Coming up"],
          ["notice_out", "Notice out"], ["fixed_term", "Fixed term"],
          ["all", "All"]].map(([k, l]) => (
          <button key={k} className={filter === k ? "on" : ""}
                  onClick={() => setFilter(k)}>{l}</button>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="pf-empty">Nothing in this group.</div>
      ) : (
        <div className="pf-list">
          {rows.map((x) => {
            const editable = x.status === "serve_now" && canDecide;
            const rent = rents[x.lease_id] ?? x.proposed_rent;
            const change = rent == null ? null : cents(rent - Number(x.current_rent));
            const pct = change == null ? null
              : (change / Number(x.current_rent)) * 100;

            return (
              <div className={`pf-item ${x.status === "serve_now" ? "soon" : ""}`}
                   key={x.lease_id}>
                <div className="pf-item-h">
                  {editable && (
                    <input type="checkbox" checked={selected.has(x.lease_id)}
                           onChange={() => toggle(x.lease_id)} />
                  )}
                  <strong className="pf-mono">{x.unit_number}</strong>
                  <span className="pf-dim">{x.tenant_name}</span>
                  <span className={`pf-tag ${x.status === "serve_now" ? "pf-tag--soon"
                    : x.status === "notice_out" ? "pf-tag--done" : ""}`}>
                    {x.status.replace(/_/g, " ")}
                  </span>
                </div>

                {/* Their own dates, said out loud. This is the part that makes
                    it obvious why a calendar batch cannot work. */}
                <div className="pf-figs">
                  <div><em>Now</em><strong>{money(x.current_rent)}</strong></div>
                  {editable ? (
                    <div>
                      <em>New rent</em>
                      <input className="pf-in pf-in--sm" type="number" step="0.01"
                             value={rent ?? ""}
                             onChange={(e) => setRents({ ...rents,
                               [x.lease_id]: Number(e.target.value) })} />
                    </div>
                  ) : (
                    <div><em>Proposed</em><strong>{money(x.proposed_rent)}</strong></div>
                  )}
                  {change != null && change !== 0 && (
                    <div><em>Change</em>
                      <strong className={change > 0 ? "pf-up" : "pf-down"}>
                        {change > 0 ? "+" : ""}{money(change)} ({pct.toFixed(1)}%)
                      </strong></div>
                  )}
                  <div><em>Their anniversary</em>
                    <strong className="pf-mono">{x.eligible_from}</strong></div>
                  <div><em>Last changed</em>
                    <strong className="pf-mono">{x.anniversary_of ?? "never"}</strong></div>
                </div>

                <p className="pf-say">{x.explain}</p>

                {pct != null && pct > 5 && x.status === "serve_now" && (
                  <div className="pf-warn">
                    {pct.toFixed(1)}% is a large step. Nothing caps it in Alberta, and
                    it is also the most common reason a tenant who would have stayed
                    gives notice — a turnover usually costs more than the difference.
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {canDecide && selected.size > 0 && (
        <div className="pf-actions pf-sticky">
          <button className="pf-btn" disabled={busy} onClick={prepare}>
            {busy ? "Drafting…" : `Draft ${selected.size} notice${selected.size === 1 ? "" : "s"}`}
          </button>
          <span className="pf-dim">
            Each gets its own effective date, from its own anniversary and the
            notice period. Nothing is served until you send it.
          </span>
        </div>
      )}
    </div>
  );
}

/* ══════════════════ Turnover ══════════════════ */

/** The gap between a tenant leaving and the unit being re-let is pure vacancy
 *  loss. Nobody measured it because no single person owned it. */
function Turnover({ turnovers, pricing, canEdit, onSave, flash }) {
  const [adding, setAdding] = useState(false);

  const rows = useMemo(() => turnovers.map((t) => {
    const end = t.occupied_at ?? today();
    const vacant = days(t.vacated_at, end);
    return { ...t, days_vacant: vacant,
      lost_rent: t.daily_rent ? cents(vacant * t.daily_rent) : null,
      days_to_list: t.listed_at ? days(t.vacated_at, t.listed_at) : null,
      days_to_lease: t.leased_at ? days(t.vacated_at, t.leased_at) : null };
  }).sort((a, b) => String(b.vacated_at).localeCompare(String(a.vacated_at))),
  [turnovers]);

  const open = rows.filter((t) => t.state !== "occupied");
  const done = rows.filter((t) => t.occupied_at);
  const running = cents(open.reduce((s, t) => s + (t.lost_rent ?? 0), 0));
  const avg = done.length
    ? Number((done.reduce((s, t) => s + t.days_vacant, 0) / done.length).toFixed(1)) : null;

  return (
    <div className="pf-body">
      <div className="pf-stats">
        <Stat l="Vacant now" v={open.length} />
        <Stat l="Lost so far" v={money0(running)} tone={running > 0 ? "warn" : null} />
        <Stat l="Average days" v={avg ?? "—"} sub={done.length ? `${done.length} completed` : ""} />
      </div>

      <p className="pf-note">
        Every day between a tenant leaving and the next one moving in is rent nobody
        is paying. It is the cost that does not appear on any invoice, which is why
        it goes unmeasured.
      </p>

      {canEdit && (
        <div className="pf-actions">
          <button className="pf-btn pf-btn--sm" onClick={() => setAdding(!adding)}>
            Start a turnover
          </button>
        </div>
      )}

      {adding && (
        <NewTurnover pricing={pricing} onCancel={() => setAdding(false)}
          onAdd={(t) => { onSave([t, ...turnovers]); setAdding(false); }} />
      )}

      {rows.length === 0 ? (
        <div className="pf-empty">No turnovers recorded.</div>
      ) : (
        <div className="pf-list">
          {rows.map((t) => (
            <div className={`pf-item ${t.state === "occupied" ? "" :
              t.days_vacant > 45 ? "urgent" : t.days_vacant > 21 ? "soon" : ""}`} key={t.id}>
              <div className="pf-item-h">
                <span className={`pf-tag ${t.state === "occupied" ? "pf-tag--done" : ""}`}>
                  {t.state}
                </span>
                <strong className="pf-mono">{t.unit_number}</strong>
                <span className="pf-dim">Vacated {t.vacated_at}</span>
                <span className={t.days_vacant > 45 ? "pf-bad" : ""}>
                  {t.days_vacant} days
                </span>
                {t.lost_rent != null && (
                  <span className="pf-mono pf-lost">{money0(t.lost_rent)} lost</span>
                )}
              </div>

              <div className="pf-track">
                {["vacated_at", "inspected_at", "work_done_at", "listed_at", "leased_at",
                  "occupied_at"].map((k, i) => {
                  const labels = ["Vacated", "Inspected", "Work done", "Listed",
                                  "Leased", "Occupied"];
                  const on = !!t[k];
                  return (
                    <div className={`pf-step ${on ? "on" : ""}`} key={k}>
                      <span />
                      <em>{labels[i]}</em>
                      {on && <b>{String(t[k]).slice(5)}</b>}
                    </div>
                  );
                })}
              </div>

              {t.tasks && (
                <div className="pf-tasks">
                  {t.tasks.map((task) => (
                    <label key={task.label} className={task.done ? "on" : ""}>
                      <input type="checkbox" checked={!!task.done} disabled={!canEdit}
                             onChange={(e) => onSave(turnovers.map((x) => x.id === t.id
                               ? { ...x, tasks: x.tasks.map((tk) => tk.label === task.label
                                   ? { ...tk, done: e.target.checked,
                                       done_at: e.target.checked ? nowISO() : null } : tk) }
                               : x))} />
                      {task.label}
                    </label>
                  ))}
                </div>
              )}

              {canEdit && t.state !== "occupied" && (
                <div className="pf-actions">
                  {!t.listed_at && (
                    <button className="pf-btn pf-btn--sm"
                            onClick={() => { onSave(turnovers.map((x) => x.id === t.id
                              ? { ...x, listed_at: today(), state: "listed" } : x));
                              flash("Listed. The clock keeps running until somebody moves in."); }}>
                      Mark listed
                    </button>
                  )}
                  {t.listed_at && !t.occupied_at && (
                    <button className="pf-btn pf-btn--sm"
                            onClick={() => onSave(turnovers.map((x) => x.id === t.id
                              ? { ...x, occupied_at: today(), state: "occupied" } : x))}>
                      Somebody has moved in
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NewTurnover({ pricing, onCancel, onAdd }) {
  const [unit, setUnit] = useState("");
  const [vacated, setVacated] = useState(today());
  const [rent, setRent] = useState("");

  return (
    <div className="pf-panel">
      <div className="pf-row">
        <label className="pf-f"><span>Unit</span>
          <input className="pf-in" value={unit} placeholder="378-519"
                 onChange={(e) => setUnit(e.target.value)} /></label>
        <label className="pf-f"><span>Vacated</span>
          <input className="pf-in" type="date" value={vacated}
                 onChange={(e) => setVacated(e.target.value)} /></label>
        <label className="pf-f"><span>Monthly rent <em>for the loss figure</em></span>
          <input className="pf-in" type="number" step="0.01" value={rent}
                 onChange={(e) => setRent(e.target.value)} /></label>
      </div>
      <div className="pf-actions">
        <button className="pf-btn" disabled={!unit.trim()}
                onClick={() => onAdd({ id: uid("to_"), unit_number: unit.trim(),
                  vacated_at: vacated, state: "vacant",
                  daily_rent: rent ? cents(Number(rent) / 30.44) : null,
                  tasks: TURNOVER_TASKS.map((label) => ({ label, done: false })),
                  created_at: nowISO() })}>
          Start
        </button>
        <button className="pf-btn pf-btn--ghost" onClick={onCancel}>Cancel</button>
        <span className="pf-dim">
          The same checklist every time, so nothing depends on what somebody remembered.
        </span>
      </div>
    </div>
  );
}

/* ══════════════════ Pricing signals ══════════════════ */

/** Counts, not advice. What a unit should rent for depends on the local
 *  market, which this system cannot see — a number here would be read as an
 *  answer. */
function PricingSignals({ outcomes, turnovers, pricing }) {
  const signals = useMemo(() => {
    const byType = {};
    for (const o of outcomes) {
      const type = o.unitType ?? o.unit_type ?? "unknown";
      byType[type] ||= { type, showings: 0, interested: 0, not_interested: 0,
                         price_reason: 0, applications: 0 };
      byType[type].showings++;
      if (o.outcome === "interested") byType[type].interested++;
      if (o.outcome === "not_interested") byType[type].not_interested++;
      if (/pric|價|貴|expensive/i.test(o.reason ?? "")) byType[type].price_reason++;
      if (o.applied) byType[type].applications++;
    }

    const vacancy = {};
    for (const t of turnovers) {
      const type = t.unit_type ?? "unknown";
      const d = days(t.vacated_at, t.occupied_at ?? today());
      (vacancy[type] ||= []).push(d);
    }

    return Object.values(byType).map((s) => {
      const v = vacancy[s.type];
      const avgVacant = v?.length
        ? Number((v.reduce((a, b) => a + b, 0) / v.length).toFixed(1)) : null;
      const conversion = s.showings > 0
        ? Number((s.applications / s.showings * 100).toFixed(1)) : null;
      return { ...s, avg_days_vacant: avgVacant, conversion,
        signal: s.showings >= 8 && s.applications === 0 ? "shown_often_no_applications"
          : s.price_reason >= 3 ? "price_named_repeatedly"
          : avgVacant > 45 ? "slow_to_fill"
          : conversion != null && conversion > 40 ? "converting_well" : null };
    }).sort((a, b) => b.showings - a.showings);
  }, [outcomes, turnovers]);

  const SIGNAL = {
    shown_often_no_applications: {
      label: "Shown often, nobody applied", tone: "bad",
      say: "People are coming to look and leaving. Something they see in person is putting them off, and it is not always the price — a smell, a corridor, a view onto a wall." },
    price_named_repeatedly: {
      label: "Price came up repeatedly", tone: "bad",
      say: "Enough people have said it out loud that it is worth taking seriously. What they say and what they mean are not always the same, but three times is a pattern." },
    slow_to_fill: {
      label: "Slow to fill", tone: "warn",
      say: "Sitting empty longer than the rest. Six weeks of vacancy costs more than most of the increases anybody argues about." },
    converting_well: {
      label: "Converting well", tone: "good",
      say: "People who see it apply. Worth knowing before the next review — this is the one where holding the price is defensible." },
  };

  return (
    <div className="pf-body">
      <p className="pf-note">
        These are counts, not a recommendation. What a unit should rent for depends
        on what else is available nearby, which this system cannot see. A suggested
        figure here would be read as an answer.
      </p>

      {signals.length === 0 ? (
        <div className="pf-empty">
          No showing outcomes recorded yet. This fills in as viewings are logged.
        </div>
      ) : (
        <div className="pf-list">
          {signals.map((s) => {
            const sig = SIGNAL[s.signal];
            return (
              <div className={`pf-item ${sig?.tone === "bad" ? "urgent"
                : sig?.tone === "warn" ? "soon" : ""}`} key={s.type}>
                <div className="pf-item-h">
                  <strong className="pf-mono">{s.type}</strong>
                  {sig && (
                    <span className={`pf-tag pf-tag--${sig.tone === "good" ? "done"
                      : sig.tone === "bad" ? "urgent" : "soon"}`}>{sig.label}</span>
                  )}
                </div>

                <div className="pf-figs">
                  <div><em>Showings</em><strong>{s.showings}</strong></div>
                  <div><em>Applications</em><strong>{s.applications}</strong></div>
                  <div><em>Conversion</em>
                    <strong>{s.conversion == null ? "—" : `${s.conversion}%`}</strong></div>
                  <div><em>Said no on price</em><strong>{s.price_reason}</strong></div>
                  {s.avg_days_vacant != null && (
                    <div><em>Average vacant</em>
                      <strong className={s.avg_days_vacant > 45 ? "pf-bad" : ""}>
                        {s.avg_days_vacant} days
                      </strong></div>
                  )}
                </div>

                {sig && <p className="pf-say">{sig.say}</p>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ══════════════════ Owner ══════════════════ */

function OwnerStatements({ statements }) {
  return (
    <div className="pf-body">
      <p className="pf-note">
        One statement per building per month, generated once the period is reconciled.
        Two figures matter and they are not the same: what the property earned, and
        what can actually be taken out.
      </p>

      {statements.length === 0 ? (
        <div className="pf-empty">
          Nothing generated yet. Statements come from the accounting console once a
          period has been reconciled.
        </div>
      ) : (
        <div className="pf-list">
          {statements.map((s) => {
            const f = s.figures ?? {};
            return (
              <div className="pf-item" key={s.id}>
                <div className="pf-item-h">
                  <strong className="pf-mono">{s.period}</strong>
                  <span>Building {s.building_code}</span>
                  <span className={`pf-tag ${s.state === "final" ? "pf-tag--done" : ""}`}>
                    {s.state}
                  </span>
                </div>
                <div className="pf-figs">
                  <div><em>Revenue</em><strong>{money(f.revenue)}</strong></div>
                  <div><em>Expenses</em><strong>{money(f.expenses)}</strong></div>
                  <div><em>Net operating income</em>
                    <strong className={f.noi < 0 ? "pf-bad" : ""}>{money(f.noi)}</strong></div>
                  <div><em>Cash collected</em><strong>{money(f.cash_collected)}</strong></div>
                  <div><em>Distributable</em><strong>{money(f.distributable)}</strong></div>
                </div>
                <p className="pf-say">
                  Net operating income is accrual — what was earned. Distributable is
                  cash — what is actually there. They differ whenever rent has been
                  billed and not collected, and taking the first out of an account
                  holding the second writes a cheque the bank will not honour.
                </p>
                {s.method && (
                  <details className="pf-method">
                    <summary>How each figure was worked out</summary>
                    <pre>{s.method}</pre>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ---------- bits ---------- */

function Stat({ l, v, sub, tone }) {
  return (
    <div className="pf-stat">
      <div className="pf-stat-l">{l}</div>
      <div className={`pf-stat-v ${tone === "bad" ? "pf-bad" : tone === "warn" ? "pf-warnc" : ""}`}>
        {v}
      </div>
      {sub && <div className="pf-stat-s">{sub}</div>}
    </div>
  );
}

const stampShort = (s) => (s ? String(s).slice(0, 10) : "—");

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&family=Archivo:wght@700;800&display=swap');
.pf{--paper:#fff;--ink2:#3E4C5A;--dim:#78899A;--ground:#EDF0F3;--rule:#D3DBE1;
  --red:#B23A54;--green:#0E8577;--amber:#FFF6E0;--amberline:#E8C877;
  background:var(--ground);color:var(--ink,#131C25);min-height:100vh;font-size:14px;
  line-height:1.55;font-family:'IBM Plex Sans',system-ui,sans-serif;padding-bottom:44px}
.pf *{box-sizing:border-box}
.pf-mono{font-family:'IBM Plex Mono',monospace;font-variant-numeric:tabular-nums}
.pf-dim{color:var(--dim);font-size:12.5px}
.pf-bad{color:var(--red)}
.pf-warnc{color:#B26A3A}
.pf-up{color:var(--red)}
.pf-down{color:var(--green)}
.pf-load{padding:80px 20px;text-align:center;color:var(--dim)}

.pf-head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;
  padding:22px 26px 16px;background:var(--paper);border-bottom:1px solid var(--rule)}
.pf-eyebrow{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.13em;
  text-transform:uppercase;color:var(--dim)}
.pf-head h1{font-family:'Archivo',sans-serif;font-weight:800;font-size:23px;
  letter-spacing:-.02em;margin:4px 0 0;color:var(--brand)}
.pf-flash{font-size:12.5px;color:var(--green);background:#F5FAF8;border:1px solid var(--green);
  border-radius:3px;padding:6px 11px}
.pf-tabs{display:flex;padding:0 26px;background:var(--paper);border-bottom:1px solid var(--rule);
  overflow-x:auto}
.pf-tabs button{font:inherit;font-weight:600;font-size:13.5px;cursor:pointer;background:none;
  border:0;padding:12px 16px;color:var(--dim);border-bottom:2px solid transparent;
  margin-bottom:-1px;white-space:nowrap}
.pf-tabs button.on{color:var(--brand);border-bottom-color:var(--brand)}

.pf-body{padding:18px 26px;max-width:1180px;display:flex;flex-direction:column;gap:14px}
.pf-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:1px;
  background:var(--rule);border:1px solid var(--rule);border-radius:4px;overflow:hidden}
.pf-stat{background:var(--paper);padding:14px 16px}
.pf-stat-l{font-size:10.5px;letter-spacing:.06em;color:var(--dim);text-transform:uppercase;
  font-family:'IBM Plex Mono',monospace}
.pf-stat-v{font-family:'IBM Plex Mono',monospace;font-size:22px;font-weight:600;margin-top:3px}
.pf-stat-s{font-size:11px;color:var(--dim)}
.pf-note{color:var(--dim);font-size:12.5px;margin:0;line-height:1.7;max-width:74ch}
.pf-empty{color:var(--dim);font-size:12.5px;padding:30px 0;text-align:center;
  border:1px dashed var(--rule);border-radius:3px;background:var(--paper)}
.pf-alert{background:#FDF6F7;border:1px solid var(--red);border-radius:4px;padding:11px 14px;
  font-size:12.5px;color:var(--red);line-height:1.7}
.pf-alert span{color:var(--ink2)}

.pf-list{display:flex;flex-direction:column;gap:10px}
.pf-item{background:var(--paper);border:1px solid var(--rule);border-radius:4px;
  padding:13px 15px;display:flex;flex-direction:column;gap:8px}
.pf-item.urgent{border-left:3px solid var(--red)}
.pf-item.soon{border-left:3px solid var(--amberline)}
.pf-item-h{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:13.5px}
.pf-tag{font-size:10.5px;font-weight:700;color:#fff;background:var(--dim);border-radius:9px;
  padding:1px 9px;white-space:nowrap}
.pf-tag--urgent{background:var(--red)}
.pf-tag--soon{background:#C98A15}
.pf-tag--planned{background:var(--dim)}
.pf-tag--done{background:var(--green)}
.pf-tag--review{background:#5A6B7D}
.pf-lost{color:var(--red);font-weight:600}

.pf-figs{display:flex;gap:24px;flex-wrap:wrap}
.pf-figs>div{display:flex;flex-direction:column;gap:1px}
.pf-figs em{font-style:normal;font-size:10px;color:var(--dim);text-transform:uppercase;
  letter-spacing:.05em;font-family:'IBM Plex Mono',monospace}
.pf-figs strong{font-family:'IBM Plex Mono',monospace;font-size:15px}

.pf-track{display:flex;gap:2px;flex-wrap:wrap}
.pf-step{flex:1 1 80px;display:flex;flex-direction:column;gap:3px;min-width:70px}
.pf-step>span{height:3px;background:var(--rule);border-radius:2px}
.pf-step.on>span{background:var(--brand)}
.pf-step em{font-style:normal;font-size:10px;color:var(--dim)}
.pf-step.on em{color:var(--ink2);font-weight:600}
.pf-step b{font-family:'IBM Plex Mono',monospace;font-size:10px;color:var(--dim)}

.pf-tasks{display:flex;flex-wrap:wrap;gap:5px}
.pf-tasks label{display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;
  border:1px solid var(--rule);border-radius:12px;padding:3px 10px;color:var(--dim)}
.pf-tasks label.on{border-color:var(--green);color:var(--green)}

.pf-block{background:#FDF6F7;border:1px solid var(--red);border-radius:3px;padding:9px 12px;
  font-size:12.5px;color:var(--red);line-height:1.65}
.pf-warn{background:var(--amber);border:1px solid var(--amberline);border-radius:3px;
  padding:9px 12px;font-size:12.5px;color:#6B5410;line-height:1.7}
.pf-say{font-size:12.5px;color:var(--ink2);line-height:1.75;margin:0;max-width:74ch;
  border-left:2px solid var(--rule);padding-left:11px}
.pf-method{font-size:12.5px}
.pf-method summary{cursor:pointer;color:var(--brand);padding:4px 0}
.pf-method pre{font-family:'IBM Plex Mono',monospace;font-size:11.5px;line-height:1.8;
  background:#F7F9FB;border:1px solid var(--rule);border-radius:3px;padding:11px 13px;
  margin:6px 0 0;white-space:pre-wrap;color:var(--ink2)}

.pf-card{background:var(--paper);border:1px solid var(--rule);border-radius:4px;
  padding:15px 17px;display:flex;flex-direction:column;gap:11px}
.pf-card h3{font-family:'Archivo',sans-serif;font-size:15px;margin:0;
  display:flex;align-items:center;gap:8px}
.pf-n{font-family:'IBM Plex Mono',monospace;font-size:11px;background:var(--ground);
  color:var(--dim);border-radius:9px;padding:1px 8px}
.pf-inc{border-bottom:1px solid #F0F3F5;padding:10px 0;display:flex;
  flex-direction:column;gap:8px}
.pf-inc:last-child{border-bottom:0}
.pf-inc-h{display:flex;gap:11px;align-items:baseline;flex-wrap:wrap;font-size:13.5px}
.pf-below{font-size:11.5px;color:#B26A3A;background:var(--amber);border-radius:9px;
  padding:1px 9px}
.pf-blocked{display:flex;gap:12px;padding:9px 0;border-bottom:1px solid #F0F3F5;
  font-size:12.5px;line-height:1.7}
.pf-blocked:last-child{border-bottom:0}
.pf-blocked>div{flex:1;color:var(--ink2)}
.pf-explain{font-size:12.5px;color:var(--ink2);line-height:1.75;
  background:#F7F9FB;border-left:2px solid var(--rule);padding:9px 12px;border-radius:3px}
.pf-hint{font-style:normal;font-size:11.5px;color:var(--dim);line-height:1.6}
.pf-declined{background:#FDF6F7;border:1px solid var(--red);border-radius:4px;
  padding:11px 14px;font-size:12.5px;color:var(--red);line-height:1.75}
.pf-declined p{margin:6px 0;color:var(--ink2);font-style:italic}
.pf-declined span{color:var(--ink2)}
.pf-check{display:flex;gap:9px;align-items:flex-start;font-size:12.5px;
  color:var(--ink2);line-height:1.7;cursor:pointer}
.pf-check input{margin-top:3px}
.pf-check em{font-style:normal;color:var(--dim)}
.pf-policy{background:var(--brand-tint,#EEF2F7);border-left:3px solid var(--brand);
  border-radius:3px;padding:10px 14px;font-size:13px}
.pf-in--sm{width:110px;padding:5px 8px;font-family:'IBM Plex Mono',monospace}
.pf-sticky{position:sticky;bottom:0;background:var(--paper);border:1px solid var(--rule);
  border-radius:4px;padding:11px 14px;box-shadow:0 -2px 8px rgba(0,0,0,.05)}
.pf-panel{border:1px solid var(--brand);border-radius:4px;padding:13px 15px;
  background:var(--brand-tint,#EEF2F7);display:flex;flex-direction:column;gap:10px}
.pf-opts{display:flex;gap:7px;flex-wrap:wrap}
.pf-opts button{font:inherit;font-size:12.5px;cursor:pointer;background:var(--paper);
  border:1px solid var(--rule);border-radius:3px;padding:7px 14px;color:var(--ink2)}
.pf-opts button.on{background:var(--brand);color:#fff;border-color:var(--brand);font-weight:600}
.pf-change{display:flex;flex-direction:column;gap:2px;justify-content:flex-end}
.pf-change em{font-style:normal;font-size:10.5px;color:var(--dim);text-transform:uppercase;
  font-family:'IBM Plex Mono',monospace}
.pf-change strong{font-family:'IBM Plex Mono',monospace;font-size:16px}

.pf-row{display:flex;gap:11px;flex-wrap:wrap}
.pf-row>*{flex:1 1 150px}
.pf-f{display:flex;flex-direction:column;gap:4px}
.pf-f>span{font-size:12px;font-weight:600;color:var(--ink2)}
.pf-f>span em{font-style:normal;font-weight:400;color:var(--dim)}
.pf-in{font:inherit;font-size:13px;padding:7px 10px;border:1px solid var(--rule);
  border-radius:3px;background:var(--paper);width:100%}
.pf-in:focus{outline:2px solid var(--brand);outline-offset:1px}
.pf-btn{font:inherit;font-weight:600;font-size:13px;cursor:pointer;background:var(--brand);
  color:#fff;border:1px solid var(--brand);padding:8px 15px;border-radius:3px}
.pf-btn:disabled{opacity:.4;cursor:not-allowed}
.pf-btn--ghost{background:transparent;color:var(--ink2);border-color:var(--rule)}
.pf-btn--sm{padding:6px 12px;font-size:12px}
.pf-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.pf-err{font-size:12.5px;color:var(--red);background:#FDF6F7;border:1px solid var(--red);
  border-radius:3px;padding:9px 12px}

@media (max-width:760px){
  .pf-head,.pf-tabs,.pf-body{padding-left:16px;padding-right:16px}
}
`;
