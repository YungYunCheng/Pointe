import React, { useState, useEffect } from "react";
import { useSearchParams, Link, useNavigate } from "react-router-dom";
import { useT } from "../lib/locale.jsx";
import { nextFrom } from "../lib/auth.jsx";

/* ============================================================
   Setting up portal access

   Two screens. Ask for the suite and email; then, from the link
   in the email, choose a password.

   The first screen gives the same answer whether or not anything
   matched. That is not politeness — a different answer for "no
   such suite" and "that is not the email we have" turns this into
   a way of finding out who lives where, one guess at a time.
   ============================================================ */

const MIN_LENGTH = 12;

export function Claim() {
  const { locale } = useT();
  const [params] = useSearchParams();
  const token = params.get("token");
  const zh = locale === "zh";

  return token ? <SetPassword token={token} zh={zh} /> : <AskForLink zh={zh} />;
}

/* ---------- Step one ---------- */

function AskForLink({ zh }) {
  const [email, setEmail] = useState("");
  const [unit, setUnit] = useState("");
  const [state, setState] = useState("form");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!email.trim() || !unit.trim()) return;
    setBusy(true);
    try {
      await fetch("/api/public/tenant/claim", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), unit_number: unit.trim() }),
      });
      // Always the same outcome on this screen. The server answers identically
      // either way, and showing anything else here would give away what the
      // server deliberately does not.
      setState("sent");
    } catch {
      setState("error");
    }
    setBusy(false);
  };

  if (state === "sent") return (
    <section className="bt-sec"><div className="bt-form">
      <h2>{zh ? "信寄出去了" : "Check your email"}</h2>
      <div className="bt-ok">
        {zh
          ? "如果這個單位和 Email 對得上我們的紀錄，設定連結已經寄出。連結 48 小時內有效。"
          : "If that suite and email match our records, a link is on its way. It is good for 48 hours."}
      </div>
      <p className="bt-hint" style={{ marginTop: 14 }}>
        {zh
          ? "沒收到的話，先看看垃圾郵件。我們寄到的是租約上登記的那個 Email——如果你換過信箱，要先請辦公室更新。"
          : "If it does not arrive, check your spam folder. We send it to the address on your lease — if you have changed email since signing, the office needs to update it first."}
      </p>
      <Link to="/portal" className="bt-btn bt-btn--ghost" style={{ marginTop: 18 }}>
        {zh ? "回到登入" : "Back to sign in"}
      </Link>
    </div></section>
  );

  if (state === "error") return (
    <section className="bt-sec"><div className="bt-form">
      <h2>{zh ? "連不上" : "Could not reach us"}</h2>
      <p className="bt-body">{zh ? "請稍後再試一次。" : "Try again in a moment."}</p>
    </div></section>
  );

  return (
    <section className="bt-sec"><div className="bt-form">
      <h2>{zh ? "設定住戶專區" : "Set up your account"}</h2>
      <p className="bt-body">
        {zh
          ? "填入你的單位號碼和租約上的 Email，我們會寄一個設定連結給你。"
          : "Enter your suite number and the email on your lease, and we will send you a link."}
      </p>

      <label className="bt-f">
        <span>{zh ? "單位號碼" : "Suite number"}</span>
        <input className="bt-in" value={unit} placeholder="378-519"
               onChange={(e) => setUnit(e.target.value)} />
      </label>

      <label className="bt-f">
        <span>{zh ? "Email" : "Email"}</span>
        <input className="bt-in" type="email" value={email}
               onChange={(e) => setEmail(e.target.value)} />
        <em className="bt-hint">
          {zh
            ? "必須是租約上登記的那一個。我們只會寄到那個地址。"
            : "It has to be the one on your lease. That is the only address we will send to."}
        </em>
      </label>

      <button className="bt-btn" disabled={busy || !email.trim() || !unit.trim()}
              onClick={submit}>
        {busy ? (zh ? "處理中…" : "Sending…") : (zh ? "寄設定連結給我" : "Send me a link")}
      </button>

      <p className="bt-hint" style={{ marginTop: 14 }}>
        {zh
          ? "這個專區只給現住租客。已經有帳號的話直接登入就好。"
          : "The portal is for current tenants. If you already have an account, just sign in."}
      </p>
    </div></section>
  );
}

/* ---------- Step two ---------- */

