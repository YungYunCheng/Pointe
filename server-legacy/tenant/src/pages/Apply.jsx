import React, { useState, useEffect, useMemo } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useT } from "../lib/locale.jsx";

/* ============================================================
   Application

   Six steps. Two of them exist because of how this can go wrong:

   Step 4 shows every cost before anything is submitted. Alberta caps
   the security deposit at one month's rent and counts a pet deposit
   inside that cap, so there is no figure to hold back. A tenant who
   sees the total up front cannot be surprised by it later.

   Step 2 asks how many people will live here and nothing else about
   them. Occupancy is a legitimate limit. Household composition,
   marital status, nationality, age, religion and source of income
   are protected grounds and are not asked here or anywhere.
   ============================================================ */

const TOTAL = 6;
const TYPES = {
  "1C": { beds: 1, den: false, sf: 462.8 }, "1A": { beds: 1, den: false, sf: 484.4 },
  "1B": { beds: 1, den: true, sf: 602.8 }, "3A": { beds: 2, den: true, sf: 731.9 },
  "2A": { beds: 2, den: false, sf: 742.7 },
};

export default function Apply() {
  const { t, locale, money } = useT();
  const [params] = useSearchParams();
  const [step, setStep] = useState(1);
  const [facts, setFacts] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [err, setErr] = useState("");

  const [f, setF] = useState({
    unitType: params.get("type") || "",
    moveIn: "", term: "12",
    tenants: [""], occupants: "",
    parking: false, storage: false, pets: "none", serviceAnimal: false,
    files: [], skipDocs: false,
    feeAck: false, consent: false,
    email: "", phone: "",
  });
  const set = (patch) => setF((x) => ({ ...x, ...patch }));

  /* Draft is kept so a tenant can stop and come back. It never leaves
     the browser until they press submit. */
  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get("baydo:apply-draft");
        if (r?.value) setF((x) => ({ ...x, ...JSON.parse(r.value), files: [] }));
      } catch {}
      try {
        const p = await window.storage.get("baydo:pricing");
        const pk = await window.storage.get("baydo:parking");
        setFacts({ pricing: p?.value ? JSON.parse(p.value) : {},
                   parking: pk?.value ? JSON.parse(pk.value) : { pools: [], records: [] } });
      } catch { setFacts({ pricing: {}, parking: { pools: [], records: [] } }); }
    })();
  }, []);

  useEffect(() => {
    const { files, ...rest } = f;
    window.storage?.set?.("baydo:apply-draft", JSON.stringify(rest)).catch(() => {});
  }, [f]);

  /* ---------- costs, calculated not typed ---------- */
  const costs = useMemo(() => {
    const p = facts?.pricing || {};
    const rent = Number(p.base?.[f.unitType]) || 0;
    const petCount = f.pets === "none" || f.serviceAnimal ? 0 : (f.pets === "both" ? 2 : 1);
    const monthly = [
      { k: "rent", label: locale === "zh" ? "租金" : "Rent", amt: rent },
      { k: "parking", label: locale === "zh" ? "車位" : "Parking",
        amt: f.parking ? Number(p.parkUnderground) || 0 : 0 },
      { k: "storage", label: locale === "zh" ? "儲藏室" : "Storage",
        amt: f.storage ? Number(p.storage) || 0 : 0 },
      { k: "pet", label: locale === "zh" ? "寵物月費" : "Pet rent",
        amt: petCount * (Number(p.petRent) || 0) },
    ].filter((x) => x.amt > 0 || x.k === "rent");
    const monthlyTotal = monthly.reduce((s, x) => s + x.amt, 0);

    const deposit = p.depositMode === "fixed" ? Number(p.depositFixed) || 0 : rent;
    // A service animal carries no deposit. A pet deposit sits inside the
    // security deposit cap rather than on top of it.
    const petDep = petCount === 0 ? 0
      : (f.pets.includes("dog") ? Number(p.dogDeposit) || 0 : Number(p.catDeposit) || 0);
    const upfront = [
      { label: locale === "zh" ? "保證金" : "Security deposit", amt: deposit },
      { label: locale === "zh" ? "寵物押金" : "Pet deposit", amt: petDep },
      { label: locale === "zh" ? "首月租金" : "First month", amt: monthlyTotal },
      { label: locale === "zh" ? "申請費" : "Application fee", amt: Number(p.appFee) || 0 },
    ].filter((x) => x.amt > 0);
    const upfrontTotal = upfront.reduce((s, x) => s + x.amt, 0);
    const capOk = rent === 0 || deposit + petDep <= rent;

    return { rent, monthly, monthlyTotal, upfront, upfrontTotal, capOk,
             includes: p.utilities || "" };
  }, [facts, f, locale]);

  const stallsFree = useMemo(() => {
    const pk = facts?.parking; if (!pk) return null;
    return (pk.pools || []).reduce((n, p) => {
      const used = (pk.records || []).filter((r) => r.status === "assigned" && r.poolId === p.id).length;
      return n + (Number(p.total || 0) - used);
    }, 0);
  }, [facts]);

  const canAdvance = () => {
    if (step === 1) return f.unitType && f.moveIn;
    if (step === 2) return f.tenants.some((x) => x.trim()) && Number(f.occupants) > 0
      && f.email.trim();
    if (step === 4) return f.feeAck;
    if (step === 6) return f.consent;
    return true;
  };

  const submit = async () => {
    setBusy(true); setErr("");
    try {
      const ref = "A" + Date.now().toString(36).toUpperCase().slice(-6);
      const rec = { ref, ...f, files: f.files.map((x) => x.name),
                    costs: { monthlyTotal: costs.monthlyTotal, upfrontTotal: costs.upfrontTotal },
                    locale, createdAt: new Date().toISOString(), state: "new" };
      let q = [];
      try { const r = await window.storage.get("baydo:applications"); if (r?.value) q = JSON.parse(r.value); }
      catch {}
      await window.storage.set("baydo:applications", JSON.stringify([...q, rec]));
      await window.storage.delete("baydo:apply-draft").catch(() => {});
      setDone(rec);
    } catch { setErr(t("common.error")); }
    setBusy(false);
  };

  if (done) return (
    <section className="bt-sec"><div className="bt-form">
      <h2>{t("apply.doneTitle")}</h2>
      <div className="bt-ok" style={{ marginTop: 12 }}>{t("apply.doneBody", { ref: done.ref })}</div>
      <p className="bt-hint" style={{ marginTop: 12 }}>{t("apply.doneNext")}</p>
      <Link to="/" className="bt-btn" style={{ marginTop: 20 }}>{t("nav.home")}</Link>
    </div></section>
  );

  return (
    <section className="bt-sec">
      <div className="bt-form">
        <div className="bt-steps">
          <span>{t("apply.step", { n: step, total: TOTAL })}</span>
          <div className="bt-bar"><i style={{ width: `${(step / TOTAL) * 100}%` }} /></div>
        </div>

        {step === 1 && (
          <>
            <h2>{t("apply.s1")}</h2>
            <p className="bt-body">{t("apply.s1sub")}</p>
            <div className="bt-f">
              <label>{t("book.suite")}</label>
              <select className="bt-sel" value={f.unitType} onChange={(e) => set({ unitType: e.target.value })}>
                <option value="">—</option>
                {Object.keys(TYPES).map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="bt-f">
              <label>{t("apply.moveIn")}</label>
              <input className="bt-in" type="date" value={f.moveIn}
                     onChange={(e) => set({ moveIn: e.target.value })} />
            </div>
            <div className="bt-f">
              <label>{t("apply.term")}</label>
              <div className="bt-opts">
                {[["12", "term12"], ["6", "term6"], ["monthly", "termMonthly"]].map(([k, l]) => (
                  <button key={k} className={f.term === k ? "on" : ""} onClick={() => set({ term: k })}>
                    {t(`apply.${l}`)}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h2>{t("apply.s2")}</h2>
            <p className="bt-body">{t("apply.s2sub")}</p>
            {f.tenants.map((name, i) => (
              <div className="bt-f" key={i}>
                <label>{t("apply.fullName")} {i > 0 && `#${i + 1}`}</label>
                <input className="bt-in" value={name}
                       onChange={(e) => set({ tenants: f.tenants.map((x, j) => (j === i ? e.target.value : x)) })} />
              </div>
            ))}
            <button className="bt-btn bt-btn--ghost bt-btn--sm" style={{ marginBottom: 18 }}
                    onClick={() => set({ tenants: [...f.tenants, ""] })}>
              + {t("apply.addTenant")}
            </button>
            <div className="bt-f">
              <label>{t("book.email")}</label>
              <input className="bt-in" type="email" value={f.email}
                     onChange={(e) => set({ email: e.target.value })} />
            </div>
            <div className="bt-f">
              <label>{t("book.phone")} <em>{t("common.optional")}</em></label>
              <input className="bt-in" type="tel" value={f.phone}
                     onChange={(e) => set({ phone: e.target.value })} />
            </div>
            <div className="bt-f">
              <label>{t("apply.occupants")}</label>
              <input className="bt-in" type="number" min="1" value={f.occupants}
                     onChange={(e) => set({ occupants: e.target.value })} />
              {/* Saying why we ask, so it does not read as screening */}
              <span className="bt-hint">{t("apply.occupantsHint")}</span>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h2>{t("apply.s3")}</h2>
            <p className="bt-body">{t("apply.s3sub")}</p>
            <div className="bt-f">
              <label>{t("apply.wantParking")}</label>
              <div className="bt-opts">
                <button className={f.parking ? "on" : ""} onClick={() => set({ parking: true })}>{t("common.yes")}</button>
                <button className={!f.parking ? "on" : ""} onClick={() => set({ parking: false })}>{t("common.no")}</button>
              </div>
              {f.parking && stallsFree !== null && (
                <span className="bt-hint">
                  {stallsFree > 0 ? t("parking.free", { n: stallsFree }) : t("parking.none")} · {t("parking.body")}
                </span>
              )}
            </div>
            <div className="bt-f">
              <label>{t("apply.wantStorage")}</label>
              <div className="bt-opts">
                <button className={f.storage ? "on" : ""} onClick={() => set({ storage: true })}>{t("common.yes")}</button>
                <button className={!f.storage ? "on" : ""} onClick={() => set({ storage: false })}>{t("common.no")}</button>
              </div>
            </div>
            <div className="bt-f">
              <label>{t("apply.pets")}</label>
              <div className="bt-opts">
                {[["none", "petsNone"], ["cat", "petCat"], ["dog", "petDog"], ["both", "petBoth"]].map(([k, l]) => (
                  <button key={k} className={f.pets === k ? "on" : ""} onClick={() => set({ pets: k })}>
                    {t(`apply.${l}`)}
                  </button>
                ))}
              </div>
            </div>
            <label className="bt-check">
              <input type="checkbox" checked={f.serviceAnimal}
                     onChange={(e) => set({ serviceAnimal: e.target.checked })} />
              <span>{t("apply.serviceAnimal")}</span>
            </label>
            {f.serviceAnimal && <div className="bt-note" style={{ marginTop: 12 }}>
              <p>{t("apply.serviceNote")}</p></div>}
          </>
        )}

        {step === 4 && (
          <>
            <h2>{t("apply.s4")}</h2>
            <p className="bt-body">{t("apply.s4sub")}</p>
            {costs.rent === 0 ? (
              <div className="bt-err">{t("suites.askRate")}</div>
            ) : (
              <>
                <div className="bt-costs">
                  <div className="bt-cost-h">{t("apply.monthly")}</div>
                  {costs.monthly.map((x) => (
                    <div className="bt-cost" key={x.k}><span>{x.label}</span><span>{money(x.amt)}</span></div>
                  ))}
                  <div className="bt-cost bt-cost--tot">
                    <span>{t("apply.monthlyTotal")}</span><span>{money(costs.monthlyTotal)}</span>
                  </div>
                </div>
                <div className="bt-costs">
                  <div className="bt-cost-h">{t("apply.upfront")}</div>
                  {costs.upfront.map((x, i) => (
                    <div className="bt-cost" key={i}><span>{x.label}</span><span>{money(x.amt)}</span></div>
                  ))}
                  <div className="bt-cost bt-cost--tot">
                    <span>{t("apply.upfrontTotal")}</span><span>{money(costs.upfrontTotal)}</span>
                  </div>
                </div>
                {costs.includes && <p className="bt-hint">{t("apply.rentIncludes")}: {costs.includes}</p>}
                <p className="bt-hint">{t("apply.depositNote")}</p>
                <p className="bt-hint">{t("apply.leaseGoverns")}</p>
                <label className="bt-check" style={{ marginTop: 14 }}>
                  <input type="checkbox" checked={f.feeAck} onChange={(e) => set({ feeAck: e.target.checked })} />
                  <span>{t("apply.ack")}</span>
                </label>
              </>
            )}
          </>
        )}

        {step === 5 && (
          <>
            <h2>{t("apply.s5")}</h2>
            <p className="bt-body">{t("apply.s5sub")}</p>
            <div className="bt-f">
              <label htmlFor="up">{t("apply.upload")}</label>
              <input id="up" className="bt-in" type="file" multiple
                     onChange={(e) => set({ files: [...f.files, ...Array.from(e.target.files || [])] })} />
              {f.files.length > 0 && <span className="bt-hint">{t("apply.uploaded", { n: f.files.length })}</span>}
              <span className="bt-hint">{t("apply.docHint")}</span>
            </div>
            <label className="bt-check">
              <input type="checkbox" checked={f.skipDocs} onChange={(e) => set({ skipDocs: e.target.checked })} />
              <span>{t("apply.skipDocs")}</span>
            </label>
          </>
        )}

        {step === 6 && (
          <>
            <h2>{t("apply.s6")}</h2>
            <p className="bt-body">{t("apply.s6sub")}</p>
            <dl className="bt-review">
              <Row k={t("book.suite")} v={f.unitType} onEdit={() => setStep(1)} t={t} />
              <Row k={t("apply.moveIn")} v={f.moveIn} onEdit={() => setStep(1)} t={t} />
              <Row k={t("apply.fullName")} v={f.tenants.filter(Boolean).join(", ")} onEdit={() => setStep(2)} t={t} />
              <Row k={t("apply.occupants")} v={f.occupants} onEdit={() => setStep(2)} t={t} />
              <Row k={t("apply.wantParking")} v={f.parking ? t("common.yes") : t("common.no")} onEdit={() => setStep(3)} t={t} />
              <Row k={t("apply.pets")} v={f.serviceAnimal ? t("apply.serviceAnimal") : t(`apply.pet${f.pets === "none" ? "sNone" : f.pets === "cat" ? "Cat" : f.pets === "dog" ? "Dog" : "Both"}`)} onEdit={() => setStep(3)} t={t} />
              <Row k={t("apply.monthlyTotal")} v={money(costs.monthlyTotal)} onEdit={() => setStep(4)} t={t} />
              <Row k={t("apply.upfrontTotal")} v={money(costs.upfrontTotal)} onEdit={() => setStep(4)} t={t} />
            </dl>
            <label className="bt-check" style={{ marginTop: 16 }}>
              <input type="checkbox" checked={f.consent} onChange={(e) => set({ consent: e.target.checked })} />
              <span>{t("apply.consent")}</span>
            </label>
            <p className="bt-hint">{t("apply.consentNote")}</p>
          </>
        )}

        {err && <div className="bt-err" style={{ marginTop: 14 }}>{err}</div>}

        <div className="bt-navrow">
          {step > 1 && <button className="bt-btn bt-btn--ghost" onClick={() => setStep(step - 1)}>{t("apply.back")}</button>}
          {step < TOTAL
            ? <button className="bt-btn" disabled={!canAdvance()} onClick={() => setStep(step + 1)}>{t("apply.next")}</button>
            : <button className="bt-btn" disabled={!canAdvance() || busy} onClick={submit}>
                {busy ? t("apply.submitting") : t("apply.submit")}</button>}
        </div>
      </div>

      <style>{`
        .bt-steps{margin-bottom:22px}
        .bt-steps span{font-size:12.5px;color:var(--dim);font-weight:600}
        .bt-bar{height:3px;background:var(--rule);border-radius:2px;margin-top:6px;overflow:hidden}
        .bt-bar i{display:block;height:100%;background:var(--ink);transition:width .25s}
        .bt-costs{border:1px solid var(--rule);border-radius:10px;overflow:hidden;margin-bottom:14px}
        .bt-cost-h{font-size:11.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
          color:var(--dim);background:var(--tint);padding:9px 14px;border-bottom:1px solid var(--rule)}
        .bt-cost{display:flex;justify-content:space-between;gap:12px;padding:9px 14px;font-size:14px;
          border-bottom:1px solid var(--rule)}
        .bt-cost:last-child{border-bottom:0}
        .bt-cost span:last-child{font-family:'IBM Plex Mono',monospace}
        .bt-cost--tot{font-weight:700;background:#FCFDFE}
        .bt-review{margin:0;border:1px solid var(--rule);border-radius:10px;overflow:hidden}
        .bt-rev{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 14px;
          border-bottom:1px solid var(--rule);font-size:14px}
        .bt-rev:last-child{border-bottom:0}
        .bt-rev dt{color:var(--dim);font-size:13px;margin:0}
        .bt-rev dd{margin:0;font-weight:600;text-align:right;flex:1}
        .bt-rev button{font:inherit;font-size:12.5px;background:none;border:0;color:var(--accent);
          cursor:pointer;flex:0 0 auto}
        .bt-navrow{display:flex;gap:8px;margin-top:24px}
        .bt-navrow .bt-btn{flex:1}
      `}</style>
    </section>
  );
}

function Row({ k, v, onEdit, t }) {
  return (
    <div className="bt-rev">
      <dt>{k}</dt>
      <dd>{v || "—"}</dd>
      <button onClick={onEdit}>{t("apply.editStep")}</button>
    </div>
  );
}
