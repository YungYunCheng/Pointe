import React, { useState, useEffect, useRef, useCallback } from "react";
import { publicAi, publicHandoff } from "./lib/ai.js";

/* ============================================================
   BAYDO POINTE — tenant chat widget

   Tenant-facing, so it is bilingual and follows whichever language
   the tenant writes in.

   The same routing rules as the reply console apply here:
     · Hard stops run before automation. A message about income source,
       accessibility, a protected ground, a dispute or lease terms goes
       straight to the responsible person.
     · Known questions use fixed answer rules and current database facts.
       Anything the rules cannot identify becomes a confirmation task.
     · Every reply carries a note that it is automated, with a way
       through to a person.
   ============================================================ */

const HANDOFF_HOURS = { start: 9, end: 18 };   // when a person is normally around

/* ---------- Hard stops: rules, before automation ---------- */
const HARD_STOPS = [
  { id: "R-101", topic: "eligibility",
    re: /收入|所得|income|AISH|ODSP|社會?補助|福利金|welfare|assistance|credit\s*score|信用(分數|評分|紀錄)|薪資證明|pay\s*stub|工作證明|employment\s*letter|保證人|guarantor|qualify|qualif/i },
  { id: "R-102", topic: "accessibility",
    re: /無障礙|輪椅|wheelchair|accessible|accommodat|service\s*(dog|animal)|服務犬|導盲|assistance\s*animal|行動不便|失明|聽障|身心障礙|disab/i },
  { id: "R-103", topic: "protected",
    re: /種族|族裔|膚色|宗教|信仰|race|racial|religio|懷孕|pregnan|小孩|孩子|children|kids|單親|single\s*(mom|mother|parent)|婚姻|married|divorc|國籍|移民|immigrant|newcomer|refugee|難民|性別|gender|LGBT|同志/i },
  { id: "R-104", topic: "dispute",
    re: /律師|法務|lawyer|attorney|legal\s*action|human\s*rights|人權(委員|會)|RTDRS|驅逐|evict|投訴|申訴|complain|訴訟|sue|索賠|求償|違約金/i },
  { id: "R-105", topic: "leaseterms",
    re: /租約條款|合約條款|契約條款|lease\s*terms|條款|把租約(寄|傳|發)|send\s*(me\s*)?the\s*lease|保留(單位|房)|hold\s*the\s*(unit|suite)|折扣|優惠|議價|降租|少收|減免|waive|discount|negotiat/i },
  { id: "R-106", topic: "emergency",
    re: /漏水|淹水|沒有?熱水|沒有?暖氣|停電|火災|瓦斯|煤氣|闖入|緊急|flood|leak|no\s*(hot\s*water|heat|power)|fire|gas\s*smell|break-?in|emergency|urgent/i },
];

const T = {
  en: {
    launcher: "Questions?",
    title: "Baydo Pointe",
    subtitle: "Ask about availability, rent, parking or pets",
    placeholder: "Type your question…",
    send: "Send",
    thinking: "Typing…",
    autoNote: "Automated reply",
    toHuman: "Talk to a person",
    handedOff: "Passed to our team",
    handoffBody: "The appropriate staff member has been notified. Please contact the office so they can reply to you.",
    handoffAfterHours: "The team has been notified. It is outside office hours, so please contact the office on the next business day.",
    close: "Close",
    minimize: "Minimise",
    greeting: "Hello. Ask me about available units, rent, parking or the pet policy and I will check for you. Anything else goes to our team.",
    langLabel: "中文",
    quick: ["What is available?", "How much is rent?", "Is parking available?", "Can I have a pet?"],
    offlineErr: "That did not go through. Try again, or ask for a person.",
    emergencyTitle: "If this is urgent",
    emergencyBody: "For a leak, no heat, no hot water or anything unsafe, call the office rather than waiting here.",
  },
  zh: {
    launcher: "有問題嗎？",
    title: "Baydo Pointe",
    subtitle: "空房、租金、車位、寵物都可以問",
    placeholder: "輸入你的問題…",
    send: "送出",
    thinking: "輸入中…",
    autoNote: "自動回覆",
    toHuman: "轉真人",
    handedOff: "已轉給我們的同事",
    handoffBody: "已通知對應的同事。請聯絡辦公室，讓同事可以回覆你。",
    handoffAfterHours: "已通知同事。現在是非上班時間，請在下一個工作日聯絡辦公室。",
    close: "關閉",
    minimize: "縮小",
    greeting: "你好。空房、租金、車位、寵物政策都可以問我，我幫你查。其他問題我會轉給同事。",
    langLabel: "EN",
    quick: ["有哪些空房？", "租金多少？", "還有車位嗎？", "可以養寵物嗎？"],
    offlineErr: "訊息沒送出去，請再試一次，或轉真人。",
    emergencyTitle: "如果是緊急狀況",
    emergencyBody: "漏水、沒暖氣、沒熱水或任何安全問題，請直接打電話到辦公室，不要在這裡等。",
  },
};

