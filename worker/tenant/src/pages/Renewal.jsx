import React, { useState, useEffect } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useT } from "../lib/locale.jsx";

/* ============================================================
   Answering a renewal offer

   No sign-in. The link identifies one offer and is useless for
   anything else — putting an account in front of "do you want to
   stay" is how a response rate goes to nothing.

   Declining is offered plainly rather than hidden, and there is a
   box to say why. What somebody writes there is the most useful
   thing in this whole flow: it is the only place the reason a
   tenancy ended is recorded by the person who ended it, and it is
   usually something that could have been fixed.
   ============================================================ */

const money = (n) => (n == null ? "—"
  : new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" })
      .format(Number(n)));

export default function Renewal() {
  const { locale, setLocale } = useT();
  const [params] = useSearchParams();
  const token = params.get("token");
  const [offer, setOffer] = useState(null);
  const [state, setState] = useState("loading");
  const [choice, setChoice] = useState(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const zh = locale === "zh";

  useEffect(() => {
    if (!token) { setState("notfound"); return; }
    (async () => {
      try {
        const res = await fetch(`/api/public/renewal/${token}`);
        const d = await res.json();
        if (!res.ok) { setState(d.code.toLowerCase()); return; }
        setOffer(d);
        if (d.locale && d.locale !== locale) setLocale(d.locale);
        setState(d.responded_at ? "answered" : "ready");
      } catch { setState("error"); }
    })();
  }, [token]);

  const submit = async (response) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/public/renewal/${token}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response, note: note.trim() || null }),
      });
      const d = await res.json();
      if (!res.ok) { setState(d.code.toLowerCase()); setBusy(false); return; }
      setResult(d);
      setState("done");
    } catch { setState("error"); }
    setBusy(false);
  };

  const wrap = (children) => (
    <section className="bt-sec"><div className="bt-form">{children}</div></section>
  );

  if (state === "loading") return wrap(<p>{zh ? "讀取中…" : "Loading…"}</p>);

  if (state === "notfound" || state === "error") return wrap(<>
    <h2>{zh ? "找不到這個連結" : "This link is not valid"}</h2>
    <p className="bt-body">
      {zh ? "可能是被信箱截斷了。試著整段複製貼上，或直接回覆我們的信。"
          : "It may have been cut short by your email client. Try copying the whole link, or just reply to our message."}
    </p>
  </>);

  if (state === "expired") return wrap(<>
    <h2>{zh ? "這份提議已過期" : "This offer has expired"}</h2>
    <p className="bt-body">
      {zh ? "回覆我們的信，我們會重新寄一份給你。租約到期日還在，時間仍然來得及談。"
          : "Reply to our message and we will send a fresh one. Your lease end date has not moved, so there is still time to talk."}
    </p>
  </>);

  if (state === "withdrawn") return wrap(<>
    <h2>{zh ? "這份提議已收回" : "This offer has been withdrawn"}</h2>
    <p className="bt-body">{zh ? "請直接聯絡我們。" : "Please get in touch with us."}</p>
  </>);

  if (state === "answered") return wrap(<>
    <h2>{zh ? "已經回覆過了" : "You have already answered"}</h2>
    <p className="bt-body">
      {zh ? "如果想改變決定，直接回覆我們的信就可以。"
          : "If you want to change your answer, just reply to our message."}
    </p>
  </>);

  if (state === "done") return wrap(<>
    <h2>{
      result?.state === "declined" ? (zh ? "收到了" : "Thank you for letting us know")
      : result?.state === "viewed" ? (zh ? "收到了" : "Thank you")
      : (zh ? "太好了" : "That is good news")
    }</h2>
    <div className="bt-ok">{
      result?.state === "signing"
        ? (zh ? "我們會盡快把續約文件寄給你簽署。"
              : "We will send the agreement to sign shortly.")
      : result?.state === "completed"
        ? (zh ? "續約已經完成，不用再做什麼了。"
              : "That is settled. Nothing else for you to do.")
      : result?.state === "declined"
        ? (zh ? "謝謝你告訴我們。我們會另外聯絡你安排遷出的事。"
              : "We will be in touch about the move-out.")
        : (zh ? "同事會盡快跟你聯絡討論。"
              : "Somebody will be in touch to talk it through.")
    }</div>

    {result?.state === "declined" && (
      <p className="bt-hint" style={{ marginTop: 14 }}>
        {zh
          ? "如果改變主意，在到期日之前都可以跟我們說。這件事沒有那麼不可逆。"
          : "If you change your mind before the end date, tell us. This is less final than it sounds."}
      </p>
    )}
  </>);

  const notRenewing = offer.outcome === "not_renewing";
  const change = offer.change ?? 0;

  if (notRenewing) return wrap(<>
    <h2>{zh ? "租約到期通知" : "Your lease is ending"}</h2>
    <p className="bt-body">
      {zh ? `${offer.unit_number} 的租約於 ${offer.current_ends} 到期，這次不會續約。`
          : `Your lease for ${offer.unit_number} ends on ${offer.current_ends} and will not be renewed.`}
    </p>
    {offer.message && <div className="bt-note"><p>{offer.message}</p></div>}
    <p className="bt-body">
      {zh ? "我們會另外聯絡你安排遷出檢查與押金退還。有問題直接回覆我們的信。"
          : "We will be in touch about the move-out inspection and the return of your deposit. Reply to our message with any question."}
    </p>
  </>);

  return (
    <section className="bt-sec">
      <div className="bt-form bt-renew">
        <div className="bt-renewhead">
          <div>
            <h2>{zh ? "續約" : "Your renewal"}</h2>
            <span className="bt-dim">{offer.unit_number} · {offer.tenant_name}</span>
          </div>
        </div>

        {/* The terms, laid out so the number that changed is the one you see.
            An offer that buries the rent in a paragraph is an offer somebody
            answers without having read it. */}
        <div className="bt-terms">
          <div className="bt-term">
            <em>{zh ? "目前月租" : "You pay now"}</em>
            <strong>{money(offer.current_rent)}</strong>
          </div>
          <div className="bt-term bt-term--new">
            <em>{zh ? "續約後" : "From " + offer.starts_on}</em>
            <strong>{money(offer.offered_rent)}</strong>
            {change !== 0 && (
              <span className={change > 0 ? "bt-up" : "bt-down"}>
                {change > 0 ? "+" : ""}{money(change)}
                {" "}({((change / offer.current_rent) * 100).toFixed(1)}%)
              </span>
            )}
            {change === 0 && (
              <span className="bt-same">{zh ? "不變" : "no change"}</span>
            )}
          </div>
          <div className="bt-term">
            <em>{zh ? "方式" : "Term"}</em>
            <strong>
              {offer.outcome === "month_to_month"
                ? (zh ? "按月計租" : "Month to month")
                : (zh ? `${offer.term_months} 個月` : `${offer.term_months} months`)}
            </strong>
            {offer.ends_on && (
              <span className="bt-dim">{zh ? "至 " : "to "}{offer.ends_on}</span>
            )}
          </div>
        </div>

        {offer.outcome === "month_to_month" && (
          <p className="bt-hint">
            {zh
              ? "按月計租的意思是租約不再有固定到期日，雙方任何一方要結束時，依法定通知期提前告知即可。"
              : "Month to month means there is no fixed end date. Either of us can end it later by giving the notice the law requires."}
          </p>
        )}

        {offer.message && <div className="bt-note"><p>{offer.message}</p></div>}

        <div className="bt-choices">
          {[["accept", zh ? "好，我要續約" : "Yes, I would like to stay"],
            ["discuss", zh ? "我想先談一下" : "I would like to talk about it"],
            ["decline", zh ? "我不會續約" : "No, I will be moving out"]].map(([k, label]) => (
            <button key={k} className={`bt-choice ${choice === k ? "on" : ""}`}
                    onClick={() => setChoice(k)}>
              {label}
            </button>
          ))}
        </div>

        {choice && (
          <>
            <label className="bt-f">
              <span>
                {choice === "decline"
                  ? (zh ? "方便說一下原因嗎？" : "Would you tell us why?")
                  : choice === "discuss"
                  ? (zh ? "想談什麼？" : "What would you like to discuss?")
                  : (zh ? "有什麼要補充的嗎？（選填）" : "Anything to add? (optional)")}
              </span>
              <textarea className="bt-ta" rows={3} value={note}
                        onChange={(e) => setNote(e.target.value)} />
              {choice === "decline" && (
                <em className="bt-hint">
                  {zh
                    ? "不填也可以。但如果是價格、維修或某件我們能處理的事，說出來通常還有得談。"
                    : "You do not have to. But if it is the price, a repair, or something we could put right, saying so usually means it is still worth a conversation."}
                </em>
              )}
            </label>

            {choice === "accept" && offer.requires_signature && (
              <div className="bt-note">
                <p>
                  {zh
                    ? "按下確認之後，我們會把續約文件寄給你簽署。要等雙方都簽好才算完成。"
                    : "After this we will send you the agreement to sign. It is settled once both sides have signed."}
                </p>
              </div>
            )}
            {choice === "accept" && !offer.requires_signature && (
              <div className="bt-note">
                <p>
                  {zh
                    ? "按下確認就完成了，不需要另外簽文件——租約會依現有條款繼續。"
                    : "Confirming is all it takes. Nothing new to sign: your tenancy continues under the existing agreement."}
                </p>
              </div>
            )}

            <button className="bt-btn" disabled={busy}
                    onClick={() => submit(choice)}>
              {busy ? (zh ? "送出中…" : "Sending…")
                : choice === "accept" ? (zh ? "確認續約" : "Confirm")
                : choice === "decline" ? (zh ? "送出" : "Send")
                : (zh ? "送出" : "Send")}
            </button>
          </>
        )}

        <p className="bt-hint bt-renewfoot">
          {zh
            ? `這份提議在 ${String(offer.expires_at).slice(0, 10)} 之前有效。想直接談的話，回覆我們的信就可以。`
            : `This offer holds until ${String(offer.expires_at).slice(0, 10)}. If you would rather talk it through, just reply to our message.`}
        </p>
      </div>

      <style>{CSS}</style>
    </section>
  );
}

