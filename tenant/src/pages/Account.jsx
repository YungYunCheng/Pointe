import React, { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useT } from "../lib/locale.jsx";

const post = async (path, body) => {
  const res = await fetch(path, {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.code || "REQUEST_FAILED"), { data });
  return data;
};

const Shell = ({ title, children }) => (
  <section className="bt-sec"><div className="bt-form"><h2>{title}</h2>{children}</div></section>
);

export function Signup() {
  const { locale } = useT();
  const zh = locale === "zh";
  const [f, setF] = useState({ full_name: "", email: "", phone: "", password: "", again: "" });
  const [busy, setBusy] = useState(false), [done, setDone] = useState(false), [err, setErr] = useState("");
  const submit = async () => {
    setErr("");
    if (f.password.length < 12 || f.password !== f.again) {
      setErr(zh ? "密碼至少 12 個字元，而且兩次輸入必須相同。" : "Use at least 12 characters and enter the same password twice.");
      return;
    }
    setBusy(true);
    try {
      await post("/api/public/signup", { full_name: f.full_name.trim(),
        email: f.email.trim(), phone: f.phone.trim() || null, password: f.password, locale });
      setDone(true);
    } catch (e) {
      setErr(e.data?.issues?.join(" ") || (zh ? "暫時無法註冊，請稍後再試。" : "We could not create the account. Try again shortly."));
    } finally { setBusy(false); }
  };
  if (done) return <Shell title={zh ? "請查看 Email" : "Check your email"}>
    <div className="bt-ok">{zh ? "確認連結已寄出；確認後即可登入、預約看房與送出申請。" : "A confirmation link is on its way. Confirm the address, then sign in to book and apply."}</div>
  </Shell>;
  return <Shell title={zh ? "建立租屋帳戶" : "Create a rental account"}>
    <p className="bt-body">{zh ? "尚未入住、想預約看房或申請租屋時使用。" : "For prospective tenants who want to book a viewing or apply."}</p>
    <Field label={zh ? "姓名" : "Full name"} value={f.full_name} onChange={(v) => setF({ ...f, full_name: v })} />
    <Field label="Email" type="email" value={f.email} onChange={(v) => setF({ ...f, email: v })} />
    <Field label={zh ? "電話（選填）" : "Phone (optional)"} type="tel" value={f.phone} onChange={(v) => setF({ ...f, phone: v })} />
    <Field label={zh ? "密碼（至少 12 個字元）" : "Password (at least 12 characters)"} type="password" value={f.password} onChange={(v) => setF({ ...f, password: v })} />
    <Field label={zh ? "再次輸入密碼" : "Password again"} type="password" value={f.again} onChange={(v) => setF({ ...f, again: v })} />
    {err && <div className="bt-err">{err}</div>}
    <button className="bt-btn" disabled={busy || !f.full_name.trim() || !f.email.trim()} onClick={submit}>{busy ? "…" : (zh ? "建立帳戶" : "Create account")}</button>
  </Shell>;
}

export function VerifySignup() {
  const { locale } = useT();
  const zh = locale === "zh";
  const [params] = useSearchParams();
  const token = params.get("token");
  const [state, setState] = useState("busy");
  useEffect(() => {
    if (!token) { setState("bad"); return; }
    post(`/api/public/verify-signup/${encodeURIComponent(token)}`, {})
      .then(() => setState("done")).catch(() => setState("bad"));
  }, [token]);
  return <Shell title={zh ? "確認 Email" : "Confirm email"}>
    {state === "busy" && <p className="bt-body">{zh ? "確認中…" : "Confirming…"}</p>}
    {state === "done" && <><div className="bt-ok">{zh ? "Email 已確認，可以登入了。" : "Email confirmed. You can sign in now."}</div><Link className="bt-btn" style={{ marginTop: 18 }} to="/portal">{zh ? "前往登入" : "Sign in"}</Link></>}
    {state === "bad" && <div className="bt-err">{zh ? "連結無效、已使用或已過期。" : "This link is invalid, already used or expired."}</div>}
  </Shell>;
}

export function Claim() {
  const { locale } = useT();
  const zh = locale === "zh";
  const [params] = useSearchParams();
  const token = params.get("token");
  return token ? <SetClaimPassword token={token} zh={zh} /> : <InvitationOnly zh={zh} />;
}

