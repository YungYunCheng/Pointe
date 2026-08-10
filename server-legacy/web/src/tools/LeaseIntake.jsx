import React, { useState, useEffect, useMemo, useCallback } from "react";
import { ai } from "../lib/ai.js";

/* ============================================================
   BAYDO POINTE — Lease assembly and approval
   The line: this collects details. It does not assemble a lease.
   Clauses come from the approved template library; the system only decides which are included.
   ============================================================ */

/* ---------- Variables the intake has to collect ---------- */
const VARS = [
  { k: "unit_id",       label: "Unit",              type: "text",   ask: true,  hint: "e.g. 378-519" },
  { k: "tenant_names",  label: "Tenant full names", type: "text",   ask: true,  hint: "Every adult tenant, comma separated" },
  { k: "tenant_phone",  label: "Phone",             type: "text",   ask: true,  hint: "e.g. 780-555-0142" },
  { k: "tenant_email",  label: "Email",        type: "text",   ask: true },
  { k: "occupants",     label: "Occupants",         type: "number", ask: true,  hint: "Including minors. Used only for occupancy standards." },
  { k: "start_date",    label: "Start date",        type: "date",   ask: true },
  { k: "term",          label: "Term",              type: "select", ask: true,  options: ["Fixed 12 months", "Fixed 6 months", "Month to month"] },
  { k: "parking",       label: "Parking",           type: "select", ask: true,  options: ["None", "Underground / 370", "Underground / 374", "Underground / 378", "Surface / shared"] },
  { k: "storage",       label: "Storage",           type: "select", ask: true,  options: ["None", "Yes"] },
  { k: "pets",          label: "Pets",              type: "select", ask: true,  options: ["None", "1 cat", "2 cats", "1 dog", "1 cat and 1 dog"] },
  { k: "emergency",     label: "Emergency contact", type: "text",   ask: true,  hint: "Name and phone" },
  { k: "inspection_at", label: "Move-in inspection",type: "text",   ask: true,  hint: "Alberta requires a written inspection report at move-in" },
  { k: "fee_ack",       label: "Fees acknowledged",  type: "ack" },
  // Filled from the property data. The tenant is never asked for these.
  { k: "rent",          label: "Rent",              type: "auto" },
  { k: "deposit",       label: "Deposit",           type: "auto" },
  { k: "parking_fee",   label: "Stall rent",        type: "auto" },
  { k: "storage_fee",   label: "Storage rent",      type: "auto" },
  { k: "pet_fee",       label: "Pet rent",          type: "auto" },
  { k: "utilities",     label: "Rent includes",     type: "auto" },
];
const ASK_VARS = VARS.filter((v) => v.ask);

/* ---------- What this tool does now ----------

   It collects the details needed before a lease is prepared, and it
   checks them. It does not assemble a lease.

   The agreement itself is a file Admin uploaded — the version counsel
   approved — and it goes to the tenant unchanged. A generated clause
   can be void and reads exactly as convincingly as a valid one, so the
   only way to be sure the tenant signed what was approved is for those
   to be the same file.

   What is collected here goes in the covering message and is recorded
   against the issue, so a price change next month cannot rewrite what
   this tenant was told.                                              */

/* ---------- Off-limits in intake. A generated question that matches is blocked.
     The Chinese patterns stay: tenants reply in either language. ---------- */
const FORBIDDEN_Q = {
  re: /小孩|孩子|children|kids|懷孕|pregnan|婚姻|married|配偶|spouse|單親|國籍|籍貫|移民|immigrant|出生地|宗教|信仰|religio|種族|race|族裔|年齡|幾歲|age\b|性別|gender|性向|收入|所得|income|薪|salary|工作單位|employer|AISH|補助|福利|credit|信用/i,
  why: "Intake questions must not touch a protected ground or eligibility. The number of occupants is fine — that is an occupancy standard — but the composition of the household is not.",
};

/* ---------- Pre-assembly checks. Rules, not the model. ---------- */
function runChecks(v, facts) {
  const out = [];
  const push = (ok, label, detail) => out.push({ ok, label, detail });

  const missing = ASK_VARS.filter((x) => !v[x.k]).map((x) => x.label);
  push(missing.length === 0, "Intake complete", missing.length ? `Still missing: ${missing.join(", ")}` : "All fields confirmed");

  const rent = Number(v.rent) || 0;
  const dep = Number(v.deposit) || 0;
  const petDep = facts.petDeposit || 0;
  push(rent > 0, "Rent populated", rent ? `$${rent.toLocaleString("en-CA")}` : "No rent set for this unit type");
  push(dep > 0 && dep + petDep <= rent,
       "Deposit within one month’s rent",
       rent ? `deposit $${dep.toLocaleString("en-CA")} + pet deposit $${petDep.toLocaleString("en-CA")} against rent $${rent.toLocaleString("en-CA")}`
            : "cannot be calculated",
       );

  if (v.start_date) {
    const ok = !facts.availableFrom || v.start_date >= facts.availableFrom;
    push(ok, "Start date not before the unit is available", facts.availableFrom ? `Available from ${facts.availableFrom}` : "No availability date set");
  } else push(false, "Start date not before the unit is available", "No start date entered");

  if (v.parking && v.parking !== "None") {
    push(!!facts.parkingAssigned, "Stall actually assigned, not waitlisted",
         facts.parkingAssigned ? `Assigned: ${facts.parkingAssigned}` : "No assigned stall found for this unit, so it cannot go in the lease");
  } else push(true, "Parking", "No stall in this lease");

  if (v.pets && v.pets !== "None") {
    push(!!facts.petLimit, "Pet count within policy", facts.petLimit ? `Policy limit: ${facts.petLimit}` : "No pet limit set");
  } else push(true, "Pets", "No pets in this lease");

  push(!!v.occupants && Number(v.occupants) > 0, "Occupants confirmed", v.occupants ? `${v.occupants}` : "not entered");
  push(!!v.inspection_at, "Move-in inspection booked", v.inspection_at || "Alberta requires a written inspection report");
  push(!!facts.feeAck, "Fees disclosed and acknowledged",
       facts.feeAck ? `${facts.feeAck.at} — $${facts.feeAck.monthlyTotal.toLocaleString("en-CA")}/mo, $${facts.feeAck.upfrontTotal.toLocaleString("en-CA")} up front`
                    : "Fees not yet disclosed, or the tenant has not confirmed");
  if (facts.feeAck) {
    const same = facts.feeAck.monthlyTotal === facts.feeMonthlyNow && facts.feeAck.upfrontTotal === facts.feeUpfrontNow;
    push(same, "Fees unchanged since disclosure",
         same ? "Matches the current settings" : "Fees changed after disclosure. Disclose again and get a fresh acknowledgement.");
  }

  return out;
}

