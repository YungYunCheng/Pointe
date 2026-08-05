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

  const TABS = [["renewals", "Renewals"], ["turnover", "Turnover"],
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
        <Stat l="Ending within 90 days" v={rows.length} />
        <Stat l="No decision yet" v={undecided.length}
              tone={undecided.length > 0 ? "warn" : null} />
        <Stat l="Under 30 days" v={urgent.length} tone={urgent.length > 0 ? "bad" : null} />
      </div>

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
                <span className={`pf-tag pf-tag--${r.urgency}`}>
                  {r.days_left} days
                </span>
                <strong className="pf-mono">{r.unit_number}</strong>
                <span>{r.tenant_name}</span>
                <span className="pf-dim">
                  {r.term_type === "periodic" ? "Month to month" : "Fixed term"} ·
                  ends {r.end_date}
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
                <div><em>Notice due</em>
                  <strong className={r.notice_due_in <= 0 ? "pf-bad" : ""}>
                    {r.notice_due_in <= 0 ? "overdue" : `${r.notice_due_in} days`}
                  </strong>
                </div>
              </div>

              {!r.can_raise && (
                <div className="pf-block">
                  Rent cannot be raised yet — {r.days_since_increase} days since the last
                  increase and Alberta requires {INCREASE_INTERVAL_DAYS}. A notice inside
                  that window can be invalid, not merely refused.
                </div>
              )}

              {canDecide && !r.renewal_decision && (
                deciding === r.id ? (
                  <DecideRenewal lease={r} onCancel={() => setDeciding(null)}
                    onSave={(patch) => {
                      onSave(leases.map((l) => l.id === r.id ? { ...l, ...patch } : l));
                      setDeciding(null);
                      flash(patch.renewal_decision === "offer"
                        ? "Offer recorded. Send it before the notice date."
                        : "Recorded. The move-out process starts from here.");
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

function DecideRenewal({ lease, onCancel, onSave }) {
  const [decision, setDecision] = useState("offer");
  const [rent, setRent] = useState(String(lease.rent ?? ""));
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");

  const proposed = cents(Number(rent) || 0);
  const raising = proposed > cents(lease.rent);
  const change = cents(proposed - lease.rent);
  const pct = lease.rent ? (change / lease.rent * 100) : 0;

  return (
    <div className="pf-panel">
      <div className="pf-opts">
        {[["offer", "Offer a renewal"], ["month_to_month", "Let it go month to month"],
          ["not_renewing", "Not renewing"]].map(([k, l]) => (
          <button key={k} className={decision === k ? "on" : ""}
                  onClick={() => setDecision(k)}>{l}</button>
        ))}
      </div>

      {decision === "offer" && (
        <>
          <div className="pf-row">
            <label className="pf-f"><span>Rent from {lease.end_date}</span>
              <input className="pf-in" type="number" step="0.01" value={rent}
                     onChange={(e) => setRent(e.target.value)} /></label>
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

          {raising && !lease.can_raise && (
            <div className="pf-block">
              This cannot be sent as an increase yet — {lease.days_since_increase} days since
              the last one. Offer the same rent, or wait.
            </div>
          )}
          {raising && pct > 5 && lease.can_raise && (
            <div className="pf-warn">
              {pct.toFixed(1)}% is a large increase. It is legal with proper notice, but
              it is also the most common reason a tenant who would have stayed does not —
              and a turnover usually costs more than the difference.
            </div>
          )}
        </>
      )}

      {decision === "not_renewing" && (
        <div className="pf-warn">
          Ending a tenancy needs proper notice and, in Alberta, a reason that the
          legislation allows for a periodic tenancy. Check the grounds before this
          goes out.
        </div>
      )}

      <label className="pf-f"><span>Note</span>
        <input className="pf-in" value={note} onChange={(e) => setNote(e.target.value)} /></label>

      {err && <div className="pf-err">{err}</div>}
      <div className="pf-actions">
        <button className="pf-btn"
                disabled={decision === "offer" && raising && !lease.can_raise}
                onClick={() => onSave({ renewal_decision: decision,
                  renewal_rent: decision === "offer" ? proposed : null,
                  renewal_note: note.trim() || null, renewal_decided_at: nowISO() })}>
          Record it
        </button>
        <button className="pf-btn pf-btn--ghost" onClick={onCancel}>Cancel</button>
      </div>
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
