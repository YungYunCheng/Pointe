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
  const requestedKind = params.get("kind");
  const kind = ["showing", "signing", "keys"].includes(requestedKind)
    ? requestedKind : "showing";
  const zh = locale === "zh";
  const kindLabel = zh
    ? { showing:"看房", signing:"簽約", keys:"交接鑰匙" }[kind]
    : { showing:"viewing", signing:"lease signing", keys:"key handover" }[kind];
  const [unitType, setUnitType] = useState(params.get("type") || "");
  const [day, setDay] = useState("");
  const [time, setTime] = useState("");
  const [form, setForm] = useState({ name: "", email: "", phone: "", notes: "",
    notification: "email" });
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
        name: d.tenant.name || "", email: d.tenant.email || "",
        phone: d.tenant.phone || x.phone })))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let live = true;
    setDay(""); setTime(""); setSlotsBusy(true);
    fetch(`/api/public/slots${kind === "showing" && unitType
      ? `?unit_type=${encodeURIComponent(unitType)}` : ""}`)
      .then(async (r) => {
        if (!r.ok) throw new Error("slots");
        const d = await r.json();
        if (live) { setDays(d.days || []); setOccupied(!!d.occupied); }
      })
      .catch(() => { if (live) { setDays([]); setErr(t("common.error")); } })
      .finally(() => { if (live) setSlotsBusy(false); });
    return () => { live = false; };
  }, [kind, unitType, t]);

  const chosen = days.find((d) => d.date === day);
  const wantsSms = form.notification === "sms" || form.notification === "both";
  const canSubmit = day && time && form.name.trim() && form.email.trim()
    && (!wantsSms || form.phone.trim()) && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true); setErr("");
    try {
      const requestId = crypto.randomUUID();
      const res = await fetch("/api/tenant/appointments", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type:kind,
          unit_type: kind === "showing" ? (unitType || null) : null,
          requested_date: day, requested_time: time, phone: form.phone,
          notes: form.notes, locale, notification_channel:form.notification,
          client_request_id: requestId }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.code || "booking");
      setDone({ ref:d.appointment.reference, unitType,
        date:day, time, email:form.email, channel:d.notification_channel });
    } catch (e) {
      const messages = zh ? {
        KEYS_NOT_RELEASED:"交接鑰匙尚未獲得管理人員批准，請先聯絡辦公室。",
        SIGNING_NOT_READY:"目前沒有可預約的簽約文件，請先聯絡租賃同事。",
        SLOT_NOT_AVAILABLE:"這個時間剛被預約，請選擇另一個時間。",
      } : {
        KEYS_NOT_RELEASED:"Key handover has not yet been released by staff. Please contact the office first.",
        SIGNING_NOT_READY:"There is no agreement ready for a signing appointment. Please contact the leasing team.",
        SLOT_NOT_AVAILABLE:"That time was just booked. Please choose another slot.",
      };
      setErr(messages[e.message] || t("common.error"));
    }
    setBusy(false);
  };

  if (done) {
    return (
      <section className="bt-sec">
        <div className="bt-form">
          <h2>{zh ? `${kindLabel}預約完成` : `${kindLabel} booked`}</h2>
          <div className="bt-ok" style={{ marginTop: 12 }}>
            {zh
              ? `${fmtD(done.date)} ${done.time}（Edmonton 時間）。確認與提醒會透過${done.channel === "sms" ? "簡訊" : done.channel === "both" ? "Email 和簡訊" : "Email"}發送。編號：${done.ref}`
              : `${fmtD(done.date)} at ${done.time} (Edmonton time). Confirmation and reminder will be sent by ${done.channel === "sms" ? "SMS" : done.channel === "both" ? "email and SMS" : "email"}. Reference: ${done.ref}`}
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
          <h2>{zh ? `預約${kindLabel}` : `Book ${kindLabel}`}</h2>
        <p className="bt-body">{kind === "showing" ? t("book.sub") : (zh
          ? "登入後選擇可用時間；預約會加入負責同事的日程。"
          : "Choose an available time after signing in. The appointment will be added to the responsible staff member's schedule.")}</p>

        {kind === "showing" && <div className="bt-f">
          <label>{t("book.suite")}</label>
          <select className="bt-sel" value={unitType} onChange={(e) => setUnitType(e.target.value)}>
            <option value="">{t("book.anySuite")}</option>
            {["1C", "1A", "1B", "2A", "3A"].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>}

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
          <label>{zh ? "確認與提醒方式" : "Confirmation and reminder"}</label>
          <select className="bt-sel" value={form.notification}
                  onChange={(e) => setForm({ ...form, notification:e.target.value })}>
            <option value="email">Email</option>
            <option value="sms">SMS</option>
            <option value="both">{zh ? "Email 和 SMS" : "Email and SMS"}</option>
          </select>
          {wantsSms && !form.phone.trim() && <p className="bt-hint">
            {zh ? "選擇 SMS 時請填寫含國家區號的手機號碼。" : "Enter a mobile number with country code for SMS."}
          </p>}
        </div>
        <div className="bt-f">
          <label>{t("book.notes")}</label>
          <textarea className="bt-ta" value={form.notes}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </div>

        {err && <div className="bt-err">{err}</div>}
        <button className="bt-btn" onClick={submit} disabled={!canSubmit}>
          {busy ? t("book.booking") : (zh ? `確認${kindLabel}時間` : `Confirm ${kindLabel}`)}
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
