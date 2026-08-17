import React, { useState, useEffect } from "react";
import { useParams, useSearchParams, Link } from "react-router-dom";
import { useT } from "../lib/locale.jsx";

/* ============================================================
   Privacy policy and the confirmation reply page

   The policy is a real one, not a placeholder. Alberta PIPA
   requires saying what is collected, why, who it goes to and how
   long it is kept — and the third one matters here because tenant
   messages reach an AI provider, which is a disclosure whether or
   not it feels like one.

   The confirmation page has no sign-in. A tenant asked whether a
   time works should be able to answer in one tap; putting an
   account in front of that is how a confirmation rate goes to
   nothing.
   ============================================================ */

const RETENTION = [
  { en: "Enquiries that did not become a tenancy", zh: "未成為租約的詢問", period: { en: "12 months", zh: "12 個月" } },
  { en: "Viewing requests", zh: "看房預約", period: { en: "12 months", zh: "12 個月" } },
  { en: "Applications that were declined or withdrawn", zh: "未通過或撤回的申請", period: { en: "24 months", zh: "24 個月" } },
  { en: "Documents uploaded with an application", zh: "申請時上傳的文件", period: { en: "Removed with the application", zh: "隨申請一併刪除" } },
  { en: "Messages between us", zh: "雙方往來訊息", period: { en: "3 years", zh: "3 年" } },
  { en: "Tenancy records", zh: "租約紀錄", period: { en: "7 years after the tenancy ends", zh: "租約結束後 7 年" } },
  { en: "Accounting records", zh: "會計紀錄", period: { en: "6 years, per CRA", zh: "6 年，依 CRA 規定" } },
];