const money = (n) => (n === "" || n == null || isNaN(n) || Number(n) === 0 ? null : "$" + Math.round(Number(n)).toLocaleString("en-CA"));

/* ---------- Fee calculation. Arithmetic only, never the model. ---------- */
function petCount(pets) {
  if (!pets || pets === "None") return 0;
  if (pets.includes("and")) return 2;
  const m = /×(\d+)/.exec(pets);
  return m ? Number(m[1]) : 1;
}

function feeBreakdown(v, d) {
  const n = petCount(v.pets);
  const monthly = [
    { label: "Rent", amt: d.rent || 0, always: true },
    { label: "Parking", amt: v.parking && v.parking !== "None" ? d.parking_fee || 0 : 0 },
    { label: "Storage", amt: v.storage === "Yes" ? d.storage_fee || 0 : 0 },
    { label: `Pet rent ×${n}`, amt: n * (d.pet_fee || 0) },
  ].filter((x) => x.always || x.amt > 0);
  const monthlyTotal = monthly.reduce((s, x) => s + x.amt, 0);

  const security = d.deposit || 0;
  const petDep = d.petDeposit || 0;
  const depositTotal = security + petDep;
  const capOk = d.rent > 0 && depositTotal <= d.rent;

  const upfront = [
    { label: "Security deposit", amt: security },
    { label: "Pet deposit", amt: petDep },
    { label: "First month", amt: monthlyTotal },
    { label: "Application fee", amt: d.appFee || 0 },
  ].filter((x) => x.amt > 0);
  const upfrontTotal = upfront.reduce((s, x) => s + x.amt, 0);

  return { monthly, monthlyTotal, upfront, upfrontTotal, depositTotal, capOk, security, petDep };
}

/* The disclosure is assembled by the system and sent to the tenant verbatim.
   It goes out in both languages because the tenant reads it. The model never
   touches these numbers. */
function buildDisclosure(v, d, fb) {
  const L = [];
  L.push(`Before we go further, here are the costs for ${v.unit_id}.`);
  L.push(`在往下之前，先跟你確認 ${v.unit_id} 的費用。`);
  L.push("");
  L.push("MONTHLY / 每月固定支出");
  fb.monthly.forEach((x) => L.push(`　${x.label}　${money(x.amt) || "$0"}`));
  L.push(`  Monthly total / 每月合計  ${money(fb.monthlyTotal) || "$0"}`);
  L.push("");
  L.push("DUE AT MOVE-IN / 入住時一次性");
  fb.upfront.forEach((x) => L.push(`　${x.label}　${money(x.amt) || "$0"}`));
  L.push(`  Total up front / 一次性合計  ${money(fb.upfrontTotal) || "$0"}`);
  L.push("");
  if (fb.petDep > 0)
    L.push("The pet deposit is counted inside the security deposit total; it is not charged on top. 寵物押金已包含在保證金總額內，不另外加收。");
  L.push(d.utilities ? `Rent includes / 租金包含: ${d.utilities}` : "What rent includes is set out in the signed lease. 租金包含項目以正式租約為準。");
  L.push("The signed lease governs these amounts. Once you confirm, we will carry on with the remaining details. 以上金額以正式租約為準，確認後我們再繼續。");
  return L.join("\n");
}

/* ---------- Signing lock: first to sign wins, one flow per unit ---------- */
const LOCK_TTL_MIN = 120;
const LOCK_KEY = "baydo:unitlocks";

