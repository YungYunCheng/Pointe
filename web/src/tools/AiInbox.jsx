import React, { useState, useEffect, useMemo, useCallback } from "react";
import { ai } from "../lib/ai.js";

/* ============================================================
   BAYDO POINTE — AI reply review console
   Reads baydo:pricing / baydo:overrides / baydo:parking saved by the leasing console.
   The AI only classifies and drafts. Whether a reply is sent automatically is decided by
   the hard-coded rules below, never by the model.
   ============================================================ */

const TYPES = {
  "1A": { bed: "1 bed", sf: 484.4 }, "1A (M)": { bed: "1 bed", sf: 484.4 },
  "1B": { bed: "1 bed + den", sf: 602.8 }, "1C": { bed: "1 bed", sf: 462.8 },
  "2A": { bed: "2 bed 2 bath", sf: 742.7 }, "2A (M)": { bed: "2 bed 2 bath", sf: 742.7 },
  "3A": { bed: "2 bed + den", sf: 731.9 }, "3A (M)": { bed: "2 bed + den", sf: 731.9 },
};
const G374 = {101:"1A (M)",102:"1A",103:"2A",104:"2A (M)",105:"3A (M)",106:"3A",107:"2A",108:"2A (M)",109:"1A (M)",110:"1A",111:"2A (M)",112:"3A (M)",113:"3A",114:"2A"};
const T374 = {201:"1C",202:"1A (M)",203:"1A",204:"2A",205:"2A (M)",206:"3A (M)",207:"3A",208:"2A",209:"2A (M)",210:"1A (M)",211:"1A",212:"2A (M)",213:"2A (M)",214:"3A (M)",215:"3A",216:"2A"};
const G370 = {101:"1B",102:"1A",103:"1A (M)",104:"2A (M)",105:"2A",106:"1A (M)",107:"1A",108:"2A (M)",109:"3A (M)",110:"3A",111:"2A",112:"1A (M)",113:"1A",114:"2A (M)",115:"2A",116:"1A (M)",117:"1A",118:"2A (M)"};
const T370 = {201:"1C",202:"1A",203:"1A (M)",204:"2A (M)",205:"2A",206:"1A (M)",207:"1A",208:"2A (M)",209:"3A (M)",210:"3A",211:"2A",212:"1A (M)",213:"1A",214:"2A (M)",215:"2A",216:"1A (M)",217:"1A",218:"2A (M)",219:"3A (M)",220:"3A"};
const BUILDINGS = [
  { id: "370", ground: G370, typical: T370 },
  { id: "374", ground: G374, typical: T374 },
  { id: "378", ground: G370, typical: T370 },
];
const ALL_UNITS = (() => {
  const o = [];
  for (const b of BUILDINGS) {
    for (const n of Object.keys(b.ground).map(Number)) o.push({ id: `${b.id}-${n}`, bldg: b.id, floor: 1, type: b.ground[n] });
    for (let f = 2; f <= 6; f++)
      for (const n of Object.keys(b.typical).map(Number))
        o.push({ id: `${b.id}-${f * 100 + (n % 100)}`, bldg: b.id, floor: f, type: b.typical[n] });
  }
  return o;
})();

/* ---------- 1. Hard stops. Rules, not the model. A hit goes straight to a person.
     The Chinese patterns stay: tenants write in both languages and the filter
     has to catch either. ---------- */
const HARD_STOPS = [
  { id: "R-101", label: "Screening and source of income",
    re: /收入|所得|income|AISH|ODSP|社會?補助|福利金|welfare|assistance|credit\s*score|信用(分數|評分|紀錄)|薪資證明|pay\s*stub|工作證明|employment\s*letter|保證人|guarantor/i,
    why: "The Alberta Human Rights Act makes source of income a protected ground. Eligibility questions can only be answered by a trained person following written policy." },
  { id: "R-102", label: "Accessibility and accommodation",
    re: /無障礙|輪椅|wheelchair|accessible|accommodat|service\s*(dog|animal)|服務犬|導盲|assistance\s*animal|行動不便|失明|聽障|身心障礙|disab/i,
    why: "Service animals are not pets and the pet policy does not apply. Accommodation carries a legal process; applying the ordinary rules amounts to refusing it." },
  { id: "R-103", label: "Protected grounds",
    re: /種族|族裔|膚色|宗教|信仰|race|racial|religio|懷孕|pregnan|小孩|孩子|children|kids|單親|single\s*(mom|mother|parent)|婚姻|married|divorc|國籍|移民|immigrant|newcomer|refugee|難民|性別|gender|LGBT|同志|年齡歧視/i,
    why: "The message touches a protected ground. An automatic reply here becomes written evidence of differential treatment. The audit log records the rule id only, never the content." },
  { id: "R-104", label: "Legal, complaints and disputes",
    re: /律師|法務|lawyer|attorney|legal\s*action|human\s*rights|人權(委員|會)|RTDRS|驅逐|evict|投訴|申訴|complain|訴訟|sue|索賠|求償|違約金/i,
    why: "Correspondence in a dispute becomes evidence. It has to be handled by a person." },
  { id: "R-105", label: "Lease terms and negotiation",
    re: /租約條款|合約條款|契約條款|lease\s*terms|條款|把租約(寄|傳|發)|send\s*(me\s*)?the\s*lease|保留(單位|房)|hold\s*the\s*(unit|suite)|折扣|優惠|議價|降租|少收|減免|waive|discount|negotiat/i,
    why: "Lease terms, holding a unit, or anything off the published price needs a person. Note that simply booking a signing appointment is not caught here — that runs as scheduling — but the lease itself is still only released after approval." },
];

/* ---------- 5. Routing rules: intent to automation level ----------
      L3 covers only the lookup facts in section 4.1. L2 covers only scheduling.
     Everything else goes to a person. */
