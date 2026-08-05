import React, { useState, useEffect, useMemo, useCallback } from "react";
import { ai } from "../lib/ai.js";
import PurchaseOrders from "./PurchaseOrders.jsx";

/* ============================================================
   BAYDO POINTE — Building Manager console
   · Notices of entry: occupied units need 24 hours’ written notice before a showing.
     The AI drafts it, the Building Manager approves, then it goes out.
   · Maintenance tickets: new / in progress / done, with running notes
   · Key handover: booked once signing completes
   · Scheduling: one person cannot be in two places at once
   ============================================================ */

const NOTICE_HOURS = 24;          // notice of entry lead time
const REMINDER_HOURS = 24;        // second message, closer to the time

/* When a tenant will and will not accept access. A refusal is recorded as
   carefully as availability: entering during a window the tenant excluded is
   what turns a repair into a complaint. */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/* Showings and key handovers occupy the manager's time. Vendor visits do not,
      but they still appear on the schedule so the manager knows someone is coming. */
const DUR = { showing: 30, keys: 30, maintenance: 60 };
const BLOCKING = ["showing", "keys"];

const MAINT_CATEGORIES = ["Plumbing", "Heating and air", "Locks and access", "Appliances", "Leak", "Walls and floors",
                          "Common areas", "Pests", "Other"];
const PRIORITIES = [
  { k: "emergency", label: "Emergency", color: "#B23A54", hint: "No hot water or heat, active leak, safety issue" },
  { k: "high",      label: "High",      color: "#C98A15", hint: "Affects daily use" },
  { k: "normal",    label: "Normal",    color: "#1C6FA6", hint: "Can be scheduled" },
  { k: "low",       label: "Low",       color: "#8892A0", hint: "Cosmetic or not urgent" },
];
const PR = Object.fromEntries(PRIORITIES.map((p) => [p.k, p]));

const MSTATE = {
  new:         { label: "New",         color: "#B23A54" },
  scheduled:   { label: "Scheduled",   color: "#C98A15" },
  in_progress: { label: "In progress", color: "#1C6FA6" },
  done:        { label: "Done",        color: "#0E8577" },
  cancelled:   { label: "Cancelled",   color: "#8892A0" },
};

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
const fmt = (s) => (s ? String(s).slice(0, 16).replace("T", " ") : "—");
const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const hoursUntil = (dt) => (new Date(dt) - Date.now()) / 3.6e6;

function seedMaint() {
  const ago = (h) => new Date(Date.now() - h * 3.6e6).toISOString();
  return [
    { id: "mt_1", unitId: "370-311", tenant: "K. Osei", phone: "780-555-0121",
      category: "Heating and air", priority: "emergency", state: "new",
      description: "Heat is completely dead and the unit is cold.", assignee: "", scheduledAt: "",
      notes: [], createdAt: ago(2), entryNoticeSentAt: null },
    { id: "mt_2", unitId: "378-204", tenant: "L. Moreau", phone: "587-555-0155",
      category: "Plumbing", priority: "high", state: "in_progress",
      description: "Leak under the kitchen sink, bucket underneath for now.", assignee: "Building Manager",
      scheduledAt: "", notes: [{ at: ago(20), by: "Building Manager", text: "Shut-off valve closed, part arrives tomorrow." }],
      createdAt: ago(26), entryNoticeSentAt: ago(25) },
    { id: "mt_3", unitId: "374-115", tenant: "S. Patel", phone: "780-555-0188",
      category: "Locks and access", priority: "normal", state: "new",
      description: "Fob reads intermittently, sometimes takes several taps.", assignee: "", scheduledAt: "",
      notes: [], createdAt: ago(50), entryNoticeSentAt: null },
  ];
}
function seedKeys() {
  const d = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  return [
    { id: "kh_1", unitId: "378-519", tenant: "Lily Kwan", phone: "780-555-0166",
      email: "lily.k@example.com", leaseStart: d(2), scheduledAt: "", assignee: "",
      state: "pending", items: {}, notes: "" },
  ];
}

