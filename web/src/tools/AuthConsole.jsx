import React, { useEffect, useState } from "react";
import api, { ApiError } from "../lib/api.js";

/* Staff authentication is server-owned. No seed passwords, password hashes,
   reset tokens, or reusable session credentials are kept in browser storage. */

const SESSION = "baydo:session";
const PASSWORD_WARN_DAYS = 14;

const ROLES = {
  admin:            { label: "Admin",            color: "#131C25" },
  property_manager: { label: "Property Manager", color: "#1C6FA6" },
  building_manager: { label: "Building Manager", color: "#7C5CBF" },
  accounting:       { label: "Accounting",       color: "#0E8577" },
};

const PW_RULES = [
  { label: "At least 12 characters", test: (p) => p.length >= 12 },
  { label: "Not only numbers", test: (p) => !/^\d+$/.test(p) },
  { label: "Not based on the property name", test: (p) =>
      !["password", "baydo", "pointe", "mizar", "clareview"].some((w) => p.toLowerCase().includes(w)) },
];

const fmt = (iso) => (iso ? String(iso).slice(0, 16).replace("T", " ") : "—");
const daysUntil = (iso) => (iso ? Math.ceil((new Date(iso) - Date.now()) / 864e5) : null);

async function saveDisplaySession(user) {
  const s = {
    accountId: user.id, name: user.name, email: user.email, phone: user.phone ?? null,
    role: user.role, at: new Date().toISOString(),
    password_expires_at: user.password_expires_at ?? user.passwordExpiresAt ?? null,
    password_expired: !!user.password_expired,
    must_change_password: !!user.must_change_password || !!user.mustChangePassword,
  };
  try { await window.storage?.set?.(SESSION, JSON.stringify(s)); } catch {}
  return s;
}

async function clearDisplaySession() {
  try { await window.storage?.delete?.(SESSION); } catch {}
}