const INTENT_RULES = {
  // L3 — lookups from section 4.1. Every answer comes from the data, with no judgement.
  availability:        { lvl: "L3", rule: "R-2041", label: "Vacancy" },
  rent_quote:          { lvl: "L3", rule: "R-2042", label: "Rent quote" },
  unit_spec:           { lvl: "L3", rule: "R-2043", label: "Unit specification" },
  amenities:           { lvl: "L3", rule: "R-2044", label: "Amenities" },
  location:            { lvl: "L3", rule: "R-2045", label: "Location and transit" },
  pet_policy:          { lvl: "L3", rule: "R-2046", label: "Pet policy" },
  fees:                { lvl: "L3", rule: "R-2047", label: "Fee breakdown" },
  parking_availability:{ lvl: "L3", rule: "R-2048", label: "Stall availability" },
  waitlist_position:   { lvl: "L3", rule: "R-2049", label: "Waitlist position" },
  showing_hours:       { lvl: "L3", rule: "R-2050", label: "Available slots" },

  // L2 — scheduling only. Moves the calendar, makes no financial or legal commitment.
  showing_booking:     { lvl: "L2", rule: "R-2061", label: "Book a showing" },
  showing_reschedule:  { lvl: "L2", rule: "R-2062", label: "Reschedule a showing" },
  showing_cancel:      { lvl: "L2", rule: "R-2063", label: "Cancel a showing" },
  signing_booking:     { lvl: "L2", rule: "R-2064", label: "Book a signing slot" },

  // L1 — everything else: drafted, then approved by a person before it goes out.
  parking_request:     { lvl: "L1", rule: "R-2081", label: "Stall request" },
  renewal:             { lvl: "L1", rule: "R-2082", label: "Renewal" },
  complaint:           { lvl: "L1", rule: "R-2083", label: "Complaint" },
  maintenance:         { lvl: "L1", rule: "R-2084", label: "Maintenance request" },
  early_termination:   { lvl: "L1", rule: "R-2085", label: "Early termination" },
  other:               { lvl: "L1", rule: "R-2099", label: "Other" },
};

/* Handing a message to a person is not the same as a person seeing it.
   Escalating queues an email to whoever owns it, with a clock, and tells the
   tenant a person has it. Somebody may not be at a console for hours, and a
   tenant waiting in silence is how a question becomes a complaint. */
const ESCALATION_HOURS = 4;
const SENSITIVE_RULES = ["R-101", "R-102", "R-103"];

const LEVELS = {
  L3: { label: "Sent automatically", color: "#0E8577", desc: "A lookup. The facts come from the data, so it goes out as drafted." },
  L2: { label: "Sent, spot-checked", color: "#1C6FA6", desc: "Writes to the calendar, so a sample is reviewed daily." },
  L1: { label: "Needs approval", color: "#C98A15", desc: "Drafted by the AI, sent only after someone approves it." },
  L0: { label: "Straight to a person", color: "#B23A54", desc: "No draft is produced; it is assigned directly." },
};

const CHANNELS = {
  email:    { label: "Email",    icon: "✉" },
  webform:  { label: "Web form", icon: "▤" },
  sms:      { label: "SMS",      icon: "▣" },
  whatsapp: { label: "WhatsApp", icon: "◍" },
};

const SEED = [
  { id: "m1", channel: "email", from: "j.tran@example.com", name: "Jenny Tran",
    body: "Hi — do you have any 2 bedroom units available for September 1? What's the monthly rent, and is parking included in that?" },
  { id: "m2", channel: "webform", from: "wchen@example.com", name: "Wei-Lun Chen",
    body: "請問可以養狗嗎？大概 20 公斤的柴犬。押金要多少、每個月還要另外收錢嗎？" },
  { id: "m3", channel: "sms", from: "+1 780 555 0142", name: "Unknown number",
    body: "370-412 還有沒有車位 我想登記" },
  { id: "m4", channel: "whatsapp", from: "+1 587 555 0198", name: "Marcus Idowu",
    body: "I use a wheelchair and would need a parking stall close to the elevator. Is that something you can arrange?" },
  { id: "m5", channel: "email", from: "d.singh@example.com", name: "Davinder Singh",
    body: "Hello, do you accept tenants who receive AISH? What is your minimum income requirement to qualify?" },
  { id: "m6", channel: "email", from: "lily.k@example.com", name: "Lily Kwan",
    body: "我上週看過 378-519，想這週就簽約。可以把租約寄給我嗎？另外能不能少收一點押金？" },
];

const money = (n) => (n === "" || n == null || isNaN(n) ? null : "$" + Math.round(Number(n)).toLocaleString("en-CA"));

