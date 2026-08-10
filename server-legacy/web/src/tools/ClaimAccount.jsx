import React, { useState, useEffect } from "react";

/* ============================================================
   Setting up a staff account

   Reached from an invitation. There is no self-registration here
   and there should not be: nothing that can post to the ledger
   should be openable by anybody who finds the address.

   Admin creates the account, the person chooses their own
   password. Nobody is ever sent one — a password in an email sits
   in two mailboxes forever, and it is the one credential the
   sender can also read.
   ============================================================ */

const MIN_LENGTH = 12;

export default function ClaimAccount() {
  const token = new URLSearchParams(window.location.search).get("token");
  const [info, setInfo] = useState(null);
  const [state, setState] = useState(token ? "loading" : "no_token");
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [issues, setIssues] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
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
        setIssues(d.issues ?? [d.detail ?? "That did not work."]);
        setBusy(false); return;
      }
      setState("done");
      setTimeout(() => { window.location.href = "/"; }, 2200);
    } catch {
      setIssues(["Could not reach the server. Try again."]);
    }
    setBusy(false);
  };

  const shell = (children) => (
    <div className="cl"><style>{CSS}</style>
      <div className="cl-card">
        <div className="cl-brand">
          <strong>Baydo Pointe</strong>
          <span>370 · 374 · 378 Clareview</span>
        </div>
        {children}
      </div>
    </div>
  );

  if (state === "no_token") return shell(<>
    <h1>Nothing to set up</h1>
    <p>
      Staff accounts are created by an administrator, who sends a link. There is
      no way to register from here, and there should not be — this console can
      post to the ledger.
    </p>
    <a className="cl-btn cl-btn--ghost" href="/">Back to sign in</a>
  </>);

  if (state === "loading") return shell(<p className="cl-dim">Loading…</p>);

  if (state === "expired") return shell(<>
    <h1>This link has expired</h1>
    <p>Invitations are good for 72 hours. Ask whoever set the account up to send another.</p>
    <a className="cl-btn cl-btn--ghost" href="/">Back to sign in</a>
  </>);

  if (state === "already_used") return shell(<>
    <h1>This link has been used</h1>
    <p>
      Each one works once. If the account is set up, sign in — or use the reset
      link if the password has been forgotten.
    </p>
    <a className="cl-btn" href="/">Sign in</a>
  </>);

  if (state === "invalid_token" || state === "error") return shell(<>
    <h1>This link is not valid</h1>
    <p>
      It may have been cut short by an email client. Try copying the whole link,
      or ask for a fresh one.
    </p>
    <a className="cl-btn cl-btn--ghost" href="/">Back to sign in</a>
  </>);

  if (state === "done") return shell(<>
    <h1>You are set up</h1>
    <div className="cl-ok">Password saved. Taking you to sign in.</div>
  </>);

  const tooShort = pw.length > 0 && pw.length < MIN_LENGTH;
  const mismatch = confirm.length > 0 && pw !== confirm;
  const ready = pw.length >= MIN_LENGTH && pw === confirm;

  return shell(<>
    <h1>Choose your password</h1>

    <div className="cl-for">
      <div><em>Account</em><strong>{info?.email}</strong></div>
      {info?.full_name && <div><em>Name</em><strong>{info.full_name}</strong></div>}
    </div>

    <label className="cl-f">
      <span>New password</span>
      <input className="cl-in" type="password" value={pw} autoFocus
             onChange={(e) => setPw(e.target.value)} />
      <em className={tooShort ? "cl-warn" : "cl-hint"}>
        At least {MIN_LENGTH} characters. Length carries more than symbols — a
        short phrase beats eight characters with punctuation, and it is the one
        you will still remember in March.
      </em>
    </label>

    <label className="cl-f">
      <span>Type it again</span>
      <input className="cl-in" type="password" value={confirm}
             onChange={(e) => setConfirm(e.target.value)} />
      {mismatch && <em className="cl-warn">These do not match.</em>}
    </label>

    {issues.length > 0 && (
      <div className="cl-err">{issues.map((x, i) => <div key={i}>{x}</div>)}</div>
    )}

    <button className="cl-btn" disabled={!ready || busy} onClick={submit}>
      {busy ? "Saving…" : "Set my password"}
    </button>

    <p className="cl-hint">
      It expires every 182 days and cannot be one of your last five. Nobody here
      will ever send you a password or ask for it — if you get one, it did not
      come from us.
    </p>
  </>);
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&family=Archivo:wght@700;800&display=swap');
.cl{min-height:100vh;background:var(--ground,#EDF0F3);display:flex;align-items:center;
  justify-content:center;padding:24px;font-family:'IBM Plex Sans',system-ui,sans-serif;
  font-size:14px;line-height:1.6;color:var(--ink,#131C25)}
.cl *{box-sizing:border-box}
.cl-card{background:#fff;border:1px solid var(--rule,#D3DBE1);border-radius:6px;
  padding:30px 32px;max-width:440px;width:100%;display:flex;flex-direction:column;gap:14px}
.cl-brand{padding-bottom:14px;border-bottom:1px solid var(--rule,#D3DBE1)}
.cl-brand strong{display:block;font-family:'Archivo',sans-serif;font-size:16px;
  color:var(--brand,#122542)}
.cl-brand span{display:block;font-size:11px;color:#78899A}
.cl h1{font-family:'Archivo',sans-serif;font-size:21px;letter-spacing:-.02em;margin:0}
.cl p{margin:0;color:#3E4C5A;line-height:1.75}
.cl-dim{color:#78899A}
.cl-for{display:flex;gap:24px;flex-wrap:wrap;border:1px solid var(--rule,#D3DBE1);
  border-radius:4px;padding:11px 14px}
.cl-for>div{display:flex;flex-direction:column;gap:1px}
.cl-for em{font-style:normal;font-size:10px;color:#78899A;text-transform:uppercase;
  letter-spacing:.06em;font-family:'IBM Plex Mono',monospace}
.cl-for strong{font-family:'IBM Plex Mono',monospace;font-size:13.5px}
.cl-f{display:flex;flex-direction:column;gap:5px}
.cl-f>span{font-size:12.5px;font-weight:600;color:#3E4C5A}
.cl-in{font:inherit;font-size:14px;padding:9px 11px;border:1px solid var(--rule,#D3DBE1);
  border-radius:4px;width:100%}
.cl-in:focus{outline:2px solid var(--brand,#122542);outline-offset:1px}
.cl-hint,.cl-warn{font-style:normal;font-size:11.5px;line-height:1.6}
.cl-hint{color:#78899A}
.cl-warn{color:#B26A3A}
.cl-btn{font:inherit;font-weight:600;font-size:14px;cursor:pointer;
  background:var(--brand,#122542);color:#fff;border:1px solid var(--brand,#122542);
  padding:10px 18px;border-radius:4px;text-align:center;text-decoration:none;
  display:inline-block}
.cl-btn:disabled{opacity:.4;cursor:not-allowed}
.cl-btn--ghost{background:transparent;color:#3E4C5A;border-color:var(--rule,#D3DBE1)}
.cl-err{font-size:12.5px;color:#B23A54;background:#FDF6F7;border:1px solid #B23A54;
  border-radius:4px;padding:10px 12px;display:flex;flex-direction:column;gap:3px}
.cl-ok{font-size:13px;color:#0E8577;background:#F5FAF8;border:1px solid #0E8577;
  border-radius:4px;padding:11px 13px}
`;
