import React, { useState, useEffect, useMemo, useCallback } from "react";
import api from "../lib/api.js";

/* ============================================================
   BAYDO POINTE — Schedule, daily task list and signing approval
   Reminder rule: reminders go out on the previous business day.
   So a Monday event is flagged on Friday, and observed holidays push it back further.
   ============================================================ */

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const wdOf = (s) => WD[parse(s).getDay()];
const pretty = (s) => `${s.slice(5, 7)}/${s.slice(8, 10)} (${wdOf(s)})`;

/* Alberta general holidays. Check these against your own calendar.
      Heritage Day (first Monday in August) is optional in Alberta, so it is not listed. */
const DEFAULT_HOLIDAYS = [
  "2026-09-07", // Labour Day
  "2026-10-12", // Thanksgiving
  "2026-11-11", // Remembrance Day
  "2026-12-25", // Christmas Day
  "2027-01-01", // New Year's Day
];

const isWeekend = (s) => [0, 6].includes(parse(s).getDay());
const isBiz = (s, hol) => !isWeekend(s) && !hol.includes(s);

/** Previous business day. Monday resolves to Friday; holidays push it back further. */
function prevBizDay(dateStr, hol) {
  let d = addDays(dateStr, -1);
  let guard = 0;
  while (!isBiz(d, hol) && guard++ < 30) d = addDays(d, -1);
  return d;
}

const TYPE_META = {
  showing:     { label: "Showing",      icon: "◱", color: "#1C6FA6", dur: 30 },
  signing:     { label: "Online signing",icon: "✓", color: "#0E8577", dur: 45 },
  keys:        { label: "Key handover", icon: "⚿", color: "#7C5CBF", dur: 30 },
  maintenance: { label: "Vendor visit",  icon: "✱", color: "#C98A15", dur: 60 },
  followup:    { label: "Follow-up",     icon: "→", color: "#C98A15", dur: 15 },
  review:      { label: "Draft to review",icon: "✎", color: "#8B5CF6", dur: 10 },
  move_in:     { label: "Move-in elevator", icon: "⇥", color: "#0E8577", dur: 120 },
  move_out:    { label: "Move-out elevator",icon: "⇤", color: "#7C5CBF", dur: 120 },
};

const nowISO = () => new Date().toISOString();
const CHANNEL_DEFAULT = {
  showing: "email", signing: "email", keys: "both", maintenance: "both",
  followup: "email", review: "email",
};
const CONFIRM_STATE = {
  none: { label: "Not sent", color: "#78899A" },
  sent: { label: "Confirmation sent", color: "#1C6FA6" },
  confirmed: { label: "Confirmed", color: "#0E8577" },
  declined: { label: "Declined", color: "#B23A54" },
};
const EVENT_OWNER = {
  showing: { label: "Building Manager", roles: ["admin", "property_manager", "building_manager"] },
  signing: { label: "Property Manager", roles: ["admin", "property_manager"] },
  keys: { label: "Building Manager", roles: ["admin", "building_manager"] },
  maintenance: { label: "Building Manager", roles: ["admin", "building_manager"] },
  followup: { label: "Leasing", roles: ["admin", "property_manager", "building_manager"] },
  review: { label: "Property Manager", roles: ["admin", "property_manager"] },
  move_in: { label: "Building Manager", roles: ["admin", "property_manager", "building_manager"] },
  move_out: { label: "Building Manager", roles: ["admin", "property_manager", "building_manager"] },
};

