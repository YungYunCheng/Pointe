import React, { useState, useEffect, useRef, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { useT } from "../lib/locale.jsx";

/* ============================================================
   Signing

   Read the document, agree to sign electronically, make the mark,
   submit. Four steps, no account.

   Two things here are not decoration.

   Consent is a separate, recorded step. Alberta's Electronic
   Transactions Act asks whether the party agreed to sign
   electronically, and "they clicked sign, so they must have" is not
   an answer to that.

   The document opens before the signature panel does. A signing
   flow that puts the pen in front of the page is one where somebody
   signs without reading, and that is the first thing raised when a
   lease is disputed.
   ============================================================ */

const money = (n) => (n == null ? null
  : new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(n));

export default function Sign() {
  const { token } = useParams();
  const { locale, setLocale } = useT();
  const [data, setData] = useState(null);
  const [state, setState] = useState("loading");
  const [step, setStep] = useState("read");
  const [opened, setOpened] = useState(false);
  const [consent, setConsent] = useState(false);
  const [mark, setMark] = useState(null);
  const [markKind, setMarkKind] = useState("drawn");
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [declining, setDeclining] = useState(false);
  const [declineReason, setDeclineReason] = useState("");

  const zh = locale === "zh";

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/public/sign/${token}`);
        if (res.status === 410) { const d = await res.json(); setState(d.code.toLowerCase()); return; }
        if (!res.ok) { setState("notfound"); return; }
        const d = await res.json();
        setData(d);
        // The tenant's language, not ours.
        if (d.locale && d.locale !== locale) setLocale(d.locale);
        setConsent(d.party.consented);
        if (d.party.signed) setState("done");
        else if (!d.your_turn) setState("waiting");
        else setState("ready");
        // Prefill dates, because asking somebody to type today's date is
        // friction with nothing behind it.
        const today = new Date().toISOString().slice(0, 10);
        setValues(Object.fromEntries(d.fields.filter((f) => f.kind === "date")
          .map((f) => [f.id, f.value || today])));
      } catch { setState("error"); }
    })();
  }, [token]);

  const openDocument = () => {
    window.open(`/api/public/sign/${token}/document`, "_blank", "noopener");
    setOpened(true);
  };

  const giveConsent = async () => {
    setBusy(true); setErr("");
    try {
      const res = await fetch(`/api/public/sign/${token}/consent`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agreed: true }),
      });
      if (res.ok) { setConsent(true); setStep("sign"); }
      else setErr(zh ? "出了點問題，請再試一次。" : "Something went wrong. Try again.");
    } catch { setErr(zh ? "連線失敗。" : "Could not reach us."); }
    setBusy(false);
  };

  const submit = async () => {
    if (!mark) { setErr(zh ? "請先簽名。" : "Add your signature first."); return; }
    setBusy(true); setErr("");
    try {
      const res = await fetch(`/api/public/sign/${token}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signature: mark, signature_kind: markKind,
          fields: Object.entries(values).map(([id, value]) => ({ id, value })) }),
      });
      const d = await res.json();
      if (!res.ok) {
        setErr(d.code === "FIELDS_INCOMPLETE"
          ? (zh ? `還有欄位沒填：${(d.fields ?? []).join("、")}`
                : `Still to fill in: ${(d.fields ?? []).join(", ")}`)
          : (zh ? "送出失敗，請再試一次。" : "That did not go through. Try again."));
        setBusy(false); return;
      }
      setState(d.completed ? "completed" : "done");
    } catch { setErr(zh ? "連線失敗。" : "Could not reach us."); }
    setBusy(false);
  };

  const decline = async () => {
    setBusy(true);
    try {
      await fetch(`/api/public/sign/${token}/decline`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: declineReason.trim() }),
      });
      setState("declined");
    } catch { setErr(zh ? "連線失敗。" : "Could not reach us."); }
    setBusy(false);
  };

  const wrap = (children) => (
    <section className="bt-sec"><div className="bt-form">{children}</div></section>
  );

  if (state === "loading") return wrap(<p>{zh ? "讀取中…" : "Loading…"}</p>);

  if (state === "notfound" || state === "error") return wrap(<>
    <h2>{zh ? "找不到這份文件" : "This link is not valid"}</h2>
    <p className="bt-body">
      {zh ? "連結可能已經用過或失效了。回覆我們的信，我們再寄一次給你。"
          : "The link may have been used already, or expired. Reply to our message and we will send another."}
    </p>
  </>);

  if (state === "expired") return wrap(<>
    <h2>{zh ? "連結已過期" : "This link has expired"}</h2>
    <p className="bt-body">
      {zh ? "回覆我們的信，我們會重新寄一份給你簽。"
          : "Reply to our message and we will send a fresh one."}
    </p>
  </>);

  if (state === "voided" || state === "declined_state") return wrap(<>
    <h2>{zh ? "這份文件已作廢" : "This document has been withdrawn"}</h2>
    <p className="bt-body">{zh ? "有問題請直接聯絡我們。" : "Contact us if you were expecting to sign it."}</p>
  </>);

  if (state === "declined") return wrap(<>
    <h2>{zh ? "已收到" : "Thank you"}</h2>
    <div className="bt-ok">
      {zh ? "我們知道了，同事會盡快跟你聯絡討論。"
          : "We have your note. Someone will be in touch to talk it through."}
    </div>
    <p className="bt-hint" style={{ marginTop: 12 }}>
      {zh ? "沒有簽名不代表事情就這樣結束，通常只是有一項需要先講清楚。"
          : "Not signing is not the end of it. Usually it means one term needs discussing first."}
    </p>
  </>);

  if (state === "waiting") return wrap(<>
    <h2>{zh ? "還沒輪到你" : "Not your turn yet"}</h2>
    <p className="bt-body">
      {zh ? `目前在等 ${(data?.waiting_on ?? []).join("、")} 先簽。輪到你的時候我們會再寄信給你。`
          : `We are waiting on ${(data?.waiting_on ?? []).join(", ")}. You will get an email when it is your turn.`}
    </p>
  </>);

  if (state === "done") return wrap(<>
    <h2>{zh ? "已收到你的簽名" : "Your signature is in"}</h2>
    <div className="bt-ok">
      {zh ? "還在等其他人簽署。全部完成後，我們會把完整的簽署版本寄給你。"
          : "We are waiting on the other parties. When everyone has signed, the complete signed copy comes to you by email."}
    </div>
  </>);

  if (state === "completed") return wrap(<>
    <h2>{zh ? "簽署完成" : "All signed"}</h2>
    <div className="bt-ok">
      {zh ? "完整的簽署版本已經寄到你的信箱，附有完成證明書。"
          : "The complete signed copy is on its way to your inbox, with its certificate of completion."}
    </div>
    <p className="bt-hint" style={{ marginTop: 12 }}>
      {zh ? "證明書記載了每一位簽署人、時間，以及文件的雜湊值。請和你的副本一起留存。"
          : "The certificate records who signed, when, and the hash of the document. Keep it with your copy."}
    </p>
    <a className="bt-btn" style={{ marginTop: 18 }}
       href={`/api/public/signed/${data?.reference}`}>
      {zh ? "下載簽署版本" : "Download the signed copy"}
    </a>
  </>);

  const p = data.particulars ?? {};
  const sigFields = data.fields.filter((f) => ["signature", "initials"].includes(f.kind));
  const inputFields = data.fields.filter((f) => !["signature", "initials"].includes(f.kind));

  return (
    <section className="bt-sec">
      <div className="bt-form bt-sign">
        <div className="bt-signhead">
          <div>
            <h2>{zh ? data.agreement.name_zh : data.agreement.name}</h2>
            <span className="bt-dim">
              {data.unit_number ? `${data.unit_number} · ` : ""}{data.reference}
            </span>
          </div>
          <span className="bt-signfor">{data.party.name}</span>
        </div>

        {/* Steps, so it is obvious there are four and not forty. */}
        <ol className="bt-steps2">
          {[["read", zh ? "閱讀文件" : "Read it"],
            ["consent", zh ? "同意電子簽署" : "Agree to sign electronically"],
            ["sign", zh ? "簽名" : "Sign"]].map(([k, label], i) => {
            const done = (k === "read" && opened) || (k === "consent" && consent)
              || (k === "sign" && mark);
            const active = step === k;
            return (
              <li key={k} className={`${done ? "done" : ""} ${active ? "on" : ""}`}>
                <span>{done ? "✓" : i + 1}</span>{label}
              </li>
            );
          })}
        </ol>

        {/* What they were told, alongside the document rather than inside it.
            The file is the version counsel approved and nothing writes into it. */}
        {(p.rent || p.deposit || p.start_date) && (
          <div className="bt-particulars">
            <div className="bt-particulars-h">{zh ? "你被告知的條件" : "What you were told"}</div>
            <div className="bt-particulars-g">
              {p.rent && <div><em>{zh ? "月租" : "Rent"}</em><strong>{money(p.rent)}</strong></div>}
              {p.deposit && <div><em>{zh ? "保證金" : "Deposit"}</em><strong>{money(p.deposit)}</strong></div>}
              {p.start_date && <div><em>{zh ? "起租日" : "Starts"}</em><strong>{p.start_date}</strong></div>}
            </div>
            <p className="bt-hint">
              {zh ? "如果文件裡的數字和這裡不一樣，先問清楚再簽。"
                  : "If the document says something different from this, ask before you sign, not after."}
            </p>
          </div>
        )}

        {data.message && <div className="bt-note"><p>{data.message}</p></div>}

        {/* Reading comes first, deliberately. A flow that puts the pen in front
            of the page is one where somebody signs without reading. */}
        <div className={`bt-signcard ${step === "read" ? "on" : ""}`}>
          <div className="bt-signcard-h">
            <strong>1 · {zh ? "閱讀文件" : "Read the document"}</strong>
            {opened && <span className="bt-tick">✓</span>}
          </div>
          <p className="bt-dim">
            {zh ? "請完整讀過。有任何不清楚的地方，簽之前先問。"
                : "Read it in full. If anything is unclear, ask before signing rather than after."}
          </p>
          <button className="bt-btn bt-btn--ghost" onClick={openDocument}>
            {zh ? "開啟文件" : "Open the document"}
          </button>
          {opened && step === "read" && (
            <button className="bt-btn" style={{ marginTop: 8 }} onClick={() => setStep("consent")}>
              {zh ? "讀完了，繼續" : "I have read it — continue"}
            </button>
          )}
        </div>

        {(step === "consent" || consent) && (
          <div className={`bt-signcard ${step === "consent" ? "on" : ""}`}>
            <div className="bt-signcard-h">
              <strong>2 · {zh ? "同意電子簽署" : "Agree to sign electronically"}</strong>
              {consent && <span className="bt-tick">✓</span>}
            </div>
            {consent ? (
              <p className="bt-dim">
                {zh ? "已記錄你的同意。" : "Your consent has been recorded."}
              </p>
            ) : (
              <>
                <p className="bt-dim">
                  {zh ? "在 Alberta，電子簽名要有效，雙方必須先同意用電子方式簽署。你隨時可以改要求紙本，我們照辦。"
                      : "In Alberta, an electronic signature is only valid if both parties agreed to sign that way. You can ask for paper instead at any point and we will arrange it."}
                </p>
                <label className="bt-check">
                  <input type="checkbox" onChange={(e) => e.target.checked && giveConsent()} />
                  <span>
                    {zh ? "我同意以電子方式簽署這份文件，並確認我已閱讀其內容。"
                        : "I agree to sign this document electronically, and confirm I have read it."}
                  </span>
                </label>
              </>
            )}
          </div>
        )}

        {consent && (
          <div className={`bt-signcard ${step === "sign" || consent ? "on" : ""}`}>
            <div className="bt-signcard-h">
              <strong>3 · {zh ? "簽名" : "Sign"}</strong>
              {mark && <span className="bt-tick">✓</span>}
            </div>

            {inputFields.length > 0 && (
              <div className="bt-fields">
                {inputFields.map((f) => (
                  <label className="bt-f" key={f.id}>
                    <span>{f.label || (f.kind === "date" ? (zh ? "日期" : "Date") : f.kind)}</span>
                    {f.kind === "checkbox" ? (
                      <input type="checkbox"
                             checked={values[f.id] === "true"}
                             onChange={(e) => setValues({ ...values,
                               [f.id]: String(e.target.checked) })} />
                    ) : (
                      <input className="bt-in" type={f.kind === "date" ? "date" : "text"}
                             value={values[f.id] ?? ""}
                             onChange={(e) => setValues({ ...values, [f.id]: e.target.value })} />
                    )}
                  </label>
                ))}
              </div>
            )}

            <SignaturePad name={data.party.name} zh={zh}
                          onChange={(img, kind) => { setMark(img); setMarkKind(kind); }} />

            {sigFields.length > 1 && (
              <p className="bt-hint">
                {zh ? `這份文件有 ${sigFields.length} 處需要你的簽名，會用同一個簽名填入。`
                    : `This document needs your signature in ${sigFields.length} places. The same mark is used for each.`}
              </p>
            )}

            {err && <div className="bt-err">{err}</div>}

            <button className="bt-btn" disabled={!mark || busy} onClick={submit}
                    style={{ marginTop: 10 }}>
              {busy ? (zh ? "送出中…" : "Signing…") : (zh ? "確認簽署" : "Sign the document")}
            </button>

            <p className="bt-hint">
              {zh ? "按下之後，你的簽名會加到文件上，並記錄時間與來源位址。"
                  : "When you press this, your signature is added to the document, and the time and address are recorded."}
            </p>
          </div>
        )}

        {/* Declining is offered plainly. Hiding it is how somebody signs
            something they did not want to sign. */}
        <div className="bt-declinerow">
          {declining ? (
            <div className="bt-declinebox">
              <p className="bt-dim">
                {zh ? "不簽也沒關係。方便的話告訴我們原因，我們好處理。"
                    : "Not signing is fine. Tell us why if you can, so we can sort it out."}
              </p>
              <input className="bt-in" value={declineReason}
                     placeholder={zh ? "例如：起租日需要調整" : "e.g. the start date needs to change"}
                     onChange={(e) => setDeclineReason(e.target.value)} />
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button className="bt-btn bt-btn--ghost" disabled={busy} onClick={decline}>
                  {zh ? "送出" : "Send"}
                </button>
                <button className="bt-btn bt-btn--ghost" onClick={() => setDeclining(false)}>
                  {zh ? "取消" : "Cancel"}
                </button>
              </div>
            </div>
          ) : (
            <button className="bt-linkbtn" onClick={() => setDeclining(true)}>
              {zh ? "我還不想簽" : "I am not ready to sign"}
            </button>
          )}
        </div>

        <p className="bt-hint bt-hash">
          {zh ? "文件雜湊值" : "Document hash"}: <code>{data.source_sha256?.slice(0, 32)}…</code>
          <br />
          {zh ? "你下載的檔案如果和這個值不符，那就不是我們寄給你的那一份。"
              : "If a copy you download does not match this, it is not the file we sent you."}
        </p>
      </div>

      <style>{SIGN_CSS}</style>
    </section>
  );
}

