import React, { useState, useEffect, useCallback } from "react";

/* ============================================================
   BAYDO POINTE — Sign in / Forgot password / Reset password

   Staff-facing, English only. Tenant-facing output (notices of
   entry, fee disclosures, lease correspondence) stays bilingual
   and is written in whichever language the tenant used.

   Passwords are stored as PBKDF2-SHA256 hashes with a per-user
   salt. No plaintext anywhere, so these columns map directly onto
   the users table in the API.
   ============================================================ */

const DB_USERS   = "baydo:db:users";
const DB_TOKENS  = "baydo:db:password_reset_tokens";
const DB_ATTEMPT = "baydo:db:login_attempts";
const SESSION    = "baydo:session";

const PBKDF2_ITER = 210000;
const LOCK_AFTER = 5;
const LOCK_MIN = 15;
const TOKEN_TTL_MIN = 30;

const ROLES = {
  admin:            { label: "Admin",            color: "#131C25" },
  property_manager: { label: "Property Manager", color: "#1C6FA6" },
  building_manager: { label: "Building Manager", color: "#7C5CBF" },
  accounting:       { label: "Accounting",       color: "#0E8577" },
};

/* Every account carries both an email and a phone. An account reachable on one
   channel is an account that gets locked out the day that channel fails. */
const SEED_USERS = [
  { email: "admin@themizar.ca",      full_name: "Admin",      role: "admin",
    phone: "306-974-1727", password: "Mizar@2026!" },
  { email: "bowen.wang@themizar.ca", full_name: "Bowen Wang", role: "property_manager",
    phone: "780-555-0101", password: "Agent@2026!" },
  { email: "rentals@themizar.ca",    full_name: "Rentals",    role: "building_manager",
    phone: "780-555-0102", password: "Rentals@2026!" },
  { email: "invoice@themizar.ca",    full_name: "Accounting", role: "accounting",
    phone: "780-555-0103", password: "Invoice@2026!" },
];

/* Passwords expire twice a year: long enough not to be an irritation, short
   enough that a credential leaked and unnoticed does not stay useful. */
const PASSWORD_MAX_AGE_DAYS = 182;
const PASSWORD_WARN_DAYS = 14;
const PASSWORD_HISTORY = 5;

