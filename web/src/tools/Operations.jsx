import React, { useState, useEffect, useMemo, useCallback } from "react";

/* ============================================================
   BAYDO POINTE — Operations console
   · Showing outcomes: a prompt appears 30 minutes after the booked time,
     and turns overdue at 60
   · Move-out: tenant applies, staff confirm each step, then the deposit is settled and returned
   · Admin can delete a workflow or roll it back a step so it can be redone
   ============================================================ */

const CONFIRM_AFTER_MIN = 30;
const OVERDUE_AFTER_MIN = 60;

/* ---------- Showing outcomes ---------- */
const OUTCOMES = [
  { k: "interested",     label: "Viewed · interested",   color: "#0E8577", stage: "viewed" },
  { k: "undecided",      label: "Viewed · thinking",     color: "#1C6FA6", stage: "viewed" },
  { k: "not_interested", label: "Viewed · not for them", color: "#C98A15", stage: "lost" },
  { k: "no_show",        label: "No show",               color: "#B23A54", stage: null },
  { k: "cancelled",      label: "Cancelled by tenant",   color: "#8892A0", stage: null },
];
const OC = Object.fromEntries(OUTCOMES.map((o) => [o.k, o]));

const NOT_INTERESTED_REASONS = [
  "Layout", "Light or view", "Price", "Floor",
  "Not enough parking", "No storage", "Neighbourhood", "Other",
];

/* ---------- Move-out steps ---------- */
const STEPS = [
  { k: "acknowledged", label: "Accept notice",      desc: "Check the notice period against the lease and the RTA" },
  { k: "inspection",   label: "Book inspection",    desc: "Agree a time with the tenant; both attend" },
  { k: "report",       label: "Inspection report",  desc: "Required in Alberta. Include photos and any damage" },
  { k: "notice",       label: "Deduction notice",   desc: "List each deduction and its basis, then send it to the tenant" },
  { k: "response",     label: "Tenant response",    desc: "Accepted or disputed. Record both sides where disputed" },
  { k: "refunded",     label: "Refund",             desc: "Pay out once the notice period has run. Keep the receipt" },
];
const STEP_IDX = Object.fromEntries(STEPS.map((s, i) => [s.k, i]));

/* Refund deadline. Ten days after the tenancy ends is the usual figure in Alberta;
   confirm the exact number with your manager. */
const REFUND_DAYS = 10;
const REMIND_BEFORE = 3;

/* Deduction states */
const DED_STATE = {
  proposed:  { label: "Not yet notified", color: "#8892A0" },
  notified:  { label: "Notified",         color: "#1C6FA6" },
  accepted:  { label: "Accepted",         color: "#0E8577" },
  disputed:  { label: "Disputed",         color: "#B23A54" },
  withdrawn: { label: "Withdrawn",        color: "#8892A0" },
  upheld:    { label: "Upheld after notice", color: "#C98A15" },
};
const COUNTED = ["accepted", "upheld"];

const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
const daysUntil = (d) => Math.ceil((new Date(d + "T23:59:59") - Date.now()) / 864e5);

const BED = { "1A": "1 bed", "1A (M)": "1 bed", "1B": "1 bed + den", "1C": "1 bed",
              "2A": "2 bed 2 bath", "2A (M)": "2 bed 2 bath", "3A": "2 bed + den", "3A (M)": "2 bed + den" };
const G374 = {101:"1A (M)",102:"1A",103:"2A",104:"2A (M)",105:"3A (M)",106:"3A",107:"2A",108:"2A (M)",109:"1A (M)",110:"1A",111:"2A (M)",112:"3A (M)",113:"3A",114:"2A"};
const T374 = {201:"1C",202:"1A (M)",203:"1A",204:"2A",205:"2A (M)",206:"3A (M)",207:"3A",208:"2A",209:"2A (M)",210:"1A (M)",211:"1A",212:"2A (M)",213:"2A (M)",214:"3A (M)",215:"3A",216:"2A"};
const G370 = {101:"1B",102:"1A",103:"1A (M)",104:"2A (M)",105:"2A",106:"1A (M)",107:"1A",108:"2A (M)",109:"3A (M)",110:"3A",111:"2A",112:"1A (M)",113:"1A",114:"2A (M)",115:"2A",116:"1A (M)",117:"1A",118:"2A (M)"};
const T370 = {201:"1C",202:"1A",203:"1A (M)",204:"2A (M)",205:"2A",206:"1A (M)",207:"1A",208:"2A (M)",209:"3A (M)",210:"3A",211:"2A",212:"1A (M)",213:"1A",214:"2A (M)",215:"2A",216:"1A (M)",217:"1A",218:"2A (M)",219:"3A (M)",220:"3A"};
function unitType(id) {
  const m = /^(370|374|378)-(\d{3})$/.exec((id || "").trim());
  if (!m) return null;
  const [, b, s] = m;
  const no = Number(s), fl = Math.floor(no / 100), key = no % 100;
  const g = b === "374" ? G374 : G370, t = b === "374" ? T374 : T370;
  if (fl === 1) return g[100 + key] || null;
  if (fl >= 2 && fl <= 6) return t[200 + key] || null;
  return null;
}

const nowISO = () => new Date().toISOString();
const fmt = (s) => (s ? s.slice(0, 16).replace("T", " ") : "—");
const money = (n) => (n == null || n === "" || isNaN(n) ? "—" : "$" + Math.round(Number(n)).toLocaleString("en-CA"));
const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const minsSince = (d) => (Date.now() - d.getTime()) / 60000;

function seedMoveouts() {
  const d = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  return [
    { id: "mo_1", unitId: "374-206", tenant: "Wei-Lun Chen", phone: "780-555-0193",
      email: "wchen@example.com", requestedAt: nowISO(), noticeDate: d(-2), moveOutDate: d(28),
      state: "open", deposit: { original: "", deductions: [], refund: "", method: "" },
      steps: {}, history: [{ at: nowISO(), by: "Tenant", text: "Submitted a move-out request through the web form." }] },
  ];
}