/* ---------- The pad ---------- */

/** Drawn, typed, or neither. Drawn is the more defensible: a typed name proves
 *  somebody had the link, a drawn mark is at least characteristic. Both are
 *  recorded for what they are. */
function SignaturePad({ name, zh, onChange }) {
  const [mode, setMode] = useState("drawn");
  const [typed, setTyped] = useState(name ?? "");
  const [hasInk, setHasInk] = useState(false);
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const last = useRef(null);

  const setup = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = c.getBoundingClientRect();
    c.width = rect.width * dpr;
    c.height = rect.height * dpr;
    const ctx = c.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0d1620";
  }, []);

  useEffect(() => { if (mode === "drawn") setup(); }, [mode, setup]);

  const pos = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const t = e.touches?.[0] ?? e;
    return { x: t.clientX - rect.left, y: t.clientY - rect.top };
  };

  const start = (e) => { e.preventDefault(); drawing.current = true; last.current = pos(e); };
  const move = (e) => {
    if (!drawing.current) return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext("2d");
    const p = pos(e);
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
    if (!hasInk) setHasInk(true);
  };
  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    onChange(canvasRef.current.toDataURL("image/png"), "drawn");
  };

  const clear = () => {
    const c = canvasRef.current;
    c.getContext("2d").clearRect(0, 0, c.width, c.height);
    setHasInk(false);
    onChange(null, "drawn");
  };

  return (
    <div className="bt-pad">
      <div className="bt-padtabs">
        <button className={mode === "drawn" ? "on" : ""}
                onClick={() => { setMode("drawn"); onChange(null, "drawn"); setHasInk(false); }}>
          {zh ? "手寫" : "Draw"}
        </button>
        <button className={mode === "typed" ? "on" : ""}
                onClick={() => { setMode("typed"); onChange(typed, "typed"); }}>
          {zh ? "打字" : "Type"}
        </button>
      </div>

      {mode === "drawn" ? (
        <>
          <canvas ref={canvasRef} className="bt-canvas"
                  onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
                  onTouchStart={start} onTouchMove={move} onTouchEnd={end} />
          <div className="bt-padfoot">
            <span className="bt-dim">
              {hasInk ? (zh ? "看起來不錯就可以了" : "That will do")
                      : (zh ? "在上面簽名" : "Sign above")}
            </span>
            {hasInk && (
              <button className="bt-linkbtn" onClick={clear}>{zh ? "重簽" : "Clear"}</button>
            )}
          </div>
        </>
      ) : (
        <>
          <input className="bt-in bt-typed" value={typed}
                 onChange={(e) => { setTyped(e.target.value); onChange(e.target.value, "typed"); }} />
          <p className="bt-hint">
            {zh ? "打字的簽名一樣有效，不過手寫的在爭議時比較站得住腳。"
                : "A typed name is valid, but a drawn mark stands up better if it is ever questioned."}
          </p>
        </>
      )}
    </div>
  );
}

