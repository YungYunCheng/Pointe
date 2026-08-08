import React, { useState, useEffect } from "react";
import { ROLE_THEME } from "../lib/theme.jsx";

/* ============================================================
   Inviting staff

   Admin creates the account and sets the role. The person
   chooses their own password from a link.

   Nobody is sent a password. One in an email sits in two
   mailboxes forever, and it is the only credential the sender can
   also read.

   There is no self-registration for staff and there should not
   be. This console posts to the ledger.
   ============================================================ */

const ROLES = [
  {
    code: "property_manager",
    what: "Signs leases, decides renewals, approves documents, runs move-outs, releases keys.",
    // Said plainly, because the person choosing has to weigh it.
    reaches: "Can see the ledger but not post to it.",
  },
  {
    code: "building_manager",
    what: "Leads and viewings, maintenance, notices of entry, key handovers, purchase orders.",
    reaches: "No access to accounting at all.",
  },
  {
    code: "accounting",
    what: "The ledger, payables, receivables, bank reconciliation, month end, payroll.",
    reaches: "Can post entries and close a period. The only role that can.",
  },
  {
    code: "admin",
    what: "Everything, plus accounts, permissions, retention and backups.",
    reaches: "Give this one sparingly. It can restore a backup over live data.",
    caution: true,
  },
];

