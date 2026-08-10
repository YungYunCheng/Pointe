import React, { useState, useMemo, useEffect } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useT } from "../lib/locale.jsx";

/* ============================================================
   Book a viewing

   Slots come from the schedule. Two rules from the staff side show
   through here rather than being hidden:

   · A suite that still has a tenant in it needs 24 hours' written
     notice before anyone views it. Rather than offering times we
     would then have to cancel, those slots simply are not offered,
     and the reason is stated.

   · Showings run 30 minutes and only during office hours, because
     that is what the schedule allows. Offering a 7pm slot a person
     cannot attend wastes the tenant's evening, not ours.
   ============================================================ */

const SLOT_MIN = 30;
const DAY = { start: 10, end: 18 };      // office hours for viewings
const NOTICE_HOURS = 24;                 // occupied suites need this much warning
const LEAD_HOURS = 3;                    // nothing same-hour, someone has to travel
const HORIZON_DAYS = 14;

const pad = (n) => String(n).padStart(2, "0");
const isoD = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function buildDays(occupied) {
  const out = [];
  const earliest = Date.now() + (occupied ? NOTICE_HOURS : LEAD_HOURS) * 3600e3;
  for (let i = 0; i < HORIZON_DAYS; i++) {
    const d = new Date(); d.setDate(d.getDate() + i);
    const dow = d.getDay();
    if (dow === 0) continue;                       // closed Sunday
    const endH = dow === 6 ? 16 : DAY.end;         // shorter Saturday
    const slots = [];
    for (let h = DAY.start; h < endH; h++) {
      for (const m of [0, SLOT_MIN]) {
        const at = new Date(d); at.setHours(h, m, 0, 0);
        if (at.getTime() < earliest) continue;
        slots.push(`${pad(h)}:${pad(m)}`);
      }
    }
    if (slots.length) out.push({ date: isoD(d), slots });
  }
  return out;
}

export default function Booking() {
  const { t, locale, date: fmtD } = useT();
  const [params] = useSearchParams();
  const [unitType, setUnitType] = useState(params.get("type") || "");
  const [day, setDay] = useState("");
  const [time, setTime] = useState("");
  const [form, setForm] = useState({ name: "", email: "", phone: "", notes: "" });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [err, setErr] = useState("");

  // Treated as occupied when a type is chosen, since re-lets are the common
  // case here. The server knows for certain and will refuse a short-notice slot.
  const occupied = !!unitType;
  const days = useMemo(() => buildDays(occupied), [occupied]);
  useEffect(() => { setDay(""); setTime(""); }, [unitType]);

  const chosen = days.find((d) => d.date === day);
  const canSubmit = day && time && form.name.trim() && form.email.trim() && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true); setErr("");
    try {
      const ref = "V" + Date.now().toString(36).toUpperCase().slice(-6);
      const rec = { ref, type: "showing", unitType: unitType || null, date: day, time,
                    ...form, locale, createdAt: new Date().toISOString(), state: "requested" };
      let q = [];
      try { const r = await window.storage.get("baydo:bookings"); if (r?.value) q = JSON.parse(r.value); }
      catch {}
      await window.storage.set("baydo:bookings", JSON.stringify([...q, rec]));
      setDone(rec);
    } catch (e) {
      setErr(t("common.error"));
    }
    setBusy(false);
  };

  if (done) {
    return (
      <section className="bt-sec">
        <div className="bt-form">
          <h2>{t("book.doneTitle")}</h2>
          <div className="bt-ok" style={{ marginTop: 12 }}>
            {t("book.doneBody", { date: fmtD(done.date), time: done.time,
                                  unit: done.unitType || "—", email: done.email })}
          </div>
          <p className="bt-hint" style={{ marginTop: 12 }}>{t("book.reschedule")}</p>
          <div style={{ marginTop: 20, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Link to="/apply" className="bt-btn">{t("nav.apply")}</Link>
            <Link to="/suites" className="bt-btn bt-btn--ghost">{t("nav.suites")}</Link>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="bt-sec">
      <div className="bt-form">
        <h2>{t("book.title")}</h2>
        <p className="bt-body">{t("book.sub")}</p>

        <div className="bt-f">
          <label>{t("book.suite")}</label>
          <select className="bt-sel" value={unitType} onChange={(e) => setUnitType(e.target.value)}>
            <option value="">{t("book.anySuite")}</option>
            {["1C", "1A", "1B", "2A", "3A"].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        {occupied && <div className="bt-note" style={{ margin: "0 0 18px" }}>
          <p>{t("book.occupied")}</p>
        </div>}

        <div className="bt-f">
          <label>{t("book.pickDay")}</label>
          <div className="bt-days">
            {days.slice(0, 10).map((d) => (
              <button key={d.date} className={day === d.date ? "on" : ""}
                      onClick={() => { setDay(d.date); setTime(""); }}>
                <em>{new Date(d.date + "T12:00").toLocaleDateString(
                  locale === "zh" ? "zh-Hant-CA" : "en-CA", { weekday: "short" })}</em>
                <strong>{d.date.slice(8)}</strong>
                <span>{d.date.slice(5, 7)}</span>
              </button>
            ))}
          </div>
        </div>

        {day && (
          <div className="bt-f">
            <label>{t("book.pickTime")}</label>
            {chosen?.slots.length ? (
              <div className="bt-times">
                {chosen.slots.map((s) => (
                  <button key={s} className={time === s ? "on" : ""} onClick={() => setTime(s)}>{s}</button>
                ))}
              </div>
            ) : <p className="bt-hint">{t("book.noSlots")}</p>}
          </div>
        )}

        <div className="bt-f">
          <label>{t("book.name")}</label>
          <input className="bt-in" value={form.name}
                 onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="bt-f">
          <label>{t("book.email")}</label>
          <input className="bt-in" type="email" value={form.email}
                 onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </div>
        <div className="bt-f">
          <label>{t("book.phone")} <em>{t("common.optional")}</em></label>
          <input className="bt-in" type="tel" value={form.phone}
                 onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </div>
        <div className="bt-f">
          <label>{t("book.notes")}</label>
          <textarea className="bt-ta" value={form.notes}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </div>

        {err && <div className="bt-err">{err}</div>}
        <button className="bt-btn" onClick={submit} disabled={!canSubmit}>
          {busy ? t("book.booking") : t("book.submit")}
        </button>
      </div>

      <style>{`
        .bt-days{display:flex;gap:6px;flex-wrap:wrap}
        .bt-days button{font:inherit;cursor:pointer;background:#fff;border:1px solid var(--rule);
          border-radius:8px;padding:9px 12px;display:flex;flex-direction:column;align-items:center;
          min-width:56px;color:var(--ink2)}
        .bt-days button em{font-style:normal;font-size:10.5px;color:var(--dim);text-transform:uppercase}
        .bt-days button strong{font-family:'IBM Plex Mono',monospace;font-size:17px;line-height:1.2}
        .bt-days button span{font-size:10.5px;color:var(--dim)}
        .bt-days button.on{background:var(--ink);color:#fff;border-color:var(--ink)}
        .bt-days button.on em,.bt-days button.on span{color:rgba(255,255,255,.75)}
        .bt-times{display:flex;gap:6px;flex-wrap:wrap}
        .bt-times button{font:inherit;font-family:'IBM Plex Mono',monospace;font-size:14px;cursor:pointer;
          background:#fff;border:1px solid var(--rule);border-radius:8px;padding:9px 14px;color:var(--ink2)}
        .bt-times button.on{background:var(--ink);color:#fff;border-color:var(--ink)}
      `}</style>
    </section>
  );
}