export default function ContractConsole() {
  const [vals, setVals] = useState({});
  const [chat, setChat] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [facts, setFacts] = useState(null);
  const [loading, setLoading] = useState(true);
  const [agent, setAgent] = useState("");
  const [signed, setSigned] = useState(null);
  const [qBlocked, setQBlocked] = useState(null);
  const [stage, setStage] = useState("intake"); // intake | review | signed
  const [feeAck, setFeeAck] = useState(null);   // snapshot of what the tenant confirmed
  const [session, setSession] = useState(null);
  const [lock, setLock] = useState(null);       // the lock I hold
  const [blocked, setBlocked] = useState(null); // a lock someone else holds
  const [locking, setLocking] = useState(false);

  /* ---------- Read the property data ---------- */
  useEffect(() => {
    (async () => {
      const read = async (k) => {
        try { const r = await window.storage.get(k); return r?.value ? JSON.parse(r.value) : null; }
        catch (e) { return null; }
      };
      setFacts({ pricing: await read("baydo:pricing") || {},
                 overrides: await read("baydo:overrides") || {},
                 parking: await read("baydo:parking") || { pools: [], records: [] } });
      const ses = await read("baydo:session"); if (ses) setSession(ses);
      setLoading(false);
    })();
  }, []);

  /* ---------- Values pulled from the property data ---------- */
  const derived = useMemo(() => {
    if (!facts) return {};
    const p = facts.pricing, ov = facts.overrides, pk = facts.parking;
    const id = vals.unit_id?.trim();
    const o = (id && ov[id]) || {};
    const type = id ? unitType(id) : null;
    const rent = o.rent ? Number(o.rent) : (type ? Number(p.base?.[type]) || 0 : 0);
    const deposit = p.depositMode === "fixed" ? Number(p.depositFixed) || 0 : rent;
    const rec = id ? (pk.records || []).find((r) => r.unitId === id && r.status === "assigned") : null;
    const pool = rec ? (pk.pools || []).find((x) => x.id === rec.poolId) : null;
    return {
      unit_type: type,
      rent, deposit,
      parking_fee: rec ? Number(rec.poolId === "surface" ? p.parkSurface : p.parkUnderground) || 0 : 0,
      storage_fee: Number(p.storage) || 0,
      pet_fee: Number(p.petRent) || 0,
      appFee: Number(p.appFee) || 0,
      utilities: p.utilities || "",
      petDeposit: (vals.pets && vals.pets !== "None")
        ? (vals.pets.includes("dog") ? Number(p.dogDeposit) || 0 : Number(p.catDeposit) || 0) : 0,
      petLimit: p.petLimit || "",
      availableFrom: o.date || "",
      parkingAssigned: pool ? pool.label : "",
    };
  }, [facts, vals]);

  const merged = { ...vals, ...derived };
  const fb = useMemo(() => feeBreakdown(merged, derived), [merged, derived]);
  const checks = useMemo(
    () => (facts ? runChecks(merged, { ...derived, feeAck,
                                       feeMonthlyNow: fb.monthlyTotal,
                                       feeUpfrontNow: fb.upfrontTotal }) : []),
    [merged, derived, facts, feeAck, fb]
  );
  const allOk = checks.every((c) => c.ok);
  /* Which uploaded agreements this tenancy needs. The files themselves are in
     the agreement library; this only works out which ones apply. */
  const needed = useMemo(() => {
    const out = [{ code: "lease", name: "Residential Tenancy Agreement", always: true }];
    if (merged.parking && merged.parking !== "None")
      out.push({ code: "parking", name: "Parking Agreement" });
    if (merged.storage === "Yes") out.push({ code: "storage", name: "Storage Locker Agreement" });
    if (merged.pets && merged.pets !== "None" && !merged.service_animal)
      out.push({ code: "pet", name: "Pet Addendum" });
    out.push({ code: "inspection_in", name: "Move-in Inspection Report", always: true });
    out.push({ code: "deposit_receipt", name: "Security Deposit Receipt", always: true });
    return out;
  }, [merged]);
  const remaining = ASK_VARS.filter((v) => !vals[v.k]);

  /* ---------- Intake: extract variables, then ask the next question ---------- */
  const step = useCallback(async (reply) => {
    setBusy(true); setQBlocked(null);
    const known = Object.fromEntries(ASK_VARS.map((v) => [v.k, vals[v.k] || null]));
    const prompt = `You help a leasing agent collect the details needed before a lease is prepared. This is a residential tenancy in Alberta, Canada.

Required fields:
${ASK_VARS.map((v) => `- ${v.k} (${v.label})${v.options ? ", one of: " + v.options.join(" / ") : ""}${v.hint ? " — " + v.hint : ""}`).join("\n")}

Known so far:
${JSON.stringify(known, null, 2)}

The tenant's latest reply:
"""
${reply || "(nothing yet — ask the first question)"}
"""

Rules:
1. Extract any field you can confirm from the reply into extracted. If it is not certain, leave it out.
2. term, parking, storage and pets must match the option strings above exactly. Never invent one.
3. Ask about one unconfirmed field at a time, in the language the tenant used: Traditional Chinese if they wrote in Chinese, English if they wrote in English.
4. Never ask about household composition, children, marital status, nationality, immigration status, religion, race, age, gender, income, employment, credit or any assistance program. The number of occupants is fine, because that is an occupancy standard. Who they are is not.
5. Do not explain lease terms, negotiate, or promise anything.
6. Never state an amount yourself. Rent, deposit, stall fees and the rest are assembled by the system and sent to the tenant verbatim. If they ask about cost, say the full breakdown is coming separately.
7. When every field is confirmed, set next_question to null and done to true.

Output JSON only, no markdown:
{"extracted":{"field":"value"},"next_question":"the next question, or null","done":false}`;

    try {
      const raw = await ai("intake_question",
        { fields: ASK_VARS.map((x) => `- ${x.k} (${x.label})`).join("\n"),
          known: JSON.stringify(vals), reply: reply || "" },
        { ref_type: "intake", ref_id: unitId });
      const out = JSON.parse(raw.replace(/```json|```/g, "").trim());

      if (out.extracted) {
        const clean = {};
        for (const [k, v] of Object.entries(out.extracted)) {
          if (v == null || v === "") continue;
          const spec = ASK_VARS.find((x) => x.k === k);
          if (!spec) continue;
          if (spec.options && !spec.options.includes(v)) continue; // reject anything not on the list
          clean[k] = String(v);
        }
        if (Object.keys(clean).length) setVals((s) => ({ ...s, ...clean }));
      }

      if (out.next_question) {
        if (FORBIDDEN_Q.re.test(out.next_question)) {
          setQBlocked(out.next_question);
          setChat((c) => [...c, { role: "system", text: "That question hit the off-limits list and was blocked before the tenant saw it. Ask it a compliant way instead." }]);
        } else {
          setChat((c) => [...c, { role: "ai", text: out.next_question }]);
        }
      } else if (out.done) {
        setChat((c) => [...c, { role: "ai", text: "All the details are in. Someone will review them, and the signing link follows after that." }]);
      }
    } catch (e) {
      setChat((c) => [...c, { role: "system", text: "The AI service did not respond. Fill the fields on the right by hand." }]);
    }
    setBusy(false);
  }, [vals]);

  const send = () => {
    if (!input.trim() || busy) return;
    setChat((c) => [...c, { role: "tenant", text: input }]);
    const r = input; setInput("");
    step(r);
  };

  const discloseFees = () => {
    if (!vals.unit_id?.trim()) return;
    const text = buildDisclosure(merged, derived, fb);
    setChat((c) => [...c, { role: "ai", text, disclosure: true }]);
  };

  const ackFees = () => {
    setFeeAck({
      at: new Date().toISOString().slice(0, 16).replace("T", " "),
      monthlyTotal: fb.monthlyTotal, upfrontTotal: fb.upfrontTotal,
      lines: [...fb.monthly, ...fb.upfront].map((x) => `${x.label} ${x.amt}`),
    });
    setChat((c) => [...c, { role: "tenant", text: "Understood, I confirm the costs." }]);
    setVals((s) => ({ ...s, fee_ack: "confirmed" }));
  };

  /* ---------- Signing lock ---------- */
  const myId = session?.accountId || "anon";
  const readLocks = async () => {
    try { const r = await window.storage.get(LOCK_KEY); return r?.value ? JSON.parse(r.value) : {}; }
    catch (e) { return {}; }
  };
  const writeLocks = async (v) => {
    try { await window.storage.set(LOCK_KEY, JSON.stringify(v)); } catch (e) {}
  };

  const unitId = (vals.unit_id || "").trim();

  useEffect(() => {
    let dead = false;
    (async () => {
      if (!unitId) { setLock(null); setBlocked(null); return; }
      const all = await readLocks();
      const cur = all[unitId];
      const active = cur && new Date(cur.expiresAt) > new Date();
      if (dead) return;
      if (!active) { setBlocked(null); setLock(null); return; }
      if (cur.byId === myId) { setLock(cur); setBlocked(null); }
      else { setBlocked(cur); setLock(null); }
    })();
    return () => { dead = true; };
  }, [unitId, myId, stage]);

  const acquire = async () => {
    if (!unitId) return;
    setLocking(true);
    const all = await readLocks();
    const cur = all[unitId];
    const active = cur && new Date(cur.expiresAt) > new Date();
    if (active && cur.byId !== myId) { setBlocked(cur); setLocking(false); return; }
    const rec = { unitId, by: session?.name || "unsigned", byId: myId, at: nowISO(),
                  expiresAt: new Date(Date.now() + LOCK_TTL_MIN * 60000).toISOString() };
    await writeLocks({ ...all, [unitId]: rec });
    setLock(rec); setBlocked(null); setLocking(false);
  };

  const release = async () => {
    const all = await readLocks();
    if (all[unitId]?.byId === myId) { delete all[unitId]; await writeLocks(all); }
    setLock(null);
  };

  const submitToAgent = async () => {
    const rec = {
      id: "s" + Date.now().toString(36),
      unitId: vals.unit_id || "",
      unitType: derived.unit_type || null,
      tenant: vals.tenant_names || "",
      phone: vals.tenant_phone || "",
      email: vals.tenant_email || "",
      submittedAt: new Date().toISOString().slice(0, 16).replace("T", " "),
      variables: Object.fromEntries(ASK_VARS.map((v) => [v.k, vals[v.k] || null])),
      fees: feeAck ? { monthlyTotal: feeAck.monthlyTotal, upfrontTotal: feeAck.upfrontTotal,
                       ackAt: feeAck.at } : null,
      state: "new",
    };
    try {
      let q = [];
      try { const r = await window.storage.get("baydo:agentqueue"); if (r?.value) q = JSON.parse(r.value); }
      catch (e) {}
      await window.storage.set("baydo:agentqueue", JSON.stringify([...q, rec]));
      setChat((c) => [...c, { role: "system", text: "Sent to the inbox. It will appear under the documents tool for review." }]);
      await release();
    } catch (e) {
      setChat((c) => [...c, { role: "system", text: "Sending failed. Try again shortly." }]);
    }
    setStage("review");
  };

  const doSign = () => {
    setSigned({
      contract_id: "ct_" + Date.now(),
      unit_id: merged.unit_id,
      variables: Object.fromEntries(ASK_VARS.map((v) => [v.k, vals[v.k] || null])),
      derived: { rent: derived.rent, deposit: derived.deposit, parking_fee: derived.parking_fee,
                 storage_fee: derived.storage_fee, pet_fee: derived.pet_fee },
      agreements_needed: needed.map((a) => a.code),
      agreement_source: "uploaded file, not generated",
      fee_disclosure: feeAck,
      checks_passed: checks.map((c) => c.label),
      approved_by: agent, approved_at: new Date().toISOString(),
      link_expires_at: new Date(Date.now() + 72 * 3600e3).toISOString(),
    });
    setStage("signed");
  };

  if (loading) return <div className="ct"><style>{CSS}</style><div className="ct-load">Loading property data…</div></div>;

  return (
    <div className="ct">
      <style>{CSS}</style>

      <header className="ct-head">
        <div>
          <div className="ct-eyebrow">Baydo Pointe · Lease assembly</div>
          <h1>Intake, variables and approval</h1>
        </div>
        <div className="ct-steps">
          {[["intake", "1 · Intake"], ["review", "2 · Review"], ["signed", "3 · Signed"]].map(([k, l]) => (
            <button key={k} className={stage === k ? "on" : ""}
                    onClick={() => setStage(k)} disabled={k === "signed" && !signed}>{l}</button>
          ))}
        </div>
      </header>

      <div className="ct-rule">
        <strong>Where the line sits</strong>: nothing here writes or assembles a lease.
        The agreement is a file Admin uploaded — the version counsel approved — and it reaches
        the tenant unchanged. This screen collects the details that go with it.
      </div>

      <div className="ct-grid">
        {/* ── Intake ── */}
        {stage === "intake" && (
          <section className="ct-card">
            <h2>Intake <span className="ct-n">{remaining.length} left</span></h2>
            <p className="ct-note">
              One question at a time, with fields extracted from each reply. A question touching a protected ground is blocked before it reaches the tenant.
            </p>

            {unitId && (
              <div className={`ct-lock ${blocked ? "blocked" : lock ? "held" : ""}`}>
                {blocked ? (
                  <>
                    <strong>{unitId} is already being signed</strong>
                    <span>
                      {blocked.by} started this unit at {blocked.at.slice(0, 16).replace("T", " ")}.
                      First to sign wins, so offer your client another available unit.
                    </span>
                  </>
                ) : lock ? (
                  <>
                    <strong>{unitId} locked to you</strong>
                    <span>
                      Held until {lock.expiresAt.slice(0, 16).replace("T", " ")}.
                      Nobody else can start on this unit meanwhile. It releases automatically once you submit.
                    </span>
                    <button className="ct-btn ct-btn--ghost" onClick={release}>Give up this unit</button>
                  </>
                ) : (
                  <>
                    <strong>{unitId} is free</strong>
                    <span>First to sign wins. Once you lock it, nobody else can start on this unit.</span>
                    <button className="ct-btn" disabled={locking} onClick={acquire}>
                      {locking ? "Locking…" : "Lock and start"}
                    </button>
                  </>
                )}
              </div>
            )}

            <div className={`ct-fee ${feeAck ? "acked" : ""}`}>
              <div className="ct-fee-h">
                <strong>Fee disclosure</strong>
                {feeAck ? <span className="ct-fee-ok">Confirmed by tenant · {feeAck.at}</span>
                        : <span className="ct-dim">Not disclosed yet</span>}
              </div>
              {!vals.unit_id?.trim() ? (
                <p className="ct-dim">Confirm the unit number first so the costs can be calculated.</p>
              ) : !derived.rent ? (
                <p className="ct-warn">No rent is set for {derived.unit_type || "this unit type"}, so the costs cannot be disclosed.</p>
              ) : !fb.capOk ? (
                <p className="ct-warn">
                  Security deposit {money(fb.security)} plus pet deposit {money(fb.petDep)} comes to {money(fb.depositTotal)},
                  which exceeds one month’s rent of {money(derived.rent)}. That amount cannot be disclosed or collected. Adjust the deposit settings first.
                </p>
              ) : (
                <>
                  <div className="ct-feegrid">
                    <div>
                      <div className="ct-feel">Monthly</div>
                      {fb.monthly.map((x, i) => (
                        <div className="ct-feerow" key={i}><span>{x.label}</span><span className="ct-mono">{money(x.amt) || "$0"}</span></div>
                      ))}
                      <div className="ct-feerow ct-feetot"><span>Monthly total</span><span className="ct-mono">{money(fb.monthlyTotal)}</span></div>
                    </div>
                    <div>
                      <div className="ct-feel">Due at move-in</div>
                      {fb.upfront.map((x, i) => (
                        <div className="ct-feerow" key={i}><span>{x.label}</span><span className="ct-mono">{money(x.amt) || "$0"}</span></div>
                      ))}
                      <div className="ct-feerow ct-feetot"><span>Total up front</span><span className="ct-mono">{money(fb.upfrontTotal)}</span></div>
                    </div>
                  </div>
                  <div className="ct-fee-a">
                    <button className="ct-btn ct-btn--ghost" onClick={discloseFees}>
                      Send to tenant
                    </button>
                    <button className="ct-btn" onClick={ackFees} disabled={!!feeAck}>
                      Tenant confirmed
                    </button>
                    <span className="ct-dim">Assembled by the system and sent verbatim. The model is not involved.</span>
                  </div>
                </>
              )}
            </div>

            <div className="ct-chat">
              {chat.length === 0 && (
                <div className="ct-empty">Start the intake below, or fill the fields on the right by hand.</div>
              )}
              {chat.map((m, i) => (
                <div className={`ct-msg ct-msg--${m.role}`} key={i}>
                  <span className="ct-who">
                    {m.role === "ai" ? "AI" : m.role === "tenant" ? "Tenant" : "System"}
                  </span>
                  <p>{m.text}</p>
                </div>
              ))}
              {qBlocked && (
                <div className="ct-blocked">
                  <strong>Blocked question</strong>
                  <p className="ct-mono">{qBlocked}</p>
                  <p>{FORBIDDEN_Q.why}</p>
                </div>
              )}
            </div>

            <div className="ct-ask">
              <input className="ct-in" value={input} placeholder="Simulate the tenant’s reply…"
                     onChange={(e) => setInput(e.target.value)}
                     onKeyDown={(e) => e.key === "Enter" && send()} />
              <button className="ct-btn" onClick={send} disabled={busy || !input.trim()}>Send</button>
              <button className="ct-btn ct-btn--ghost" onClick={() => step("")} disabled={busy}>
                {busy ? "Working…" : chat.length ? "Next question" : "Start intake"}
              </button>
            </div>
          </section>
        )}

        {/* ── Review ── */}
        {stage === "review" && (
          <section className="ct-card">
            <h2>Review</h2>
            <p className="ct-note">
              Every check below is a rule, not the model. If any one fails, no signing link goes out.
            </p>
            <div className="ct-checks">
              {checks.map((c, i) => (
                <div className={`ct-chk ${c.ok ? "ok" : "bad"}`} key={i}>
                  <span className="ct-chk-i">{c.ok ? "✓" : "✕"}</span>
                  <div>
                    <strong>{c.label}</strong>
                    <div className="ct-dim">{c.detail}</div>
                  </div>
                </div>
              ))}
            </div>

            <label className="ct-field">
              <span>Approver</span>
              <input className="ct-in" placeholder="Your name or account" value={agent}
                     onChange={(e) => setAgent(e.target.value)} />
            </label>

            <div className="ct-signrow">
              <button className="ct-btn" disabled={!allOk || !agent.trim()} onClick={doSign}>
                Approve, sign and release the signing link
              </button>
              {!allOk && <span className="ct-dim">A check has failed</span>}
              {allOk && !agent.trim() && <span className="ct-dim">Enter the approver name</span>}
            </div>
          </section>
        )}

        {/* ── Signed ── */}
        {stage === "signed" && signed && (
          <section className="ct-card">
            <h2>Approved and sent</h2>
            <p className="ct-note">The signing link expires in 72 hours. The audit record follows.</p>
            <pre className="ct-log">{JSON.stringify(signed, null, 2)}</pre>
          </section>
        )}

        {/* ── Variables and clauses ── */}
        <div className="ct-side">
          <section className="ct-card">
            <h2>Lease variables</h2>
            <p className="ct-note">Extracted values appear here and can be edited. The grey fields come from the property data and are never asked of the tenant.</p>
            <div className="ct-vars">
              {VARS.map((v) => {
                const auto = v.type === "auto";
                const isAck = v.type === "ack";
                const val = auto ? fmtAuto(v.k, derived) : (vals[v.k] || "");
                return (
                  <div className={`ct-var ${auto ? "auto" : val ? "filled" : "empty"}`} key={v.k}>
                    <span className="ct-var-l">{v.label}</span>
                    {isAck ? (
                      <span className="ct-var-v" style={{ color: feeAck ? "#0E8577" : "#B23A54" }}>
                        {feeAck ? `Confirmed · ${feeAck.at}` : "Not disclosed"}
                      </span>
                    ) : auto ? (
                      <span className="ct-var-v ct-mono">{val || "—"}</span>
                    ) : v.type === "select" ? (
                      <select className="ct-sel" value={val}
                              onChange={(e) => setVals({ ...vals, [v.k]: e.target.value })}>
                        <option value="">—</option>
                        {v.options.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    ) : (
                      <input className="ct-in ct-in--sm" type={v.type === "date" ? "date" : v.type}
                             value={val} placeholder={v.hint || "—"}
                             onChange={(e) => setVals({ ...vals, [v.k]: e.target.value })} />
                    )}
                  </div>
                );
              })}
            </div>
            {stage === "intake" && (
              <>
                <button className="ct-btn" style={{ marginTop: 14 }} disabled={!lock}
                        onClick={submitToAgent}>Send to the inbox</button>
                {!lock && (
                  <span className="ct-note" style={{ marginTop: 6 }}>
                    {blocked ? "This unit is being signed by someone else." : "Lock the unit before submitting."}
                  </span>
                )}
              </>
            )}
          </section>

          <section className="ct-card">
            <h2>Agreements this tenancy needs <span className="ct-n">{needed.length}</span></h2>
            <p className="ct-note">
              Worked out from the answers above. Each one is a file in the agreement
              library — Admin uploads the version counsel approved, and that file is what
              the tenant signs. Nothing here generates or edits one.
            </p>
            <div className="ct-clauses">
              {needed.map((a) => (
                <div className="ct-clause on" key={a.code}>
                  <span className="ct-cl-t">{a.name}</span>
                  <span className="ct-cl-s">{a.always ? "Always" : "Applies here"}</span>
                </div>
              ))}
            </div>
            <p className="ct-note">
              If one of these has no approved file in the library, it cannot be sent.
              Check the Agreements screen before the signing appointment rather than
              during it.
            </p>
          </section>
        </div>
      </div>

      <footer className="ct-foot">
        Prototype. The uploaded agreements and the checks here — the deposit cap, the inspection reports, the notice periods —
        must all be settled by a lawyer or a RECA advisor against the Alberta Residential Tenancies Act before use.
        Intake questions must not touch a protected ground, and eligibility screening is handled separately by trained staff.
      </footer>
    </div>
  );
}

/* ---------- Helpers ---------- */
function unitType(id) {
  const G374 = {101:"1A (M)",102:"1A",103:"2A",104:"2A (M)",105:"3A (M)",106:"3A",107:"2A",108:"2A (M)",109:"1A (M)",110:"1A",111:"2A (M)",112:"3A (M)",113:"3A",114:"2A"};
  const T374 = {201:"1C",202:"1A (M)",203:"1A",204:"2A",205:"2A (M)",206:"3A (M)",207:"3A",208:"2A",209:"2A (M)",210:"1A (M)",211:"1A",212:"2A (M)",213:"2A (M)",214:"3A (M)",215:"3A",216:"2A"};
  const G370 = {101:"1B",102:"1A",103:"1A (M)",104:"2A (M)",105:"2A",106:"1A (M)",107:"1A",108:"2A (M)",109:"3A (M)",110:"3A",111:"2A",112:"1A (M)",113:"1A",114:"2A (M)",115:"2A",116:"1A (M)",117:"1A",118:"2A (M)"};
  const T370 = {201:"1C",202:"1A",203:"1A (M)",204:"2A (M)",205:"2A",206:"1A (M)",207:"1A",208:"2A (M)",209:"3A (M)",210:"3A",211:"2A",212:"1A (M)",213:"1A",214:"2A (M)",215:"2A",216:"1A (M)",217:"1A",218:"2A (M)",219:"3A (M)",220:"3A"};
  const m = /^(370|374|378)-(\d{3})$/.exec(id.trim());
  if (!m) return null;
  const [, b, noStr] = m;
  const no = Number(noStr), floor = Math.floor(no / 100), key = no % 100;
  const g = b === "374" ? G374 : G370, t = b === "374" ? T374 : T370;
  if (floor === 1) return g[100 + key] || null;
  if (floor >= 2 && floor <= 6) return t[200 + key] || null;
  return null;
}

function fmtAuto(k, d) {
  if (k === "utilities") return d.utilities || "";
  const map = { rent: d.rent, deposit: d.deposit, parking_fee: d.parking_fee,
                storage_fee: d.storage_fee, pet_fee: d.pet_fee };
  return money(map[k]) || "";
}

/* ============================ Styles ============================ */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=Archivo:wght@700;800&display=swap');
.ct{--ink:#131C25;--ink2:#3E4C5A;--dim:#78899A;--paper:#fff;--ground:#E9EDF0;--rule:#D3DBE1;
  --amber:#FFF6E0;--amberline:#E8C877;--red:#B23A54;--green:#0E8577;--accent:var(--brand,#2A6183);
  background:var(--ground);color:var(--ink);min-height:100vh;font-size:14px;line-height:1.55;
  font-family:'IBM Plex Sans','PingFang TC','Microsoft JhengHei',system-ui,sans-serif;padding-bottom:44px}
.ct *{box-sizing:border-box}
.ct-mono{font-family:'IBM Plex Mono',monospace}
.ct-dim{color:var(--dim);font-size:12px}
.ct-load{padding:80px 24px;text-align:center;color:var(--dim)}

.ct-head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;
  padding:24px 28px 16px;background:var(--paper);border-bottom:1px solid var(--rule)}