export default function Operations() {
  const [session, setSession] = useState(null);
  const [events, setEvents] = useState([]);
  const [outcomes, setOutcomes] = useState({});
  const [moveouts, setMoveouts] = useState(seedMoveouts);
  const [leads, setLeads] = useState([]);
  const [parking, setParking] = useState(null);
  const [overrides, setOverrides] = useState({});
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState("idle");
  const [tab, setTab] = useState("showings");
  const [tick, setTick] = useState(0);
  const [newMo, setNewMo] = useState(false);

  const isAdmin = session?.role === "admin";
  const who = session?.name || "unsigned";

  useEffect(() => {
    (async () => {
      const read = async (k) => {
        try { const r = await window.storage.get(k); return r?.value ? JSON.parse(r.value) : null; }
        catch (e) { return null; }
      };
      const s = await read("baydo:session"); if (s) setSession(s);
      const sc = await read("baydo:schedule"); if (sc?.events) setEvents(sc.events);
      const o = await read("baydo:showoutcomes"); if (o) setOutcomes(o);
      const m = await read("baydo:moveouts"); if (m) setMoveouts(m);
      const l = await read("baydo:leads"); if (l) setLeads(l);
      const pk = await read("baydo:parking"); if (pk) setParking(pk);
      const ov = await read("baydo:overrides"); if (ov) setOverrides(ov);
      setLoading(false);
    })();
  }, []);

  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 60000); return () => clearInterval(t); }, []);

  const persist = useCallback(async (k, v) => {
    setSaveState("saving");
    try {
      const ok = await window.storage.set(k, JSON.stringify(v));
      setSaveState(ok ? "saved" : "error");
    } catch (e) { setSaveState("error"); }
    setTimeout(() => setSaveState((x) => (x === "saved" ? "idle" : x)), 1500);
  }, []);

  const saveOutcomes = (v) => { setOutcomes(v); persist("baydo:showoutcomes", v); };
  const saveMoveouts = (v) => { setMoveouts(v); persist("baydo:moveouts", v); };

  /* ---------- Outcome queue ---------- */
  const showQueue = useMemo(() => {
    const list = events.filter((e) => e.type === "showing" && e.state === "booked");
    const pend = [], done = [];
    for (const e of list) {
      const at = new Date(`${e.date}T${e.time}:00`);
      const mins = minsSince(at);
      const rec = outcomes[e.id];
      if (rec) { done.push({ e, rec, at }); continue; }
      if (mins >= CONFIRM_AFTER_MIN) pend.push({ e, at, mins, overdue: mins >= OVERDUE_AFTER_MIN });
    }
    pend.sort((a, b) => b.mins - a.mins);
    done.sort((a, b) => b.at - a.at);
    return { pend, done };
  }, [events, outcomes, tick]);

  const recordOutcome = (eventId, outcome, reason, note) => {
    const rec = { outcome, reason: reason || null, note: note || "", by: who, at: nowISO() };
    saveOutcomes({ ...outcomes, [eventId]: rec });
    // Push the outcome back into the CRM stage
    const ev = events.find((x) => x.id === eventId);
    const stage = OC[outcome]?.stage;
    if (ev && stage && leads.length) {
      const next = leads.map((l) =>
        (l.email && l.email === ev.contact) || (l.phone && l.phone === ev.contact) || l.name === ev.name
          ? { ...l, stage, last_contact_at: nowISO(),
              ...(stage === "lost" ? { lost_reason: reason || "Not interested after viewing" } : {}),
              notes: [...(l.notes || []), { at: nowISO(), by: who,
                       text: `Showing outcome: ${OC[outcome].label}${reason ? " (" + reason + ")" : ""}` }] }
          : l);
      setLeads(next); persist("baydo:leads", next);
    }
  };

  const clearOutcome = (eventId) => {
    const n = { ...outcomes }; delete n[eventId]; saveOutcomes(n);
  };

  /* ---------- Move-out ---------- */
  const patchMo = (id, p) => saveMoveouts(moveouts.map((m) => (m.id === id ? { ...m, ...p } : m)));

  const confirmStep = (id, stepKey, extra = {}) => {
    const m = moveouts.find((x) => x.id === id);
    const steps = { ...m.steps, [stepKey]: { done: true, by: who, at: nowISO(), ...extra } };
    const allDone = STEPS.every((s) => steps[s.k]?.done);
    patchMo(id, { steps, state: allDone ? "closed" : "open",
      history: [...(m.history || []),
        { at: nowISO(), by: who, text: `Confirmed: ${STEPS.find((s) => s.k === stepKey).label}` }] });
  };

  const undoStep = (id, stepKey) => {
    const m = moveouts.find((x) => x.id === id);
    const steps = { ...m.steps };
    // Rolling back a step clears everything after it, so the record is never half old
    STEPS.forEach((s, i) => { if (i >= STEP_IDX[stepKey]) delete steps[s.k]; });
    patchMo(id, { steps, state: "open",
      history: [...(m.history || []),
        { at: nowISO(), by: who, text: `Admin rolled back to "${STEPS.find((s) => s.k === stepKey).label}"; later steps cleared.` }] });
  };

  const cancelMo = (id, reason) => {
    const m = moveouts.find((x) => x.id === id);
    patchMo(id, { state: "cancelled", cancel_reason: reason,
      history: [...(m.history || []), { at: nowISO(), by: who, text: `Workflow cancelled: ${reason || "no reason given"}` }] });
  };

  const reopenMo = (id) => {
    const m = moveouts.find((x) => x.id === id);
    patchMo(id, { state: "open", cancel_reason: undefined,
      history: [...(m.history || []), { at: nowISO(), by: who, text: "Admin reopened the workflow" }] });
  };

  const deleteMo = (id) => saveMoveouts(moveouts.filter((m) => m.id !== id));

  /* ---------- Confirming vacancy releases the stall and the unit ---------- */
  const confirmVacated = (mo) => {
    const lines = [];

    // Release the stall and promote the earliest waiting request in that area
    if (parking?.records?.length) {
      let recs = parking.records.filter((r) => r.unitId !== mo.unitId || r.status === "released");
      const mine = parking.records.filter((r) => r.unitId === mo.unitId && r.status !== "released");
      for (const r of mine) {
        const pool = parking.pools.find((p) => p.id === r.poolId);
        lines.push(`Released stall in ${pool?.label || r.poolId}`);
        if (r.status === "assigned") {
          const next = recs.filter((x) => x.status === "waiting" && x.poolId === r.poolId)
                           .sort((a, b) => a.ts - b.ts)[0];
          if (next) {
            recs = recs.map((x) => (x.rid === next.rid ? { ...x, status: "assigned" } : x));
            lines.push(`Promoted ${next.unitId} into ${pool?.label || r.poolId}`);
          }
        }
      }
      const nextPk = { ...parking, records: recs };
      setParking(nextPk); persist("baydo:parking", nextPk);
    }

    // Put the unit back on the market
    const o = overrides[mo.unitId] || {};
    const nextOv = { ...overrides, [mo.unitId]: { ...o, status: "available", date: "" } };
    setOverrides(nextOv); persist("baydo:overrides", nextOv);
    lines.push(`Unit ${mo.unitId} set back to available`);

    patchMo(mo.id, { vacatedAt: nowISO(), vacatedBy: who,
      history: [...(mo.history || []),
        { at: nowISO(), by: who, text: `Tenant confirmed vacated. ${lines.join("; ")}.` }] });
  };

  const openMo = moveouts.filter((m) => m.state === "open");
  const closedMo = moveouts.filter((m) => m.state !== "open");

  if (loading) return <div className="op"><style>{CSS}</style><div className="op-load">Loading…</div></div>;

  return (
    <div className="op">
      <style>{CSS}</style>

      <header className="op-head">
        <div>
          <div className="op-eyebrow">Baydo Pointe · Operations</div>
          <h1>Showing outcomes and move-outs</h1>
        </div>
        <div className="op-headr">
          {session && (
            <span className="op-chip"
                  style={{ background: session.role === "admin" ? "#131C25"
                           : session.role === "building_manager" ? "#7C5CBF" : "#1C6FA6" }}>
              {session.role === "admin" ? "Admin"
               : session.role === "building_manager" ? "Building Manager" : "Property Manager"}
              {" · "}{session.name}
            </span>
          )}
          <span className={`op-save op-save--${saveState}`}>
            {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved"
              : saveState === "error" ? "Save failed" : "Autosaves"}
          </span>
        </div>
      </header>

      <nav className="op-tabs">
        <button className={tab === "showings" ? "on" : ""} onClick={() => setTab("showings")}>
          Showing outcomes {showQueue.pend.length > 0 && <i className="op-b">{showQueue.pend.length}</i>}
        </button>
        <button className={tab === "moveout" ? "on" : ""} onClick={() => setTab("moveout")}>
          Move-outs {openMo.length > 0 && <i className="op-b">{openMo.length}</i>}
        </button>
      </nav>

      {/* ═══════ Showing outcomes ═══════ */}
      {tab === "showings" && (
        <div className="op-body">
          <p className="op-note">
            A prompt appears {CONFIRM_AFTER_MIN} minutes after the booked time and turns overdue at {OVERDUE_AFTER_MIN}.
            The outcome updates the lead stage in the CRM.
          </p>

          {showQueue.pend.length === 0 ? (
            <div className="op-empty">Nothing waiting for an outcome.</div>
          ) : (
            <div className="op-queue">
              {showQueue.pend.map(({ e, at, mins, overdue }) => (
                <ShowConfirm key={e.id} ev={e} at={at} mins={mins} overdue={overdue}
                             onRecord={(o, r, n) => recordOutcome(e.id, o, r, n)} />
              ))}
            </div>
          )}

          {showQueue.done.length > 0 && (
            <section className="op-card">
              <h2>Recorded <span className="op-n">{showQueue.done.length}</span></h2>
              <div className="op-list">
                {showQueue.done.map(({ e, rec }) => {
                  const o = OC[rec.outcome];
                  const t = unitType(e.unit);
                  return (
                    <div className="op-row" key={e.id}>
                      <span className="op-badge" style={{ "--c": o.color }}>{o.label}</span>
                      <span className="op-mono op-strong">{e.unit}</span>
                      {t && <span className="op-tag">{BED[t]}</span>}
                      <strong>{e.name}</strong>
                      {rec.reason && <span className="op-dim">{rec.reason}</span>}
                      <span className="op-dim op-mono op-right">{fmt(rec.at)} · {rec.by}</span>
                      {isAdmin && (
                        <button className="op-btn op-btn--xs op-btn--ghost" onClick={() => clearOutcome(e.id)}>
                          Clear and redo
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              {isAdmin && (
                <p className="op-note op-admin">
                  Clear and redo is Admin only. If someone records the wrong outcome, clear it and have them enter it again.
                </p>
              )}
            </section>
          )}
        </div>
      )}

      {/* ═══════ Move-out ═══════ */}
      {tab === "moveout" && (
        <div className="op-body">
          <div className="op-barrow">
            <p className="op-note" style={{ margin: 0, flex: 1 }}>
              Once a tenant applies, staff confirm each step in turn. Nothing advances without a confirmation, and the whole thing can be cancelled at any point.
            </p>
            <button className="op-btn" onClick={() => setNewMo(!newMo)}>Log a request</button>
          </div>

          {newMo && <NewMoveout onAdd={(m) => { saveMoveouts([...moveouts, m]); setNewMo(false); }}
                                onCancel={() => setNewMo(false)} />}

          <div className="op-warn">
            Alberta sets a deadline for returning a deposit and requires an itemised statement of any deductions. The usual figure is {REFUND_DAYS} days after the tenancy ends,
            either to refund or to provide the statement. Confirm the exact number, what may be deducted, and where normal wear ends
            with your manager before hard-coding any of it.
          </div>

          {/* Refund deadlines */}
          {(() => {
            const due = moveouts
              .filter((m) => m.state === "open" && m.moveOutDate && !m.steps?.refunded)
              .map((m) => ({ m, deadline: addDays(m.moveOutDate, REFUND_DAYS) }))
              .map((x) => ({ ...x, left: daysUntil(x.deadline) }))
              .sort((a, b) => a.left - b.left);
            const urgent = due.filter((x) => x.left <= REMIND_BEFORE);
            if (due.length === 0) return null;
            return (
              <section className={`op-card ${urgent.length ? "op-card--urgent" : ""}`}>
                <h2>Refund deadlines <span className="op-n">{due.length}</span></h2>
                <p className="op-note">
                  Deadline is the move-out date plus {REFUND_DAYS} days. It turns red inside {REMIND_BEFORE} days.
                </p>
                <div className="op-list">
                  {due.map(({ m, deadline, left }) => (
                    <div className="op-row" key={m.id}>
                      <span className="op-badge"
                            style={{ "--c": left < 0 ? "#B23A54" : left <= REMIND_BEFORE ? "#C98A15" : "#1C6FA6" }}>
                        {left < 0 ? `${-left} days overdue` : left === 0 ? "Due today" : `${left} days left`}
                      </span>
                      <span className="op-mono op-strong">{m.unitId}</span>
                      <strong>{m.tenant}</strong>
                      <span className="op-dim">Moves out {m.moveOutDate}</span>
                      <span className="op-dim op-mono op-right">Due {deadline}</span>
                    </div>
                  ))}
                </div>
              </section>
            );
          })()}

          {openMo.length === 0 && closedMo.length === 0 && (
            <div className="op-empty">No move-out requests.</div>
          )}

          {openMo.map((m) => (
            <MoveoutCard key={m.id} mo={m} isAdmin={isAdmin}
                         onConfirm={(k, extra) => confirmStep(m.id, k, extra)}
                         onUndo={(k) => undoStep(m.id, k)}
                         onPatch={(p) => patchMo(m.id, p)}
                         onCancel={(r) => cancelMo(m.id, r)}
                         onVacate={() => confirmVacated(m)}
                         onDelete={() => deleteMo(m.id)} />
          ))}

          {closedMo.length > 0 && (
            <section className="op-card">
              <h2>Closed and cancelled <span className="op-n">{closedMo.length}</span></h2>
              {closedMo.map((m) => (
                <div className="op-row" key={m.id}>
                  <span className="op-badge" style={{ "--c": m.state === "closed" ? "#0E8577" : "#8892A0" }}>
                    {m.state === "closed" ? "Closed" : "Cancelled"}
                  </span>
                  <span className="op-mono op-strong">{m.unitId}</span>
                  <strong>{m.tenant}</strong>
                  {m.cancel_reason && <span className="op-dim">{m.cancel_reason}</span>}
                  <span className="op-dim op-mono op-right">Moved out {m.moveOutDate}</span>
                  {isAdmin && (
                    <>
                      <button className="op-btn op-btn--xs op-btn--ghost" onClick={() => reopenMo(m.id)}>Reopen</button>
                      <button className="op-btn op-btn--xs op-btn--danger" onClick={() => deleteMo(m.id)}>Delete</button>
                    </>
                  )}
                </div>
              ))}
            </section>
          )}
        </div>
      )}

      <footer className="op-foot">
        A move-out inspection report is required in Alberta. Without one, a deposit dispute is very hard to defend.
        Every deduction should be itemised with supporting evidence, and normal wear and tear cannot be deducted.
        {isAdmin && " Admin deletions and reopens are written to the workflow history."}
      </footer>
    </div>
  );
}

/* ============================ Sub-components ============================ */

function ShowConfirm({ ev, at, mins, overdue, onRecord }) {
  const [pick, setPick] = useState(null);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const t = unitType(ev.unit);
  const needReason = pick === "not_interested";

  return (
    <div className={`op-confirm ${overdue ? "overdue" : ""}`}>
      <div className="op-ch">
        <span className="op-when">{overdue ? "Overdue" : "Awaiting outcome"}</span>
        <span className="op-mono">{ev.date} {ev.time}</span>
        <span className="op-dim">({Math.round(mins)} min ago)</span>
      </div>
      <div className="op-cbody">
        <span className="op-mono op-unit">{ev.unit}</span>
        {t && <><span className="op-mono op-type">{t}</span><span className="op-tag">{BED[t]}</span></>}
        <strong>{ev.name}</strong>
        <span className="op-dim">{ev.contact}</span>
      </div>
      <div className="op-q">How did the showing go?</div>
      <div className="op-opts">
        {OUTCOMES.map((o) => (
          <button key={o.k} className={pick === o.k ? "on" : ""} style={{ "--c": o.color }}
                  onClick={() => setPick(o.k)}>{o.label}</button>
        ))}
      </div>
      {needReason && (
        <select className="op-sel" value={reason} onChange={(e) => setReason(e.target.value)}>
          <option value="">Reason it was not for them (optional, but worth filling)</option>
          {NOT_INTERESTED_REASONS.map((r) => <option key={r}>{r}</option>)}
        </select>
      )}
      {pick && (
        <input className="op-in" value={note} placeholder="Anything to add (optional)"
               onChange={(e) => setNote(e.target.value)} />
      )}
      <button className="op-btn" disabled={!pick} onClick={() => onRecord(pick, reason, note)}>
        Record the outcome
      </button>
    </div>
  );
}

function NewMoveout({ onAdd, onCancel }) {
  const [f, setF] = useState({ unitId: "", tenant: "", phone: "", email: "",
                               noticeDate: new Date().toISOString().slice(0, 10), moveOutDate: "" });
  const set = (k, v) => setF({ ...f, [k]: v });
  const t = unitType(f.unitId);
  return (
    <div className="op-add">
      <div className="op-addrow">
        <label><span>Unit</span>
          <input className="op-in" value={f.unitId} placeholder="374-206"
                 onChange={(e) => set("unitId", e.target.value)} />
          <em>{f.unitId ? (t ? `${t} · ${BED[t]}` : "No such unit") : "Type a unit to see its layout"}</em></label>
        <label><span>Tenant</span>
          <input className="op-in" value={f.tenant} onChange={(e) => set("tenant", e.target.value)} /></label>
        <label><span>Phone</span>
          <input className="op-in" value={f.phone} onChange={(e) => set("phone", e.target.value)} /></label>
        <label><span>Email</span>
          <input className="op-in" value={f.email} onChange={(e) => set("email", e.target.value)} /></label>
      </div>
      <div className="op-addrow">
        <label><span>Notice given</span>
          <input className="op-in" type="date" value={f.noticeDate}
                 onChange={(e) => set("noticeDate", e.target.value)} /></label>
        <label><span>Move-out date</span>
          <input className="op-in" type="date" value={f.moveOutDate}
                 onChange={(e) => set("moveOutDate", e.target.value)} /></label>
        <button className="op-btn" disabled={!f.unitId.trim() || !f.tenant.trim() || !f.moveOutDate}
                onClick={() => onAdd({ id: uid("mo_"), ...f, requestedAt: nowISO(), state: "open",
                  deposit: { original: "", deductions: [], refund: "", method: "" }, steps: {},
                  history: [{ at: nowISO(), by: "Logged by staff", text: "Move-out request recorded." }] })}>
          Create
        </button>
        <button className="op-btn op-btn--ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function MoveoutCard({ mo, isAdmin, onConfirm, onUndo, onPatch, onCancel, onVacate, onDelete }) {
  const [confirmVac, setConfirmVac] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);
  const [inspAt, setInspAt] = useState("");
  const [reportNote, setReportNote] = useState("");
  const [ded, setDed] = useState({ label: "", amount: "", evidence: "" });
  const [method, setMethod] = useState("");

  const t = unitType(mo.unitId);
  const dep = mo.deposit || { deductions: [] };
  const deds = dep.deductions || [];
  const noticed = !!mo.steps?.notice;
  // Before notice, count everything proposed. After notice, only what the tenant accepted or what was upheld.
  const dedTotal = deds
    .filter((d) => (noticed ? COUNTED.includes(d.state) : d.state !== "withdrawn"))
    .reduce((s, d) => s + Number(d.amount || 0), 0);
  const pendingDed = deds.filter((d) => !["accepted", "upheld", "withdrawn"].includes(d.state)).length;
  const refund = Number(dep.original || 0) - dedTotal;
  const deadline = mo.moveOutDate ? addDays(mo.moveOutDate, REFUND_DAYS) : null;
  const left = deadline ? daysUntil(deadline) : null;
  const curIdx = STEPS.findIndex((s) => !mo.steps?.[s.k]);
  const current = curIdx === -1 ? null : STEPS[curIdx];

  return (
    <section className="op-card op-mo">
      <div className="op-moh">
        <span className="op-mono op-unit">{mo.unitId}</span>
        {t && <><span className="op-mono op-type">{t}</span><span className="op-tag">{BED[t]}</span></>}
        <strong>{mo.tenant}</strong>
        <span className="op-dim">{mo.phone} · {mo.email}</span>
        <span className="op-dim op-right op-mono">Moves out {mo.moveOutDate}</span>
        {deadline && !mo.steps?.refunded && (
          <span className="op-badge"
                style={{ "--c": left < 0 ? "#B23A54" : left <= REMIND_BEFORE ? "#C98A15" : "#1C6FA6" }}>
            Refund due {deadline} ({left < 0 ? `${-left} days overdue` : left === 0 ? "today" : `${left} days left`})
          </span>
        )}
      </div>

      <div className="op-steps">
        {STEPS.map((s, i) => {
          const done = mo.steps?.[s.k];
          const isCur = current?.k === s.k;
          return (
            <div className={`op-step ${done ? "done" : isCur ? "cur" : "todo"}`} key={s.k}>
              <span className="op-sn">{done ? "✓" : i + 1}</span>
              <div className="op-sb">
                <strong>{s.label}</strong>
                <span className="op-dim">{done ? `${fmt(done.at)} · ${done.by}` : s.desc}</span>
                {done && s.k === "inspection" && done.at_datetime &&
                  <span className="op-dim">Inspection at {done.at_datetime}</span>}
                {done && s.k === "report" && done.note && <span className="op-dim">{done.note}</span>}
                {done && s.k === "refunded" && done.method && <span className="op-dim">Paid by {done.method}</span>}
              </div>
              {done && isAdmin && (
                <button className="op-btn op-btn--xs op-btn--ghost" onClick={() => onUndo(s.k)}>
                  Roll back to here
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Confirming vacancy releases the stall and the unit */}
      <div className={`op-vacate ${mo.vacatedAt ? "done" : ""}`}>
        {mo.vacatedAt ? (
          <>
            <strong>Confirmed vacated</strong>
            <span className="op-dim">{fmt(mo.vacatedAt)} · {mo.vacatedBy} — stall released, unit back on the market</span>
          </>
        ) : confirmVac ? (
          <>
            <span>
              Confirming does three things at once: releases this unit’s stall, promotes the earliest waiting request in that area,
              and puts the unit back on the market. Has the tenant actually moved out?
            </span>
            <button className="op-btn" onClick={() => { onVacate(); setConfirmVac(false); }}>Yes, vacated</button>
            <button className="op-btn op-btn--ghost" onClick={() => setConfirmVac(false)}>Back</button>
          </>
        ) : (
          <>
            <strong>Has the tenant moved out?</strong>
            <span className="op-dim">The stall and unit are only released once you confirm. The deposit steps carry on either way.</span>
            <button className="op-btn op-btn--sm" onClick={() => setConfirmVac(true)}>Confirm vacated</button>
          </>
        )}
      </div>

      {/* The step currently waiting for confirmation */}
      {current && (
        <div className="op-action">
          <div className="op-actionh">Next: {current.label}</div>

          {current.k === "inspection" && (
            <input className="op-in" type="datetime-local" value={inspAt}
                   onChange={(e) => setInspAt(e.target.value)} />
          )}
          {current.k === "report" && (
            <input className="op-in" value={reportNote}
                   placeholder="Report summary, e.g. walls show normal wear, carpet needs cleaning"
                   onChange={(e) => setReportNote(e.target.value)} />
          )}
          {current.k === "notice" && (
            <div className="op-settle">
              <label className="op-f"><span>Deposit held</span>
                <input className="op-in" type="number" value={dep.original || ""}
                       onChange={(e) => onPatch({ deposit: { ...dep, original: e.target.value } })} /></label>

              <div className="op-deds">
                {(dep.deductions || []).map((d, i) => (
                  <div className="op-ded op-ded--full" key={i}>
                    <div className="op-dedh">
                      <strong>{d.label}</strong>
                      <span className="op-mono">{money(d.amount)}</span>
                      <button className="op-x" onClick={() => onPatch({ deposit: { ...dep,
                        deductions: dep.deductions.filter((_, j) => j !== i) } })}>×</button>
                    </div>
                    <div className="op-dim">Basis and evidence: {d.evidence || "not recorded — a deduction without evidence rarely holds"}</div>
                  </div>
                ))}
                <div className="op-dedadd">
                  <input className="op-in" value={ded.label} placeholder="Deduction"
                         onChange={(e) => setDed({ ...ded, label: e.target.value })} />
                  <input className="op-in" type="number" value={ded.amount} placeholder="Amount"
                         onChange={(e) => setDed({ ...ded, amount: e.target.value })} />
                  <input className="op-in" value={ded.evidence} placeholder="Basis and evidence: photo reference, quote, report section"
                         onChange={(e) => setDed({ ...ded, evidence: e.target.value })} />
                  <button className="op-btn op-btn--xs" disabled={!ded.label.trim() || !ded.amount}
                          onClick={() => { onPatch({ deposit: { ...dep, deductions:
                            [...(dep.deductions || []), { ...ded, state: "proposed" }] } });
                            setDed({ label: "", amount: "", evidence: "" }); }}>
                    Add
                  </button>
                </div>
              </div>

              <div className="op-calc">
                <span>Deposit {money(dep.original)}</span>
                <span>Proposed deductions {money(dedTotal)}</span>
                <strong>Proposed refund {money(refund)}</strong>
              </div>
              {refund < 0 && <div className="op-bad">Deductions exceed the deposit. The balance has to be claimed separately; it cannot be forced out of the deposit.</div>}
              <p className="op-note" style={{ margin: 0 }}>
                Confirming means this list has gone to the tenant. Only then does the response stage open;
                deducting without notifying first is the most common way these are lost. If nothing is being deducted, leave the list empty and confirm.
              </p>
            </div>
          )}

          {current.k === "response" && (
            <div className="op-settle">
              {(dep.deductions || []).length === 0 ? (
                <p className="op-note" style={{ margin: 0 }}>No deductions, so confirm to move on to the refund.</p>
              ) : (
                <div className="op-deds">
                  {(dep.deductions || []).map((d, i) => {
                    const st = DED_STATE[d.state || "notified"];
                    const setD = (p) => onPatch({ deposit: { ...dep,
                      deductions: dep.deductions.map((x, j) => (j === i ? { ...x, ...p } : x)) } });
                    return (
                      <div className="op-ded op-ded--full" key={i}>
                        <div className="op-dedh">
                          <span className="op-badge" style={{ "--c": st.color }}>{st.label}</span>
                          <strong>{d.label}</strong>
                          <span className="op-mono op-right">{money(d.amount)}</span>
                        </div>
                        <div className="op-dim">Basis: {d.evidence || "not recorded"}</div>

                        {["notified", "proposed"].includes(d.state || "notified") && (
                          <div className="op-dedact">
                            <button className="op-btn op-btn--xs"
                                    onClick={() => setD({ state: "accepted", respondedAt: nowISO() })}>
                              Tenant accepts
                            </button>
                            <button className="op-btn op-btn--xs op-btn--ghost"
                                    onClick={() => setD({ state: "disputed", respondedAt: nowISO() })}>
                              Tenant disputes
                            </button>
                          </div>
                        )}

                        {d.state === "disputed" && (
                          <>
                            <input className="op-in" value={d.tenantSays || ""}
                                   placeholder="What the tenant said, in their words — this is part of the record"
                                   onChange={(e) => setD({ tenantSays: e.target.value })} />
                            <input className="op-in" value={d.disputeEvidence || ""}
                                   placeholder="Evidence the tenant provided: photos, messages, receipts"
                                   onChange={(e) => setD({ disputeEvidence: e.target.value })} />
                            <div className="op-dedact">
                              <button className="op-btn op-btn--xs op-btn--ghost"
                                      onClick={() => setD({ state: "withdrawn", resolvedAt: nowISO() })}>
                                Withdraw this deduction
                              </button>
                              <button className="op-btn op-btn--xs"
                                      disabled={!(d.upheldBasis || "").trim()}
                                      onClick={() => setD({ state: "upheld", resolvedAt: nowISO(),
                                                            upheldNoticeAt: nowISO() })}>
                                Uphold after notice
                              </button>
                            </div>
                            <input className="op-in" value={d.upheldBasis || ""}
                                   placeholder="Basis for upholding it. Required, and the tenant must be notified again in writing"
                                   onChange={(e) => setD({ upheldBasis: e.target.value })} />
                            <div className="op-bad">
                              Upholding a disputed deduction can end up at RTDRS. Before you do, be sure the evidence is strong
                              and that it is not normal wear. Withdrawing a small deduction is usually cheaper than fighting over it.
                            </div>
                          </>
                        )}

                        {["accepted", "upheld", "withdrawn"].includes(d.state) && (
                          <div className="op-dedact">
                            <span className="op-dim">
                              {d.state === "withdrawn" ? "Withdrawn, not deducted"
                                : `Deducting ${money(d.amount)}`}
                              {d.resolvedAt ? ` · ${fmt(d.resolvedAt)}` : ""}
                            </span>
                            <button className="op-btn op-btn--xs op-btn--ghost"
                                    onClick={() => setD({ state: "notified", resolvedAt: null })}>
                              Back to unresolved
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="op-calc">
                <span>Deposit {money(dep.original)}</span>
                <span>Confirmed deductions {money(dedTotal)}</span>
                <strong>Refund due {money(refund)}</strong>
              </div>
              {pendingDed > 0 && (
                <div className="op-bad">{pendingDed} deduction(s) still have no tenant response. Resolve them before the refund.</div>
              )}
            </div>
          )}
          {current.k === "refunded" && (
            <>
              <div className="op-calc"><strong>Refund due {money(refund)}</strong></div>
              <input className="op-in" value={method}
                     placeholder="How it was paid and the reference, e.g. e-Transfer to wchen@example.com"
                     onChange={(e) => setMethod(e.target.value)} />
            </>
          )}

          <div className="op-actions">
            <button className="op-btn"
                    disabled={
                      (current.k === "inspection" && !inspAt) ||
                      (current.k === "report" && !reportNote.trim()) ||
                      (current.k === "notice" && (!dep.original || refund < 0)) ||
                      (current.k === "response" && pendingDed > 0) ||
                      (current.k === "refunded" && !method.trim())
                    }
                    onClick={() => {
                      if (current.k === "notice") {
                        onPatch({ deposit: { ...dep, deductions: deds.map((d) =>
                          d.state === "proposed" ? { ...d, state: "notified", notifiedAt: nowISO() } : d) } });
                        onConfirm("notice", { items: deds.length, proposed: dedTotal });
                      } else {
                        onConfirm(current.k,
                          current.k === "inspection" ? { at_datetime: inspAt } :
                          current.k === "report" ? { note: reportNote } :
                          current.k === "response" ? { final: dedTotal, refund } :
                          current.k === "refunded" ? { method, amount: refund } : {});
                      }
                    }}>
              Confirm: {current.label}
            </button>
            {!cancelling ? (
              <button className="op-btn op-btn--ghost" onClick={() => setCancelling(true)}>Cancel the workflow</button>
            ) : (
              <>
                <input className="op-in" value={cancelReason} placeholder="Reason"
                       style={{ maxWidth: 200 }} onChange={(e) => setCancelReason(e.target.value)} />
                <button className="op-btn op-btn--danger" onClick={() => onCancel(cancelReason)}>Confirm cancel</button>
                <button className="op-btn op-btn--ghost" onClick={() => setCancelling(false)}>Back</button>
              </>
            )}
            {isAdmin && (confirmDel ? (
              <>
                <span className="op-dim">Deleting cannot be undone</span>
                <button className="op-btn op-btn--danger" onClick={onDelete}>Confirm delete</button>
                <button className="op-btn op-btn--ghost" onClick={() => setConfirmDel(false)}>Back</button>
              </>
            ) : (
              <button className="op-btn op-btn--ghost" onClick={() => setConfirmDel(true)}>Delete workflow</button>
            ))}
          </div>
        </div>
      )}

      {(mo.history || []).length > 0 && (
        <details className="op-hist">
          <summary>History ({mo.history.length})</summary>
          {mo.history.slice().reverse().map((h, i) => (
            <div className="op-hi" key={i}>
              <span className="op-mono op-dim">{fmt(h.at)}</span>
              <span className="op-dim">{h.by}</span>
              <span>{h.text}</span>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=Archivo:wght@700;800&display=swap');
.op{--ink:#131C25;--ink2:#3E4C5A;--dim:#78899A;--paper:#fff;--ground:#E9EDF0;--rule:#D3DBE1;
  --amber:#FFF6E0;--amberline:#E8C877;--red:#B23A54;--green:#0E8577;--accent:#1C6FA6;
  background:var(--ground);color:var(--ink);min-height:100vh;font-size:14px;line-height:1.55;
  font-family:'IBM Plex Sans','PingFang TC','Microsoft JhengHei',system-ui,sans-serif;padding-bottom:44px}
.op *{box-sizing:border-box}
.op-mono{font-family:'IBM Plex Mono',monospace;font-variant-numeric:tabular-nums}
.op-dim{color:var(--dim);font-size:12px}
.op-strong{font-weight:600}
.op-right{margin-left:auto}
.op-load{padding:80px 20px;text-align:center;color:var(--dim)}

.op-head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;
  padding:24px 28px 16px;background:var(--paper);border-bottom:1px solid var(--rule)}
.op-eyebrow{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.13em;
  text-transform:uppercase;color:var(--dim)}
.op-head h1{font-family:'Archivo','PingFang TC',sans-serif;font-weight:800;font-size:24px;
  letter-spacing:-.02em;margin:4px 0 0}
.op-headr{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.op-chip{font-size:11px;font-weight:700;color:#fff;border-radius:9px;padding:3px 10px}
.op-save{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--dim);padding:4px 9px;
  border:1px solid var(--rule);border-radius:3px}
.op-save--saved{color:var(--green);border-color:var(--green)}
.op-save--error{color:var(--red);border-color:var(--red)}

.op-tabs{display:flex;padding:0 28px;background:var(--paper);border-bottom:1px solid var(--rule)}
.op-tabs button{font:inherit;font-weight:600;font-size:13.5px;cursor:pointer;background:none;border:0;
  padding:12px 18px;color:var(--dim);border-bottom:2px solid transparent;margin-bottom:-1px;
  display:flex;align-items:center;gap:7px}
.op-tabs button.on{color:var(--ink);border-bottom-color:var(--ink)}
.op-b{font-style:normal;font-family:'IBM Plex Mono',monospace;font-size:10px;background:var(--red);
  color:#fff;border-radius:8px;padding:1px 6px}

.op-btn{font:inherit;font-weight:600;font-size:13px;cursor:pointer;background:var(--ink);color:#fff;
  border:1px solid var(--ink);padding:8px 15px;border-radius:3px}
.op-btn:hover:not(:disabled){background:#000}
.op-btn:disabled{opacity:.4;cursor:not-allowed}
.op-btn--ghost{background:transparent;color:var(--ink2);border-color:var(--rule)}
.op-btn--ghost:hover:not(:disabled){background:var(--ground);color:var(--ink)}
.op-btn--danger{background:var(--red);border-color:var(--red)}
.op-btn--xs{padding:4px 10px;font-size:11.5px}
.op-btn:focus-visible,.op-in:focus-visible,.op-sel:focus-visible,.op-tabs button:focus-visible,
.op-opts button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

.op-in,.op-sel{font:inherit;font-size:13px;padding:7px 10px;border:1px solid var(--amberline);
  border-radius:3px;background:var(--amber);color:var(--ink);width:100%;min-width:0}
.op-sel{background:var(--paper);border-color:var(--rule);cursor:pointer}

.op-body{padding:18px 28px;display:flex;flex-direction:column;gap:14px;max-width:1100px}
.op-note{color:var(--dim);font-size:12.5px;margin:0 0 4px;line-height:1.65}
.op-admin{color:var(--accent)}
.op-empty{color:var(--dim);font-size:12.5px;padding:26px 0;text-align:center;background:var(--paper);
  border:1px dashed var(--rule);border-radius:4px}
.op-card{background:var(--paper);border:1px solid var(--rule);border-radius:4px;padding:18px 20px;
  display:flex;flex-direction:column;gap:12px}
.op-card h2{font-family:'Archivo',sans-serif;font-weight:700;font-size:15px;margin:0;
  display:flex;align-items:center;gap:8px}
.op-n{font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:500;color:var(--dim);
  border:1px solid var(--rule);border-radius:10px;padding:0 8px}
.op-warn{background:#FFF8E6;border:1px solid var(--amberline);border-radius:4px;padding:11px 14px;
  font-size:12px;color:#7A5D14;line-height:1.7}
.op-barrow{display:flex;gap:12px;align-items:center;flex-wrap:wrap}

/* Showing outcomes */
.op-queue{display:flex;flex-direction:column;gap:12px}
.op-confirm{background:var(--paper);border:1px solid var(--amberline);border-left:4px solid var(--amberline);
  border-radius:4px;padding:15px 18px;display:flex;flex-direction:column;gap:10px}
.op-confirm.overdue{border-color:var(--red);border-left-color:var(--red);background:#FFFCFC}
.op-ch{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.op-when{font-size:11px;font-weight:700;color:#fff;background:#C98A15;border-radius:9px;padding:2px 9px}
.op-confirm.overdue .op-when{background:var(--red)}
.op-cbody{display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:13.5px}
.op-unit{font-size:15px;font-weight:600}
.op-type{font-size:13px;color:var(--accent);font-weight:600}
.op-tag{font-size:11px;border:1px solid var(--rule);border-radius:9px;padding:1px 8px;color:var(--ink2)}
.op-q{font-size:13px;font-weight:600;color:var(--ink2);margin-top:2px}
.op-opts{display:flex;gap:6px;flex-wrap:wrap}
.op-opts button{font:inherit;font-size:12.5px;cursor:pointer;background:var(--paper);
  border:1px solid var(--rule);border-radius:3px;padding:8px 14px;color:var(--ink2)}
.op-opts button.on{background:var(--c);color:#fff;border-color:var(--c);font-weight:600}

.op-list{display:flex;flex-direction:column;gap:1px;background:var(--rule);border:1px solid var(--rule);
  border-radius:3px;overflow:hidden}
.op-row{display:flex;align-items:center;gap:9px;padding:8px 12px;background:var(--paper);
  font-size:12.5px;flex-wrap:wrap}
.op-badge{font-size:10.5px;font-weight:700;color:#fff;background:var(--c);border-radius:9px;padding:1px 8px}

/* Move-out */
.op-add{background:var(--paper);border:1px solid var(--rule);border-radius:4px;padding:14px 16px;
  display:flex;flex-direction:column;gap:10px}
.op-addrow{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
.op-addrow label{display:flex;flex-direction:column;gap:4px;flex:1 1 130px}
.op-addrow label span{font-size:12px;font-weight:600;color:var(--ink2)}
.op-addrow label em{font-style:normal;font-size:11px;color:var(--dim)}

.op-mo{border-left:3px solid var(--accent)}
.op-moh{display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:13.5px;
  padding-bottom:10px;border-bottom:1px solid var(--rule)}

.op-steps{display:flex;flex-direction:column;gap:1px;background:var(--rule);border:1px solid var(--rule);
  border-radius:3px;overflow:hidden}
.op-step{display:flex;align-items:flex-start;gap:11px;padding:9px 12px;background:var(--paper)}
.op-step.done{background:#F6FBF8}
.op-step.cur{background:#F2F7FB}
.op-step.todo{opacity:.55}
.op-sn{flex:0 0 22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:700;background:var(--ground);
  color:var(--dim)}
.op-step.done .op-sn{background:var(--green);color:#fff}
.op-step.cur .op-sn{background:var(--accent);color:#fff}
.op-sb{display:flex;flex-direction:column;gap:1px;flex:1;min-width:0}
.op-sb strong{font-size:13px}

.op-action{border:1px solid var(--accent);border-radius:3px;padding:13px 15px;background:#FCFDFE;
  display:flex;flex-direction:column;gap:10px}
.op-actionh{font-size:12.5px;font-weight:700;color:var(--accent)}
.op-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}

.op-settle{display:flex;flex-direction:column;gap:9px}
.op-f{display:flex;flex-direction:column;gap:4px;max-width:200px}
.op-f>span{font-size:12px;font-weight:600;color:var(--ink2)}
.op-deds{display:flex;flex-direction:column;gap:5px}
.op-ded{display:flex;align-items:center;gap:9px;font-size:12.5px;border:1px solid var(--rule);
  border-radius:3px;padding:5px 10px}
.op-ded>span:first-child{flex:1}
.op-x{border:0;background:none;cursor:pointer;color:var(--dim);font-size:15px;line-height:1;padding:0 3px}
.op-x:hover{color:var(--red)}
.op-dedadd{display:flex;gap:7px;align-items:center;flex-wrap:wrap}
.op-dedadd .op-in{flex:1 1 110px;width:auto}
.op-ded--full{flex-direction:column;align-items:stretch;gap:6px;padding:9px 11px}
.op-dedh{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.op-dedh strong{font-size:13px}
.op-dedact{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin-top:2px}
.op-card--urgent{border-color:var(--red)}
.op-vacate{display:flex;gap:10px;align-items:center;flex-wrap:wrap;border:1px solid var(--amberline);
  background:#FFFCF3;border-radius:3px;padding:11px 13px;font-size:12.5px;color:var(--ink2)}
.op-vacate.done{border-color:var(--green);background:#F6FBF8}
.op-vacate strong{font-size:13px}
.op-calc{display:flex;gap:16px;align-items:baseline;font-size:12.5px;flex-wrap:wrap;
  border-top:1px solid var(--rule);padding-top:8px}
.op-calc strong{font-size:14px;font-family:'IBM Plex Mono',monospace}
.op-bad{font-size:12px;color:var(--red);background:#FDF6F7;border:1px solid var(--red);
  border-radius:3px;padding:7px 10px}

.op-hist{font-size:12px}
.op-hist summary{cursor:pointer;color:var(--dim);font-size:12px;padding:4px 0}
.op-hi{display:flex;gap:9px;padding:4px 0 4px 12px;border-left:2px solid var(--rule);flex-wrap:wrap}

.op-foot{padding:4px 28px 0;color:var(--dim);font-size:11.5px;max-width:90ch;line-height:1.7}

@media (max-width:720px){
  .op-head,.op-tabs,.op-body,.op-foot{padding-left:16px;padding-right:16px}
  .op-right{margin-left:0;width:100%}
}
`;