function InvitationOnly({ zh }) {
  return <Shell title={zh ? "設定住戶專區" : "Set up tenant access"}>
    <div className="bt-note">
      {zh
        ? "已签约或已经入住的租客，请联系管理办公室。Admin 会按照有效租约中的姓名、Email 和房号寄出专属邀请。你不需要、也无法自行选择房号。"
        : "Signed and current tenants receive a private invitation from management using the name, email and suite on the active lease. You do not need to—and cannot—choose a suite yourself."}
    </div>
    <a className="bt-btn" style={{ marginTop:18 }} href="mailto:rentals@themizar.ca">
      {zh ? "联系管理办公室" : "Contact management"}
    </a>
  </Shell>;
}

function SetClaimPassword({ token, zh }) {
  const [pw, setPw] = useState(""), [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false), [done, setDone] = useState(false), [err, setErr] = useState("");
  const submit = async () => {
    if (pw.length < 12 || pw !== again) { setErr(zh ? "密碼至少 12 個字元，而且兩次輸入必須相同。" : "Use at least 12 characters and enter the same password twice."); return; }
    setBusy(true); setErr("");
    try { await post(`/api/public/verify/${encodeURIComponent(token)}`, { password: pw }); setDone(true); }
    catch (e) { setErr(e.data?.issues?.join(" ") || (zh ? "連結無效、已使用或已過期。" : "This link is invalid, already used or expired.")); }
    finally { setBusy(false); }
  };
  if (done) return <Shell title={zh ? "帳戶已設定" : "Account ready"}><div className="bt-ok">{zh ? "現在可以登入住戶專區。" : "You can now sign in to the tenant portal."}</div><Link className="bt-btn" style={{ marginTop: 18 }} to="/portal">{zh ? "前往登入" : "Sign in"}</Link></Shell>;
  return <Shell title={zh ? "設定密碼" : "Choose a password"}>
    <Field label={zh ? "密碼（至少 12 個字元）" : "Password (at least 12 characters)"} type="password" value={pw} onChange={setPw} />
    <Field label={zh ? "再次輸入密碼" : "Password again"} type="password" value={again} onChange={setAgain} />
    {err && <div className="bt-err">{err}</div>}
    <button className="bt-btn" disabled={busy} onClick={submit}>{busy ? "…" : (zh ? "設定密碼" : "Set password")}</button>
  </Shell>;
}

export function ResetPassword() {
  const { locale } = useT();
  const zh = locale === "zh";
  const [params] = useSearchParams();
  const token = params.get("token");
  const [pw, setPw] = useState(""), [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false), [done, setDone] = useState(false), [err, setErr] = useState("");
  const submit = async () => {
    if (!token || pw.length < 12 || pw !== again) { setErr(zh ? "連結必須有效，密碼至少 12 個字元，而且兩次輸入相同。" : "Use a valid link and enter the same password of at least 12 characters twice."); return; }
    setBusy(true); setErr("");
    try { await post("/api/public/tenant/reset", { token, password: pw }); setDone(true); }
    catch { setErr(zh ? "連結無效、已使用或已過期。" : "This link is invalid, already used or expired."); }
    finally { setBusy(false); }
  };
  if (done) return <Shell title={zh ? "密碼已更新" : "Password updated"}><div className="bt-ok">{zh ? "所有舊登入已登出，請用新密碼登入。" : "Old sessions have been signed out. Sign in with the new password."}</div><Link className="bt-btn" style={{ marginTop: 18 }} to="/portal">{zh ? "前往登入" : "Sign in"}</Link></Shell>;
  return <Shell title={zh ? "重設密碼" : "Reset password"}>
    <Field label={zh ? "新密碼（至少 12 個字元）" : "New password (at least 12 characters)"} type="password" value={pw} onChange={setPw} />
    <Field label={zh ? "再次輸入新密碼" : "New password again"} type="password" value={again} onChange={setAgain} />
    {err && <div className="bt-err">{err}</div>}
    <button className="bt-btn" disabled={busy} onClick={submit}>{busy ? "…" : (zh ? "更新密碼" : "Update password")}</button>
  </Shell>;
}

function Field({ label, value, onChange, type = "text" }) {
  return <div className="bt-f"><label>{label}</label><input className="bt-in" type={type} value={value}
    autoComplete={type === "password" ? "new-password" : undefined}
    onChange={(e) => onChange(e.target.value)} /></div>;
}