.ct-eyebrow{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.13em;
  text-transform:uppercase;color:var(--dim)}
.ct-head h1{font-family:'Archivo','PingFang TC',sans-serif;font-weight:800;font-size:24px;
  letter-spacing:-.02em;margin:4px 0 0}
.ct-steps{display:inline-flex;border:1px solid var(--rule);border-radius:3px;overflow:hidden}
.ct-steps button{font:inherit;font-size:13px;font-weight:600;cursor:pointer;background:var(--paper);
  border:0;border-right:1px solid var(--rule);padding:8px 15px;color:var(--dim)}
.ct-steps button:last-child{border-right:0}
.ct-steps button.on{background:var(--brand,var(--ink));color:#fff}
.ct-steps button:disabled{opacity:.4;cursor:not-allowed}

.ct-rule{background:#F2F7FB;border-bottom:1px solid #C7D6E2;padding:11px 28px;font-size:12.5px;
  color:var(--ink2);line-height:1.65}

.ct-btn{font:inherit;font-weight:600;font-size:13px;cursor:pointer;background:var(--brand,var(--ink));color:#fff;
  border:1px solid var(--brand,var(--ink));padding:8px 15px;border-radius:3px}
.ct-btn:hover:not(:disabled){background:#000}
.ct-btn:disabled{opacity:.4;cursor:not-allowed}
.ct-btn--ghost{background:transparent;color:var(--ink2);border-color:var(--rule)}
.ct-btn--ghost:hover:not(:disabled){background:var(--ground);color:var(--ink)}
.ct-btn:focus-visible,.ct-in:focus-visible,.ct-sel:focus-visible,.ct-steps button:focus-visible{
  outline:2px solid var(--accent);outline-offset:2px}

.ct-in,.ct-sel{font:inherit;font-size:13px;padding:7px 10px;border:1px solid var(--amberline);
  border-radius:3px;background:var(--amber);color:var(--ink);min-width:0;width:100%}
.ct-sel{background:var(--paper);border-color:var(--rule);cursor:pointer}
.ct-in--sm{padding:5px 8px;font-size:12.5px}

.ct-grid{display:grid;grid-template-columns:1fr minmax(320px,420px);gap:16px;padding:18px 28px;
  align-items:start;max-width:1340px}
.ct-side{display:flex;flex-direction:column;gap:16px}
.ct-card{background:var(--paper);border:1px solid var(--rule);border-radius:4px;padding:18px 20px}
.ct-card h2{font-family:'Archivo',sans-serif;font-weight:700;font-size:15px;margin:0 0 4px;
  display:flex;align-items:center;gap:8px}
.ct-n{font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:500;color:var(--dim);
  border:1px solid var(--rule);border-radius:10px;padding:0 8px}
.ct-note{color:var(--dim);font-size:12.5px;margin:5px 0 14px;line-height:1.6}
.ct-empty{color:var(--dim);font-size:12.5px;padding:22px 0;text-align:center;
  border:1px dashed var(--rule);border-radius:3px}

/* Intake */
.ct-chat{display:flex;flex-direction:column;gap:10px;max-height:340px;overflow-y:auto;
  padding-right:4px;margin-bottom:14px}
.ct-msg{max-width:88%}
.ct-msg--tenant{align-self:flex-end}
.ct-who{font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:.08em;color:var(--dim);
  text-transform:uppercase}
.ct-msg p{margin:3px 0 0;padding:9px 12px;border-radius:3px;font-size:13.5px;line-height:1.65;
  border:1px solid var(--rule);background:#FCFDFE;white-space:pre-wrap}

/* Signing lock */
.ct-lock{display:flex;flex-direction:column;gap:5px;border:1px solid var(--rule);border-radius:3px;
  padding:12px 14px;background:#FCFDFE;margin-bottom:14px;font-size:12.5px;color:var(--ink2);
  line-height:1.65;align-items:flex-start}
.ct-lock strong{font-size:13.5px;color:var(--ink)}
.ct-lock.held{border-color:var(--green);background:#F6FBF8}
.ct-lock.held strong{color:var(--green)}
.ct-lock.blocked{border-color:var(--red);background:#FDF6F7}
.ct-lock.blocked strong{color:var(--red)}
.ct-lock button{margin-top:5px}

/* Fee disclosure */
.ct-fee{border:1px solid var(--amberline);background:#FFFCF3;border-radius:3px;padding:12px 14px;
  margin-bottom:14px}
.ct-fee.acked{border-color:var(--green);background:#F6FBF8}
.ct-fee-h{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:8px;
  font-size:13px}
.ct-fee-ok{font-size:11.5px;font-weight:600;color:var(--green)}
.ct-warn{font-size:12.5px;color:var(--red);line-height:1.6;margin:0}
.ct-feegrid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:11px}
.ct-feel{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.07em;
  text-transform:uppercase;color:var(--dim);margin-bottom:4px}
.ct-feerow{display:flex;justify-content:space-between;gap:10px;font-size:12.5px;padding:2px 0}
.ct-feetot{border-top:1px solid var(--rule);margin-top:3px;padding-top:4px;font-weight:600}
.ct-fee-a{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
@media (max-width:560px){.ct-feegrid{grid-template-columns:1fr;gap:10px}}
.ct-msg--tenant p{background:#F2F7FB;border-color:#C7D6E2}
.ct-msg--system p{background:#FFF8E6;border-color:var(--amberline);color:#7A5D14;font-size:12.5px}
.ct-blocked{border:1px solid var(--red);border-left:3px solid var(--red);border-radius:3px;
  padding:11px 13px;background:#FDF6F7}
.ct-blocked strong{font-size:12px;color:var(--red)}
.ct-blocked p{margin:5px 0 0;font-size:12.5px;line-height:1.6;color:var(--ink2)}
.ct-ask{display:flex;gap:8px;flex-wrap:wrap}
.ct-ask .ct-in{flex:1 1 200px;width:auto}

/* Checks */
.ct-checks{display:flex;flex-direction:column;gap:7px;margin-bottom:16px}
.ct-chk{display:flex;gap:11px;align-items:flex-start;border:1px solid var(--rule);border-radius:3px;
  padding:9px 12px;font-size:13px}
.ct-chk.ok{border-left:3px solid var(--green)}
.ct-chk.bad{border-left:3px solid var(--red);background:#FDF6F7}
.ct-chk-i{font-weight:700;flex:0 0 auto}
.ct-chk.ok .ct-chk-i{color:var(--green)}
.ct-chk.bad .ct-chk-i{color:var(--red)}
.ct-field{display:flex;flex-direction:column;gap:5px;margin-bottom:12px}
.ct-field span{font-size:12px;font-weight:600;color:var(--ink2)}
.ct-signrow{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.ct-log{font-family:'IBM Plex Mono',monospace;font-size:11.5px;background:#F7F9FB;
  border:1px solid var(--rule);border-radius:3px;padding:12px 14px;overflow-x:auto;line-height:1.6;
  margin:0;color:var(--ink2)}

/* Variables */
.ct-vars{display:flex;flex-direction:column;gap:1px;background:var(--rule);border:1px solid var(--rule);
  border-radius:3px;overflow:hidden}
.ct-var{display:grid;grid-template-columns:105px 1fr;gap:10px;align-items:center;padding:6px 11px;
  background:var(--paper)}
.ct-var.auto{background:#F7F9FB}
.ct-var.filled{background:#F6FBF8}
.ct-var-l{font-size:12px;font-weight:600;color:var(--ink2)}
.ct-var-v{font-size:12.5px;color:var(--ink)}

/* Clauses */
.ct-clauses{display:flex;flex-direction:column;gap:1px;background:var(--rule);border:1px solid var(--rule);
  border-radius:3px;overflow:hidden}
.ct-cl{display:grid;grid-template-columns:60px 1fr auto;gap:10px;align-items:center;padding:7px 11px;
  background:var(--paper);font-size:12.5px;color:var(--dim)}
.ct-cl.on{color:var(--ink)}
.ct-cl-id{font-size:11px}
.ct-cl-s{font-size:11px;font-weight:600}
.ct-cl.on .ct-cl-s{color:var(--green)}

.ct-foot{padding:4px 28px 0;color:var(--dim);font-size:11.5px;max-width:88ch;line-height:1.65}

@media (max-width:880px){
  .ct-grid{grid-template-columns:1fr;padding:16px}
  .ct-head,.ct-rule,.ct-foot{padding-left:16px;padding-right:16px}
}
`;
