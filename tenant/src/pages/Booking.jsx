import React, { useState, useEffect } from "react";
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
  const [days, setDays] = useState([]);
  const [occupied, setOccupied] = useState(false);
  const [slotsBusy, setSlotsBusy] = useState(true);

  useEffect(() => {
    fetch("/api/tenant/me", { credentials: "include" })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => d?.tenant && setForm((x) => ({ ...x,
        name: d.tenant.name || "", email: d.tenant.email || "" })))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let live = true;
    setDay(""); setTime(""); setSlotsBusy(true);
    fetch(`/api/public/slots${unitType ? `?unit_type=${encodeURIComponent(unitType)}` : ""}`)
      .then(async (r) => {
        if (!r.ok) throw new Error("slots");
        const d = await r.json();
        if (live) { setDays(d.days || []); setOccupied(!!d.occupied); }
      })
      .catch(() => { if (live) { setDays([]); setErr(t("common.error")); } })
      .finally(() => { if (live) setSlotsBusy(false); });
    return () => { live = false; };
  }, [unitType, t]);

  const chosen = days.find((d) => d.date === day);
  const canSubmit = day && time && form.name.trim() && form.email.trim() && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true); setErr("");
    try {
      const requestId = crypto.randomUUID();
      const res = await fetch("/api/tenant/viewings", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unit_type: unitType || null,
          requested_date: day, requested_time: time, phone: form.phone,
          notes: form.notes, locale, client_request_id: requestId }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.code || "booking");
      setDone({ ref: d.booking.reference, unitType: d.booking.unit_type,
        date: String(d.booking.requested_date).slice(0, 10), time,
        email: form.email });
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
          {slotsBusy && <p className="bt-hint">{t("common.loading")}</p>}
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
          <input className="bt-in" value={form.name} readOnly />
        </div>
        <div className="bt-f">
          <label>{t("book.email")}</label>
          <input className="bt-in" type="email" value={form.email} readOnly />
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