function SetPassword({ token, zh }) {
  const navigate = useNavigate();
  const [info, setInfo] = useState(null);
  const [state, setState] = useState("loading");
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [issues, setIssues] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/public/verify/${token}`);
        const d = await res.json();
        if (!res.ok) { setState(d.code.toLowerCase()); return; }
        setInfo(d);
        setState("ready");
      } catch { setState("error"); }
    })();
  }, [token]);

  const submit = async () => {
    setBusy(true); setIssues([]);
    try {
      const res = await fetch(`/api/public/verify/${token}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      const d = await res.json();
      if (!res.ok) {
        setIssues(d.issues ?? [d.detail ?? (zh ? "設定失敗" : "That did not work")]);
        setBusy(false); return;
      }
      setState("done");
      setTimeout(() => navigate("/portal"), 2200);
    } catch {
      setIssues([zh ? "連不上，請再試一次。" : "Could not reach us. Try again."]);
    }
    setBusy(false);
  };

  const wrap = (children) => (
    <section className="bt-sec"><div className="bt-form">{children}</div></section>
  );

  if (state === "loading") return wrap(<p>{zh ? "讀取中…" : "Loading…"}</p>);

  if (state === "expired") return wrap(<>
    <h2>{zh ? "連結過期了" : "This link has expired"}</h2>
    <p className="bt-body">
      {zh ? "連結只有 48 小時有效。重新申請一個就好。"
          : "Links are good for 48 hours. Ask for a new one."}
    </p>
    <Link to="/claim" className="bt-btn" style={{ marginTop: 16 }}>
      {zh ? "重新申請" : "Send me another"}
    </Link>
  </>);

  if (state === "already_used") return wrap(<>
    <h2>{zh ? "這個連結用過了" : "This link has been used"}</h2>
    <p className="bt-body">
      {zh ? "每個連結只能用一次。如果帳號已經設定好了，直接登入；忘記密碼的話用重設。"
          : "Each link works once. If the account is set up, sign in — or use the reset link if you have forgotten the password."}
    </p>
    <Link to="/portal" className="bt-btn" style={{ marginTop: 16 }}>
      {zh ? "去登入" : "Sign in"}
    </Link>
  </>);

  if (state === "invalid_token" || state === "error") return wrap(<>
    <h2>{zh ? "找不到這個連結" : "This link is not valid"}</h2>
    <p className="bt-body">
      {zh ? "連結可能被信箱截斷了。試著整段複製貼上，或重新申請一個。"
          : "It may have been cut short by your email client. Try copying the whole link, or ask for a new one."}
    </p>
    <Link to="/claim" className="bt-btn" style={{ marginTop: 16 }}>
      {zh ? "重新申請" : "Send me another"}
    </Link>
  </>);

  if (state === "done") return wrap(<>
    <h2>{zh ? "設定完成" : "You are set up"}</h2>
    <div className="bt-ok">
      {zh ? "密碼設定好了，正在帶你到登入頁面。"
          : "Your password is set. Taking you to sign in."}
    </div>
  </>);

  const tooShort = pw.length > 0 && pw.length < MIN_LENGTH;
  const mismatch = confirm.length > 0 && pw !== confirm;
  const ready = pw.length >= MIN_LENGTH && pw === confirm;

  return wrap(<>
    <h2>{zh ? "設定密碼" : "Choose a password"}</h2>

    {/* Shows the suite so somebody can tell they have the right link, and the
        email masked, because the link may have been forwarded and the address
        is not the reader's to give away. */}
    <div className="bt-claimfor">
      <div><em>{zh ? "單位" : "Suite"}</em><strong>{info?.unit_number}</strong></div>
      <div><em>{zh ? "Email" : "Email"}</em><strong>{info?.email}</strong></div>
    </div>

    <label className="bt-f">
      <span>{zh ? "新密碼" : "New password"}</span>
      <input className="bt-in" type="password" value={pw} autoFocus
             onChange={(e) => setPw(e.target.value)} />
      <em className={`bt-hint ${tooShort ? "bt-warn" : ""}`}>
        {zh ? `至少 ${MIN_LENGTH} 個字。長度比符號有用——一句話比八個字加驚嘆號好記也難猜。`
            : `At least ${MIN_LENGTH} characters. Length helps more than symbols — a short phrase beats eight characters with punctuation, and you will remember it.`}
      </em>
    </label>

    <label className="bt-f">
      <span>{zh ? "再輸入一次" : "Type it again"}</span>
      <input className="bt-in" type="password" value={confirm}
             onChange={(e) => setConfirm(e.target.value)} />
      {mismatch && (
        <em className="bt-hint bt-warn">{zh ? "兩次輸入不一樣。" : "These do not match."}</em>
      )}
    </label>

    {issues.length > 0 && (
      <div className="bt-err">
        {issues.map((x, i) => <div key={i}>{x}</div>)}
      </div>
    )}

    <button className="bt-btn" disabled={!ready || busy} onClick={submit}>
      {busy ? (zh ? "設定中…" : "Setting it…") : (zh ? "設定密碼" : "Set my password")}
    </button>
  </>);
}