export default function InviteStaff() {
  const [session, setSession] = useState(undefined);
  const [users, setUsers] = useState([]);
  const [f, setF] = useState({ full_name: "", email: "", phone: "",
                               role_code: "building_manager", locale: "en" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [sent, setSent] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get("baydo:session");
        setSession(r?.value ? JSON.parse(r.value) : null);
      } catch { setSession(null); }
      try {
        const res = await fetch("/api/admin/users", { credentials: "include" });
        if (res.ok) setUsers((await res.json()).users ?? []);
      } catch {}
    })();
  }, []);

  const set = (p) => setF({ ...f, ...p });
  // A phone is required, not optional. An account reachable on one channel is
  // an account locked out the day that channel fails.
  const ok = f.full_name.trim() && f.email.includes("@") && f.phone.trim();

  const invite = async () => {
    setBusy(true); setErr(""); setSent(null);
    try {
      const res = await fetch("/api/admin/users/invite", {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "include", body: JSON.stringify(f),
      });
      const d = await res.json();
      if (!res.ok) {
        setErr(d.code === "EMAIL_IN_USE"
          ? "That address already has an account."
          : d.code === "PHONE_REQUIRED" ? d.detail
          : d.detail ?? "Could not create the account.");
        setBusy(false); return;
      }
      setSent({ ...f });
      setUsers([{ ...d.user, invited: true, is_active: false }, ...users]);
      setF({ full_name: "", email: "", phone: "",
             role_code: "building_manager", locale: "en" });
    } catch {
      setErr("Could not reach the server.");
    }
    setBusy(false);
  };

  const reinvite = async (id) => {
    try {
      const res = await fetch(`/api/admin/users/${id}/reinvite`, {
        method: "POST", credentials: "include" });
      if (res.ok) setErr("");
    } catch {}
  };

  if (session === undefined)
    return <div className="iv"><style>{CSS}</style><div className="iv-load">Loading…</div></div>;

  if (session && session.role !== "admin")
    return (
      <div className="iv"><style>{CSS}</style>
        <div className="iv-deny">
          <h2>Admin only</h2>
          <p>
            Creating accounts is the Admin role. You are signed in as {session.name}.
          </p>
        </div>
      </div>
    );

  const pending = users.filter((u) => u.invited && !u.password_hash);
  const role = ROLES.find((r) => r.code === f.role_code);

  return (
    <div className="iv">
      <style>{CSS}</style>

      <header className="iv-head">
        <div>
          <div className="iv-eyebrow">Baydo Pointe · Admin</div>
          <h1>Invite someone</h1>
        </div>
      </header>

      <div className="iv-body">
        <p className="iv-note">
          The account is created with no password and cannot be signed into. An
          invitation goes to the address you enter, and they choose their own
          password from it. The link works once and expires in 72 hours.
        </p>

        {sent && (
          <div className="iv-sent">
            <strong>Invitation sent to {sent.email}.</strong>
            <span>
              {" "}They are set up as {ROLE_THEME[sent.role_code]?.label}. Until they
              open the link the account exists but does nothing — that is the right
              state for one nobody has claimed.
            </span>
          </div>
        )}

        <section className="iv-card">
          <div className="iv-row">
            <label className="iv-f"><span>Name</span>
              <input className="iv-in" value={f.full_name}
                     onChange={(e) => set({ full_name: e.target.value })} /></label>
            <label className="iv-f"><span>Email</span>
              <input className="iv-in" type="email" value={f.email}
                     placeholder="name@themizar.ca"
                     onChange={(e) => set({ email: e.target.value })} />
              <em className="iv-hint">The invitation goes here.</em></label>
          </div>

          <div className="iv-row">
            <label className="iv-f"><span>Phone <em>required</em></span>
              <input className="iv-in" value={f.phone} placeholder="780-555-0100"
                     onChange={(e) => set({ phone: e.target.value })} />
              <em className="iv-hint">
                A second channel. One address is a lockout waiting for a mailbox
                to go down.
              </em></label>
            <label className="iv-f"><span>Language</span>
              <select className="iv-in" value={f.locale}
                      onChange={(e) => set({ locale: e.target.value })}>
                <option value="en">English</option>
                <option value="zh">繁體中文</option>
              </select></label>
          </div>

          <div className="iv-f">
            <span>Role</span>
            <div className="iv-roles">
              {ROLES.map((rr) => {
                const theme = ROLE_THEME[rr.code];
                const on = f.role_code === rr.code;
                return (
                  <button key={rr.code} className={`iv-role ${on ? "on" : ""}`}
                          style={on ? { "--c": theme?.ink } : undefined}
                          onClick={() => set({ role_code: rr.code })}>
                    <span className="iv-dot" style={{ background: theme?.ink }} />
                    <strong>{theme?.label}</strong>
                  </button>
                );
              })}
            </div>
          </div>

          {role && (
            <div className={`iv-what ${role.caution ? "caution" : ""}`}>
              <p><strong>What they will be able to do.</strong> {role.what}</p>
              <p className="iv-dim">{role.reaches}</p>
            </div>
          )}

          {err && <div className="iv-err">{err}</div>}

          <div className="iv-actions">
            <button className="iv-btn" disabled={!ok || busy} onClick={invite}>
              {busy ? "Sending…" : "Create and send the invitation"}
            </button>
            <span className="iv-dim">
              Nobody is sent a password, including by us.
            </span>
          </div>
        </section>

        {pending.length > 0 && (
          <section className="iv-card">
            <h2>Waiting to be claimed <span className="iv-n">{pending.length}</span></h2>
            <p className="iv-note">
              These accounts exist and cannot be signed into. If a link has expired
              or never arrived, sending another cancels the first — two live links to
              one account means two ways in, and only one of them was asked for.
            </p>
            {pending.map((u) => (
              <div className="iv-pending" key={u.id}>
                <span className="iv-dot"
                      style={{ background: ROLE_THEME[u.role_code]?.ink }} />
                <div>
                  <strong>{u.full_name}</strong>
                  <span className="iv-dim"> {u.email}</span>
                  <div className="iv-dim">
                    {ROLE_THEME[u.role_code]?.label} · invited{" "}
                    {String(u.invited_at ?? "").slice(0, 10)}
                  </div>
                </div>
                <button className="iv-btn iv-btn--sm iv-btn--ghost"
                        onClick={() => reinvite(u.id)}>Send another</button>
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&family=Archivo:wght@700;800&display=swap');
.iv{--paper:#fff;--ink2:#3E4C5A;--dim:#78899A;--ground:#EDF0F3;--rule:#D3DBE1;
  --red:#B23A54;--green:#0E8577;--amber:#FFF6E0;--amberline:#E8C877;
  background:var(--ground);color:var(--ink,#131C25);min-height:100vh;font-size:14px;
  line-height:1.55;font-family:'IBM Plex Sans',system-ui,sans-serif;padding-bottom:44px}
.iv *{box-sizing:border-box}
.iv-dim{color:var(--dim);font-size:12.5px}
.iv-load{padding:80px 20px;text-align:center;color:var(--dim)}
.iv-deny{max-width:440px;margin:70px auto;background:var(--paper);
  border:1px solid var(--rule);border-radius:5px;padding:26px 24px}
.iv-deny h2{font-family:'Archivo',sans-serif;margin:0 0 8px}
.iv-deny p{margin:0;font-size:13px;color:var(--ink2);line-height:1.7}

.iv-head{padding:22px 26px 16px;background:var(--paper);border-bottom:1px solid var(--rule)}
.iv-eyebrow{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.13em;
  text-transform:uppercase;color:var(--dim)}
.iv-head h1{font-family:'Archivo',sans-serif;font-weight:800;font-size:23px;
  letter-spacing:-.02em;margin:4px 0 0;color:var(--brand)}

.iv-body{padding:18px 26px;max-width:820px;display:flex;flex-direction:column;gap:14px}
.iv-note{color:var(--dim);font-size:12.5px;margin:0;line-height:1.75;max-width:74ch}
.iv-card{background:var(--paper);border:1px solid var(--rule);border-radius:5px;
  padding:18px 20px;display:flex;flex-direction:column;gap:13px}
.iv-card h2{font-family:'Archivo',sans-serif;font-size:16px;margin:0;
  display:flex;align-items:center;gap:9px}
.iv-n{font-family:'IBM Plex Mono',monospace;font-size:11px;background:var(--ground);
  color:var(--dim);border-radius:9px;padding:1px 8px}

.iv-row{display:flex;gap:12px;flex-wrap:wrap}
.iv-row>*{flex:1 1 200px}
.iv-f{display:flex;flex-direction:column;gap:5px}
.iv-f>span{font-size:12.5px;font-weight:600;color:var(--ink2)}
.iv-f>span em{font-style:normal;font-weight:400;color:var(--dim)}
.iv-hint{font-style:normal;font-size:11.5px;color:var(--dim);line-height:1.6}
.iv-in{font:inherit;font-size:13.5px;padding:8px 11px;border:1px solid var(--rule);
  border-radius:4px;background:var(--paper);width:100%}
.iv-in:focus{outline:2px solid var(--brand);outline-offset:1px}

.iv-roles{display:flex;gap:7px;flex-wrap:wrap}
.iv-role{font:inherit;font-size:13px;cursor:pointer;background:var(--paper);
  border:1px solid var(--rule);border-radius:4px;padding:8px 14px;color:var(--ink2);
  display:flex;align-items:center;gap:8px}
.iv-role.on{border-color:var(--c);background:#FCFDFE;font-weight:600}
.iv-dot{width:9px;height:9px;border-radius:50%;flex:0 0 9px}
.iv-what{border-left:3px solid var(--brand);background:var(--brand-tint,#EEF2F7);
  border-radius:3px;padding:11px 14px}
.iv-what.caution{border-left-color:var(--amberline);background:var(--amber)}
.iv-what p{margin:0 0 4px;font-size:12.5px;color:var(--ink2);line-height:1.7}
.iv-what p:last-child{margin:0}

.iv-sent{background:#F5FAF8;border:1px solid var(--green);border-radius:4px;
  padding:11px 14px;font-size:12.5px;color:var(--green);line-height:1.75}
.iv-sent span{color:var(--ink2)}
.iv-err{font-size:12.5px;color:var(--red);background:#FDF6F7;border:1px solid var(--red);
  border-radius:4px;padding:10px 12px}
.iv-pending{display:flex;gap:11px;align-items:center;padding:10px 0;
  border-bottom:1px solid #F0F3F5}
.iv-pending:last-child{border-bottom:0}
.iv-pending>div{flex:1}
.iv-pending strong{font-size:13.5px}

.iv-btn{font:inherit;font-weight:600;font-size:13.5px;cursor:pointer;
  background:var(--brand);color:#fff;border:1px solid var(--brand);
  padding:9px 16px;border-radius:4px}
.iv-btn:disabled{opacity:.4;cursor:not-allowed}
.iv-btn--ghost{background:transparent;color:var(--ink2);border-color:var(--rule)}
.iv-btn--sm{padding:6px 12px;font-size:12.5px}
.iv-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}

@media (max-width:640px){ .iv-head,.iv-body{padding-left:16px;padding-right:16px} }
`;