export default function AIInbox({ session }) {
  const [facts, setFacts] = useState(null);
  const [loading, setLoading] = useState(true);
  const [msgs, setMsgs] = useState(() => SEED.map((m) => ({ ...m, ts: Date.now(), state: "new" })));
  const [sel, setSel] = useState("m1");
  const [busy, setBusy] = useState(null);
  const [draftEdit, setDraftEdit] = useState("");
  const [view, setView] = useState("inbox");
  const [escalations, setEscalations] = useState([]);
  const [shadowRuns, setShadowRuns] = useState([]);
  const saveEscalations = async (v) => {
    setEscalations(v);
    try { await window.storage.set("baydo:escalations", JSON.stringify(v)); } catch {}
  };
  const saveShadow = async (v) => {
    setShadowRuns(v);
    try { await window.storage.set("baydo:shadowruns", JSON.stringify(v)); } catch {}
  };
  const openEscalations = escalations.filter((e) => e.state === "open");

  const [compose, setCompose] = useState({ open: false, channel: "email", body: "" });

  /* ---------- 3. Fact lookup: read the property data ---------- */
  /* ---------- 3. Fact lookup: read the property data ---------- */
useEffect(() => {
  const loadData = async () => {
    const read = async (key, defaultValue = null) => {
      try {
        const result = await window.storage.get(key);

        return result?.value
          ? JSON.parse(result.value)
          : defaultValue;
      } catch (error) {
        return defaultValue;
      }
    };

    const savedEscalations = await read("baydo:escalations", []);
    const savedShadowRuns = await read("baydo:shadowruns", []);
    const pricing = await read("baydo:pricing");
    const overrides = await read("baydo:overrides", {});
    const parking = await read("baydo:parking");

    setEscalations(savedEscalations);
    setShadowRuns(savedShadowRuns);
    setFacts(buildFacts(pricing, overrides, parking));
    setLoading(false);
  };

  loadData();
}, []);

const selected = msgs.find((m) => m.id === sel);
useEffect(() => {
  setDraftEdit(selected?.draft || "");
}, [sel, selected?.draft]);


  const counts = useMemo(() => {
    const c = { new: 0, L3: 0, L2: 0, L1: 0, L0: 0, sent: 0 };
    for (const m of msgs) {
      if (m.state === "sent") c.sent++;
      else if (m.state === "new") c.new++;
      else if (m.level) c[m.level]++;
    }
    return c;
  }, [msgs]);

  const patch = (id, p) => setMsgs((ms) => ms.map((m) => (m.id === id ? { ...m, ...p } : m)));

  /* ---------- Escalation ---------- */
  const escalate = async (m, rule) => {
    // For the protected-ground rules the content is not copied into the
    // notification. The person opens the thread to read it; what travels is
    // the rule id.
    const sensitive = SENSITIVE_RULES.includes(rule?.id);
    const due = new Date(Date.now() + ESCALATION_HOURS * 3600e3).toISOString();
    const id = "esc_" + Date.now().toString(36);

    let queue = [];
    try {
      const r = await window.storage.get("baydo:outbox");
      if (r?.value) queue = JSON.parse(r.value);
    } catch (e) {}

    const toStaff = {
      id: "ob_" + Date.now().toString(36) + "a", kind: "escalation", channel: "email",
      to: "bowen.wang@themizar.ca", to_name: "Property Manager",
      subject: `Needs a reply${m.unit ? ` · ${m.unit}` : ""}${rule ? ` · ${rule.id}` : ""}`,
      body: sensitive
        ? `A message from ${m.name} needs a person. Rule ${rule.id}. The content is not repeated here — open the thread to read it.\n\nExpected first response by ${due.slice(0, 16).replace("T", " ")}.`
        : `A message from ${m.name}${m.unit ? ` (${m.unit})` : ""} needs a person.\n\n${m.body}\n\nExpected first response by ${due.slice(0, 16).replace("T", " ")}.`,
      ref_type: "escalation", ref_id: id, required_by: due,
      state: "queued", created_at: nowISO(),
    };

    // The tenant is told a person has it, with a realistic expectation rather
    // than silence.
    const zh = /[\u4e00-\u9fff]/.test(m.body);
    const toTenant = {
      id: "ob_" + Date.now().toString(36) + "b", kind: "escalation_ack", channel: "email",
      to: m.from, to_name: m.name,
      subject: zh ? "已收到你的訊息" : "We have your message",
      body: zh
        ? "你的訊息已經轉給我們的同事處理，通常一個工作天內會回覆你。如果情況緊急，請直接打電話到辦公室。"
        : "Your message has been passed to a colleague and you will normally hear back within one business day. If it is urgent, please call the office rather than waiting here.",
      ref_type: "escalation", ref_id: id, state: "queued", created_at: nowISO(),
    };

    try {
      await window.storage.set("baydo:outbox", JSON.stringify([toStaff, toTenant, ...queue]));
    } catch (e) {}

    return { id, due_by: due, notified: true, content_copied: !sensitive };
  };

  /* ---------- Pipeline ---------- */
  const process = useCallback(async (m) => {
    setBusy(m.id);

    // 1. Hard stop. A rule, not the model.
    const hit = HARD_STOPS.find((r) => r.re.test(m.body));
    if (hit) {
      patch(m.id, { state: "blocked", level: "L0", rule: hit.id, ruleLabel: hit.label,
                    why: hit.why, intent: null, draft: "" });
      setBusy(null);
      return;
    }

    // 2 and 4. Classify, then draft.
    try {
      const raw = await ai("inbox_draft",
        { facts, message: m.body, channel: m.channel,
          intents: Object.keys(INTENT_RULES) },
        { ref_type: "message", ref_id: m.id });
      const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());

      const rule = INTENT_RULES[parsed.intent] || INTENT_RULES.other;
      let level = rule.lvl;
      let warn = null;

      // 4. Check: every amount in the draft must exist in the retrieved facts.
      const bad = checkNumbers(parsed.draft, facts.allowedNumbers);
      if (bad.length) { level = "L1"; warn = `The draft contains amounts not found in the data: ${bad.join(", ")}. Downgraded for review.`; }
      if (parsed.missing_info) { level = "L1"; warn = warn || `Missing data: ${parsed.missing_info}. Downgraded for review.`; }
      if (parsed.confidence < 0.7) { level = "L1"; warn = warn || `Classification confidence ${parsed.confidence} is below threshold. Downgraded for review.`; }

      patch(m.id, {
        state: level === "L1" ? "review" : "ready",
        level, rule: rule.rule, ruleLabel: rule.label,
        intent: parsed.intent, confidence: parsed.confidence,
        draft: parsed.draft, factsUsed: parsed.facts_used || [], warn,
      });
    } catch (e) {
      patch(m.id, { state: "review", level: "L1", rule: "R-2099", ruleLabel: "System downgrade",
                    warn: "The AI service did not respond, so this went to a person. In production a fixed fallback message should go out here: received, someone will reply shortly.",
                    draft: "" });
    }
    setBusy(null);
  }, [facts]);

  const processAll = async () => {
    for (const m of msgs.filter((x) => x.state === "new")) await process(m);
  };

  const send = async (m, body) => {
    await fetch("/api/ai/feedback", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: "inbox_draft", ref_type: "message", ref_id: m.id,
        original: m.body, draft: m.draft, final: body,
        model: "@cf/zai-org/glm-4.7-flash" }),
    }).catch(() => null);
    patch(m.id, { state: "sent", draft: body, sentAt: Date.now(), edited: body !== m.draft });
  };

  const addMessage = () => {
    if (!compose.body.trim()) return;
    const id = "m" + Date.now();
    setMsgs((ms) => [...ms, { id, channel: compose.channel, from: "Test", name: "Test message",
                              body: compose.body, ts: Date.now(), state: "new" }]);
    setCompose({ open: false, channel: compose.channel, body: "" });
    setSel(id);
  };

  if (loading) return <div className="ai-root"><style>{CSS}</style><div className="ai-load">Loading property data…</div></div>;

  return (
    <div className="ai-root">
      <style>{CSS}</style>

      <header className="ai-head">
        <div>
          <div className="ai-eyebrow">Baydo Pointe · Prototype</div>
          <h1>AI replies <span>review console</span></h1>
        </div>
        <div className="ai-headr">
          <button className="ai-btn ai-btn--ghost" onClick={() => setCompose({ ...compose, open: !compose.open })}>
            Test a message
          </button>
          <button className="ai-btn" onClick={processAll} disabled={!!busy || counts.new === 0}>
            {busy ? "Working…" : `Process all (${counts.new})`}
          </button>
        </div>
      </header>

      <nav className="ai-tabs">
        {[["inbox", "Inbox"], ["escalations", "Needs a person"],
          ["shadow", "Shadow mode"]].map(([k, l]) => (
          <button key={k} className={view === k ? "on" : ""} onClick={() => setView(k)}>
            {l}
            {k === "escalations" && openEscalations.length > 0 &&
              <i className="ai-b">{openEscalations.length}</i>}
          </button>
        ))}
      </nav>

      {view === "escalations" && (
        <Escalations items={escalations} session={session}
          onSave={saveEscalations} />
      )}

      {view === "shadow" && (
        <Shadow runs={shadowRuns} session={session} onSave={saveShadow} />
      )}

      {view === "inbox" && !facts.hasPricing && (
        <div className="ai-banner">
          No rents are set, so the AI cannot look up a price and anything involving money is downgraded for review. That is the fact layer working as intended.
          Set rents under Pricing in the leasing console, then come back.
        </div>
      )}

      {view === "inbox" && (<>
        {compose.open && (
          <div className="ai-compose">
            <select className="ai-select" value={compose.channel}
                    onChange={(e) => setCompose({ ...compose, channel: e.target.value })}>
              {Object.entries(CHANNELS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <textarea className="ai-ta" rows={2} value={compose.body} placeholder="Type a tenant message to test the routing and draft…"
                      onChange={(e) => setCompose({ ...compose, body: e.target.value })} />
            <button className="ai-btn" onClick={addMessage}>Add to inbox</button>
          </div>
        )}

        <div className="ai-stats">
          {[["Unprocessed", counts.new, null], ["Auto-sent", counts.L3 + counts.L2, LEVELS.L3.color],
            ["Needs approval", counts.L1, LEVELS.L1.color], ["To a person", counts.L0, LEVELS.L0.color],
            ["Sent", counts.sent, null]].map(([l, v, c]) => (
            <div className="ai-stat" key={l}>
              <div className="ai-stat-l">{l}</div>
              <div className="ai-stat-v" style={c ? { color: c } : undefined}>{v}</div>
            </div>
          ))}
        </div>

        <div className="ai-main">
          {/* Inbox */}
          <div className="ai-list">
            {msgs.map((m) => {
              const lv = m.level ? LEVELS[m.level] : null;
              return (
                <button key={m.id} className={`ai-mi ${sel === m.id ? "on" : ""}`} onClick={() => setSel(m.id)}>
                  <div className="ai-mi-h">
                    <span className="ai-ch">{CHANNELS[m.channel].icon}</span>
                    <strong>{m.name}</strong>
                    {m.state === "sent" ? <span className="ai-pill ai-pill--sent">Sent</span>
                      : lv ? <span className="ai-pill" style={{ "--p": lv.color }}>{lv.label}</span>
                      : <span className="ai-pill ai-pill--new">Unprocessed</span>}
                  </div>
                  <div className="ai-mi-b">{m.body}</div>
                </button>
              );
            })}
          </div>

          {/* Detail */}
          <div className="ai-detail">
            {!selected ? <div className="ai-empty">Pick a message on the left.</div> : (
              <>
                <div className="ai-sec">
                  <div className="ai-sec-h">Original message</div>
                  <div className="ai-orig">
                    <div className="ai-dim">
                      {CHANNELS[selected.channel].label} · {selected.name} · {selected.from}
                    </div>
                    <p>{selected.body}</p>
                  </div>
                </div>

                {selected.state === "new" && (
                  <button className="ai-btn" onClick={() => process(selected)} disabled={busy === selected.id}>
                    {busy === selected.id ? "Classifying and drafting…" : "Run the pipeline"}
                  </button>
                )}

                {selected.level && (
                  <div className="ai-sec">
                    <div className="ai-sec-h">Routing decision</div>
                    <div className="ai-route" style={{ "--p": LEVELS[selected.level].color }}>
                      <div className="ai-route-h">
                        <span className="ai-lvl">{selected.level}</span>
                        <strong>{LEVELS[selected.level].label}</strong>
                        <span className="ai-mono ai-dim">Rule {selected.rule}</span>
                      </div>
                      <div className="ai-dim">{selected.ruleLabel} — {LEVELS[selected.level].desc}</div>
                      {selected.intent && (
                        <div className="ai-dim ai-mono" style={{ marginTop: 6 }}>
                          intent: {selected.intent} · confidence: {selected.confidence}
                        </div>
                      )}
                      {selected.why && <div className="ai-why">{selected.why}</div>}
                      {selected.warn && <div className="ai-warn">{selected.warn}</div>}
                    </div>
                  </div>
                )}

                {selected.factsUsed?.length > 0 && (
                  <div className="ai-sec">
                    <div className="ai-sec-h">Facts used</div>
                    <div className="ai-facts">
                      {selected.factsUsed.map((f, i) => <span className="ai-fact" key={i}>{f}</span>)}
                    </div>
                  </div>
                )}

                {selected.state === "blocked" && (
                  <div className="ai-sec">
                    <div className="ai-sec-h">Handling</div>
                    <p className="ai-dim">
                      Rule {selected.rule} assigns this straight to a person with no draft. The audit log keeps the rule id and the time only;
                      it never copies content that touches a protected ground.
                    </p>
                    <button className="ai-btn ai-btn--ghost" onClick={() => patch(selected.id, { state: "sent" })}>
                      Mark as assigned
                    </button>
                  </div>
                )}

                {(selected.state === "ready" || selected.state === "review") && (
                  <div className="ai-sec">
                    <div className="ai-sec-h">
                      Draft reply{selected.state === "review" && <em> · needs your approval</em>}
                    </div>
                    <textarea className="ai-ta ai-ta--lg" rows={9} value={draftEdit}
                              onChange={(e) => setDraftEdit(e.target.value)} />
                    <div className="ai-acts">
                      <button className="ai-btn" onClick={() => send(selected, draftEdit)}>
                        {selected.state === "ready" ? "Send" : "Approve and send"}
                      </button>
                      <button className="ai-btn ai-btn--ghost"
                              onClick={() => patch(selected.id, { state: "blocked", level: "L0",
                                                                 rule: "manual", ruleLabel: "Escalated by staff",
                                                                 why: "A staff member judged this needs handling in person." })}>
                        Send to a person
                      </button>
                      {draftEdit !== selected.draft && <span className="ai-dim">Draft edited</span>}
                    </div>
                  </div>
                )}

                {selected.state === "sent" && (
                  <div className="ai-sec">
                    <div className="ai-sec-h">Audit record</div>
                    <pre className="ai-log">{JSON.stringify({
                      outbound_id: "out_" + selected.id,
                      in_reply_to: selected.id,
                      channel: selected.channel,
                      routing_decision: selected.level,
                      rule_id: selected.rule,
                      intent: selected.intent,
                      intent_confidence: selected.confidence,
                      facts_used: selected.factsUsed || [],
                      model: "@cf/zai-org/glm-4.7-flash",
                      prompt_version: "v1.0",
                      draft_edited_by_human: !!selected.edited,
                      sent_at: selected.sentAt ? new Date(selected.sentAt).toISOString() : null,
                    }, null, 2)}</pre>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <footer className="ai-foot">
          Prototype. The AI classifies and drafts; whether anything is sent automatically comes from the hard-coded rules above. That way every automatic send
          points at a rule id a lawyer can review, rather than at the model’s own judgement. The hard-stop list and the CASL and PIPA handling
          must be reviewed by a lawyer or a RECA advisor before this goes live.
        </footer>
      </>)}
    </div>
  );
}

/* ============================ Fact layer ============================ */

function buildFacts(pricing, overrides, parking) {
  const ov = overrides || {};
  const p = pricing || {};
  const pk = parking || { pools: [], records: [], maxPerUnit: 1 };
  const allowed = new Set();
  const add = (v) => { if (v !== "" && v != null && !isNaN(v)) allowed.add(Math.round(Number(v))); };

  // Vacancy and rent
  const byType = {};
  for (const u of ALL_UNITS) {
    const o = ov[u.id] || {};
    const status = o.status || "available";
    const rent = o.rent ? Number(o.rent) : Number(p.base?.[u.type]) || null;
    if (!byType[u.type]) byType[u.type] = { vacant: 0, rents: new Set(), dates: [] };
    if (status === "available") {
      byType[u.type].vacant++;
      if (rent) byType[u.type].rents.add(rent);
      if (o.date) byType[u.type].dates.push(o.date);
    }
    if (rent) add(rent);
  }
  const hasPricing = Object.values(p.base || {}).some((v) => v !== "" && v != null);

  [p.catDeposit, p.dogDeposit, p.petRent, p.parkUnderground, p.parkSurface, p.storage, p.appFee,
   p.depositFixed].forEach(add);

  const pools = (pk.pools || []).map((pool) => {
    const used = (pk.records || []).filter((r) => r.status === "assigned" && r.poolId === pool.id).length;
    add(Number(pool.total) - used);
    return { label: pool.label, total: Number(pool.total), used, free: Number(pool.total) - used };
  });
  const waiting = (pk.records || []).filter((r) => r.status === "waiting").length;
  add(waiting);

  const lines = [];
  lines.push("PROPERTY: Baydo Pointe, 370/374/378 Clareview Station Drive NW, Edmonton, AB. 330 units across three six-storey buildings, next to Clareview LRT station.");
  lines.push("AMENITIES: each building has a gym, lounge and games room, lobby, pet wash and bike storage. The site has bike racks, an outdoor patio and a bus pad.");
  lines.push("UNIT TYPES AND VACANCY:");
  for (const [t, d] of Object.entries(byType)) {
    const r = [...d.rents];
    lines.push(`  ${t} (${TYPES[t].bed}, ${TYPES[t].sf} ft², 71 ft² balcony): ${d.vacant} available; ` +
      (r.length ? `rent ${r.length === 1 ? money(r[0]) : money(Math.min(...r)) + "–" + money(Math.max(...r))}` : "rent not set") +
      (d.dates.length ? `; earliest move-in ${d.dates.sort()[0]}` : "; move-in date not set"));
  }
  lines.push("DEPOSIT: " + (p.depositMode === "fixed"
    ? (money(p.depositFixed) ? `fixed at ${money(p.depositFixed)}` : "not set")
    : "one month’s rent"));
  lines.push("PETS: " +
    (money(p.catDeposit) ? `cat deposit ${money(p.catDeposit)}; ` : "cat deposit not set; ") +
    (money(p.dogDeposit) ? `dog deposit ${money(p.dogDeposit)}; ` : "dog deposit not set; ") +
    (money(p.petRent) ? `pet rent ${money(p.petRent)} per animal; ` : "pet rent not set; ") +
    (p.petLimit ? `limit ${p.petLimit}` : "limit not set"));
  lines.push("PARKING: first come, first served. A request is assigned if the area has room, otherwise it waits in request order. Limit " + pk.maxPerUnit + " per unit.");
  for (const pool of pools) lines.push(`  ${pool.label}: ${pool.used}/${pool.total}, ${pool.free} free`);
  lines.push(`  Currently waiting: ${waiting}`);
  lines.push("STALL RENT: " +
    (money(p.parkUnderground) ? `underground ${money(p.parkUnderground)}; ` : "underground not set; ") +
    (money(p.parkSurface) ? `surface ${money(p.parkSurface)}` : "surface not set"));
  lines.push("OTHER: " +
    (money(p.storage) ? `storage ${money(p.storage)}/month; ` : "storage not set; ") +
    (money(p.appFee) ? `application fee ${money(p.appFee)}; ` : "application fee not set; ") +
    (p.utilities ? `rent includes: ${p.utilities}` : "what rent includes is not set"));

  return { text: lines.join("\n"), allowedNumbers: allowed, hasPricing };
}

function buildPrompt(m, facts) {
  return `You draft replies for the Baydo Pointe leasing team. Below is the live property data. It is your only source of facts.

${facts.text}

Tenant message (channel: ${CHANNELS[m.channel].label}):
"""
${m.body}
"""

Rules:
1. Every amount, date, count and unit number in the reply must appear in the facts above. Never calculate, estimate or fill a gap.
2. If what they asked about is marked not set, or is absent, do not invent it. Say what is missing in missing_info and write in the draft that you will confirm and come back to them.
3. Never promise to hold a unit, negotiate, quote lease terms, or answer eligibility questions.
4. For a showing or signing request, confirm only that the slot is being booked and a confirmation will follow. Never invent a specific time; the scheduler assigns it.
      A signing slot can be booked, but say clearly that the lease is reviewed by a person before any signing link goes out, and include no lease content.
5. Reply in the language the tenant wrote in: Traditional Chinese for a Chinese message, English for an English one. Keep SMS under 300 characters.
6. Professional and warm, not salesy. End by noting this is an automated reply and a person is available.
7. After any amount, note that the signed lease governs.

intent must be one of: availability, rent_quote, unit_spec, amenities, location, pet_policy, fees, parking_availability, waitlist_position, showing_hours, showing_booking, showing_reschedule, showing_cancel, signing_booking, parking_request, renewal, complaint, maintenance, early_termination, other

Output JSON only. No markdown, no text before or after:
{"intent":"...","confidence":0.0,"facts_used":["the facts used, e.g. 2A rent, 370 underground free"],"missing_info":null or "what is missing","draft":"the full reply"}`;
}

// Check that every amount in the draft came from the fact layer
function checkNumbers(draft, allowed) {
  if (!draft) return [];
  const found = draft.match(/\$\s?[\d,]+(\.\d+)?/g) || [];
  const bad = [];
  for (const f of found) {
    const n = Math.round(Number(f.replace(/[$,\s]/g, "")));
    if (!allowed.has(n) && !bad.includes(f)) bad.push(f.trim());
  }
  return bad;
}

/* ============================ Styles ============================ */

/* ══════════════════ Needs a person ══════════════════ */

/** Handing a message to a person is not the same as a person seeing it. Each
 *  of these went out as an email with a clock, and this is where the clock is
 *  visible. Overdue sits at the top, because a tenant waiting in silence is
 *  how a question becomes a complaint. */
function Escalations({ items, session, onSave }) {
  const [answering, setAnswering] = useState(null);
  const [body, setBody] = useState("");

  const now = new Date().toISOString();
  const sorted = [...items].sort((a, b) => {
    const ao = a.state === "open" && a.due_by < now, bo = b.state === "open" && b.due_by < now;
    if (ao !== bo) return ao ? -1 : 1;
    return String(a.due_by).localeCompare(String(b.due_by));
  });
  const overdue = sorted.filter((e) => e.state === "open" && e.due_by < now);

  return (
    <div className="ai-list" style={{ padding: "16px 26px" }}>
      {overdue.length > 0 && (
        <div className="ai-banner ai-banner--bad">
          <strong>{overdue.length} past the time we said we would reply.</strong>{" "}
          The tenant was told one business day. Silence past that point is what
          turns a question into a complaint.
        </div>
      )}

      <p className="ai-note">
        These are the messages the rules stopped. For the protected-ground rules the
        content is not repeated in the notification — open the thread to read it.
      </p>

      {sorted.length === 0 ? (
        <div className="ai-empty">Nothing waiting on a person.</div>
      ) : sorted.map((e) => {
        const late = e.state === "open" && e.due_by < now;
        return (
          <article className={`ai-msg ${late ? "ai-msg--late" : ""}`} key={e.id}>
            <div className="ai-msg-h">
              <span className={`ai-badge ${late ? "bad" : ""}`}>
                {e.state === "open" ? (late ? "overdue" : "waiting") : e.state}
              </span>
              {e.rule_id && <span className="ai-rule">{e.rule_id}</span>}
              <strong>{e.tenant_name ?? "A tenant"}</strong>
              {e.unit_number && <span className="ai-mono">{e.unit_number}</span>}
              <span className="ai-dim">
                due {String(e.due_by ?? "").slice(5, 16).replace("T", " ")}
              </span>
            </div>

            {e.body_included === false || e.body == null ? (
              <p className="ai-withheld">
                The content is not copied here. This rule covers income, accessibility
                or another protected ground, and the audit record holds the rule
                reference rather than what was said.
              </p>
            ) : (
              <p className="ai-body">{e.body}</p>
            )}

            {e.state === "answered" ? (
              <div className="ai-answered">
                <strong>Answered</strong> {String(e.answered_at ?? "").slice(0, 16).replace("T", " ")}
                <p>{e.answer_body}</p>
              </div>
            ) : answering === e.id ? (
              <div className="ai-answerbox">
                <textarea className="ai-ta" rows={4} value={body} autoFocus
                          placeholder="Your reply goes to the tenant as written."
                          onChange={(ev) => setBody(ev.target.value)} />
                <div className="ai-actions">
                  <button className="ai-btn" disabled={!body.trim()}
                          onClick={() => { onSave(items.map((x) => x.id === e.id
                            ? { ...x, state: "answered", answer_body: body.trim(),
                                answered_at: new Date().toISOString(),
                                claimed_name: session?.name } : x));
                            setAnswering(null); setBody(""); }}>
                    Send it
                  </button>
                  <button className="ai-btn ai-btn--ghost"
                          onClick={() => { setAnswering(null); setBody(""); }}>Cancel</button>
                  <span className="ai-dim">
                    Written by you, sent as written. Nothing rewrites it on the way out.
                  </span>
                </div>
              </div>
            ) : (
              <div className="ai-actions">
                <button className="ai-btn ai-btn--sm" onClick={() => setAnswering(e.id)}>
                  Answer
                </button>
                {e.claimed_name && (
                  <span className="ai-dim">{e.claimed_name} has this one</span>
                )}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

/* ══════════════════ Shadow mode ══════════════════ */

/** The AI runs the whole way through and nothing is sent. Two to four weeks of
 *  this is how you find the error rate rather than guessing it.
 *
 *  The number that matters is the error rate on what would have sent
 *  unsupervised. Accuracy across drafts a person reviews anyway flatters the
 *  result — those get caught either way. */
function Shadow({ runs, session, onSave }) {
  const [filter, setFilter] = useState("unreviewed");

  const stats = useMemo(() => {
    const reviewed = runs.filter((r) => r.verdict);
    const wouldSend = runs.filter((r) => r.would_send);
    const wrongAndSent = wouldSend.filter((r) => r.verdict && r.verdict !== "correct");
    return {
      total: runs.length, reviewed: reviewed.length,
      wouldSend: wouldSend.length,
      errorOnSends: wouldSend.length
        ? Number((wrongAndSent.length / wouldSend.length * 100).toFixed(1)) : null,
      overall: reviewed.length
        ? Number((reviewed.filter((r) => r.verdict === "correct").length
            / reviewed.length * 100).toFixed(1)) : null,
      ready: reviewed.length >= 100 && wouldSend.length > 0
        && wrongAndSent.length / wouldSend.length < 0.02,
    };
  }, [runs]);

  const VERDICTS = [
    ["correct", "Correct"],
    ["wrong_intent", "Wrong intent"],
    ["wrong_content", "Wrong content"],
    ["should_not_send", "Should not have sent"],
    ["missed_stop", "Missed a hard stop"],
  ];

  const shown = runs.filter((r) => filter === "all" ? true
    : filter === "unreviewed" ? !r.verdict : r.verdict === filter);

  return (
    <div className="ai-list" style={{ padding: "16px 26px" }}>
      <div className="ai-shadowstats">
        <div><em>Runs</em><strong>{stats.total}</strong></div>
        <div><em>Reviewed</em><strong>{stats.reviewed}</strong></div>
        <div><em>Would have sent</em><strong>{stats.wouldSend}</strong></div>
        <div className="ai-key">
          <em>Wrong and would have sent</em>
          <strong className={stats.errorOnSends > 2 ? "ai-bad" : "ai-ok"}>
            {stats.errorOnSends == null ? "—" : `${stats.errorOnSends}%`}
          </strong>
        </div>
      </div>

      <p className="ai-note">
        The last figure is the one that matters. Overall accuracy counts drafts a
        person reviews anyway, and those get caught either way — what decides whether
        this can run unsupervised is how often something wrong would have gone out
        with nobody looking.
        {stats.reviewed < 100 && " Review at least a hundred before drawing a conclusion."}
      </p>

      {stats.ready && (
        <div className="ai-banner ai-banner--ok">
          Under 2% on what would have sent, across {stats.reviewed} reviewed. That is
          the threshold. Turning it on is still a decision somebody makes.
        </div>
      )}

      <div className="ai-seg">
        {[["unreviewed", "Not scored"], ...VERDICTS, ["all", "All"]].map(([k, l]) => (
          <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>
            {l}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <div className="ai-empty">
          {runs.length === 0
            ? "Nothing recorded. Shadow mode is off — set AI_SHADOW_MODE=1 to start collecting."
            : "Nothing in this group."}
        </div>
      ) : shown.slice(0, 60).map((r) => (
        <article className="ai-msg" key={r.id}>
          <div className="ai-msg-h">
            <span className={`ai-badge ${r.would_send ? "bad" : ""}`}>
              {r.would_send ? "would have sent" : "would have held"}
            </span>
            {r.intent && <span className="ai-rule">{r.intent}</span>}
            {r.rule_id && <span className="ai-rule">{r.rule_id}</span>}
            {r.confidence != null && (
              <span className="ai-dim">confidence {(r.confidence * 100).toFixed(0)}%</span>
            )}
            {r.verdict && (
              <span className={`ai-badge ${r.verdict === "correct" ? "ok" : "bad"}`}>
                {VERDICTS.find(([v]) => v === r.verdict)?.[1] ?? r.verdict}
              </span>
            )}
          </div>
          {r.draft && <p className="ai-body">{r.draft}</p>}

          {!r.verdict && (
            <div className="ai-actions">
              {VERDICTS.map(([v, l]) => (
                <button key={v} className="ai-btn ai-btn--sm ai-btn--ghost"
                        onClick={() => onSave(runs.map((x) => x.id === r.id
                          ? { ...x, verdict: v, reviewed_name: session?.name,
                              reviewed_at: new Date().toISOString() } : x))}>
                  {l}
                </button>
              ))}
            </div>
          )}
          {r.reviewed_name && (
            <div className="ai-dim">Scored by {r.reviewed_name}</div>
          )}
        </article>
      ))}
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=Archivo:wght@700;800&display=swap');
.ai-root{--ink:#131C25;--ink2:#3E4C5A;--dim:#78899A;--paper:#fff;--ground:#E9EDF0;--rule:#D3DBE1;
  --amber:#FFF6E0;--amberline:#E8C877;--red:#B23A54;--accent:var(--brand,#2A6183);
  background:var(--ground);color:var(--ink);min-height:100vh;font-size:14px;line-height:1.55;
  font-family:'IBM Plex Sans','PingFang TC','Microsoft JhengHei',system-ui,sans-serif;padding-bottom:48px}
.ai-root *{box-sizing:border-box}
.ai-mono{font-family:'IBM Plex Mono',monospace;font-variant-numeric:tabular-nums}
.ai-dim{color:var(--dim);font-size:12.5px}
.ai-load{padding:80px 24px;text-align:center;color:var(--dim)}

.ai-head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;
  padding:24px 28px 18px;background:var(--paper);border-bottom:1px solid var(--rule)}
.ai-eyebrow{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.13em;
  text-transform:uppercase;color:var(--dim)}
.ai-head h1{font-family:'Archivo','PingFang TC',sans-serif;font-weight:800;font-size:24px;
  letter-spacing:-.02em;margin:4px 0 0}
.ai-head h1 span{font-weight:700;font-size:16px;color:var(--dim);margin-left:6px}
.ai-headr{display:flex;gap:10px}
.ai-btn{font:inherit;font-weight:600;font-size:13px;cursor:pointer;background:var(--brand,var(--ink));color:#fff;
  border:1px solid var(--brand,var(--ink));padding:8px 16px;border-radius:3px}
.ai-btn:hover:not(:disabled){background:#000}
.ai-btn:disabled{opacity:.4;cursor:not-allowed}
.ai-btn--ghost{background:transparent;color:var(--ink2);border-color:var(--rule)}
.ai-btn--ghost:hover{background:var(--ground);color:var(--ink)}
.ai-btn:focus-visible,.ai-mi:focus-visible,.ai-select:focus-visible,.ai-ta:focus-visible{
  outline:2px solid var(--accent);outline-offset:2px}

.ai-tabs{display:flex;padding:0 26px;background:#fff;border-bottom:1px solid var(--rule)}
.ai-tabs button{font:inherit;font-weight:600;font-size:13.5px;cursor:pointer;background:none;
  border:0;padding:12px 16px;color:var(--dim);border-bottom:2px solid transparent;
  margin-bottom:-1px;display:flex;align-items:center;gap:6px}
.ai-tabs button.on{color:var(--brand);border-bottom-color:var(--brand)}
.ai-b{font-style:normal;font-family:'IBM Plex Mono',monospace;font-size:10px;
  background:var(--red);color:#fff;border-radius:8px;padding:1px 6px}
.ai-banner--bad{background:#FDF6F7;border-color:var(--red);color:var(--red)}
.ai-banner--ok{background:#F5FAF8;border-color:var(--green);color:var(--green)}
.ai-note{color:var(--dim);font-size:12.5px;line-height:1.7;max-width:74ch;margin:0 0 4px}
.ai-empty{color:var(--dim);font-size:12.5px;padding:30px 0;text-align:center;
  border:1px dashed var(--rule);border-radius:3px;background:#fff}
.ai-withheld{font-size:12.5px;color:var(--dim);font-style:italic;line-height:1.7;
  border-left:2px solid var(--rule);padding-left:11px;margin:4px 0}
.ai-answerbox{display:flex;flex-direction:column;gap:8px}
.ai-answered{background:#F5FAF8;border-left:3px solid var(--green);border-radius:3px;
  padding:9px 12px;font-size:12.5px}
.ai-answered p{margin:5px 0 0;line-height:1.7;color:var(--ink2)}
.ai-msg--late{border-left:3px solid var(--red);background:#FFFCFC}
.ai-shadowstats{display:flex;gap:26px;flex-wrap:wrap;background:#fff;border:1px solid var(--rule);
  border-radius:4px;padding:14px 16px}
.ai-shadowstats>div{display:flex;flex-direction:column;gap:2px}
.ai-shadowstats em{font-style:normal;font-size:10.5px;color:var(--dim);text-transform:uppercase;
  letter-spacing:.05em;font-family:'IBM Plex Mono',monospace}
.ai-shadowstats strong{font-family:'IBM Plex Mono',monospace;font-size:20px}
.ai-key{border-left:2px solid var(--rule);padding-left:22px}
.ai-bad{color:var(--red)}
.ai-ok{color:var(--green)}
.ai-seg{display:flex;flex-wrap:wrap;gap:5px;margin:4px 0}
.ai-seg button{font:inherit;font-size:12px;cursor:pointer;background:#fff;
  border:1px solid var(--rule);border-radius:12px;padding:4px 11px;color:var(--dim)}
.ai-seg button.on{background:var(--brand);color:#fff;border-color:var(--brand)}
.ai-btn--sm{padding:5px 11px;font-size:12px}
.ai-banner{background:#FFF8E6;border-bottom:1px solid var(--amberline);padding:11px 28px;
  font-size:12.5px;color:#7A5D14;line-height:1.6}
.ai-compose{display:flex;gap:10px;padding:14px 28px;background:var(--paper);
  border-bottom:1px solid var(--rule);align-items:flex-start;flex-wrap:wrap}
.ai-select{font:inherit;font-size:13px;padding:8px 10px;border:1px solid var(--rule);border-radius:3px;
  background:var(--paper);cursor:pointer}
.ai-ta{font:inherit;font-size:13px;flex:1 1 260px;min-width:0;padding:8px 10px;border-radius:3px;
  border:1px solid var(--amberline);background:var(--amber);resize:vertical;line-height:1.6;
  color:var(--ink);font-family:inherit}
.ai-ta--lg{width:100%;background:var(--paper);border-color:var(--rule)}

.ai-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));background:var(--paper);
  border-bottom:1px solid var(--rule)}
.ai-stat{padding:13px 28px;border-right:1px solid var(--rule)}
.ai-stat:last-child{border-right:0}
.ai-stat-l{font-size:10.5px;letter-spacing:.06em;color:var(--dim);text-transform:uppercase;
  font-family:'IBM Plex Mono',monospace}
.ai-stat-v{font-family:'IBM Plex Mono',monospace;font-size:20px;font-weight:600;margin-top:2px}

.ai-main{display:grid;grid-template-columns:minmax(260px,340px) 1fr;gap:16px;padding:18px 28px;
  align-items:start;max-width:1300px}
.ai-list{display:flex;flex-direction:column;gap:1px;background:var(--rule);border:1px solid var(--rule);
  border-radius:4px;overflow:hidden}
.ai-mi{font:inherit;text-align:left;cursor:pointer;background:var(--paper);border:0;padding:11px 13px;
  border-left:3px solid transparent}
.ai-mi:hover{background:#F6F9FB}
.ai-mi.on{background:#F2F7FB;border-left-color:var(--accent)}
.ai-mi-h{display:flex;align-items:center;gap:7px;margin-bottom:3px}
.ai-mi-h strong{font-size:13px;font-weight:600;margin-right:auto;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap}
.ai-ch{color:var(--dim);font-size:13px}
.ai-mi-b{font-size:12px;color:var(--dim);line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;
  -webkit-box-orient:vertical;overflow:hidden}
.ai-pill{font-size:10.5px;font-weight:600;padding:2px 7px;border-radius:9px;white-space:nowrap;
  color:var(--p);border:1px solid var(--p)}
.ai-pill--new{color:var(--dim);border-color:var(--rule)}
.ai-pill--sent{color:var(--dim);border-color:var(--rule);background:var(--ground)}

.ai-detail{background:var(--paper);border:1px solid var(--rule);border-radius:4px;padding:20px 22px;
  display:flex;flex-direction:column;gap:18px}
.ai-empty{color:var(--dim);padding:30px 0;text-align:center}
.ai-sec-h{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.08em;
  text-transform:uppercase;color:var(--dim);margin-bottom:8px}
.ai-sec-h em{font-style:normal;color:#C98A15;font-weight:600}
.ai-orig{border:1px solid var(--rule);border-radius:3px;padding:12px 14px;background:#FCFDFE}
.ai-orig p{margin:6px 0 0;font-size:13.5px;line-height:1.65}

.ai-route{border:1px solid var(--rule);border-left:3px solid var(--p);border-radius:3px;padding:12px 14px}
.ai-route-h{display:flex;align-items:center;gap:9px;margin-bottom:4px;flex-wrap:wrap}
.ai-lvl{font-family:'IBM Plex Mono',monospace;font-size:11px;font-weight:600;color:#fff;background:var(--p);
  border-radius:2px;padding:2px 6px}
.ai-why{margin-top:9px;padding-top:9px;border-top:1px dotted var(--rule);font-size:12.5px;
  color:var(--ink2);line-height:1.6}
.ai-warn{margin-top:9px;font-size:12.5px;color:#7A5D14;background:#FFF8E6;border-radius:3px;
  padding:8px 10px;line-height:1.6}

.ai-facts{display:flex;flex-wrap:wrap;gap:6px}
.ai-fact{font-family:'IBM Plex Mono',monospace;font-size:11.5px;background:var(--ground);
  border:1px solid var(--rule);border-radius:2px;padding:3px 8px;color:var(--ink2)}

.ai-acts{display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap}
.ai-log{font-family:'IBM Plex Mono',monospace;font-size:11.5px;background:#F7F9FB;border:1px solid var(--rule);
  border-radius:3px;padding:12px 14px;overflow-x:auto;line-height:1.6;margin:0;color:var(--ink2)}
.ai-foot{padding:4px 28px 0;color:var(--dim);font-size:11.5px;max-width:88ch;line-height:1.65}

@media (max-width:820px){
  .ai-main{grid-template-columns:1fr;padding:16px}
  .ai-head,.ai-stats .ai-stat,.ai-banner,.ai-compose,.ai-foot{padding-left:16px;padding-right:16px}
  .ai-list{max-height:280px;overflow-y:auto}
}
`;