/* Messages the hard stops produce. */
const STOP_REPLY = {
  en: {
    eligibility: "That is something our leasing team answers directly, so I have passed it to them.",
    accessibility: "I have passed this to our team so they can go through it with you properly.",
    protected: "I have passed this to our team, who will get back to you.",
    dispute: "I have passed this to our team so it is handled by a person.",
    leaseterms: "Lease terms and anything about pricing are handled by our leasing team, so I have passed this on.",
    emergency: "If this is urgent, please call the office rather than waiting for a reply here. I have flagged it to our team as well.",
  },
  zh: {
    eligibility: "這個問題由我們的租賃同事直接回覆比較清楚，我已經轉過去了。",
    accessibility: "我已經把這件事轉給同事，讓他們好好跟你討論。",
    protected: "我已經轉給同事，他們會回覆你。",
    dispute: "這件事我轉給同事，由真人處理。",
    leaseterms: "租約條款和價格相關的事情由租賃同事處理，我已經轉過去了。",
    emergency: "如果情況緊急，請直接打電話到辦公室，不要在這裡等回覆。我同時也已經通報同事。",
  },
};

const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const nowISO = () => new Date().toISOString();
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const inHours = () => {
  const d = new Date(), h = d.getHours(), dow = d.getDay();
  return dow >= 1 && dow <= 5 && h >= HANDOFF_HOURS.start && h < HANDOFF_HOURS.end;
};
const looksChinese = (s) => /[\u4e00-\u9fff]/.test(s);