export default function AuthConsole() {
  const urlToken = new URLSearchParams(window.location.search).get("token") ?? "";
  const [session, setSession] = useState(null);
  const [screen, setScreen] = useState(urlToken ? "reset" : "login");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [token, setToken] = useState(urlToken);
  const [newPw, setNewPw] = useState("");
  const [newPw2, setNewPw2] = useState("");

  const clear = () => { setErr(""); setInfo(""); };

  useEffect(() => {
    (async () => {
      try {
        const out = await api.me();
        const s = await saveDisplaySession(out.user);
        setSession(s);
        setScreen("done");
      } catch {
        await clearDisplaySession();
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const doLogin = async () => {
    clear(); setBusy(true);
    try {
      const user = await api.login(email.trim(), pw);
      const s = await saveDisplaySession(user);
      setSession(s);
      setPw("");
      setScreen("done");
      window.dispatchEvent(new CustomEvent("baydo:signed-in"));
      if (user.must_change_password || user.password_expired)
        setInfo("Change this password before using the rest of the system.");
      else if (user.password_warning)
        setInfo(`This password expires in ${user.password_days_left} days.`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 423)
        setErr(`Too many attempts. This account is locked until ${fmt(e.payload.locked_until)}.`);
      else if (e instanceof ApiError && e.code === "PASSWORD_NEEDS_RESET") {
        setErr("This account needs a password reset before it can sign in.");
        setScreen("forgot");
      } else setErr("Email or password is incorrect.");
    } finally { setBusy(false); }
  };

  const doForgot = async () => {
    clear(); setBusy(true);
    try {
      await api.forgot(email.trim());
      setInfo("If that email has an account, a reset link has been sent. It expires in 30 minutes.");
      setScreen("reset");
    } catch {
      setInfo("If that email has an account, a reset link has been sent. It expires in 30 minutes.");
      setScreen("reset");
    } finally { setBusy(false); }
  };

  const doReset = async () => {
    clear(); setBusy(true);
    if (PW_RULES.some((r) => !r.test(newPw))) {
      setErr("That password does not meet the rules below."); setBusy(false); return;
    }
    if (newPw !== newPw2) {
      setErr("The two new passwords do not match."); setBusy(false); return;
    }
    try {
      await api.reset(token.trim(), newPw);
      setInfo("Password updated. Sign in with the new password.");
      setNewPw(""); setNewPw2(""); setToken("");
      window.history.replaceState({}, "", window.location.pathname);
      setScreen("login");
    } catch (e) {
      setErr(e instanceof ApiError && e.code === "PASSWORD_RECENTLY_USED"
        ? "Choose a password you have not used recently."
        : "That reset link is invalid, expired, or has already been used.");
    } finally { setBusy(false); }
  };

  const logout = async () => {
    try { await api.logout(); } catch {}
    await clearDisplaySession();
    setSession(null); setScreen("login"); setEmail(""); setPw(""); clear();
    window.dispatchEvent(new CustomEvent("baydo:signed-out"));
  };

  if (loading)
    return <div className="au"><style>{CSS}</style><div className="au-load">Loading…</div></div>;

  const title = screen === "done" ? "Signed in"
              : screen === "forgot" ? "Forgot password"
              : screen === "reset" ? "Reset password" : "Sign in";

  return (
    <div className="au">
      <style>{CSS}</style>
      <div className="au-wrap">
        <div className="au-box">
          <div className="au-eyebrow">Baydo Pointe</div>
          <h1>{title}</h1>

          {screen === "done" && session && <>
            <div className="au-me">
              <span className="au-chip" style={{ background: ROLES[session.role]?.color ?? "#8892A0" }}>
                {ROLES[session.role]?.label ?? session.role}
              </span>
              <div><strong>{session.name}</strong><div className="au-dim">{session.email}</div></div>
            </div>
            {session.password_expires_at && <div className="au-pw">
              Password expires {fmt(session.password_expires_at).slice(0, 10)}
            </div>}
            {info && <div className="au-info">{info}</div>}
            <button className="au-btn" onClick={logout}>Sign out</button>
            <button className="au-link" onClick={() => { setEmail(session.email); setScreen("forgot"); clear(); }}>
              Change password
            </button>
          </>}

          {screen === "login" && <>
            <p className="au-note">Your server account decides what you can see and change.</p>
            <label className="au-f"><span>Email</span>
              <input className="au-in" type="email" autoComplete="username" value={email}
                placeholder="name@themizar.ca" onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doLogin()} />
            </label>
            <label className="au-f"><span>Password</span><div className="au-pwwrap">
              <input className="au-in" type={showPw ? "text" : "password"}
                autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doLogin()} />
              <button className="au-eye" type="button" onClick={() => setShowPw(!showPw)}>
                {showPw ? "Hide" : "Show"}
              </button>
            </div></label>
            {err && <div className="au-err">{err}</div>}
            {info && <div className="au-info">{info}</div>}
            <button className="au-btn" onClick={doLogin} disabled={busy || !email.trim() || !pw}>
              {busy ? "Checking…" : "Sign in"}
            </button>
            <button className="au-link" onClick={() => { setScreen("forgot"); clear(); }}>
              Forgot your password?
            </button>
          </>}

          {screen === "forgot" && <>
            <p className="au-note">Enter your account email and we will send a one-time reset link.</p>
            <label className="au-f"><span>Email</span>
              <input className="au-in" type="email" value={email} placeholder="name@themizar.ca"
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doForgot()} />
            </label>
            {err && <div className="au-err">{err}</div>}
            <button className="au-btn" onClick={doForgot} disabled={busy || !email.trim()}>
              {busy ? "Working…" : "Send reset link"}
            </button>
            <button className="au-link" onClick={() => { setScreen("login"); clear(); }}>Back to sign in</button>
          </>}

          {screen === "reset" && <>
            {info && <div className="au-info">{info}</div>}
            <label className="au-f"><span>Reset token</span>
              <input className="au-in au-mono" value={token} placeholder="Paste the token from the email"
                onChange={(e) => setToken(e.target.value)} />
            </label>
            <label className="au-f"><span>New password</span>
              <input className="au-in" type="password" autoComplete="new-password" value={newPw}
                onChange={(e) => setNewPw(e.target.value)} />
            </label>
            {newPw && <div className="au-rules">{PW_RULES.map((r) => {
              const ok = r.test(newPw);
              return <span key={r.label} className={ok ? "ok" : ""}>{ok ? "✓" : "○"} {r.label}</span>;
            })}</div>}
            <label className="au-f"><span>Enter it again</span>
              <input className="au-in" type="password" autoComplete="new-password" value={newPw2}
                onChange={(e) => setNewPw2(e.target.value)} />
            </label>
            {err && <div className="au-err">{err}</div>}
            <button className="au-btn" onClick={doReset}
              disabled={busy || !token.trim() || !newPw || !newPw2}>
              {busy ? "Working…" : "Set new password"}
            </button>
            <button className="au-link" onClick={() => { setScreen("login"); clear(); }}>Back to sign in</button>
          </>}
        </div>
      </div>
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&family=Archivo:wght@700;800&display=swap');
.au{--ink:#131C25;--ink2:#3E4C5A;--dim:#78899A;--paper:#fff;--ground:#E9EDF0;--rule:#D3DBE1;
  --amber:#FFF6E0;--amberline:#E8C877;--red:#B23A54;--green:#0E8577;--accent:var(--brand,#2A6183);
  background:var(--ground);color:var(--ink);min-height:100vh;font-size:14px;line-height:1.55;
  font-family:'IBM Plex Sans',system-ui,sans-serif;padding:28px 16px}
.au *{box-sizing:border-box}
.au-mono,.au-json,.au-token code{font-family:'IBM Plex Mono',monospace}
.au-dim{color:var(--dim);font-size:12px}
.au-load{padding:80px 20px;text-align:center;color:var(--dim)}
.au-wrap{max-width:440px;margin:0 auto;display:flex;flex-direction:column;gap:14px}

.au-box{background:var(--paper);border:1px solid var(--rule);border-radius:5px;padding:24px;
  display:flex;flex-direction:column;gap:13px}
.au-eyebrow{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.13em;
  text-transform:uppercase;color:var(--dim)}
.au-box h1{font-family:'Archivo',sans-serif;font-weight:800;font-size:23px;
  letter-spacing:-.02em;margin:2px 0 0}
.au-note{color:var(--dim);font-size:12.5px;margin:0;line-height:1.65}

.au-f{display:flex;flex-direction:column;gap:5px}
.au-f>span{font-size:12px;font-weight:600;color:var(--ink2)}
.au-in{font:inherit;font-size:13.5px;padding:9px 11px;border:1px solid var(--amberline);
  border-radius:3px;background:var(--amber);color:var(--ink);width:100%}
.au-in:focus{outline:2px solid var(--accent);outline-offset:1px}
.au-pwwrap{position:relative;display:flex}
.au-eye{position:absolute;right:6px;top:50%;transform:translateY(-50%);font:inherit;font-size:11.5px;
  cursor:pointer;background:none;border:0;color:var(--dim);padding:4px 6px}
.au-eye:hover{color:var(--ink)}

.au-btn{font:inherit;font-weight:600;font-size:13.5px;cursor:pointer;background:var(--brand,var(--ink));color:#fff;
  border:1px solid var(--brand,var(--ink));padding:10px 16px;border-radius:3px;width:100%}
.au-btn:hover:not(:disabled){background:#000}
.au-btn:disabled{opacity:.4;cursor:not-allowed}
.au-link{font:inherit;font-size:12.5px;cursor:pointer;background:none;border:0;color:var(--accent);
  padding:2px;text-align:center}
.au-link:hover{text-decoration:underline}
.au-link--danger{color:var(--red)}
.au-btn:focus-visible,.au-link:focus-visible,.au-dbh:focus-visible{
  outline:2px solid var(--accent);outline-offset:2px}

.au-err{font-size:12.5px;color:var(--red);background:#FDF6F7;border:1px solid var(--red);
  border-radius:3px;padding:8px 11px;line-height:1.6}
.au-info{font-size:12.5px;color:#7A5D14;background:#FFF8E6;border:1px solid var(--amberline);
  border-radius:3px;padding:8px 11px;line-height:1.6}

.au-me{display:flex;align-items:center;gap:11px;border:1px solid var(--rule);border-radius:3px;
  padding:12px 14px;background:#FCFDFE}
.au-chip{font-size:10.5px;font-weight:700;color:#fff;border-radius:9px;padding:2px 9px;white-space:nowrap}

.au-rules{display:flex;flex-wrap:wrap;gap:5px 12px;font-size:11.5px;color:var(--dim)}
.au-rules .ok{color:var(--green)}

.au-token{border:1px dashed var(--amberline);background:#FFFCF3;border-radius:3px;padding:11px 13px;
  display:flex;flex-direction:column;gap:6px}
.au-token strong{font-size:12px;color:#7A5D14}
.au-token code{font-size:13px;background:var(--paper);border:1px solid var(--rule);border-radius:2px;
  padding:6px 9px;word-break:break-all}
.au-token p{margin:0;font-size:11.5px;color:var(--dim);line-height:1.6}

.au-db{background:var(--paper);border:1px solid var(--rule);border-radius:5px;padding:14px 18px;
  display:flex;flex-direction:column;gap:10px}
.au-dbh{font:inherit;font-size:13px;font-weight:600;cursor:pointer;background:none;border:0;padding:0;
  text-align:left;display:flex;align-items:center;gap:8px;color:var(--ink)}
.au-dbh em{font-style:normal;font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--dim);
  margin-left:auto}
.au-json{font-size:11px;line-height:1.65;background:#F7F9FB;border:1px solid var(--rule);border-radius:3px;
  padding:11px 13px;margin:0;overflow-x:auto;max-height:260px;overflow-y:auto;color:var(--ink2)}

.au-warn{font-size:11.5px;color:#7A5D14;background:#FFF8E6;border:1px solid var(--amberline);
  border-radius:4px;padding:12px 14px;line-height:1.7}
.au-warn strong{display:block;margin-bottom:3px}
.au-pw{font-size:12px;color:var(--dim);border:1px solid var(--rule);border-radius:3px;
  padding:7px 11px;font-family:'IBM Plex Mono',monospace}
.au-pw.warn{color:#7A5D14;background:var(--amber);border-color:var(--amberline)}
.au-pw.expired{color:var(--red);background:#FDF6F7;border-color:var(--red);font-weight:600}
.au-contact{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end}
`;