const SIGN_CSS = `
.bt-sign{max-width:640px}
.bt-signhead{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;
  flex-wrap:wrap;padding-bottom:14px;border-bottom:1px solid var(--rule)}
.bt-signhead h2{margin:0}
.bt-signfor{font-size:12.5px;font-weight:600;background:var(--tint);border-radius:12px;
  padding:4px 12px;color:var(--ink2)}
.bt-steps2{list-style:none;display:flex;gap:6px;flex-wrap:wrap;padding:0;margin:16px 0}
.bt-steps2 li{display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--dim);
  border:1px solid var(--rule);border-radius:18px;padding:5px 13px 5px 6px}
.bt-steps2 li span{width:19px;height:19px;border-radius:50%;background:var(--ground);
  display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700}
.bt-steps2 li.done{border-color:var(--green);color:var(--green)}
.bt-steps2 li.done span{background:var(--green);color:#fff}
.bt-steps2 li.on{border-color:var(--ink);color:var(--ink)}

.bt-particulars{border:1px solid var(--rule);border-radius:8px;padding:14px 16px;margin-bottom:14px}
.bt-particulars-h{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim);
  font-family:'IBM Plex Mono',monospace;margin-bottom:9px}
.bt-particulars-g{display:flex;gap:26px;flex-wrap:wrap;margin-bottom:8px}
.bt-particulars-g>div{display:flex;flex-direction:column;gap:2px}
.bt-particulars-g em{font-style:normal;font-size:11px;color:var(--dim)}
.bt-particulars-g strong{font-family:'IBM Plex Mono',monospace;font-size:17px}

.bt-signcard{border:1px solid var(--rule);border-radius:8px;padding:16px 18px;margin-bottom:12px;
  display:flex;flex-direction:column;gap:9px;opacity:.55}
.bt-signcard.on{opacity:1;border-color:var(--ink)}
.bt-signcard-h{display:flex;justify-content:space-between;align-items:center}
.bt-signcard-h strong{font-size:14px}
.bt-tick{color:var(--green);font-weight:700}
.bt-fields{display:flex;flex-direction:column;gap:10px}

.bt-pad{border:1px solid var(--rule);border-radius:8px;overflow:hidden}
.bt-padtabs{display:flex;border-bottom:1px solid var(--rule)}
.bt-padtabs button{flex:1;font:inherit;font-size:13px;font-weight:600;cursor:pointer;
  background:var(--tint);border:0;padding:9px;color:var(--dim)}
.bt-padtabs button.on{background:#fff;color:var(--ink)}
.bt-canvas{display:block;width:100%;height:170px;background:#fff;touch-action:none;cursor:crosshair}
.bt-padfoot{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;
  border-top:1px dashed var(--rule);background:#FCFDFE}
.bt-typed{font-family:'Georgia',serif;font-style:italic;font-size:26px;text-align:center;
  border:0;border-radius:0;padding:24px 12px}
.bt-typed:focus{outline:none;box-shadow:none}

.bt-declinerow{margin-top:16px;padding-top:14px;border-top:1px solid var(--rule)}
.bt-declinebox{display:flex;flex-direction:column;gap:6px}
.bt-linkbtn{font:inherit;font-size:13px;background:none;border:0;color:var(--accent);
  cursor:pointer;padding:2px 0}
.bt-linkbtn:hover{text-decoration:underline}
.bt-hash{margin-top:18px;padding-top:12px;border-top:1px solid var(--rule);
  font-size:11.5px;line-height:1.7}
.bt-hash code{font-family:'IBM Plex Mono',monospace;font-size:10.5px;word-break:break-all}
`;