export default function BuildingManager() {
  const [session, setSession] = useState(null);
  const [events, setEvents] = useState([]);
  const [moveouts, setMoveouts] = useState([]);
  const [maint, setMaint] = useState(seedMaint);
  const [keys, setKeys] = useState(seedKeys);
  const [notices, setNotices] = useState([]);
  const [windows, setWindows] = useState([]);
  const [reminders, setReminders] = useState([]);
  const [orders, setOrders] = useState([]);
  const [releases, setReleases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState("idle");
  const [tab, setTab] = useState("maint");
  const [busy, setBusy] = useState(null);
  const [newMt, setNewMt] = useState(false);

  const who = session?.name || "unsigned";

  useEffect(() => {
    (async () => {
      const read = async (k) => {
        try { const r = await window.storage.get(k); return r?.value ? JSON.parse(r.value) : null; }
        catch (e) { return null; }
      };
      const s = await read("baydo:session"); if (s) setSession(s);
      const sc = await read("baydo:schedule"); if (sc?.events) setEvents(sc.events);
      const mo = await read("baydo:moveouts"); if (mo) setMoveouts(mo);
      const mt = await read("baydo:maintenance"); if (mt) setMaint(mt);
      const kh = await read("baydo:keyhandover"); if (kh) setKeys(kh);
      const nt = await read("baydo:entrynotices"); if (nt) setNotices(nt);
      const ew = await read("baydo:entrywindows"); if (ew) setWindows(ew);
      const rm = await read("baydo:entryreminders"); if (rm) setReminders(rm);
      const po = await read("baydo:purchaseorders"); if (po) setOrders(po);
      const kr = await read("baydo:keyreleases"); if (kr) setReleases(kr);
      setLoading(false);
    })();
  }, []);

  const persist = useCallback(async (k, v) => {
    setSaveState("saving");
    try {
      const ok = await window.storage.set(k, JSON.stringify(v));
      setSaveState(ok ? "saved" : "error");
    } catch (e) { setSaveState("error"); }
    setTimeout(() => setSaveState((x) => (x === "saved" ? "idle" : x)), 1500);
  }, []);

  const saveMaint = (v) => { setMaint(v); persist("baydo:maintenance", v); };
  const saveKeys = (v) => { setKeys(v); persist("baydo:keyhandover", v); };
  const saveNotices = (v) => { setNotices(v); persist("baydo:entrynotices", v); };
  const saveWindows = (v) => { setWindows(v); persist("baydo:entrywindows", v); };
  const saveReminders = (v) => { setReminders(v); persist("baydo:entryreminders", v); };
  const saveOrders = (v) => { setOrders(v); persist("baydo:purchaseorders", v); };

  /* Copying a confirmed order into a bill. The order proves what was agreed;
     the bill is what we owe, and only the bill posts. */
  const toBill = async (po) => {
    let bills = [];
    try {
      const r = await window.storage.get("acct:invoices");
      if (r?.value) bills = JSON.parse(r.value);
    } catch (e) {}
    const bill = {
      id: uid("ap_"), vendor_id: po.vendor_id, invoice_no: po.po_number,
      invoice_date: today(), due_date: today(),
      building_code: po.unit_number?.slice(0, 3), unit_number: po.unit_number,
      lines: (po.lines ?? []).map((l) => ({ gl_code: l.gl_code ?? "5010",
        description: l.description, amount: Number(l.actual ?? l.estimated) })),
      subtotal: Number(po.actual_amount ?? po.estimated), gst: 0,
      total: Number(po.actual_amount ?? po.estimated),
      description: `${po.description} (${po.po_number})`,
      ticket_id: po.ticket_id, state: "draft", paid_amount: 0, from_po: po.id,
    };
    try { await window.storage.set("acct:invoices", JSON.stringify([bill, ...bills])); } catch (e) {}
    saveOrders(orders.map((x) => x.id === po.id
      ? { ...x, state: "billed", bill_id: bill.id, bill_invoice_no: bill.invoice_no } : x));
  };

  /* The notice is the legal step and goes out first. A reminder follows closer
     to the time, because a notice read four days ago is not the same as knowing
     somebody is at the door this afternoon — and the tenant may not be home. */
  const scheduleReminder = async (notice, channel) => {
    const entryAt = new Date(`${notice.date}T${(notice.window ?? "09:00–10:00").split("–")[0]}:00`);
    const remindAt = new Date(entryAt.getTime() - REMINDER_HOURS * 3600e3);
    const body = [
      `Reminder: we will be entering ${notice.unitId} on ${notice.date}, ${notice.window}.`,
      "You do not need to be home. If the time no longer works, reply and we will arrange another.",
      "",
      `提醒：我們將於 ${notice.date} ${notice.window} 進入 ${notice.unitId}。`,
      "你不需要在家。如果這個時間不方便，回覆我們可以另約。",
    ].join("\n");

    const rec = { id: uid("rm_"), notice_id: notice.id, unit: notice.unitId,
      channel, body, remind_at: remindAt.toISOString(), entry_at: entryAt.toISOString(),
      state: remindAt <= new Date() ? "due" : "scheduled",
      confirm_state: "sent", created_at: nowISO(), by: who };
    saveReminders([rec, ...reminders]);

    let queue = [];
    try {
      const r = await window.storage.get("baydo:outbox");
      if (r?.value) queue = JSON.parse(r.value);
    } catch (e) {}
    try {
      await window.storage.set("baydo:outbox", JSON.stringify([{
        id: uid("ob_"), kind: "entry_reminder", channel, to: notice.contact,
        to_name: notice.tenant, body, ref_type: "entry_notice", ref_id: notice.id,
        required_by: remindAt.toISOString(), state: "queued", created_at: nowISO() },
        ...queue]));
    } catch (e) {}
  };

  /* ---------- Conflicts: only showings and key handovers occupy time ---------- */
  const booked = useMemo(() => {
    const out = [];
    events.filter((e) => e.state === "booked" && e.date && e.time && BLOCKING.includes(e.type))
      .forEach((e) => out.push({ who: e.assignee || "unassigned", start: new Date(`${e.date}T${e.time}:00`),
                 min: DUR[e.type] || 30, what: `${e.type === "showing" ? "Showing" : "Key handover"} ${e.unit}`,
                 ref: e.id }));
    keys.filter((k) => k.scheduledAt && k.state !== "done").forEach((k) =>
      out.push({ who: k.assignee || "unassigned", start: new Date(k.scheduledAt),
                 min: DUR.keys, what: `Key handover ${k.unitId}`, ref: k.id }));
    return out;
  }, [events, keys]);

  const conflictOf = useCallback((assignee, startStr, min, selfRef) => {
    if (!startStr || !assignee) return null;
    const s = new Date(startStr), e = new Date(s.getTime() + min * 60000);
    for (const b of booked) {
      if (b.ref === selfRef) continue;
      if (b.who !== assignee) continue;
      const bs = b.start, be = new Date(bs.getTime() + b.min * 60000);
      if (s < be && bs < e) return b;
    }
    return null;
  }, [booked]);

  /* ---------- Put vendor visits on the schedule so they show up and get a reminder ---------- */
  const pushToSchedule = useCallback(async (payload) => {
    try {
      const r = await window.storage.get("baydo:schedule");
      const sc = r?.value ? JSON.parse(r.value) : { events: [], holidays: [], done: {} };
      const evs = (sc.events || []).filter((e) => e.ref !== payload.ref);
      const next = { ...sc, events: [...evs, payload] };
      await window.storage.set("baydo:schedule", JSON.stringify(next));
      setEvents(next.events);
    } catch (e) { /* schedule not created yet */ }
  }, []);

  /* ---------- Showings in occupied units need 24 hours' notice ---------- */
  const noticeNeeded = useMemo(() => {
    // A unit under notice is still occupied, so a showing needs a notice of entry
    const occupied = new Set(moveouts.filter((m) => m.state === "open").map((m) => m.unitId));
    const tenantOf = Object.fromEntries(moveouts.map((m) => [m.unitId, m]));
    return events
      .filter((e) => e.type === "showing" && e.state === "booked" && occupied.has(e.unit))
      .map((e) => {
        const sent = notices.find((n) => n.eventId === e.id && n.state === "sent");
        const at = new Date(`${e.date}T${e.time}:00`);
        return { ev: e, at, sent, lead: hoursUntil(at), tenant: tenantOf[e.unit] };
      })
      .filter((x) => !x.sent && x.at > new Date())
      .sort((a, b) => a.at - b.at);
  }, [events, moveouts, notices]);

  /* ---------- AI drafts the notice of entry ---------- */
  const draftNotice = async (item) => {
    setBusy(item.ev.id);
    const t = unitType(item.ev.unit);
    const startH = item.ev.time;
    const [hh, mm] = startH.split(":").map(Number);
    const endH = `${String(hh + 1).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    // Facts only. The prompt lives on the server, where it can be reviewed and
    // changed once rather than being whatever version this browser last loaded.
    const aiInput = {
      unit: item.ev.unit,
      layout: t ? `${t}, ${BED[t]}` : null,
      tenant: item.tenant?.tenant || "",
      date: item.ev.date,
      from: startH,
      to: endH,
      purpose: "a showing — the tenant has given notice and the unit is being re-let",
      issued: new Date().toISOString().slice(0, 16).replace("T", " "),
    };

    try {
      const text = await ai("entry_notice", aiInput, { ref_type: "event", ref_id: item.ev.id });
      const rec = { id: uid("nt_"), eventId: item.ev.id, unitId: item.ev.unit,
                    tenant: item.tenant?.tenant || "", contact: item.tenant?.email || item.tenant?.phone || "",
                    date: item.ev.date, window: `${startH}–${endH}`, text,
                    state: "draft", by: who, at: nowISO() };
      saveNotices([...notices.filter((n) => n.eventId !== item.ev.id), rec]);
    } catch (e) {
      saveNotices([...notices, { id: uid("nt_"), eventId: item.ev.id, unitId: item.ev.unit,
        state: "error", text: "The AI service did not respond. Write the notice manually.", by: who, at: nowISO() }]);
    }
    setBusy(null);
  };

  const sendNotice = (id) =>
    saveNotices(notices.map((n) => (n.id === id ? { ...n, state: "sent", sentBy: who, sentAt: nowISO() } : n)));
  const editNotice = (id, text) =>
    saveNotices(notices.map((n) => (n.id === id ? { ...n, text, edited: true } : n)));

  /* ---------- Maintenance ---------- */
  const patchMt = (id, p) => saveMaint(maint.map((m) => (m.id === id ? { ...m, ...p } : m)));
  const addMtNote = (id, text) => {
    if (!text.trim()) return;
    const m = maint.find((x) => x.id === id);
    patchMt(id, { notes: [...(m.notes || []), { at: nowISO(), by: who, text: text.trim() }] });
  };

  /* A vendor visit does not occupy the manager's time, but it goes on the calendar and gets a reminder */
  const scheduleVendor = async (m, when, vendor) => {
    const [date, time] = when.split("T");
    await pushToSchedule({
      id: uid("ev_"), ref: m.id, type: "maintenance", date, time: time.slice(0, 5),
      unit: m.unitId, name: `${m.category} · ${vendor || "vendor TBD"}`,
      contact: m.tenant ? `Tenant ${m.tenant} ${m.phone}` : "", state: "booked",
      assignee: "Vendor", note: m.description,
    });
    patchMt(m.id, { scheduledAt: when, vendor,
      state: m.state === "new" ? "scheduled" : m.state,
      notes: [...(m.notes || []),
        { at: nowISO(), by: who, text: `Booked for ${fmt(when)} with ${vendor || "an unnamed vendor"}. Added to the schedule.` }] });
  };

  /* ---------- Key handover ---------- */
  const patchKh = (id, p) => saveKeys(keys.map((k) => (k.id === id ? { ...k, ...p } : k)));

  const mtOpen = maint.filter((m) => !["done", "cancelled"].includes(m.state));
  const mtClosed = maint.filter((m) => ["done", "cancelled"].includes(m.state));
  const khOpen = keys.filter((k) => k.state !== "done");

  if (loading) return <div className="bm"><style>{CSS}</style><div className="bm-load">Loading…</div></div>;

  return (
    <div className="bm">
      <style>{CSS}</style>

      <header className="bm-head">
        <div>
          <div className="bm-eyebrow">Baydo Pointe · Building Manager</div>
          <h1>On-site console</h1>
        </div>
        <div className="bm-headr">
          {session && <span className="bm-chip">{session.name}</span>}
          <span className={`bm-save bm-save--${saveState}`}>
            {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved"
              : saveState === "error" ? "Save failed" : "Autosaves"}
          </span>
        </div>
      </header>

      <nav className="bm-tabs">
        <button className={tab === "maint" ? "on" : ""} onClick={() => setTab("maint")}>
          Maintenance {mtOpen.length > 0 && <i className="bm-b">{mtOpen.length}</i>}
        </button>
        <button className={tab === "notice" ? "on" : ""} onClick={() => setTab("notice")}>
          Notices of entry {noticeNeeded.length > 0 && <i className="bm-b">{noticeNeeded.length}</i>}
        </button>
        <button className={tab === "po" ? "on" : ""} onClick={() => setTab("po")}>
          Purchase orders {orders.filter((o) => o.state === "work_done").length > 0
            && <i className="bm-b">{orders.filter((o) => o.state === "work_done").length}</i>}
        </button>
        <button className={tab === "keys" ? "on" : ""} onClick={() => setTab("keys")}>
          Key handover {khOpen.length > 0 && <i className="bm-b">{khOpen.length}</i>}
        </button>
      </nav>

      {/* ═══════ Maintenance ═══════ */}
      {tab === "maint" && (
        <div className="bm-body">
          <div className="bm-barrow">
            <p className="bm-note" style={{ margin: 0, flex: 1 }}>
              Booking a time checks for conflicts: nobody gets two things at once. Send a notice of entry before entering an occupied unit.
            </p>
            <button className="bm-btn" onClick={() => setNewMt(!newMt)}>Log a request</button>
          </div>

          {newMt && <NewMaint onAdd={(m) => { saveMaint([...maint, m]); setNewMt(false); }}
                              onCancel={() => setNewMt(false)} />}

          {mtOpen.length === 0 ? <div className="bm-empty">Nothing outstanding.</div> :
            mtOpen
              .sort((a, b) => (b.rush ? 1 : 0) - (a.rush ? 1 : 0) ||
                              PRIORITIES.findIndex((p) => p.k === a.priority) -
                              PRIORITIES.findIndex((p) => p.k === b.priority))
              .map((m) => (
                <MaintCard key={m.id} mt={m} who={who}
                           onSchedule={(when, vendor) => scheduleVendor(m, when, vendor)}
                           onPatch={(p) => patchMt(m.id, p)} onNote={(t) => addMtNote(m.id, t)} />
              ))}

          {mtClosed.length > 0 && (
            <section className="bm-card">
              <h2>Closed <span className="bm-n">{mtClosed.length}</span></h2>
              <div className="bm-list">
                {mtClosed.map((m) => (
                  <div className="bm-row" key={m.id}>
                    <span className="bm-badge" style={{ "--c": MSTATE[m.state].color }}>
                      {MSTATE[m.state].label}
                    </span>
                    <span className="bm-mono bm-strong">{m.unitId}</span>
                    <span className="bm-tag">{m.category}</span>
                    <span className="bm-dim bm-cut">{m.description}</span>
                    <span className="bm-dim bm-mono bm-right">{fmt(m.completedAt || m.createdAt)}</span>
                    <button className="bm-btn bm-btn--xs bm-btn--ghost"
                            onClick={() => patchMt(m.id, { state: "in_progress", completedAt: null })}>
                      Reopen
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {/* ═══════ Notices of entry ═══════ */}
      {tab === "notice" && (
        <div className="bm-body">
          <div className="bm-warn">
            While a unit is still occupied, a showing needs {NOTICE_HOURS} hours’ written notice to the tenant,
            stating the date, the time window and the purpose. Showings can start once the tenant gives a month’s notice, but this step cannot be skipped.
            Confirm the exact lead time and format with your manager.
          </div>

          {noticeNeeded.length === 0 ? (
            <div className="bm-empty">No entries need a notice right now.</div>
          ) : noticeNeeded.map((item) => {
            const draft = notices.find((n) => n.eventId === item.ev.id && n.state !== "sent");
            const tight = item.lead < NOTICE_HOURS;
            const t = unitType(item.ev.unit);
            return (
              <section className={`bm-card ${tight ? "bm-card--warn" : ""}`} key={item.ev.id}>
                <div className="bm-noth">
                  <span className="bm-mono bm-unit">{item.ev.unit}</span>
                  {t && <><span className="bm-mono bm-type">{t}</span><span className="bm-tag">{BED[t]}</span></>}
                  <strong>{item.ev.name}</strong>
                  <span className="bm-dim">Showing {item.ev.date} {item.ev.time}</span>
                  <span className={`bm-badge bm-right`}
                        style={{ "--c": tight ? "#B23A54" : "#0E8577" }}>
                    {tight ? `Only ${item.lead.toFixed(1)} h until the showing — under the ${NOTICE_HOURS} required`
                           : `${item.lead.toFixed(1)} h until the showing — enough notice`}
                  </span>
                </div>
                <div className="bm-dim">
                  Current tenant: {item.tenant?.tenant || "—"} · {item.tenant?.email || item.tenant?.phone || "—"}
                </div>

                {tight && (
                  <div className="bm-bad">
                    Not enough notice. Reschedule the showing rather than sending it anyway: entering on short notice
                    gives the tenant grounds to refuse and can turn into a dispute.
                  </div>
                )}

                {!draft ? (
                  <button className="bm-btn" disabled={busy === item.ev.id}
                          onClick={() => draftNotice(item)}>
                    {busy === item.ev.id ? "Drafting…" : "Draft the notice with AI"}
                  </button>
                ) : (
                  <>
                    <div className="bm-dim">
                      Window {draft.date} {draft.window} · drafted {fmt(draft.at)} by {draft.by}
                      {draft.edited && " · edited by hand"}
                    </div>
                    <textarea className="bm-ta" rows={9} value={draft.text}
                              onChange={(e) => editNotice(draft.id, e.target.value)} />
                    <div className="bm-actions">
                      <button className="bm-btn" disabled={tight} onClick={() => sendNotice(draft.id)}>
                        Approve and send to the tenant
                      </button>
                      <button className="bm-btn bm-btn--ghost" disabled={busy === item.ev.id}
                              onClick={() => draftNotice(item)}>Redraft</button>
                      {tight && <span className="bm-dim">Not enough notice — reschedule first</span>}
                    </div>
                  </>
                )}
              </section>
            );
          })}

          {noticeNeeded.length > 0 && (
            <section className="bm-card">
              <EntryWindows unit={noticeNeeded[0].ev.unit} windows={windows}
                onAdd={(w) => saveWindows([...windows, w])}
                onRemove={(id) => saveWindows(windows.filter((x) => x.id !== id))} />
            </section>
          )}

          {notices.filter((n) => n.state === "sent").length > 0 && (
            <section className="bm-card">
              <h2>Notices sent <span className="bm-n">{notices.filter((n) => n.state === "sent").length}</span></h2>
              <div className="bm-list">
                {notices.filter((n) => n.state === "sent").map((n) => (
                  <div className="bm-row" key={n.id}>
                    <span className="bm-badge" style={{ "--c": "#0E8577" }}>Sent</span>
                    <span className="bm-mono bm-strong">{n.unitId}</span>
                    <span className="bm-dim">{n.date} {n.window}</span>
                    <span className="bm-dim">{n.tenant}</span>
                    <span className="bm-dim bm-mono bm-right">{fmt(n.sentAt)} · {n.sentBy}</span>
                    {(() => {
                      const rm = reminders.find((r) => r.notice_id === n.id);
                      if (rm) return (
                        <span className="bm-dim">
                          Reminder {rm.channel === "both" ? "email and text"
                            : rm.channel === "sms" ? "text" : "email"} · {fmt(rm.remind_at)}
                        </span>
                      );
                      return (
                        <span className="bm-remind">
                          <button className="bm-btn bm-btn--xs bm-btn--ghost"
                                  onClick={() => scheduleReminder(n, "email")}>Remind by email</button>
                          <button className="bm-btn bm-btn--xs bm-btn--ghost"
                                  onClick={() => scheduleReminder(n, "both")}>Email and text</button>
                        </span>
                      );
                    })()}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {/* ═══════ Key handover ═══════ */}
      {tab === "po" && (
        <div className="bm-body">
          <PurchaseOrders session={session} tickets={maint} vendors={[]}
            orders={orders} onSave={saveOrders} onBill={toBill} />
        </div>
      )}

      {tab === "keys" && (
        <div className="bm-body">
          <p className="bm-note">
            Keys can only be booked once the Property Manager has confirmed the lease
            is signed. Handing over possession against an unsigned lease leaves nothing
            to enforce, and it is not a mistake that can be undone quietly.
            Booking checks for conflicts, so nothing gets double-booked.
          </p>

          {khOpen.length === 0 ? <div className="bm-empty">No handovers outstanding.</div> :
            khOpen.map((k) => (
              <KeyCard key={k.id} kh={k} who={who} conflictOf={conflictOf}
                       onPatch={(p) => patchKh(k.id, p)} />
            ))}

          {keys.filter((k) => k.state === "done").length > 0 && (
            <section className="bm-card">
              <h2>Completed <span className="bm-n">{keys.filter((k) => k.state === "done").length}</span></h2>
              <div className="bm-list">
                {keys.filter((k) => k.state === "done").map((k) => (
                  <div className="bm-row" key={k.id}>
                    <span className="bm-badge" style={{ "--c": "#0E8577" }}>Handed over</span>
                    <span className="bm-mono bm-strong">{k.unitId}</span>
                    <strong>{k.tenant}</strong>
                    <span className="bm-dim bm-mono bm-right">{fmt(k.scheduledAt)} · {k.assignee}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      <footer className="bm-foot">
        Confirm the notice lead time, format and delivery method, plus maintenance response times, with your manager and write them into the SOP.
        Emergencies — no heat, an active leak, a safety issue — usually carry a much shorter response requirement and do not follow the normal schedule.
      </footer>
    </div>
  );
}

/* ============================ Sub-components ============================ */

/** The tenant's own availability. Advisory rather than enforced: a landlord
 *  keeps a right of entry on proper notice, and an emergency does not wait for
 *  a convenient slot. But going ahead over a stated objection should be a
 *  decision somebody makes on purpose, not something the calendar does quietly. */
function EntryWindows({ unit, windows, onAdd, onRemove }) {
  const [kind, setKind] = useState("blocked");
  const [weekday, setWeekday] = useState(1);
  const [from, setFrom] = useState("09:00");
  const [to, setTo] = useState("17:00");
  const [reason, setReason] = useState("");

  const mine = windows.filter((w) => w.unit_number === unit);
  const blocked = mine.filter((w) => w.kind === "blocked");
  const available = mine.filter((w) => w.kind === "available");

  return (
    <div className="bm-windows">
      <div className="bm-noteh">When we can enter {unit}</div>
      <p className="bm-dim">
        Set by the tenant, or by you after speaking to them. Times marked as not
        suitable still allow entry on proper notice, but going ahead anyway is a
        decision rather than an accident.
      </p>

      {available.length > 0 && (
        <div className="bm-wlist">
          <span className="bm-wlabel bm-wlabel--ok">Suits the tenant</span>
          {available.map((w) => (
            <span className="bm-window" key={w.id}>
              {w.specific_date ?? WEEKDAYS[w.weekday]} {w.from_time}–{w.to_time}
              <button className="bm-x" onClick={() => onRemove(w.id)}>×</button>
            </span>
          ))}
        </div>
      )}
      {blocked.length > 0 && (
        <div className="bm-wlist">
          <span className="bm-wlabel bm-wlabel--no">Not suitable</span>
          {blocked.map((w) => (
            <span className="bm-window bm-window--no" key={w.id} title={w.reason ?? ""}>
              {w.specific_date ?? WEEKDAYS[w.weekday]} {w.from_time}–{w.to_time}
              <button className="bm-x" onClick={() => onRemove(w.id)}>×</button>
            </span>
          ))}
        </div>
      )}
      {mine.length === 0 && (
        <div className="bm-dim">Nothing set. Any time inside office hours is assumed to work.</div>
      )}

      <div className="bm-wadd">
        <select className="bm-sel" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="blocked">Not suitable</option>
          <option value="available">Suits the tenant</option>
        </select>
        <select className="bm-sel" value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
          {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
        </select>
        <input className="bm-in" type="time" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input className="bm-in" type="time" value={to} onChange={(e) => setTo(e.target.value)} />
        <input className="bm-in" value={reason} placeholder="Reason (optional)"
               onChange={(e) => setReason(e.target.value)} />
        <button className="bm-btn bm-btn--xs"
                onClick={() => { onAdd({ id: uid("ew_"), unit_number: unit, kind, weekday,
                  from_time: from, to_time: to, reason, set_by: "staff" });
                  setReason(""); }}>Add</button>
      </div>
    </div>
  );
}

function NewMaint({ onAdd, onCancel }) {
  const [f, setF] = useState({ unitId: "", tenant: "", phone: "", category: MAINT_CATEGORIES[0],
                               priority: "normal", description: "" });
  const set = (k, v) => setF({ ...f, [k]: v });
  const t = unitType(f.unitId);
  return (
    <div className="bm-add">
      <div className="bm-addrow">
        <label><span>Unit</span>
          <input className="bm-in" value={f.unitId} placeholder="370-311"
                 onChange={(e) => set("unitId", e.target.value)} />
          <em>{f.unitId ? (t ? `${t} · ${BED[t]}` : "No such unit") : "Type a unit to see its layout"}</em></label>
        <label><span>Tenant</span>
          <input className="bm-in" value={f.tenant} onChange={(e) => set("tenant", e.target.value)} /></label>
        <label><span>Phone</span>
          <input className="bm-in" value={f.phone} onChange={(e) => set("phone", e.target.value)} /></label>
        <label><span>Category</span>
          <select className="bm-sel" value={f.category} onChange={(e) => set("category", e.target.value)}>
            {MAINT_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </select></label>
      </div>
      <div className="bm-addrow">
        <label style={{ flex: "0 0 auto" }}><span>Priority</span>
          <div className="bm-prio">
            {PRIORITIES.map((p) => (
              <button key={p.k} className={f.priority === p.k ? "on" : ""} style={{ "--c": p.color }}
                      onClick={() => set("priority", p.k)} title={p.hint}>{p.label}</button>
            ))}
          </div></label>
        <label style={{ flex: 1 }}><span>Description</span>
          <input className="bm-in" value={f.description}
                 onChange={(e) => set("description", e.target.value)} /></label>
        <button className="bm-btn" disabled={!f.unitId.trim() || !f.description.trim()}
                onClick={() => onAdd({ id: uid("mt_"), ...f, state: "new", assignee: "",
                  scheduledAt: "", notes: [], createdAt: nowISO(), entryNoticeSentAt: null })}>
          Create
        </button>
        <button className="bm-btn bm-btn--ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function MaintCard({ mt, who, onSchedule, onPatch, onNote }) {
  const [note, setNote] = useState("");
  const [when, setWhen] = useState(mt.scheduledAt || "");
  const [vendor, setVendor] = useState(mt.vendor || "");
  const p = PR[mt.priority] || PR.normal;
  const st = MSTATE[mt.state];
  const t = unitType(mt.unitId);
  const ageH = (Date.now() - new Date(mt.createdAt)) / 3.6e6;

  return (
    <section className={`bm-card bm-mt ${mt.rush ? "bm-card--urgent" : ""}`} style={{ "--p": p.color }}>
      <div className="bm-mth">
        {mt.rush && <span className="bm-rush">RUSH</span>}
        <span className="bm-badge" style={{ "--c": p.color }}>{p.label}</span>
        <span className="bm-badge" style={{ "--c": st.color }}>{st.label}</span>
        <span className="bm-mono bm-unit">{mt.unitId}</span>
        {t && <span className="bm-tag">{BED[t]}</span>}
        <span className="bm-tag">{mt.category}</span>
        <strong>{mt.tenant}</strong>
        <span className="bm-dim">{mt.phone}</span>
        <span className="bm-dim bm-mono bm-right">
          {ageH < 24 ? `${Math.round(ageH)} h ago` : `${Math.round(ageH / 24)} d ago`}
        </span>
      </div>

      <p className="bm-desc">{mt.description}</p>

      <div className="bm-rushrow">
        <button className={`bm-rushbtn ${mt.rush ? "on" : ""}`}
                onClick={() => onPatch({ rush: !mt.rush, rushBy: !mt.rush ? who : null,
                                         rushAt: !mt.rush ? nowISO() : null })}>
          {mt.rush ? "✓ Marked rush" : "Mark as rush"}
        </button>
        <span className="bm-dim">
          {mt.rush
            ? `Marked by ${mt.rushBy || "—"} at ${fmt(mt.rushAt)}. Rush is your call; the system never sets it.`
            : "Seen it on site and it cannot wait? Mark it. Only the Building Manager can change this."}
        </span>
      </div>

      <div className="bm-mtstate">
        {["new", "scheduled", "in_progress", "done", "cancelled"].map((k) => (
          <button key={k} className={mt.state === k ? "on" : ""} style={{ "--c": MSTATE[k].color }}
                  onClick={() => onPatch({ state: k, ...(k === "done" ? { completedAt: nowISO() } : {}) })}>
            {MSTATE[k].label}
          </button>
        ))}
      </div>

      <div className="bm-sched">
        <label className="bm-f"><span>Vendor</span>
          <input className="bm-in" value={vendor} placeholder="Vendor name and contact"
                 onChange={(e) => setVendor(e.target.value)} /></label>
        <label className="bm-f"><span>Visit time</span>
          <input className="bm-in" type="datetime-local" value={when}
                 onChange={(e) => setWhen(e.target.value)} /></label>
        <button className="bm-btn bm-btn--sm" disabled={!when}
                onClick={() => onSchedule(when, vendor)}>
          Add to schedule
        </button>
      </div>
      {mt.scheduledAt ? (
        <div className="bm-ok">
          Booked {fmt(mt.scheduledAt)} · {mt.vendor || "vendor TBD"} (about {DUR.maintenance} min).
          It is on the schedule, appears in the day’s task list, and follows the previous-business-day reminder rule.
        </div>
      ) : (
        <div className="bm-dim">
          A vendor visit does not use your time, so it never clashes with a showing or a handover, but it still appears on the schedule so you know someone is coming.
        </div>
      )}
      {mt.entryNoticeSentAt ? (
        <div className="bm-dim">Notice of entry sent {fmt(mt.entryNoticeSentAt)}.</div>
      ) : mt.scheduledAt && (
        <div className="bm-warn" style={{ fontSize: 11.5 }}>
          If the unit is occupied, a vendor visit needs a notice of entry too. Emergencies — a leak, no heat, a safety issue —
          are usually treated differently; confirm the handling with your manager.
        </div>
      )}

      <div className="bm-notes">
        <div className="bm-noteh">Notes</div>
        {(mt.notes || []).length === 0 && <div className="bm-dim">No notes yet.</div>}
        {(mt.notes || []).slice().reverse().map((n, i) => (
          <div className="bm-note-i" key={i}>
            <div className="bm-dim">{fmt(n.at)} · {n.by}</div>
            <p>{n.text}</p>
          </div>
        ))}
        <div className="bm-noteadd">
          <input className="bm-in" value={note} placeholder="Add a note, e.g. part ordered, arriving tomorrow"
                 onChange={(e) => setNote(e.target.value)}
                 onKeyDown={(e) => { if (e.key === "Enter") { onNote(note); setNote(""); } }} />
          <button className="bm-btn bm-btn--sm" disabled={!note.trim()}
                  onClick={() => { onNote(note); setNote(""); }}>Add</button>
        </div>
      </div>
    </section>
  );
}

function KeyCard({ kh, who, conflictOf, onPatch }) {
  const [when, setWhen] = useState(kh.scheduledAt || "");
  const [assignee, setAssignee] = useState(kh.assignee || who);
  const t = unitType(kh.unitId);
  const clash = conflictOf(assignee, when, DUR.keys, kh.id);
  const items = kh.items || {};
  const CHECK = ["Unit keys", "Mailbox key", "Access fob", "Parking remote or decal", "Storage key", "Move-in inspection report completed"];
  const allDone = CHECK.every((c) => items[c]);

  return (
    <section className="bm-card">
      <div className="bm-mth">
        <span className="bm-mono bm-unit">{kh.unitId}</span>
        {t && <><span className="bm-mono bm-type">{t}</span><span className="bm-tag">{BED[t]}</span></>}
        <strong>{kh.tenant}</strong>
        <span className="bm-dim">{kh.phone} · {kh.email}</span>
        <span className="bm-dim bm-mono bm-right">Starts {kh.leaseStart}</span>
      </div>

      <div className="bm-sched">
        <label className="bm-f"><span>Assigned to</span>
          <input className="bm-in" value={assignee} onChange={(e) => setAssignee(e.target.value)} /></label>
        <label className="bm-f"><span>Handover time</span>
          <input className="bm-in" type="datetime-local" value={when}
                 onChange={(e) => setWhen(e.target.value)} /></label>
        <button className="bm-btn bm-btn--sm" disabled={!when || !assignee.trim() || !!clash}
                onClick={() => onPatch({ scheduledAt: when, assignee, state: "scheduled" })}>
          Save to schedule
        </button>
      </div>
      {clash && (
        <div className="bm-bad">
          Conflict: {assignee} already has {clash.what} at {fmt(clash.start.toISOString())}. Change the time or the person.
        </div>
      )}
      {kh.scheduledAt && !clash && (
        <div className="bm-ok">Booked {fmt(kh.scheduledAt)} · {kh.assignee} (about {DUR.keys} min)</div>
      )}

      <div className="bm-check">
        <div className="bm-noteh">Handover checklist</div>
        {CHECK.map((c) => (
          <label className="bm-ci" key={c}>
            <input type="checkbox" checked={!!items[c]}
                   onChange={(e) => onPatch({ items: { ...items, [c]: e.target.checked } })} />
            <span>{c}</span>
          </label>
        ))}
      </div>

      <input className="bm-in" value={kh.notes || ""} placeholder="Notes"
             onChange={(e) => onPatch({ notes: e.target.value })} />

      <div className="bm-actions">
        <button className="bm-btn" disabled={!allDone || !kh.scheduledAt}
                onClick={() => onPatch({ state: "done", completedAt: nowISO() })}>
          Complete handover
        </button>
        {!allDone && <span className="bm-dim">Tick every item first</span>}
      </div>
    </section>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=Archivo:wght@700;800&display=swap');
.bm{--ink:#131C25;--ink2:#3E4C5A;--dim:#78899A;--paper:#fff;--ground:#E9EDF0;--rule:#D3DBE1;
  --amber:#FFF6E0;--amberline:#E8C877;--red:#B23A54;--green:#0E8577;--accent:var(--brand,#2A6183);
  background:var(--ground);color:var(--ink);min-height:100vh;font-size:14px;line-height:1.55;
  font-family:'IBM Plex Sans','PingFang TC','Microsoft JhengHei',system-ui,sans-serif;padding-bottom:44px}
.bm *{box-sizing:border-box}
.bm-mono{font-family:'IBM Plex Mono',monospace;font-variant-numeric:tabular-nums}
.bm-dim{color:var(--dim);font-size:12px}
.bm-strong{font-weight:600}
.bm-right{margin-left:auto}
.bm-cut{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px}
.bm-load{padding:80px 20px;text-align:center;color:var(--dim)}

.bm-head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;
  padding:24px 28px 16px;background:var(--paper);border-bottom:1px solid var(--rule)}
.bm-eyebrow{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.13em;
  text-transform:uppercase;color:var(--dim)}
.bm-head h1{font-family:'Archivo','PingFang TC',sans-serif;font-weight:800;font-size:24px;
  letter-spacing:-.02em;margin:4px 0 0}
.bm-headr{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.bm-chip{font-size:11px;font-weight:700;color:#fff;background:#7C5CBF;border-radius:9px;padding:3px 10px}
.bm-save{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--dim);padding:4px 9px;
  border:1px solid var(--rule);border-radius:3px}
.bm-save--saved{color:var(--green);border-color:var(--green)}
.bm-save--error{color:var(--red);border-color:var(--red)}

.bm-tabs{display:flex;padding:0 28px;background:var(--paper);border-bottom:1px solid var(--rule)}
.bm-tabs button{font:inherit;font-weight:600;font-size:13.5px;cursor:pointer;background:none;border:0;
  padding:12px 18px;color:var(--dim);border-bottom:2px solid transparent;margin-bottom:-1px;
  display:flex;align-items:center;gap:7px}
.bm-tabs button.on{color:var(--ink);border-bottom-color:var(--brand,var(--ink))}
.bm-b{font-style:normal;font-family:'IBM Plex Mono',monospace;font-size:10px;background:var(--red);
  color:#fff;border-radius:8px;padding:1px 6px}

.bm-btn{font:inherit;font-weight:600;font-size:13px;cursor:pointer;background:var(--brand,var(--ink));color:#fff;
  border:1px solid var(--brand,var(--ink));padding:8px 15px;border-radius:3px}
.bm-btn:hover:not(:disabled){background:#000}
.bm-btn:disabled{opacity:.4;cursor:not-allowed}
.bm-btn--ghost{background:transparent;color:var(--ink2);border-color:var(--rule)}
.bm-btn--ghost:hover:not(:disabled){background:var(--ground);color:var(--ink)}
.bm-btn--sm{padding:6px 12px;font-size:12px}
.bm-btn--xs{padding:4px 10px;font-size:11.5px}
.bm-btn:focus-visible,.bm-in:focus-visible,.bm-sel:focus-visible,.bm-ta:focus-visible,
.bm-tabs button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

.bm-in,.bm-sel,.bm-ta{font:inherit;font-size:13px;padding:7px 10px;border:1px solid var(--amberline);
  border-radius:3px;background:var(--amber);color:var(--ink);width:100%;min-width:0}
.bm-sel{background:var(--paper);border-color:var(--rule);cursor:pointer}
.bm-ta{font-size:13px;line-height:1.7;resize:vertical;background:var(--paper);border-color:var(--rule);
  white-space:pre-wrap}

.bm-body{padding:18px 28px;display:flex;flex-direction:column;gap:14px;max-width:1100px}
.bm-note{color:var(--dim);font-size:12.5px;margin:0 0 4px;line-height:1.65}
.bm-empty{color:var(--dim);font-size:12.5px;padding:26px 0;text-align:center;background:var(--paper);
  border:1px dashed var(--rule);border-radius:4px}
.bm-card{background:var(--paper);border:1px solid var(--rule);border-radius:4px;padding:16px 18px;
  display:flex;flex-direction:column;gap:11px}
.bm-card h2{font-family:'Archivo',sans-serif;font-weight:700;font-size:15px;margin:0;
  display:flex;align-items:center;gap:8px}
.bm-card--urgent{border-color:var(--red);border-left:3px solid var(--red)}
.bm-card--warn{border-color:var(--amberline)}
.bm-n{font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:500;color:var(--dim);
  border:1px solid var(--rule);border-radius:10px;padding:0 8px}
.bm-warn{background:#FFF8E6;border:1px solid var(--amberline);border-radius:4px;padding:11px 14px;
  font-size:12px;color:#7A5D14;line-height:1.7}
.bm-barrow{display:flex;gap:12px;align-items:center;flex-wrap:wrap}

.bm-add{background:var(--paper);border:1px solid var(--rule);border-radius:4px;padding:14px 16px;
  display:flex;flex-direction:column;gap:10px}
.bm-addrow{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
.bm-addrow label{display:flex;flex-direction:column;gap:4px;flex:1 1 120px}
.bm-addrow label span{font-size:12px;font-weight:600;color:var(--ink2)}
.bm-addrow label em{font-style:normal;font-size:11px;color:var(--dim)}
.bm-prio{display:flex;gap:4px}
.bm-prio button{font:inherit;font-size:12px;cursor:pointer;background:var(--paper);
  border:1px solid var(--rule);border-radius:3px;padding:7px 11px;color:var(--dim)}
.bm-prio button.on{background:var(--c);color:#fff;border-color:var(--c);font-weight:600}

.bm-mt{border-left:3px solid var(--p)}
.bm-mth,.bm-noth{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px}
.bm-unit{font-size:15px;font-weight:600}
.bm-type{font-size:13px;color:var(--accent);font-weight:600}
.bm-tag{font-size:11px;border:1px solid var(--rule);border-radius:9px;padding:1px 8px;color:var(--ink2)}
.bm-badge{font-size:10.5px;font-weight:700;color:#fff;background:var(--c);border-radius:9px;padding:1px 8px}
.bm-rush{font-size:10.5px;font-weight:800;color:#fff;background:var(--red);border-radius:3px;
  padding:2px 9px;letter-spacing:.06em}
.bm-rushrow{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.bm-rushbtn{font:inherit;font-size:12px;font-weight:600;cursor:pointer;background:var(--paper);
  border:1px dashed var(--rule);border-radius:3px;padding:6px 13px;color:var(--dim)}
.bm-rushbtn:hover{border-color:var(--red);color:var(--red)}
.bm-rushbtn.on{background:var(--red);color:#fff;border:1px solid var(--red)}
.bm-desc{margin:0;font-size:13.5px;line-height:1.65;background:#FCFDFE;border:1px solid var(--rule);
  border-radius:3px;padding:10px 12px}

.bm-mtstate{display:flex;gap:5px;flex-wrap:wrap}
.bm-mtstate button{font:inherit;font-size:12px;cursor:pointer;background:var(--paper);
  border:1px solid var(--rule);border-radius:3px;padding:6px 12px;color:var(--dim)}
.bm-mtstate button.on{background:var(--c);color:#fff;border-color:var(--c);font-weight:600}

.bm-sched{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}
.bm-f{display:flex;flex-direction:column;gap:4px;flex:1 1 150px}
.bm-f>span{font-size:12px;font-weight:600;color:var(--ink2)}
.bm-bad{font-size:12px;color:var(--red);background:#FDF6F7;border:1px solid var(--red);
  border-radius:3px;padding:8px 11px;line-height:1.65}
.bm-ok{font-size:12px;color:var(--green);background:#F6FBF8;border:1px solid var(--green);
  border-radius:3px;padding:7px 11px}

.bm-notes{border-top:1px solid var(--rule);padding-top:10px;display:flex;flex-direction:column;gap:7px}
.bm-noteh{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.07em;
  text-transform:uppercase;color:var(--dim)}
.bm-note-i{border-left:2px solid var(--rule);padding-left:10px}
.bm-note-i p{margin:2px 0 0;font-size:13px;line-height:1.6}
.bm-noteadd{display:flex;gap:8px}
.bm-noteadd .bm-in{flex:1}

.bm-check{display:flex;flex-wrap:wrap;gap:6px 16px;border-top:1px solid var(--rule);padding-top:10px}
.bm-check .bm-noteh{width:100%}
.bm-ci{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--ink2)}

.bm-list{display:flex;flex-direction:column;gap:1px;background:var(--rule);border:1px solid var(--rule);
  border-radius:3px;overflow:hidden}
.bm-row{display:flex;align-items:center;gap:9px;padding:8px 12px;background:var(--paper);
  font-size:12.5px;flex-wrap:wrap}
.bm-actions{display:flex;gap:9px;align-items:center;flex-wrap:wrap}

.bm-foot{padding:4px 28px 0;color:var(--dim);font-size:11.5px;max-width:90ch;line-height:1.7}

.bm-windows{display:flex;flex-direction:column;gap:8px}
.bm-wlist{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.bm-wlabel{font-size:10.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;
  font-family:'IBM Plex Mono',monospace}
.bm-wlabel--ok{color:var(--green)}
.bm-wlabel--no{color:var(--red)}
.bm-window{font-size:12px;border:1px solid var(--green);color:var(--green);border-radius:12px;
  padding:2px 4px 2px 10px;display:inline-flex;align-items:center;gap:2px}
.bm-window--no{border-color:var(--red);color:var(--red)}
.bm-wadd{display:flex;gap:6px;flex-wrap:wrap;align-items:center;border-top:1px solid var(--rule);
  padding-top:9px}
.bm-wadd .bm-in,.bm-wadd .bm-sel{width:auto;flex:0 1 auto;min-width:90px}
.bm-remind{display:flex;gap:5px;flex-wrap:wrap}

.bm-locked{border:1px dashed var(--rule);border-radius:4px;padding:12px 14px;
  display:flex;flex-direction:column;gap:5px;background:#FBFCFD}
.bm-locked-h{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.bm-locked p{margin:0;line-height:1.65}

@media (max-width:720px){
  .bm-head,.bm-tabs,.bm-body,.bm-foot{padding-left:16px;padding-right:16px}
  .bm-right{margin-left:0;width:100%}
  .bm-cut{max-width:none}
}
`;