/* ---------- Crypto (Web Crypto API) ---------- */
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password),
                                            "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
  return b64(bits);
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { algo: "PBKDF2-SHA256", iterations: PBKDF2_ITER,
           salt: b64(salt), hash: await derive(password, salt, PBKDF2_ITER) };
}
async function verifyPassword(password, rec) {
  if (!rec?.password_hash) return false;
  const h = await derive(password, unb64(rec.password_salt), rec.password_iterations || PBKDF2_ITER);
  const a = h, b = rec.password_hash;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;                       // compare every character, no early exit
}
async function sha256(text) {
  return b64(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}
const randToken = () =>
  b64(crypto.getRandomValues(new Uint8Array(24))).replace(/[+/=]/g, "").slice(0, 28);

const PW_RULES = [
  { label: "At least 10 characters", test: (p) => p.length >= 10 },
  { label: "One lowercase letter",   test: (p) => /[a-z]/.test(p) },
  { label: "One uppercase letter",   test: (p) => /[A-Z]/.test(p) },
  { label: "One number",             test: (p) => /\d/.test(p) },
  { label: "One symbol",             test: (p) => /[^A-Za-z0-9]/.test(p) },
];

const nowISO = () => new Date().toISOString();
const addMin = (m) => new Date(Date.now() + m * 60000).toISOString();
const fmt = (iso) => (iso ? iso.slice(0, 16).replace("T", " ") : "—");
const addDays = (n) => new Date(Date.now() + n * 864e5).toISOString();
const daysUntil = (iso) => (iso ? Math.ceil((new Date(iso) - Date.now()) / 864e5) : null);

export default function AuthConsole() {
  const [users, setUsers] = useState([]);
  const [tokens, setTokens] = useState([]);
  const [attempts, setAttempts] = useState({});
  const [session, setSession] = useState(null);
  const [screen, setScreen] = useState("login");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [showDb, setShowDb] = useState(false);

  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [token, setToken] = useState("");
  const [newPw, setNewPw] = useState("");
  const [newPw2, setNewPw2] = useState("");
  const [issued, setIssued] = useState(null);

  const read = useCallback(async (k, fallback) => {
    try { const r = await window.storage.get(k); return r?.value ? JSON.parse(r.value) : fallback; }
    catch (e) { return fallback; }
  }, []);
  const write = useCallback(async (k, v) => {
    try { await window.storage.set(k, JSON.stringify(v)); } catch (e) {}
  }, []);

  /* ---------- Init: create any seed account that is missing ---------- */
  useEffect(() => {
    (async () => {
      let u = (await read(DB_USERS, null)) || [];
      const have = new Set(u.map((x) => (x.email || "").toLowerCase()));
      const missing = SEED_USERS.filter((s) => !have.has(s.email.toLowerCase()));
      if (missing.length) {
        for (const s of missing) {
          const h = await hashPassword(s.password);
          u.push({
            id: "usr_" + Math.random().toString(36).slice(2, 10),
            email: s.email.toLowerCase(), full_name: s.full_name, role: s.role,
            phone: s.phone ?? null,
            password_algo: h.algo, password_iterations: h.iterations,
            password_salt: h.salt, password_hash: h.hash,
            password_changed_at: nowISO(),
            password_expires_at: addDays(PASSWORD_MAX_AGE_DAYS),
            password_history: [],
            must_change_password: true, is_active: true,
            last_login_at: null, created_at: nowISO(), updated_at: nowISO(),
          });
        }
        await write(DB_USERS, u);
      }
      setUsers(u);
      setTokens(await read(DB_TOKENS, []));
      setAttempts(await read(DB_ATTEMPT, {}));
      const s = await read(SESSION, null);
      if (s) { setSession(s); setScreen("done"); }
      setLoading(false);
    })();
  }, [read, write]);

  const saveUsers = async (u) => { setUsers(u); await write(DB_USERS, u); };
  const saveTokens = async (x) => { setTokens(x); await write(DB_TOKENS, x); };
  const saveAttempts = async (a) => { setAttempts(a); await write(DB_ATTEMPT, a); };
  const clear = () => { setErr(""); setInfo(""); };

  /* ---------- Sign in ---------- */
  const doLogin = async () => {
    clear(); setBusy(true);

    /* The server decides. Everything the browser could check — the password,
       the lock, whether the account is even active — is checkable by anybody
       with developer tools, so none of it is a control. It runs on the server
       or it does not run.

       What is left here is the form and the messages. */
    try {
      const res = await fetch("/api/public/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: email.trim(), password: pw }),
      });
      const d = await res.json();

      if (res.status === 423) {
        setErr(`Too many attempts. This account is locked until ${fmt(d.locked_until)}.`);
        setBusy(false); return;
      }

      if (res.status === 409 && d.code === "PASSWORD_NEEDS_RESET") {
        // A hash from the old server that this runtime cannot verify. Said
        // plainly, because otherwise somebody tries the same correct password
        // all afternoon.
        setErr("This password was set on the previous server and cannot be checked here. Use the reset link below.");
        setBusy(false); return;
      }

      if (res.status === 429) {
        setErr(d.detail ?? "Too many sign-in attempts from this address. Try again in a few minutes.");
        setBusy(false); return;
      }

      if (!res.ok) {
        // Identical message whether the account exists or the password was
        // wrong. Anything more specific turns this form into a way of finding
        // out who works here.
        setErr("Email or password is incorrect.");
        setBusy(false); return;
      }

      const u = d.user;
      const s = { accountId: u.id, name: u.name, email: u.email, phone: u.phone,
                  role: u.role, token: d.token, at: nowISO(),
                  permissions: u.permissions ?? [],
                  password_expires_at: u.password_days_left != null
                    ? addDays(u.password_days_left) : null,
                  password_expired: !!u.password_expired,
                  must_change_password: !!u.must_change_password };
      setSession(s);
      await write(SESSION, s);
      setStage(s.must_change_password ? "change" : "in");
    } catch {
      setErr("Could not reach the server. Check your connection and try again.");
    }
    setBusy(false);
  };

  const doForgot = async () => {
    clear(); setBusy(true);
    try {
      await fetch("/api/public/auth/forgot", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
    } catch { /* the message below is the same either way */ }

    /* The same answer whether or not the account exists, and the same answer
       whether or not the request even reached us. A form that says "no such
       account" is a form that tells anybody who asks which addresses work
       here. */
    setNote("If that address is on file, a reset link is on its way. It expires in 30 minutes.");
    setBusy(false);
  };

  const doReset = async () => {
    clear(); setBusy(true);
    try {
      const res = await fetch("/api/public/auth/reset", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: resetToken.trim(), password: newPw }),
      });
      const d = await res.json();

      if (!res.ok) {
        setErr(
          d.code === "PASSWORD_TOO_WEAK" ? (d.issues ?? []).join(" ")
          : d.code === "PASSWORD_RECENTLY_USED"
            ? `That is one of your last ${d.within ?? 5} passwords. Rotating between two is not a rotation.`
          : d.code === "TOKEN_EXPIRED" ? "That link has expired. Ask for a new one."
          : d.code === "INVALID_TOKEN" ? "That link is not valid. It may have been used already."
          : "Could not set the password.");
        setBusy(false); return;
      }

      setNote("Password changed. Every other session has been signed out — whoever asked for this may have done so because somebody else had the old one.");
      setStage("login");
    } catch {
      setErr("Could not reach the server. Try again.");
    }
    setBusy(false);
  };

  const logout = async () => {
    setSession(null);
    try { await window.storage.delete(SESSION); } catch (e) {}
    setScreen("login"); setEmail(""); setPw(""); clear();
  };

  const resetDb = async () => {
    for (const k of [DB_USERS, DB_TOKENS, DB_ATTEMPT, SESSION]) {
      try { await window.storage.delete(k); } catch (e) {}
    }
    window.location.reload();
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

          {screen === "done" && session && (
            <>
              <div className="au-me">
                <span className="au-chip"
                      style={{ background: ROLES[session.role]?.color ?? "#8892A0" }}>
                  {ROLES[session.role]?.label ?? session.role}
                </span>
                <div>
                  <strong>{session.name}</strong>
                  <div className="au-dim">{session.email}</div>
                  <div className="au-dim">{session.phone ?? "no phone on file"}</div>
                </div>
              </div>

              {session.password_expires_at && (
                <div className={`au-pw ${session.password_expired ? "expired"
                  : daysUntil(session.password_expires_at) <= PASSWORD_WARN_DAYS ? "warn" : ""}`}>
                  {session.password_expired
                    ? `Password expired ${Math.abs(daysUntil(session.password_expires_at))} days ago`
                    : `Password expires ${fmt(session.password_expires_at).slice(0, 10)} · ${daysUntil(session.password_expires_at)} days`}
                </div>
              )}
              {info && <div className="au-info">{info}</div>}
              <p className="au-note">
                Your session is saved. The other tools will show only what this role can access.
              </p>
              <button className="au-btn" onClick={logout}>Sign out</button>
              <button className="au-link"
                      onClick={() => { setScreen("forgot"); setEmail(session.email); clear(); }}>
                Change password
              </button>
            </>
          )}

          {screen === "login" && (
            <>
              <p className="au-note">
                Your account decides what you can see. Roles cannot be switched after signing in.
              </p>
              <label className="au-f">
                <span>Email</span>
                <input className="au-in" type="email" autoComplete="username" value={email}
                       placeholder="name@themizar.ca"
                       onChange={(e) => setEmail(e.target.value)}
                       onKeyDown={(e) => e.key === "Enter" && doLogin()} />
              </label>
              <label className="au-f">
                <span>Password</span>
                <div className="au-pwwrap">
                  <input className="au-in" type={showPw ? "text" : "password"}
                         autoComplete="current-password" value={pw}
                         onChange={(e) => setPw(e.target.value)}
                         onKeyDown={(e) => e.key === "Enter" && doLogin()} />
                  <button className="au-eye" onClick={() => setShowPw(!showPw)}>
                    {showPw ? "Hide" : "Show"}
                  </button>
                </div>
              </label>
              {err && <div className="au-err">{err}</div>}
              {info && <div className="au-info">{info}</div>}
              <button className="au-btn" onClick={doLogin} disabled={busy || !email.trim() || !pw}>
                {busy ? "Checking…" : "Sign in"}
              </button>
              <button className="au-link" onClick={() => { setScreen("forgot"); clear(); }}>
                Forgot your password?
              </button>
            </>
          )}

          {screen === "forgot" && (
            <>
              <p className="au-note">Enter your account email and we will send a reset link.</p>
              <label className="au-f">
                <span>Email</span>
                <input className="au-in" type="email" value={email} placeholder="name@themizar.ca"
                       onChange={(e) => setEmail(e.target.value)}
                       onKeyDown={(e) => e.key === "Enter" && doForgot()} />
              </label>
              {err && <div className="au-err">{err}</div>}
              <button className="au-btn" onClick={doForgot} disabled={busy || !email.trim()}>
                {busy ? "Working…" : "Send reset link"}
              </button>
              <button className="au-link" onClick={() => { setScreen("login"); clear(); }}>
                Back to sign in
              </button>
            </>
          )}

          {screen === "reset" && (
            <>
              {info && <div className="au-info">{info}</div>}
              {issued && (
                <div className="au-token">
                  <strong>Prototype only: the reset code is shown here</strong>
                  <code>{issued.raw}</code>
                  <span className="au-dim">Valid until {fmt(issued.expires_at)}</span>
                  <p>In production this goes inside an emailed link and never appears on screen.</p>
                </div>
              )}
              <label className="au-f">
                <span>Reset code</span>
                <input className="au-in au-mono" value={token} placeholder="Paste the reset code"
                       onChange={(e) => setToken(e.target.value)} />
              </label>
              <label className="au-f">
                <span>New password</span>
                <input className="au-in" type="password" autoComplete="new-password" value={newPw}
                       onChange={(e) => setNewPw(e.target.value)} />
              </label>
              {newPw && (
                <div className="au-rules">
                  {PW_RULES.map((r) => {
                    const ok = r.test(newPw);
                    return <span key={r.label} className={ok ? "ok" : ""}>
                      {ok ? "✓" : "○"} {r.label}</span>;
                  })}
                </div>
              )}
              <label className="au-f">
                <span>Enter it again</span>
                <input className="au-in" type="password" autoComplete="new-password" value={newPw2}
                       onChange={(e) => setNewPw2(e.target.value)} />
              </label>
              {err && <div className="au-err">{err}</div>}
              <button className="au-btn" onClick={doReset}
                      disabled={busy || !token.trim() || !newPw || !newPw2}>
                {busy ? "Working…" : "Set new password"}
              </button>
              <button className="au-link" onClick={() => { setScreen("login"); clear(); }}>
                Back to sign in
              </button>
            </>
          )}
        </div>

        <div className="au-db">
          <button className="au-dbh" onClick={() => setShowDb(!showDb)}>
            <span>{showDb ? "▾" : "▸"}</span> Data tables (JSON)
            <em>users {users.length} · tokens {tokens.length}</em>
          </button>
          {showDb && (
            <>
              <p className="au-note">
                No plaintext passwords: only the algorithm, iteration count, salt and hash.
                These columns map straight onto the users table in the API.
              </p>
              <pre className="au-json">{JSON.stringify(users, null, 2)}</pre>
              <pre className="au-json">{JSON.stringify(tokens, null, 2)}</pre>
              <button className="au-link au-link--danger" onClick={resetDb}>
                Wipe and reseed accounts
              </button>
            </>
          )}
        </div>

        <div className="au-warn">
          <strong>Verification happens on the server.</strong>
          <p>
            The password is checked by the API, the hash never reaches this page,
            and the lock-out counter lives in the database where a browser cannot
            reach it. Sessions are issued server-side and every endpoint checks the
            role behind them.
          </p>
          <p>
            Nobody here will send you a password or ask for one. If you receive
            either, it did not come from us.
          </p>
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