/* ============================================================
   Signing up

   Anybody can. What it gives you is an account and nothing else
   — no suite, no lease. It is a place to keep your own viewings
   and applications, and the only thing it shows you is what you
   submitted yourself.

   That is what makes self-service safe here. Getting access to a
   tenancy is a separate thing, and it happens when a lease is
   signed.
   ============================================================ */

export function SignUp() {
  const { locale } = useT();
  const zh = locale === "zh";
  const [params] = useSearchParams();

  /* Where they were going before we asked them to sign up. Somebody who
     clicked "book a viewing" on a specific suite told us exactly what they
     wanted, and dropping them on a dashboard afterwards throws that away. */
  const next = nextFrom(`?${params.toString()}`, "/portal");
  const [f, setF] = useState({ full_name: "", email: "", phone: "", password: "" });
  const [confirm, setConfirm] = useState("");
  const [state, setState] = useState("form");
  const [issues, setIssues] = useState([]);
  const [busy, setBusy] = useState(false);

  const set = (p) => setF({ ...f, ...p });
  const tooShort = f.password.length > 0 && f.password.length < MIN_LENGTH;
  const mismatch = confirm.length > 0 && f.password !== confirm;
  const ready = f.full_name.trim() && f.email.includes("@")
    && f.password.length >= MIN_LENGTH && f.password === confirm;

  const submit = async () => {
    setBusy(true); setIssues([]);
    try {
      const res = await fetch("/api/public/signup", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...f, locale }),
      });
      const d = await res.json();
      if (!res.ok && res.status !== 201) {
        setIssues(d.issues ?? [d.detail ?? (zh ? "註冊失敗" : "That did not work")]);
        setBusy(false); return;
      }
      setState("sent");
    } catch {
      setIssues([zh ? "連不上，請再試一次。" : "Could not reach us. Try again."]);
    }
    setBusy(false);
  };

  if (state === "sent") return (
    <section className="bt-sec"><div className="bt-form">
      <h2>{zh ? "確認一下 Email" : "Check your email"}</h2>
      <div className="bt-ok">
        {zh ? "確認信寄出去了。點裡面的連結之後就可以預約看房和送申請。"
            : "A confirmation link is on its way. Open it and you can book viewings and apply."}
      </div>
      <p className="bt-hint" style={{ marginTop: 14 }}>
        {zh ? "連結 48 小時內有效。沒收到的話看一下垃圾郵件。"
            : "The link is good for 48 hours. If it does not arrive, check your spam folder."}
      </p>
      <Link to={`/portal?next=${encodeURIComponent(next)}`}
            className="bt-btn bt-btn--ghost" style={{ marginTop: 18 }}>
        {zh ? "回到登入" : "Back to sign in"}
      </Link>
    </div></section>
  );

  return (
    <section className="bt-sec"><div className="bt-form">
      <h2>{zh ? "建立帳號" : "Create an account"}</h2>

      {/* Says why they were stopped, when they were stopped for a reason.
          "Create an account" with no explanation reads as a wall; the same
          words after "you were about to book a viewing" read as a step. */}
      {next !== "/portal" && (
        <div className="bt-note">
          <p>{zh
            ? "預約看房只要一分鐘，我們需要一個地方把確認信寄給你。建好之後會直接帶你回去。"
            : "Booking takes a minute and we need somewhere to send the confirmation. We will take you straight back afterwards."}</p>
        </div>
      )}
      <p className="bt-body">
        {zh ? "有帳號就可以預約看房、送出申請，並隨時看到進度。"
            : "An account lets you book a viewing, apply, and follow what happens next."}
      </p>

      <div className="bt-row">
        <label className="bt-f">
          <span>{zh ? "姓名" : "Name"}</span>
          <input className="bt-in" value={f.full_name}
                 onChange={(e) => set({ full_name: e.target.value })} />
        </label>
        <label className="bt-f">
          <span>{zh ? "電話" : "Phone"} <em>{zh ? "選填" : "optional"}</em></span>
          <input className="bt-in" value={f.phone}
                 onChange={(e) => set({ phone: e.target.value })} />
        </label>
      </div>

      <label className="bt-f">
        <span>Email</span>
        <input className="bt-in" type="email" value={f.email}
               onChange={(e) => set({ email: e.target.value })} />
        <em className="bt-hint">
          {zh ? "我們會寄確認信到這裡。" : "We send a confirmation link here."}
        </em>
      </label>

      <label className="bt-f">
        <span>{zh ? "密碼" : "Password"}</span>
        <input className="bt-in" type="password" value={f.password}
               onChange={(e) => set({ password: e.target.value })} />
        <em className={`bt-hint ${tooShort ? "bt-warn" : ""}`}>
          {zh ? `至少 ${MIN_LENGTH} 個字。長度比符號有用。`
              : `At least ${MIN_LENGTH} characters. Length helps more than symbols.`}
        </em>
      </label>

      <label className="bt-f">
        <span>{zh ? "再輸入一次" : "Type it again"}</span>
        <input className="bt-in" type="password" value={confirm}
               onChange={(e) => setConfirm(e.target.value)} />
        {mismatch && (
          <em className="bt-hint bt-warn">{zh ? "兩次不一樣。" : "These do not match."}</em>
        )}
      </label>

      {issues.length > 0 && (
        <div className="bt-err">{issues.map((x, i) => <div key={i}>{x}</div>)}</div>
      )}

      <button className="bt-btn" disabled={!ready || busy} onClick={submit}>
        {busy ? (zh ? "處理中…" : "Creating…") : (zh ? "建立帳號" : "Create my account")}
      </button>

      {/* Said here rather than discovered later. Somebody who signs up
          expecting to see a suite they have not rented should find out now. */}
      <p className="bt-hint" style={{ marginTop: 14 }}>
        {zh ? "已經是住戶？帳號會在簽約時由我們接上你的單位，之後就能看到租約、報修和帳務。"
            : "Already a tenant? We connect your account to your suite when the lease is signed — after that you will see your lease, repairs and balance here."}
      </p>

      <Link to={`/portal?next=${encodeURIComponent(next)}`} className="bt-linkbtn"
            style={{ marginTop: 6 }}>
        {zh ? "已經有帳號了" : "I already have an account"}
      </Link>
    </div></section>
  );
}