export default function TenantChat() {
  const [open, setOpen] = useState(false);
  const [lang, setLang] = useState("en");
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [handedOff, setHandedOff] = useState(false);
  const [unread, setUnread] = useState(0);
  const [threadId] = useState(() => uid("th_"));
  const bodyRef = useRef(null);
  const t = T[lang];

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [msgs, busy]);

  useEffect(() => { if (open) setUnread(0); }, [open]);

  const push = (m) => setMsgs((x) => [...x, { id: uid("m_"), at: nowISO(), ...m }]);

  /* ---------- Hand off to a person ---------- */
  const handOff = useCallback((reason, ruleId, message, language = lang) => {
    setHandedOff(true);
    // The server creates a database confirmation assigned to the responsible
    // role. The message content is not copied for R-101 to R-103.
    const sensitive = ["R-101", "R-102", "R-103"].includes(ruleId);
    push({ role: "system",
           text: `${t.handedOff}. ${inHours() ? t.handoffBody : t.handoffAfterHours}`,
           meta: { thread: threadId, rule: ruleId ?? "manual",
                   content_copied: !sensitive } });
    if (!open) setUnread((n) => n + 1);
    if (message) publicHandoff({ message, topic: reason, rule_id: ruleId,
      language, thread_id: threadId }).catch(() => {});
  }, [t, open, threadId, lang]);

  /* ---------- Send ---------- */
  const send = async (text) => {
    const body = (text ?? input).trim();
    if (!body || busy || handedOff) return;
    setInput("");
    push({ role: "tenant", text: body });

    // Follow the tenant's language from what they actually wrote
    const detected = looksChinese(body) ? "zh" : "en";
    if (detected !== lang) setLang(detected);
    const tt = T[detected];

    // 1. Hard stops run first, before any automated answer
    const hit = HARD_STOPS.find((r) => r.re.test(body));
    if (hit) {
      push({ role: "bot", text: STOP_REPLY[detected][hit.topic], stop: hit.id });
      handOff(hit.topic, hit.id, body, detected);
      return;
    }

    // 2. Otherwise answer from the property data
    setBusy(true);
    try {
  const reply = await publicAi({
    message: body,
    history: msgs
      .slice(-6)
      .map((m) => `${m.role === "tenant" ? "Tenant" : "You"}: ${m.text}`)
      .join("\n"),
    language: detected,
    thread_id: threadId,
    });
      if (reply?.text) push({ role: "bot", text: reply.text, auto: true });
      else { push({ role: "bot", text: tt.offlineErr }); }
      if (reply?.needs_confirmation) setHandedOff(true);
    } catch (e) {
      push({ role: "bot", text: tt.offlineErr });
    }
    setBusy(false);
    if (!open) setUnread((n) => n + 1);
  };

  const toggleLang = () => setLang((l) => (l === "en" ? "zh" : "en"));

  return (
    <div className="tc">
      <style>{CSS}</style>

      {/* Sample page behind the widget, so the placement is visible */}
      <div className="tc-page">
        <div className="tc-page-in">
          <div className="tc-eyebrow">Baydo Pointe</div>
          <h1>370 · 374 · 378 Clareview Station Drive NW</h1>
          <p>
            330 suites across three six-storey buildings, steps from Clareview LRT.
            One and two bedroom layouts, a gym, lounge and pet wash in every building.
          </p>
          <p className="tc-hint">
            The chat launcher sits bottom right. It answers from the live property
            data and hands anything it should not answer to a person.
          </p>
        </div>
      </div>

      {/* Launcher */}
      {!open && (
        <button className="tc-launch" onClick={() => setOpen(true)} aria-label={t.launcher}>
          <span className="tc-launch-ic" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
            </svg>
          </span>
          <span className="tc-launch-tx">{t.launcher}</span>
          {unread > 0 && <span className="tc-badge">{unread}</span>}
        </button>
      )}

      {/* Panel */}
      {open && (
        <div className="tc-panel" role="dialog" aria-label={t.title}>
          <header className="tc-head">
            <div>
              <strong>{t.title}</strong>
              <span>{t.subtitle}</span>
            </div>
            <div className="tc-headr">
              <button className="tc-lang" onClick={toggleLang} aria-label="Switch language">
                {t.langLabel}
              </button>
              <button className="tc-x" onClick={() => setOpen(false)} aria-label={t.minimize}>−</button>
            </div>
          </header>

          <div className="tc-body" ref={bodyRef}>
            <div className="tc-msg tc-msg--bot">
              <p>{t.greeting}</p>
            </div>

            {msgs.length === 0 && (
              <div className="tc-quick">
                {t.quick.map((q) => (
                  <button key={q} onClick={() => send(q)}>{q}</button>
                ))}
              </div>
            )}

            {msgs.map((m) => (
              <div key={m.id} className={`tc-msg tc-msg--${m.role}`}>
                <p>{m.text}</p>
                <div className="tc-meta">
                  <span>{clock(m.at)}</span>
                  {m.auto && <span className="tc-auto">{t.autoNote}</span>}
                  {m.stop && <span className="tc-auto">→ {t.toHuman}</span>}
                </div>
              </div>
            ))}

            {busy && (
              <div className="tc-msg tc-msg--bot tc-typing">
                <span></span><span></span><span></span>
              </div>
            )}

            {handedOff && (
              <div className="tc-note">
                <strong>{t.emergencyTitle}</strong>
                <p>{t.emergencyBody}</p>
              </div>
            )}
          </div>

          <div className="tc-foot">
            {!handedOff ? (
              <>
                <div className="tc-inputrow">
                  <input value={input} placeholder={t.placeholder} disabled={busy}
                         onChange={(e) => setInput(e.target.value)}
                         onKeyDown={(e) => e.key === "Enter" && send()} />
                  <button className="tc-send" onClick={() => send()}
                          disabled={busy || !input.trim()} aria-label={t.send}>
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
                         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
                    </svg>
                  </button>
                </div>
                <button className="tc-human" onClick={() => handOff("requested", null,
                  [...msgs].reverse().find((m) => m.role === "tenant")?.text ||
                    (lang === "zh" ? "訪客要求真人協助" : "Visitor requested staff assistance"))}>
                  {t.toHuman}
                </button>
              </>
            ) : (
              <div className="tc-closed">{t.handedOff}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=Archivo:wght@700;800&display=swap');
.tc{--ink:#131C25;--ink2:#3E4C5A;--dim:#78899A;--paper:#fff;--ground:#E9EDF0;--rule:#D3DBE1;
  --accent:#1C6FA6;--green:#0E8577;--amber:#FFF6E0;--amberline:#E8C877;
  font-family:'IBM Plex Sans','PingFang TC','Microsoft JhengHei',system-ui,sans-serif;
  font-size:14px;line-height:1.55;color:var(--ink);min-height:100vh;position:relative}
.tc *{box-sizing:border-box}

/* Sample page */
.tc-page{min-height:100vh;background:linear-gradient(160deg,#F4F7F9 0%,#E4EAEF 100%);
  display:flex;align-items:center;padding:40px 24px}
.tc-page-in{max-width:620px;margin:0 auto}
.tc-eyebrow{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.14em;
  text-transform:uppercase;color:var(--dim)}
.tc-page h1{font-family:'Archivo',sans-serif;font-weight:800;font-size:clamp(24px,4vw,36px);
  letter-spacing:-.025em;margin:8px 0 14px;line-height:1.15}
.tc-page p{margin:0 0 12px;color:var(--ink2);max-width:56ch}
.tc-hint{font-size:12.5px;color:var(--dim);border-left:2px solid var(--rule);padding-left:12px}

/* Launcher */
.tc-launch{position:fixed;right:20px;bottom:20px;z-index:40;display:flex;align-items:center;gap:9px;
  font:inherit;font-weight:600;font-size:14px;cursor:pointer;background:var(--ink);color:#fff;
  border:0;border-radius:26px;padding:12px 20px 12px 16px;
  box-shadow:0 6px 22px rgba(19,28,37,.28);transition:transform .16s,box-shadow .16s}
.tc-launch:hover{transform:translateY(-2px);box-shadow:0 10px 28px rgba(19,28,37,.34)}
.tc-launch:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.tc-launch-ic{display:flex}
.tc-badge{position:absolute;top:-3px;right:-3px;min-width:20px;height:20px;border-radius:10px;
  background:#B23A54;color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;
  justify-content:center;padding:0 6px;border:2px solid #fff}

/* Panel */
.tc-panel{position:fixed;right:20px;bottom:20px;z-index:41;width:min(380px,calc(100vw - 32px));
  height:min(600px,calc(100vh - 40px));background:var(--paper);border:1px solid var(--rule);
  border-radius:12px;display:flex;flex-direction:column;overflow:hidden;
  box-shadow:0 18px 50px rgba(19,28,37,.22);animation:tcIn .2s cubic-bezier(.2,.8,.3,1)}
@keyframes tcIn{from{transform:translateY(14px) scale(.98);opacity:0}to{transform:none;opacity:1}}
@media (prefers-reduced-motion:reduce){.tc-panel{animation:none}}

.tc-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;
  padding:15px 16px;background:var(--ink);color:#fff;flex:0 0 auto}
.tc-head strong{display:block;font-family:'Archivo',sans-serif;font-size:15.5px;letter-spacing:-.01em}
.tc-head span{display:block;font-size:11.5px;color:rgba(255,255,255,.7);margin-top:2px}
.tc-headr{display:flex;align-items:center;gap:6px}
.tc-lang{font:inherit;font-size:11.5px;font-weight:600;cursor:pointer;background:rgba(255,255,255,.14);
  border:0;border-radius:4px;padding:4px 9px;color:#fff}
.tc-lang:hover{background:rgba(255,255,255,.24)}
.tc-x{font:inherit;font-size:20px;line-height:1;cursor:pointer;background:none;border:0;
  color:rgba(255,255,255,.75);padding:0 5px}
.tc-x:hover{color:#fff}
.tc-lang:focus-visible,.tc-x:focus-visible{outline:2px solid #fff;outline-offset:2px}

.tc-body{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;
  background:#FAFBFC}
.tc-msg{max-width:86%}
.tc-msg p{margin:0;padding:10px 13px;border-radius:12px;font-size:13.5px;line-height:1.6;
  white-space:pre-wrap;word-break:break-word}
.tc-msg--bot p,.tc-msg--system p{background:var(--paper);border:1px solid var(--rule);
  border-bottom-left-radius:3px}
.tc-msg--system p{background:var(--amber);border-color:var(--amberline);color:#7A5D14;font-size:13px}
.tc-msg--tenant{align-self:flex-end}
.tc-msg--tenant p{background:var(--ink);color:#fff;border-bottom-right-radius:3px}
.tc-meta{display:flex;gap:8px;align-items:center;margin-top:3px;padding:0 3px;
  font-size:10.5px;color:var(--dim)}
.tc-msg--tenant .tc-meta{justify-content:flex-end}
.tc-auto{border:1px solid var(--rule);border-radius:8px;padding:0 6px}

.tc-quick{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px}
.tc-quick button{font:inherit;font-size:12.5px;cursor:pointer;background:var(--paper);
  border:1px solid var(--rule);border-radius:14px;padding:6px 12px;color:var(--ink2)}
.tc-quick button:hover{border-color:var(--accent);color:var(--accent)}
.tc-quick button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

.tc-typing p{display:none}
.tc-typing{display:flex;gap:4px;align-items:center;background:var(--paper);border:1px solid var(--rule);
  border-radius:12px;border-bottom-left-radius:3px;padding:13px 14px;width:fit-content}
.tc-typing span{width:6px;height:6px;border-radius:50%;background:var(--dim);
  animation:tcDot 1.3s infinite ease-in-out}
.tc-typing span:nth-child(2){animation-delay:.18s}
.tc-typing span:nth-child(3){animation-delay:.36s}
@keyframes tcDot{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}
@media (prefers-reduced-motion:reduce){.tc-typing span{animation:none;opacity:.5}}

.tc-note{border:1px solid var(--amberline);background:var(--amber);border-radius:8px;
  padding:11px 13px;color:#7A5D14}
.tc-note strong{display:block;font-size:12.5px;margin-bottom:3px}
.tc-note p{margin:0;font-size:12px;line-height:1.6;padding:0;background:none;border:0}

.tc-foot{flex:0 0 auto;border-top:1px solid var(--rule);padding:11px 13px;background:var(--paper);
  display:flex;flex-direction:column;gap:8px}
.tc-inputrow{display:flex;gap:8px;align-items:center}
.tc-inputrow input{flex:1;font:inherit;font-size:13.5px;padding:10px 13px;border:1px solid var(--rule);
  border-radius:20px;background:#FAFBFC;color:var(--ink);min-width:0}
.tc-inputrow input:focus{outline:none;border-color:var(--accent);background:var(--paper)}
.tc-send{flex:0 0 auto;width:38px;height:38px;border-radius:50%;border:0;cursor:pointer;
  background:var(--ink);color:#fff;display:flex;align-items:center;justify-content:center}
.tc-send:hover:not(:disabled){background:#000}
.tc-send:disabled{opacity:.3;cursor:not-allowed}
.tc-send:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.tc-human{font:inherit;font-size:12px;cursor:pointer;background:none;border:0;color:var(--accent);
  padding:2px;align-self:center}
.tc-human:hover{text-decoration:underline}
.tc-human:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.tc-closed{font-size:12.5px;color:var(--green);text-align:center;padding:6px 0;font-weight:600}

@media (max-width:480px){
  .tc-panel{right:8px;left:8px;bottom:8px;width:auto;height:calc(100vh - 16px);border-radius:10px}
  .tc-launch{right:14px;bottom:14px}
  .tc-launch-tx{display:none}
  .tc-launch{padding:14px;border-radius:50%}
}
`;