export function Privacy() {
  const { locale } = useT();
  const zh = locale === "zh";

  return (
    <section className="bt-sec bt-prose">
      <h2>{zh ? "隱私權" : "Privacy"}</h2>
      <p className="bt-dim">
        {zh ? "最後更新：2026 年 8 月" : "Last updated: August 2026"}
      </p>

      <h3>{zh ? "我們收集什麼" : "What we collect"}</h3>
      <p>
        {zh
          ? "你主動提供的：姓名、Email、電話、有興趣的單位、希望入住日、居住人數，以及申請時你選擇上傳的文件。"
          : "What you give us: your name, email, phone, the suites you are interested in, when you would like to move in, how many people will live there, and any documents you choose to upload with an application."}
      </p>
      <p>
        {zh
          ? "如果你成為租客，還包括租約、繳款紀錄、報修內容，以及我們寄給你的通知。"
          : "If you become a tenant: your lease, payment records, repairs you report, and the notices we send you."}
      </p>

      <div className="bt-note">
        <p>
          {zh
            ? "我們不會詢問，也不會考量：你的家庭組成、婚姻狀態、國籍、移民身分、宗教、種族、年齡、性別，或你的收入從哪裡來。這些在 Alberta 都是受保護特徵。"
            : "We do not ask about, and do not take into account, your household composition, marital status, nationality, immigration status, religion, race, age, gender, or where your income comes from. These are protected grounds in Alberta."}
        </p>
        <p>
          {zh
            ? "我們會問總共幾個人住，因為居住人數有法定上限。這是唯一的用途。"
            : "We do ask how many people will live in the suite, because occupancy is subject to a legal limit. That is the only reason."}
        </p>
      </div>

      <h3>{zh ? "為什麼收集" : "Why we collect it"}</h3>
      <p>
        {zh
          ? "為了回覆你的詢問、安排看房、處理申請，以及在你成為租客後管理租約。沒有其他用途。"
          : "To answer your enquiry, arrange a viewing, process an application, and manage the tenancy if you become a tenant. Nothing else."}
      </p>

      {/* Under PIPA this is a disclosure whether or not it feels like one, and
          saying so is not optional. */}
      <h3>{zh ? "誰會看到" : "Who sees it"}</h3>
      <p>
        {zh
          ? "我們的員工，以及下列服務商，各自只在需要的範圍內："
          : "Our staff, and the following service providers, each only as far as they need to:"}
      </p>
      <ul>
        <li>
          <strong>{zh ? "自動化與人工確認" : "Automation and human confirmation"}</strong> — {zh
            ? "公開聊天使用固定問題分類與目前的物業資料回答，不會將訊息送到 AI 服務。系統無法識別的問題，以及涉及收入來源、無障礙需求或其他受保護特徵的訊息，會交由專人確認。"
            : "public chat messages are matched to fixed question categories and current property data and are not sent to an AI provider. Questions the system cannot identify, and messages touching on source of income, accessibility needs or other protected grounds, go to a person for confirmation."}
        </li>
        <li>
          <strong>{zh ? "Email 與簡訊服務商" : "Email and SMS providers"}</strong> — {zh
            ? "為了把通知寄給你。" : "to deliver notices to you."}
        </li>
        <li>
          <strong>{zh ? "雲端儲存" : "Cloud storage"}</strong> — {zh
            ? "存放你上傳的文件與租約檔案。" : "to hold documents you upload and your lease."}
        </li>
      </ul>
      <p className="bt-dim">
        {zh
          ? "這些服務商可能在加拿大境外處理資料。我們不會為了行銷把你的資料賣給或提供給任何人。"
          : "These providers may process data outside Canada. We do not sell your information, and we do not pass it to anyone for marketing."}
      </p>

      <h3>{zh ? "保留多久" : "How long we keep it"}</h3>
      <table className="bt-table">
        <thead><tr>
          <th>{zh ? "資料" : "What"}</th><th>{zh ? "保留期間" : "Kept for"}</th>
        </tr></thead>
        <tbody>
          {RETENTION.map((r) => (
            <tr key={r.en}>
              <td>{zh ? r.zh : r.en}</td>
              <td>{zh ? r.period.zh : r.period.en}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="bt-dim">
        {zh
          ? "這些期限由系統排程執行，不是寫在紙上的政策。過期的資料會被移除或去識別化。"
          : "These periods are enforced by a scheduled job, not just written down. Data past its period is removed or stripped of anything identifying."}
      </p>

      <h3>{zh ? "你的權利" : "Your rights"}</h3>
      <p>
        {zh
          ? "你可以要求看我們持有的關於你的資料，要求更正錯誤，或要求刪除我們沒有法律義務保留的部分。寫信到 rentals@themizar.ca 即可，我們會在 30 天內回覆。"
          : "You can ask to see what we hold about you, ask us to correct anything wrong, or ask us to delete anything we are not legally required to keep. Write to rentals@themizar.ca and we will respond within 30 days."}
      </p>
      <p>
        {zh
          ? "你也可以隨時要求停止接收行銷訊息。租約相關的通知（例如進入單位通知）屬於法定通知，不在此列。"
          : "You can ask us to stop sending you marketing at any time. Notices required by your tenancy, such as a notice of entry, are a legal obligation and are not marketing."}
      </p>
      <p className="bt-dim">
        {zh
          ? "如果你認為我們處理得不對，可以向 Alberta 資訊與隱私專員辦公室提出。"
          : "If you think we have handled something wrongly, you can raise it with the Office of the Information and Privacy Commissioner of Alberta."}
      </p>

      <Link to="/" className="bt-btn bt-btn--ghost" style={{ marginTop: 24 }}>
        {zh ? "回首頁" : "Back to home"}
      </Link>
    </section>
  );
}

/* ============================================================
   Confirmation reply

   One tap, no sign-in. The token identifies one question and is
   useless for anything else.
   ============================================================ */

export function ConfirmReply() {
  const { locale } = useT();
  const [params] = useSearchParams();
  const token = params.get("token");
  const [state, setState] = useState("loading");
  const [question, setQuestion] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const zh = locale === "zh";

  useEffect(() => {
    if (!token) { setState("missing"); return; }
    (async () => {
      try {
        const res = await fetch(`/api/public/confirm/${token}`);
        if (!res.ok) { setState("notfound"); return; }
        const d = await res.json();
        setQuestion(d.question ?? "");
        setState(d.state === "sent" ? "asking" : d.state);
      } catch { setState("error"); }
    })();
  }, [token]);

  const respond = async (response) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/public/confirm/${token}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response, note: note.trim() || null }),
      });
      setState(res.ok ? response : "error");
    } catch { setState("error"); }
    setBusy(false);
  };

  const wrap = (children) => (
    <section className="bt-sec"><div className="bt-form">{children}</div></section>
  );

  if (state === "loading") return wrap(<p>{zh ? "讀取中…" : "Loading…"}</p>);
  if (state === "missing" || state === "notfound")
    return wrap(<>
      <h2>{zh ? "找不到這個連結" : "This link is not valid"}</h2>
      <p className="bt-body">
        {zh ? "連結可能已經用過了。有問題的話直接回覆我們的信就可以。"
            : "It may already have been used. Reply to our message if you need anything."}
      </p>
    </>);
  if (state === "expired")
    return wrap(<>
      <h2>{zh ? "這個連結已過期" : "This link has expired"}</h2>
      <p className="bt-body">
        {zh ? "回覆我們的信，我們再幫你安排。" : "Reply to our message and we will sort it out."}
      </p>
    </>);
  if (state === "confirmed")
    return wrap(<>
      <h2>{zh ? "已確認" : "Confirmed"}</h2>
      <div className="bt-ok">
        {zh ? "謝謝，時間已經記下了。" : "Thank you — we have it in the diary."}
      </div>
    </>);
  if (state === "declined")
    return wrap(<>
      <h2>{zh ? "已收到" : "Thank you"}</h2>
      <div className="bt-ok">
        {zh ? "我們會另外找時間跟你聯絡。" : "We will be in touch with another time."}
      </div>
    </>);
  if (state === "error")
    return wrap(<>
      <h2>{zh ? "出了點問題" : "Something went wrong"}</h2>
      <p className="bt-body">
        {zh ? "請直接回覆我們的信。" : "Please reply to our message instead."}
      </p>
    </>);

  return wrap(<>
    <h2>{zh ? "確認時間" : "Confirm the time"}</h2>
    <p className="bt-body">{question}</p>

    <div className="bt-f">
      <label>{zh ? "想補充什麼嗎？（選填）" : "Anything to add? (optional)"}</label>
      <textarea className="bt-ta" rows={2} value={note}
                onChange={(e) => setNote(e.target.value)} />
    </div>

    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <button className="bt-btn" disabled={busy} onClick={() => respond("confirmed")}>
        {zh ? "這個時間可以" : "That time works"}
      </button>
      <button className="bt-btn bt-btn--ghost" disabled={busy}
              onClick={() => respond("declined")}>
        {zh ? "需要改時間" : "I need another time"}
      </button>
    </div>

    <p className="bt-hint" style={{ marginTop: 14 }}>
      {zh
        ? "說不方便完全沒問題，我們再約就是了。比起我們白跑一趟，你先講反而省事。"
        : "Saying no is fine — we will find another time. It saves us both a wasted trip."}
    </p>
  </>);
}

export default Privacy;