/* ---------- Confirming the address ---------- */

export function VerifySignup() {
  const { locale } = useT();
  const [params] = useSearchParams();
  const token = params.get("token");
  const [state, setState] = useState("working");
  const zh = locale === "zh";

  useEffect(() => {
    if (!token) { setState("invalid_token"); return; }
    (async () => {
      try {
        const res = await fetch(`/api/public/verify-signup/${token}`, { method: "POST" });
        const d = await res.json();
        setState(res.ok ? "done" : d.code.toLowerCase());
      } catch { setState("error"); }
    })();
  }, [token]);

  const wrap = (children) => (
    <section className="bt-sec"><div className="bt-form">{children}</div></section>
  );

  if (state === "working") return wrap(<p>{zh ? "確認中…" : "Confirming…"}</p>);

  if (state === "done") return wrap(<>
    <h2>{zh ? "Email 確認了" : "Address confirmed"}</h2>
    <div className="bt-ok">
      {zh ? "可以登入了。接下來可以預約看房或直接送申請。"
          : "You can sign in now. From there, book a viewing or go straight to an application."}
    </div>
    <Link to="/portal" className="bt-btn" style={{ marginTop: 16 }}>
      {zh ? "登入" : "Sign in"}
    </Link>
  </>);

  if (state === "expired") return wrap(<>
    <h2>{zh ? "連結過期了" : "This link has expired"}</h2>
    <p className="bt-body">
      {zh ? "連結只有 48 小時。用同一個 Email 再註冊一次就會重寄。"
          : "Links last 48 hours. Sign up again with the same address and we will send another."}
    </p>
    <Link to="/signup" className="bt-btn" style={{ marginTop: 16 }}>
      {zh ? "重寄一次" : "Send another"}
    </Link>
  </>);

  if (state === "already_used") return wrap(<>
    <h2>{zh ? "已經確認過了" : "Already confirmed"}</h2>
    <Link to="/portal" className="bt-btn" style={{ marginTop: 16 }}>
      {zh ? "去登入" : "Sign in"}
    </Link>
  </>);

  return wrap(<>
    <h2>{zh ? "這個連結無效" : "This link is not valid"}</h2>
    <p className="bt-body">
      {zh ? "可能是被信箱截斷了。試著整段複製貼上。"
          : "It may have been cut short by your email client. Try copying the whole link."}
    </p>
  </>);
}

export default Claim;