const CSS = `
.bt-renew{max-width:560px}
.bt-renewhead{padding-bottom:12px;border-bottom:1px solid var(--rule)}
.bt-renewhead h2{margin:0}
.bt-terms{display:flex;gap:1px;background:var(--rule);border:1px solid var(--rule);
  border-radius:6px;overflow:hidden}
.bt-term{flex:1;background:#fff;padding:13px 15px;display:flex;flex-direction:column;gap:3px}
.bt-term--new{background:var(--tint)}
.bt-term em{font-style:normal;font-size:10.5px;color:var(--dim);
  text-transform:uppercase;letter-spacing:.05em}
.bt-term strong{font-family:'IBM Plex Mono',monospace;font-size:20px}
.bt-term span{font-size:11.5px}
.bt-up{color:#B23A54;font-weight:600}
.bt-down{color:#0E8577;font-weight:600}
.bt-same{color:var(--dim)}
.bt-choices{display:flex;flex-direction:column;gap:8px}
.bt-choice{font:inherit;font-size:14px;text-align:left;cursor:pointer;background:#fff;
  border:1.5px solid var(--rule);border-radius:6px;padding:13px 16px;color:var(--ink2)}
.bt-choice:hover{border-color:var(--dim)}
.bt-choice.on{border-color:var(--accent);background:var(--tint);font-weight:600;
  color:var(--ink)}
.bt-renewfoot{margin-top:8px;padding-top:12px;border-top:1px solid var(--rule)}
`;