function fromApiEvent(e) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Edmonton",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
    minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(e.starts_at));
  const get = (k) => parts.find((p) => p.type === k)?.value;
  return { ...e, date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`, unit: e.unit_number || "—",
    name: e.contact_name || "Internal", contact: e.contact_info || "",
    /* The label is role-based for legacy showings that were incorrectly
       assigned to a PM. Migration 015 fixes the stored owner as well. */
    assignee: e.type === "showing" && e.assignee_role !== "building_manager"
      ? "Building Manager" : e.owner_name || e.assignee || null,
    sign: e.signing_state || undefined,
    confirm_state: e.confirmation_state || "none",
    confirm_channel: e.confirmation_channel || undefined,
    confirm_sent_at: e.confirmation_sent_at || undefined };
}

function fromMoveBooking(booking) {
  const from = String(booking.time_from || "").slice(0, 5);
  const to = String(booking.time_to || "").slice(0, 5);
  return {
    ...booking,
    id: booking.id,
    is_move_booking: true,
    type: booking.direction,
    date: String(booking.move_date).slice(0, 10),
    time: from,
    end_time: to,
    unit: booking.unit_number,
    name: booking.tenant_name,
    contact: booking.tenant_email,
    assignee: "Building Manager",
    state: ["declined", "cancelled"].includes(booking.status)
      ? "cancelled" : booking.status === "completed" ? "done" : "booked",
    move_status: booking.status,
  };
}

const normaliseStoredEvent = (event) =>
  event.type === "showing" && event.assignee === "Bowen Wang"
    ? { ...event, assignee: "Building Manager" }
    : event;

const SIGN_STATES = {
  pending_review: { label: "Awaiting approval",  color: "#C98A15" },
  approved:       { label: "Approved, not sent", color: "#1C6FA6" },
  sent:           { label: "Signing link sent",  color: "#0E8577" },
  signed:         { label: "Signed by both",     color: "#0E8577" },
};

function seedEvents() {
  const t = iso(new Date());
  const next = (n) => addDays(t, n);
  return [
    { id: "e1", type: "showing", date: t,       time: "10:00", unit: "370-412", name: "Jenny Tran",   contact: "j.tran@example.com",  state: "booked" },
    { id: "e2", type: "review",  date: t,       time: "11:30", unit: "—",       name: "3 complaint drafts", contact: "Review queue",              state: "booked" },
    { id: "e3", type: "showing", date: t,       time: "14:30", unit: "374-206", name: "Wei-Lun Chen",     contact: "wchen@example.com",   state: "booked" },
    { id: "e4", type: "showing", date: next(1), time: "11:00", unit: "378-315", name: "Priya Nair",   contact: "+1 780 555 0177",     state: "booked" },
    { id: "e5", type: "showing", date: next(3), time: "09:30", unit: "370-501", name: "Ahmed Farouk", contact: "a.farouk@example.com",state: "booked" },
    { id: "e6", type: "signing", date: next(3), time: "15:00", unit: "378-519", name: "Lily Kwan",    contact: "lily.k@example.com",  state: "booked", sign: "pending_review" },
    { id: "e7", type: "followup",date: next(4), time: "10:00", unit: "374-311", name: "No reply after showing", contact: "m.ross@example.com",  state: "booked" },
    { id: "e8", type: "signing", date: next(5), time: "13:00", unit: "370-118", name: "Sam Oduya",    contact: "s.oduya@example.com", state: "booked", sign: "pending_review" },
  ];
}

/** Sending, and asking the other side to agree. A step waiting on a
 *  confirmation does not advance on the assumption that a message was read —
 *  a booking nobody confirmed is a trip to a locked door. */
function ConfirmBar({ ev, onSend, onMark }) {
  const [channel, setChannel] = useState(ev.confirm_channel ?? CHANNEL_DEFAULT[ev.type] ?? "email");
  const st = CONFIRM_STATE[ev.confirm_state ?? "none"];
  return (
    <div className="sc-confirm">
      <span className="sc-cstate" style={{ "--c": st.color }}>{st.label}</span>
      {(ev.confirm_state ?? "none") === "none" ? (
        <>
          <div className="sc-chan">
            {[["email", "Email"], ["sms", "Text"], ["both", "Both"]].map(([k, l]) => (
              <button key={k} className={channel === k ? "on" : ""}
                      onClick={() => setChannel(k)}>{l}</button>
            ))}
          </div>
          <button className="sc-btn sc-btn--xs" onClick={() => onSend(ev, channel)}>
            Send confirmation
          </button>
        </>
      ) : (
        <>
          <span className="sc-dim">
            {ev.confirm_channel === "both" ? "email and text"
              : ev.confirm_channel === "sms" ? "text" : "email"}
            {ev.confirm_sent_at ? ` · ${String(ev.confirm_sent_at).slice(5, 16).replace("T", " ")}` : ""}
          </span>
          {ev.confirm_state === "sent" && (
            <>
              <button className="sc-btn sc-btn--xs sc-btn--ghost"
                      onClick={() => onMark(ev, "confirmed")}>Mark confirmed</button>
              <button className="sc-btn sc-btn--xs sc-btn--ghost"
                      onClick={() => onMark(ev, "declined")}>Declined</button>
            </>
          )}
          {ev.confirm_state === "declined" && (
            <span className="sc-bad">Offer another time — this one does not work.</span>
          )}
        </>
      )}
    </div>
  );
}

export default function ScheduleConsole({ session }) {
  const [today, setToday] = useState(iso(new Date()));
  const [events, setEvents] = useState(seedEvents);
  const [holidays, setHolidays] = useState(DEFAULT_HOLIDAYS);
  const [agent, setAgent] = useState("");
  const [done, setDone] = useState({});
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState("idle");
  const [form, setForm] = useState({ open: false, type: "showing", unit: "", name: "", contact: "",
                                     date: iso(new Date()), time: "10:00" });
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [staff, setStaff] = useState([]);
  const [apiMode, setApiMode] = useState(false);

  /* ---------- Load and save ---------- */
  useEffect(() => {
    (async () => {
      try {
        const [eventResult, moveResult] = await Promise.allSettled([
          api.get("/events"), api.moveBookings(),
        ]);
        if (eventResult.status !== "fulfilled") throw eventResult.reason;
        const remote = eventResult.value;
        const moves = moveResult.status === "fulfilled"
          ? (moveResult.value.bookings ?? []).map(fromMoveBooking) : [];
        setEvents([...(remote.events ?? []).map(fromApiEvent), ...moves]);
        setStaff(remote.staff ?? []); setApiMode(true); setLoading(false); return;
      } catch {}
      try {
        const r = await window.storage.get("baydo:schedule");
        if (r?.value) {
          const s = JSON.parse(r.value);
          if (s.events) {
            const normalised = s.events.map(normaliseStoredEvent);
            setEvents(normalised);
            if (normalised.some((event, i) => event !== s.events[i]))
              try { await window.storage.set("baydo:schedule", JSON.stringify({ ...s, events: normalised })); } catch {}
          }
          if (s.holidays) setHolidays(s.holidays);
          if (s.done) setDone(s.done);
          if (s.agent) setAgent(s.agent);
        }
      } catch (e) {}
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (session?.name && !agent) setAgent(session.name);
  }, [session?.name]);

  const persist = useCallback(async (next) => {
    setSaveState("saving");
    try {
      const ok = await window.storage.set("baydo:schedule", JSON.stringify(next));
      setSaveState(ok ? "saved" : "error");
    } catch (e) { setSaveState("error"); }
    setTimeout(() => setSaveState((s) => (s === "saved" ? "idle" : s)), 1500);
  }, []);

  const save = (patch) => {
    const next = { events, holidays, done, agent, ...patch };
    if (patch.events) setEvents(patch.events);
    if (patch.holidays) setHolidays(patch.holidays);
    if (patch.done) setDone(patch.done);
    if (patch.agent !== undefined) setAgent(patch.agent);
    persist(next);
  };

  /* ---------- Confirmations ----------
     Queued rather than sent from here. A provider outage should delay a
     message, not lose it and leave nobody knowing which ones went missing. */
  const sendConfirmation = async (ev, channel) => {
    const when = `${ev.date} ${ev.time}`;
    const body = [
      `We have you booked for ${TYPE_META[ev.type]?.label ?? ev.type} at ${ev.unit ?? "our office"} on ${when}.`,
      "Reply to confirm, or tell us if another time suits you better.",
      "",
      `已為你預約 ${when}${ev.unit ? `，${ev.unit}` : ""}。`,
      "回覆確認即可，時間不方便的話也請告訴我們。",
    ].join("\n");

    let queue = [];
    try {
      const r = await window.storage.get("baydo:outbox");
      if (r?.value) queue = JSON.parse(r.value);
    } catch (e) {}
    const msg = { id: "ob_" + Date.now().toString(36), kind: `${ev.type}_confirm`,
      channel, to_name: ev.name, to: ev.contact, body, ref_type: "event", ref_id: ev.id,
      state: "queued", created_at: nowISO() };
    try { await window.storage.set("baydo:outbox", JSON.stringify([msg, ...queue])); } catch (e) {}

    if (apiMode) {
      await api.patch(`/events/${ev.id}`, { confirmation_state: "sent", confirmation_channel: channel });
      const remote = await api.get("/events"); setEvents((remote.events ?? []).map(fromApiEvent));
    } else save({ events: events.map((x) => x.id === ev.id
      ? { ...x, confirm_state: "sent", confirm_channel: channel, confirm_sent_at: nowISO() } : x) });
  };

  const markConfirmation = async (ev, state) => {
    if (apiMode) {
      await api.patch(`/events/${ev.id}`, { confirmation_state: state });
      const remote = await api.get("/events"); setEvents((remote.events ?? []).map(fromApiEvent));
    } else save({ events: events.map((x) => x.id === ev.id
      ? { ...x, confirm_state: state, confirm_responded_at: nowISO() } : x) });
  };

  /* ---------- Today's list ---------- */
  const owners = useMemo(() => [...new Set(events.map((e) =>
    e.assignee || EVENT_OWNER[e.type]?.label).filter(Boolean))].sort(), [events]);
  const canSee = useCallback((e) => {
    if (session?.role === "admin")
      return ownerFilter === "all" || (e.assignee || EVENT_OWNER[e.type]?.label) === ownerFilter;
    if (e.type === "showing")
      return ["property_manager", "building_manager"].includes(session?.role);
    if (!e.assignee || e.assignee === session?.name) return true;
    return EVENT_OWNER[e.type]?.roles?.includes(session?.role) ?? false;
  }, [session?.role, session?.name, ownerFilter]);

  const dayList = useMemo(
    () => events.filter((e) => e.date === today && e.state === "booked" && canSee(e))
                .sort((a, b) => a.time.localeCompare(b.time)),
    [events, today, canSee]
  );

  /* ---------- Reminders due today ---------- */
  const reminders = useMemo(() => {
    const groups = {};
    for (const e of events) {
      if (e.state !== "booked") continue;
      if (prevBizDay(e.date, holidays) !== today) continue;
      (groups[e.date] ||= []).push(e);
    }
    return Object.entries(groups).sort().map(([date, list]) => ({
      date, list: list.sort((a, b) => a.time.localeCompare(b.time)),
      gap: Math.round((parse(date) - parse(today)) / 86400000),
    }));
  }, [events, today, holidays]);

  const pendingSignings = useMemo(
    () => events.filter((e) => e.type === "signing" && e.sign === "pending_review")
                .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)),
    [events]
  );

  const reloadEvents = async () => {
    const [remote, moves] = await Promise.all([api.get("/events"), api.moveBookings()]);
    setEvents([...(remote.events ?? []).map(fromApiEvent),
      ...(moves.bookings ?? []).map(fromMoveBooking)]);
  };
  const setSign = async (id, sign) => {
    if (apiMode) { await api.patch(`/events/${id}`, { signing_state: sign }); await reloadEvents(); }
    else save({ events: events.map((e) => (e.id === id ? { ...e, sign, approvedBy: agent || "unsigned",
      approvedAt: new Date().toISOString() } : e)) });
  };

  const toggleDone = async (id) => {
    const move = events.find((e) => e.id === id && e.is_move_booking);
    if (move) { if (move.move_status === "confirmed") await api.completeMoveBooking(id);
      await reloadEvents(); return; }
    if (apiMode) { await api.patch(`/events/${id}`, { state: done[id] ? "booked" : "done" });
      setDone({ ...done, [id]: !done[id] }); await reloadEvents(); }
    else save({ done: { ...done, [id]: !done[id] } });
  };
  const cancel = async (id) => {
    const move = events.find((e) => e.id === id && e.is_move_booking);
    if (move) { await api.declineMoveBooking(id, "Please choose another time.");
      await reloadEvents(); return; }
    if (apiMode) { await api.patch(`/events/${id}`, { state: "cancelled" }); await reloadEvents(); }
    else save({ events: events.map((e) => (e.id === id ? { ...e, state: "cancelled" } : e)) });
  };

  const addEvent = async () => {
    if (!form.unit.trim() || !form.name.trim()) return;
    if (form.type === "showing" && !["admin", "building_manager"].includes(session?.role)) return;
    if (apiMode) {
      await api.post("/events", { type: form.type, date: form.date, time: form.time,
        unit_number: form.unit.trim() === "—" ? null : form.unit.trim(),
        contact_name: form.name.trim(), contact_info: form.contact.trim(),
        assignee_id: form.assignee_id || null, duration_min: TYPE_META[form.type]?.dur ?? 30 });
      await reloadEvents(); setForm({ ...form, open: false, unit: "", name: "", contact: "" }); return;
    }
    const e = { id: "e" + Date.now(), type: form.type, date: form.date, time: form.time,
                unit: form.unit.trim(), name: form.name.trim(), contact: form.contact.trim(),
                assignee: session?.name || null,
                state: "booked", ...(form.type === "signing" ? { sign: "pending_review" } : {}) };
    save({ events: [...events, e] });
    setForm({ ...form, open: false, unit: "", name: "", contact: "" });
  };

  const canManageEvent = useCallback((ev) =>
    ev.is_move_booking ? session?.role === "building_manager"
      : ev.type !== "showing" || ["admin", "building_manager"].includes(session?.role),
  [session?.role]);

  const decideMove = async (ev, decision) => {
    const note = decision === "decline"
      ? (window.prompt("Reason / another time suggestion (optional)") || "") : "";
    if (decision === "confirm") await api.confirmMoveBooking(ev.id, note);
    else await api.declineMoveBooking(ev.id, note);
    await reloadEvents();
  };

  const todayIsBiz = isBiz(today, holidays);

  if (loading) return <div className="sc"><style>{CSS}</style><div className="sc-load">Loading the schedule…</div></div>;

  return (
    <div className="sc">
      <style>{CSS}</style>

      <header className="sc-head">
        <div>
          <div className="sc-eyebrow">Baydo Pointe · Schedule and tasks</div>
          <h1>{pretty(today)}
            {!todayIsBiz && <span className="sc-off">Non-working day</span>}
          </h1>
        </div>
        <div className="sc-headr">
          <span className={`sc-save sc-save--${saveState}`}>
            {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved"
              : saveState === "error" ? "Save failed" : "Autosaves"}
          </span>
          <div className="sc-nav">
            <button onClick={() => setToday(addDays(today, -1))} aria-label="Previous day">‹</button>
            <button onClick={() => setToday(iso(new Date()))}>Today</button>
            <button onClick={() => setToday(addDays(today, 1))} aria-label="Next day">›</button>
          </div>
          {session?.role === "admin" && <select className="sc-sel" value={ownerFilter}
            onChange={(e) => setOwnerFilter(e.target.value)} aria-label="Schedule owner">
            <option value="all">All staff schedules</option>
            {owners.map((owner) => <option key={owner} value={owner}>{owner}</option>)}
          </select>}
          <button className="sc-btn" onClick={() => setForm({ ...form, open: !form.open, date: today,
            type: session?.role === "property_manager" && form.type === "showing" ? "signing" : form.type,
            assignee_id: "" })}>
            New booking
          </button>
        </div>
      </header>

      {form.open && (
        <div className="sc-form">
          <select className="sc-sel" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value, assignee_id: "" })}>
            {Object.entries(TYPE_META)
              .filter(([k]) => !["move_in", "move_out"].includes(k))
              .filter(([k]) => k !== "showing" || ["admin", "building_manager"].includes(session?.role))
              .map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <input className="sc-in" placeholder="Unit e.g. 370-412" value={form.unit}
                 onChange={(e) => setForm({ ...form, unit: e.target.value })} />
          <input className="sc-in" placeholder="Name" value={form.name}
                 onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="sc-in" placeholder="Email or phone" value={form.contact}
                 onChange={(e) => setForm({ ...form, contact: e.target.value })} />
          <input className="sc-in" type="date" value={form.date}
                 onChange={(e) => setForm({ ...form, date: e.target.value })} />
          <input className="sc-in" type="time" value={form.time}
                 onChange={(e) => setForm({ ...form, time: e.target.value })} />
          {session?.role === "admin" && <select className="sc-sel" value={form.assignee_id || ""}
            onChange={(e) => setForm({ ...form, assignee_id: e.target.value })}>
            <option value="">{form.type === "showing" ? "Assign automatically · Building Manager" : "Assign automatically"}</option>
            {staff.filter((person) => form.type !== "showing" || person.role_code === "building_manager")
              .map((person) => <option key={person.id} value={person.id}>{person.full_name} · {person.role_code}</option>)}
          </select>}
          <button className="sc-btn" onClick={addEvent}>Add</button>
        </div>
      )}

      <div className="sc-grid">
        {/* ── Today's task list ── */}
        <section className="sc-card">
          <h2>Today <span className="sc-n">{dayList.length}</span></h2>
          <p className="sc-note">Generated each morning and ordered by time. Tick an item to mark it done.</p>
          {dayList.length === 0 ? (
            <div className="sc-empty">Nothing scheduled for this day.</div>
          ) : (
            <div className="sc-timeline">
              {dayList.map((e) => {
                const m = TYPE_META[e.type];
                const isDone = !!done[e.id];
                const canManage = canManageEvent(e);
                return (
                  <div className={`sc-item ${isDone ? "done" : ""}`} key={e.id} style={{ "--c": m.color }}>
                    <div className="sc-time">
                      <strong>{e.time}</strong>
                      <em>{m.dur} min</em>
                      {(e.assignee || EVENT_OWNER[e.type]) && <span className="sc-owner">
                        {e.assignee || EVENT_OWNER[e.type].label}
                      </span>}
                    </div>
                    <div className="sc-body">
                      <div className="sc-item-h">
                        <span className="sc-tag">{m.icon} {m.label}</span>
                        <strong>{e.unit}</strong>
                        {e.type === "signing" && e.sign && (
                          <span className="sc-sign" style={{ "--s": SIGN_STATES[e.sign].color }}>
                            {SIGN_STATES[e.sign].label}
                          </span>
                        )}
                      </div>
                      <div className="sc-dim">{e.name} · {e.contact}</div>
                      {e.is_move_booking && <div className="sc-move-line">
                        <span className={`sc-move-status sc-move-status--${e.move_status}`}>{e.move_status}</span>
                        <span>{e.time}–{e.end_time}</span>
                        {e.notes && <span className="sc-dim">{e.notes}</span>}
                      </div>}
                      {e.type === "signing" && e.sign === "pending_review" && (
                        <div className="sc-block">
                          The lease has not been approved, so no signing link will go out. Handle it under Signing approval on the right.
                        </div>
                      )}
                      {e.is_move_booking ? (
                        canManage && e.move_status === "requested" ? <div className="sc-confirm">
                          <button className="sc-btn sc-btn--xs" onClick={() => decideMove(e, "confirm")}>Confirm elevator</button>
                          <button className="sc-btn sc-btn--xs sc-btn--ghost" onClick={() => decideMove(e, "decline")}>Decline</button>
                        </div> : <div className="sc-block">
                          {canManage ? "Building Manager decision recorded."
                            : "View only · Building Manager confirms this elevator booking."}
                        </div>
                      ) : canManage
                        ? <ConfirmBar ev={e} onSend={sendConfirmation} onMark={markConfirmation} />
                        : <div className="sc-block">View only · Building Manager handles this showing.</div>}
                    </div>
                    {canManage && (!e.is_move_booking || e.move_status === "confirmed") && <div className="sc-acts">
                      <button className="sc-chk" onClick={() => toggleDone(e.id)}
                              aria-label={isDone ? "Mark not done" : "Mark done"}>{isDone ? "✓" : ""}</button>
                      {!e.is_move_booking && <button className="sc-x" onClick={() => cancel(e.id)} aria-label="Cancel booking">×</button>}
                    </div>}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <div className="sc-side">
          {/* ── Reminders to send today ── */}
          <section className="sc-card">
            <h2>Reminders due today <span className="sc-n">{reminders.reduce((s, g) => s + g.list.length, 0)}</span></h2>
            <p className="sc-note">
              Reminders go out on the previous business day, which is why Monday’s bookings surface on Friday. Observed holidays push it back further.
            </p>
            {reminders.length === 0 ? (
              <div className="sc-empty">
                {todayIsBiz ? "No reminders due today." : "Not a working day, so no reminders go out."}
              </div>
            ) : reminders.map((g) => (
              <div className="sc-remgroup" key={g.date}>
                <div className="sc-remh">
                  <strong>{pretty(g.date)}</strong>
                  <span className="sc-dim">
                    {g.gap === 1 ? "Tomorrow" : `In ${g.gap} days`}
                    {g.gap > 1 && "  · non-working days in between"}
                  </span>
                </div>
                {g.list.map((e) => (
                  <div className="sc-rem" key={e.id} style={{ "--c": TYPE_META[e.type].color }}>
                    <span className="sc-mono">{e.time}</span>
                    <span>{TYPE_META[e.type].label} · {e.unit}</span>
                    <span className="sc-dim sc-rem-n">{e.name}</span>
                  </div>
                ))}
              </div>
            ))}
          </section>

          {/* ── Signing approval ── */}
          <section className="sc-card sc-card--gate">
            <h2>Signing approval <span className="sc-n">{pendingSignings.length}</span></h2>
            <p className="sc-note">
              The appointment can be booked automatically, but the signing link only goes out once the lease is approved by a named account.
              Who approved it and when is written to the audit log.
            </p>
            <label className="sc-field">
              <span>Approver</span>
              <input className="sc-in" placeholder="Your name or account" value={agent}
                     onChange={(e) => setAgent(e.target.value)}
                     onBlur={() => save({ agent })} />
            </label>

            {pendingSignings.length === 0 ? (
              <div className="sc-empty">Nothing waiting for approval.</div>
            ) : pendingSignings.map((e) => (
              <div className="sc-gate" key={e.id}>
                <div className="sc-gate-h">
                  <strong>{e.unit}</strong>
                  <span className="sc-dim">{e.name}</span>
                  <span className="sc-mono sc-dim">{pretty(e.date)} {e.time}</span>
                </div>
                <ul className="sc-check">
                  <li>Rent, deposit and fees match the console</li>
                  <li>Parking and storage allocation confirmed</li>
                  <li>Tenant screening completed by a trained person</li>
                  <li>No clause changes, or any changes separately approved</li>
                </ul>
                <div className="sc-gate-a">
                  <button className="sc-btn" disabled={!agent.trim()}
                          onClick={() => setSign(e.id, "approved")}>
                    Approve and release the signing link
                  </button>
                  <button className="sc-btn sc-btn--ghost" onClick={() => cancel(e.id)}>Send back</button>
                  {!agent.trim() && <span className="sc-dim">Enter the approver name first</span>}
                </div>
              </div>
            ))}

            {events.filter((e) => e.type === "signing" && ["approved", "sent", "signed"].includes(e.sign)).map((e) => (
              <div className="sc-done" key={e.id}>
                <span className="sc-mono">{e.unit}</span>
                <span style={{ color: SIGN_STATES[e.sign].color }}>{SIGN_STATES[e.sign].label}</span>
                <span className="sc-dim">Approved by {e.approvedBy}</span>
                {e.sign === "approved" && (
                  <button className="sc-btn sc-btn--xs" onClick={() => setSign(e.id, "sent")}>Send link</button>
                )}
                {e.sign === "sent" && (
                  <button className="sc-btn sc-btn--xs" onClick={() => setSign(e.id, "signed")}>Mark signed</button>
                )}
              </div>
            ))}
          </section>

          {/* ── Holidays ── */}
          <section className="sc-card">
            <h2>Holidays</h2>
            <p className="sc-note">
              Reminder dates skip weekends and anything listed here. These are the Alberta general holidays; check them against your own calendar.
              Heritage Day, the first Monday in August, is optional in Alberta and is not included.
            </p>
            <div className="sc-hol">
              {holidays.map((h) => (
                <span className="sc-holchip" key={h}>
                  {h}
                  <button onClick={() => save({ holidays: holidays.filter((x) => x !== h) })}
                          aria-label={`Remove ${h}`}>×</button>
                </span>
              ))}
            </div>
            <input className="sc-in" type="date" placeholder="Add a holiday"
                   onChange={(e) => {
                     const v = e.target.value;
                     if (v && !holidays.includes(v)) save({ holidays: [...holidays, v].sort() });
                     e.target.value = "";
                   }} />
          </section>
        </div>
      </div>

      <footer className="sc-foot">
        Scheduling and reminders run automatically: the system books the slot and sends the confirmation and reminder, with a daily spot check.
        Signing has an approval gate: the appointment can be booked automatically, the document cannot be sent automatically.
        Reminders to tenants are transactional messages and rest on a different CASL consent basis than marketing follow-ups, so the send layer must check them separately.
      </footer>
    </div>
  );
}

/* ============================ Styles ============================ */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=Archivo:wght@700;800&display=swap');
.sc{--ink:#131C25;--ink2:#3E4C5A;--dim:#78899A;--paper:#fff;--ground:#E9EDF0;--rule:#D3DBE1;
  --amber:#FFF6E0;--amberline:#E8C877;--red:#B23A54;--accent:var(--brand,#2A6183);
  background:var(--ground);color:var(--ink);min-height:100vh;font-size:14px;line-height:1.55;
  font-family:'IBM Plex Sans','PingFang TC','Microsoft JhengHei',system-ui,sans-serif;padding-bottom:48px}
.sc *{box-sizing:border-box}
.sc-mono{font-family:'IBM Plex Mono',monospace;font-variant-numeric:tabular-nums}
.sc-dim{color:var(--dim);font-size:12.5px}
.sc-load{padding:80px 24px;text-align:center;color:var(--dim)}

.sc-head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;
  padding:24px 28px 18px;background:var(--paper);border-bottom:1px solid var(--rule)}
.sc-eyebrow{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.13em;
  text-transform:uppercase;color:var(--dim)}
.sc-head h1{font-family:'Archivo','PingFang TC',sans-serif;font-weight:800;font-size:25px;
  letter-spacing:-.02em;margin:4px 0 0;display:flex;align-items:center;gap:10px}
.sc-off{font-family:'IBM Plex Sans',sans-serif;font-size:11px;font-weight:600;color:var(--dim);
  border:1px solid var(--rule);border-radius:9px;padding:2px 9px}
.sc-headr{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.sc-save{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--dim);padding:4px 9px;
  border:1px solid var(--rule);border-radius:3px}
.sc-save--saved{color:#0E8577;border-color:#0E8577}
.sc-save--error{color:var(--red);border-color:var(--red)}
.sc-nav{display:inline-flex;border:1px solid var(--rule);border-radius:3px;overflow:hidden}
.sc-nav button{font:inherit;font-size:13px;cursor:pointer;background:var(--paper);border:0;
  border-right:1px solid var(--rule);padding:7px 13px;color:var(--ink2)}
.sc-nav button:last-child{border-right:0}
.sc-nav button:hover{background:var(--ground)}

.sc-btn{font:inherit;font-weight:600;font-size:13px;cursor:pointer;background:var(--brand,var(--ink));color:#fff;
  border:1px solid var(--brand,var(--ink));padding:8px 15px;border-radius:3px}
.sc-btn:hover:not(:disabled){background:#000}
.sc-btn:disabled{opacity:.4;cursor:not-allowed}
.sc-btn--ghost{background:transparent;color:var(--ink2);border-color:var(--rule)}
.sc-btn--ghost:hover{background:var(--ground);color:var(--ink)}
.sc-btn--xs{padding:4px 10px;font-size:11.5px}
.sc-btn:focus-visible,.sc-in:focus-visible,.sc-sel:focus-visible,.sc-chk:focus-visible,
.sc-nav button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

.sc-form{display:flex;gap:8px;flex-wrap:wrap;padding:14px 28px;background:var(--paper);
  border-bottom:1px solid var(--rule)}
.sc-in,.sc-sel{font:inherit;font-size:13px;padding:7px 10px;border:1px solid var(--amberline);
  border-radius:3px;background:var(--amber);color:var(--ink);min-width:0}
.sc-sel{background:var(--paper);border-color:var(--rule);cursor:pointer}
.sc-form .sc-in{flex:1 1 130px}

.sc-grid{display:grid;grid-template-columns:1fr minmax(300px,400px);gap:16px;padding:18px 28px;
  align-items:start;max-width:1340px}
.sc-side{display:flex;flex-direction:column;gap:16px}
.sc-card{background:var(--paper);border:1px solid var(--rule);border-radius:4px;padding:18px 20px}
.sc-card--gate{border-color:#E8C877;background:linear-gradient(180deg,#FFFCF3 0%,#fff 55%)}
.sc-card h2{font-family:'Archivo',sans-serif;font-weight:700;font-size:15px;margin:0 0 4px;
  display:flex;align-items:center;gap:8px}
.sc-n{font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:500;color:var(--dim);
  border:1px solid var(--rule);border-radius:10px;padding:0 8px}
.sc-note{color:var(--dim);font-size:12.5px;margin:5px 0 14px;line-height:1.6}
.sc-empty{color:var(--dim);font-size:12.5px;padding:16px 0;text-align:center;
  border:1px dashed var(--rule);border-radius:3px}

/* Timeline */
.sc-timeline{display:flex;flex-direction:column;gap:8px}
.sc-item{display:flex;gap:14px;border:1px solid var(--rule);border-left:3px solid var(--c);
  border-radius:3px;padding:11px 13px;align-items:flex-start}
.sc-item.done{opacity:.5}
.sc-item.done .sc-body strong{text-decoration:line-through}
.sc-time{flex:0 0 58px;display:flex;flex-direction:column;font-family:'IBM Plex Mono',monospace}
.sc-time strong{font-size:15px;font-weight:600;line-height:1.3}
.sc-time em{font-style:normal;font-size:10.5px;color:var(--dim)}
.sc-body{flex:1;min-width:0}
.sc-item-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:2px}
.sc-tag{font-size:11px;font-weight:600;color:var(--c);border:1px solid var(--c);border-radius:2px;
  padding:1px 6px}
.sc-item-h strong{font-family:'IBM Plex Mono',monospace;font-size:13.5px;font-weight:600}
.sc-sign{font-size:10.5px;font-weight:600;color:var(--s);border:1px solid var(--s);border-radius:9px;
  padding:1px 8px}
.sc-block{margin-top:7px;font-size:11.5px;color:#7A5D14;background:#FFF8E6;border-radius:3px;
  padding:6px 9px;line-height:1.55}
.sc-acts{display:flex;gap:5px;flex:0 0 auto}
.sc-chk{width:24px;height:24px;border:1px solid var(--rule);border-radius:3px;background:var(--paper);
  cursor:pointer;font-size:13px;color:#0E8577;font-weight:700;padding:0;line-height:1}
.sc-chk:hover{border-color:#0E8577}
.sc-x{width:24px;height:24px;border:0;background:none;cursor:pointer;color:var(--dim);font-size:17px;
  line-height:1;padding:0}
.sc-x:hover{color:var(--red)}

/* Reminders */
.sc-remgroup{margin-bottom:14px}
.sc-remgroup:last-child{margin-bottom:0}
.sc-remh{display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding-bottom:5px;
  border-bottom:1px solid var(--rule);margin-bottom:7px;font-size:13px}
.sc-rem{display:flex;align-items:center;gap:9px;padding:5px 0;font-size:12.5px;
  border-left:2px solid var(--c);padding-left:9px;margin-bottom:3px}
.sc-rem-n{margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* Signing gate */
.sc-field{display:flex;flex-direction:column;gap:5px;margin-bottom:14px}
.sc-field span{font-size:12px;font-weight:600;color:var(--ink2)}
.sc-gate{border:1px solid var(--rule);border-radius:3px;padding:12px 13px;margin-bottom:10px;
  background:var(--paper)}
.sc-gate-h{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;margin-bottom:8px}
.sc-gate-h strong{font-family:'IBM Plex Mono',monospace;font-size:14px}
.sc-check{margin:0 0 11px;padding-left:17px;font-size:12px;color:var(--ink2);line-height:1.8}
.sc-gate-a{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.sc-done{display:flex;align-items:center;gap:9px;font-size:12px;padding:7px 0;
  border-top:1px dotted var(--rule);flex-wrap:wrap}

.sc-owner{font-size:10.5px;color:var(--dim);border:1px solid var(--rule);border-radius:8px;
  padding:0 6px}
.sc-move-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:7px;font-size:12px}
.sc-move-status{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;
  padding:1px 8px;border-radius:9px;background:#FFF6E0;color:#7A5D14}
.sc-move-status--confirmed,.sc-move-status--completed{background:#E8F7F2;color:#0E8577}

/* Confirmations */
.sc-confirm{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px;
  padding-top:6px;border-top:1px dotted var(--rule)}
.sc-cstate{font-size:10.5px;font-weight:700;color:#fff;background:var(--c);border-radius:9px;
  padding:1px 8px}
.sc-chan{display:inline-flex;border:1px solid var(--rule);border-radius:3px;overflow:hidden}
.sc-chan button{font:inherit;font-size:11.5px;cursor:pointer;background:var(--paper);border:0;
  border-right:1px solid var(--rule);padding:4px 9px;color:var(--dim)}
.sc-chan button:last-child{border-right:0}
.sc-chan button.on{background:var(--brand,var(--ink));color:#fff}
.sc-btn--xs{padding:4px 9px;font-size:11.5px}
.sc-bad{font-size:11.5px;color:var(--red)}

/* Holidays */
.sc-hol{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.sc-holchip{display:inline-flex;align-items:center;gap:5px;font-family:'IBM Plex Mono',monospace;
  font-size:11.5px;background:var(--ground);border:1px solid var(--rule);border-radius:2px;
  padding:3px 5px 3px 8px}
.sc-holchip button{border:0;background:none;cursor:pointer;color:var(--dim);font-size:14px;
  line-height:1;padding:0 2px}
.sc-holchip button:hover{color:var(--red)}

.sc-foot{padding:4px 28px 0;color:var(--dim);font-size:11.5px;max-width:88ch;line-height:1.65}

@media (max-width:860px){
  .sc-grid{grid-template-columns:1fr;padding:16px}
  .sc-head,.sc-form,.sc-foot{padding-left:16px;padding-right:16px}
}
`;
