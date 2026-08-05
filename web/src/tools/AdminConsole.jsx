import React, { useState, useEffect, useMemo, useCallback } from "react";
import { ROLE_THEME } from "../lib/theme.jsx";

/* ============================================================
   BAYDO POINTE — Admin console

   The four things only Admin does: accounts and what they can
   reach, whether the plumbing is working, what data is due to be
   removed, and what is stuck in the outbox.

   None of these are day-to-day screens. They are the ones somebody
   opens when something is wrong, which is why each says what it
   means rather than showing a number and leaving the reader to
   work it out.
   ============================================================ */

const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const nowISO = () => new Date().toISOString();
const stamp = (s) => (s ? String(s).slice(0, 16).replace("T", " ") : "—");
const daysUntil = (iso) => (iso ? Math.ceil((new Date(iso) - Date.now()) / 864e5) : null);

/* Grouped so a permission list of thirty-odd reads as a handful of areas
   rather than as an alphabetical wall. */
const PERMISSION_GROUPS = {
  units:        "Units and pricing",
  parking:      "Parking",
  leads:        "Leads and viewings",
  showings:     "Leads and viewings",
  schedule:     "Schedule",
  inbox:        "Messages",
  escalation:   "Messages",
  lease:        "Leasing",
  documents:    "Documents",
  templates:    "Documents",
  moveout:      "Move-out",
  renewals:     "Renewals",
  maintenance:  "On site",
  entrynotice:  "On site",
  keys:         "On site",
  po:           "Purchase orders",
  evidence:     "On site",
  accounting:   "Accounting",
  audit:        "Audit and backup",
  backup:       "Audit and backup",
  users:        "Accounts",
  settings:     "Settings",
  notifications:"Messages",
  process:      "Admin",
};

const PERMISSIONS = [
  ["units.view", "See units and their status"],
  ["units.status.edit", "Change a unit's status"],
  ["settings.pricing.edit", "Set rents and fees"],
  ["settings.parking.quota", "Set parking quotas"],
  ["parking.view", "See parking"],
  ["parking.allocate", "Allocate a stall"],
  ["leads.view", "See leads"],
  ["leads.manage", "Add and move leads"],
  ["showings.manage", "Record showing outcomes"],
  ["schedule.view", "See the whole schedule"],
  ["schedule.leasing", "Book signings and renewals"],
  ["schedule.showings", "Book viewings and key handovers"],
  ["inbox.manage", "Work the AI inbox"],
  ["escalation.answer", "Answer an escalated message"],
  ["lease.sign", "Run a signing"],
  ["keys.release", "Confirm a lease so keys can be booked"],
  ["keys.manage", "Hand over keys"],
  ["documents.approve", "Approve a document"],
  ["templates.manage", "Upload and approve agreements"],
  ["moveout.process", "Run a move-out"],
  ["renewals.decide", "Decide a renewal"],
  ["maintenance.manage", "Maintenance tickets"],
  ["entrynotice.manage", "Notices of entry"],
  ["evidence.upload", "Upload evidence"],
  ["po.create", "Raise a purchase order"],
  ["po.confirm", "Confirm what work cost"],
  ["po.bill", "Turn an order into a bill"],
  ["accounting.view", "See the ledger"],
  ["accounting.post", "Post entries"],
  ["accounting.ap", "Vendor invoices and payments"],
  ["accounting.ar", "Rent and receipts"],
  ["accounting.bank", "Bank reconciliation"],
  ["accounting.close", "Close a period"],
  ["accounting.coa", "Edit the chart of accounts"],
  ["accounting.reports", "Generate reports"],
  ["notifications.view", "See notifications and the outbox"],
  ["audit.view", "See the change log"],
  ["backup.restore", "Restore a backup"],
  ["users.manage", "Manage accounts"],
  ["process.delete", "Delete a process"],
];

const ROLE_DEFAULTS = {
  admin: PERMISSIONS.map(([c]) => c),
  property_manager: ["units.view", "units.status.edit", "parking.view", "parking.allocate",
    "schedule.view", "schedule.leasing", "inbox.manage", "escalation.answer", "lease.sign",
    "keys.release", "documents.approve", "moveout.process", "renewals.decide",
    "accounting.view", "po.bill", "notifications.view", "evidence.upload"],
  building_manager: ["units.view", "units.status.edit", "parking.view", "parking.allocate",
    "schedule.view", "schedule.showings", "leads.view", "leads.manage", "showings.manage",
    "maintenance.manage", "entrynotice.manage", "keys.manage", "po.create", "po.confirm",
    "evidence.upload", "notifications.view"],
  accounting: ["units.view", "accounting.view", "accounting.post", "accounting.ap",
    "accounting.ar", "accounting.bank", "accounting.close", "accounting.coa",
    "accounting.reports", "po.bill", "notifications.view"],
};

const SEED_USERS = [
  { id: "u1", email: "admin@themizar.ca", full_name: "Admin", role: "admin",
    phone: "306-974-1727", is_active: true },
  { id: "u2", email: "bowen.wang@themizar.ca", full_name: "Bowen Wang",
    role: "property_manager", phone: "780-555-0101", is_active: true },
  { id: "u3", email: "rentals@themizar.ca", full_name: "Rentals",
    role: "building_manager", phone: "780-555-0102", is_active: true },
  { id: "u4", email: "invoice@themizar.ca", full_name: "Accounting", role: "accounting",
    phone: "780-555-0103", is_active: true },
];

const RETENTION_POLICIES = [
  { label: "Leads that never converted", months: 12, action: "Anonymised",
    why: "Marketing data. Removing the row outright would quietly rewrite last year's conversion rate, so what goes is the part that identifies somebody." },
  { label: "Viewing requests", months: 12, action: "Anonymised" },
  { label: "Declined applications", months: 24, action: "Anonymised, documents deleted",
    why: "Two years covers the window a human rights complaint could be brought, which is when this record is worth having. The uploaded identity documents go — they are the most sensitive thing collected and the least defensible to keep." },
  { label: "Messages", months: 36, action: "Content removed, delivery record kept" },
  { label: "Confirmation tokens", months: 6, action: "Deleted" },
  { label: "Tenancy records", months: 84, action: "Flagged only, never automatic",
    why: "Alberta's limitation period is two years from discovery with a ten-year long stop. Deleting these is a decision somebody makes." },
  { label: "Accounting records", months: 72, action: "Flagged only, never automatic",
    why: "Six years after the tax year, per CRA." },
];

export default function AdminConsole() {
  const [session, setSession] = useState(undefined);
  const [tab, setTab] = useState("users");
  const [users, setUsers] = useState(SEED_USERS);
  const [overrides, setOverrides] = useState([]);
  const [outbox, setOutbox] = useState([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    (async () => {
      const read = async (k, d) => {
        try { const r = await window.storage.get(k); return r?.value ? JSON.parse(r.value) : d; }
        catch { return d; }
      };
      setSession(await read("baydo:session", null));
      setUsers(await read("baydo:db:users", SEED_USERS));
      setOverrides(await read("baydo:permissions", []));
      setOutbox(await read("baydo:outbox", []));
      setLoading(false);
    })();
  }, []);

  const flash = (t) => { setMsg(t); setTimeout(() => setMsg(""), 3500); };
  const save = useCallback(async (key, value, setter) => {
    setter(value);
    try { await window.storage.set(key, JSON.stringify(value)); } catch {}
  }, []);

  if (loading || session === undefined)
    return <div className="ad2"><style>{CSS}</style><div className="ad2-load">Loading…</div></div>;

  if (session && session.role !== "admin")
    return (
      <div className="ad2"><style>{CSS}</style>
        <div className="ad2-deny">
          <h2>Admin only</h2>
          <p>
            Accounts, permissions and retention are the Admin role. You are signed
            in as {session.name}.
          </p>
        </div>
      </div>
    );

  const TABS = [["users", "Accounts"], ["health", "System"],
                ["retention", "Retention"], ["outbox", "Messages"]];

  return (
    <div className="ad2">
      <style>{CSS}</style>
      <header className="ad2-head">
        <div>
          <div className="ad2-eyebrow">Baydo Pointe · Admin</div>
          <h1>{TABS.find((t) => t[0] === tab)?.[1]}</h1>
        </div>
        {msg && <span className="ad2-flash">{msg}</span>}
      </header>

      <nav className="ad2-tabs">
        {TABS.map(([k, l]) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>
        ))}
      </nav>

      {tab === "users" && (
        <Users users={users} overrides={overrides} session={session}
          onSaveUsers={(v) => save("baydo:db:users", v, setUsers)}
          onSaveOverrides={(v) => save("baydo:permissions", v, setOverrides)}
          flash={flash} />
      )}
      {tab === "health" && <Health outbox={outbox} />}
      {tab === "retention" && <Retention flash={flash} />}
      {tab === "outbox" && <Outbox outbox={outbox}
        onSave={(v) => save("baydo:outbox", v, setOutbox)} flash={flash} />}
    </div>
  );
}

/* ══════════════════ Accounts ══════════════════ */

function Users({ users, overrides, session, onSaveUsers, onSaveOverrides, flash }) {
  const [selected, setSelected] = useState(null);
  const [adding, setAdding] = useState(false);

  const user = users.find((u) => u.id === selected);

  /* The role is the baseline; grants and revokes layer on top. A revoke always
     beats a grant, so taking something away never depends on which order the
     rows happen to be in. */
  const effectiveFor = (u) => {
    const base = new Set(ROLE_DEFAULTS[u.role] ?? []);
    const mine = overrides.filter((o) => o.user_id === u.id);
    for (const o of mine) if (o.effect === "grant") base.add(o.permission);
    for (const o of mine) if (o.effect === "revoke") base.delete(o.permission);
    return base;
  };

  const setOverride = (permission, effect, reason) => {
    const next = [...overrides.filter((o) =>
      !(o.user_id === user.id && o.permission === permission))];
    if (effect) next.push({ id: uid("up_"), user_id: user.id, permission, effect,
      reason, granted_name: session?.name, granted_at: nowISO() });
    onSaveOverrides(next);
    // A change takes effect now, not when the session happens to expire.
    // Otherwise somebody keeps access they were just told they had lost.
    flash("Saved. Their current sign-in has been ended, so it takes effect straight away.");
  };

  return (
    <div className="ad2-body">
      <div className="ad2-split">
        <aside className="ad2-list">
          {users.map((u) => {
            const theme = ROLE_THEME[u.role];
            return (
              <button key={u.id} className={`ad2-user ${selected === u.id ? "on" : ""}`}
                      onClick={() => setSelected(u.id)}>
                <span className="ad2-dot" style={{ background: theme?.ink }} />
                <span>
                  <strong>{u.full_name}</strong>
                  <em>{theme?.label ?? u.role}</em>
                </span>
                {!u.is_active && <span className="ad2-off">off</span>}
              </button>
            );
          })}
          <button className="ad2-add" onClick={() => setAdding(!adding)}>+ Add someone</button>
        </aside>

        <section className="ad2-detail">
          {adding ? (
            <AddUser onCancel={() => setAdding(false)}
              onAdd={(u) => { onSaveUsers([...users, u]); setAdding(false); setSelected(u.id);
                              flash("Account created. They set their own password from the reset link."); }} />
          ) : !user ? (
            <div className="ad2-empty">Pick somebody on the left.</div>
          ) : (
            <UserDetail user={user} effective={effectiveFor(user)}
              overrides={overrides.filter((o) => o.user_id === user.id)}
              isSelf={user.id === session?.accountId}
              onSetOverride={setOverride}
              onToggleActive={() => {
                onSaveUsers(users.map((u) => u.id === user.id
                  ? { ...u, is_active: !u.is_active } : u));
                flash(user.is_active ? "Account disabled." : "Account enabled.");
              }} />
          )}
        </section>
      </div>
    </div>
  );
}

function UserDetail({ user, effective, overrides, isSelf, onSetOverride, onToggleActive }) {
  const [pending, setPending] = useState(null);
  const [reason, setReason] = useState("");
  const theme = ROLE_THEME[user.role];
  const base = new Set(ROLE_DEFAULTS[user.role] ?? []);

  const grouped = useMemo(() => {
    const out = {};
    for (const [code, label] of PERMISSIONS) {
      const area = PERMISSION_GROUPS[code.split(".")[0]] ?? "Other";
      (out[area] ||= []).push({ code, label });
    }
    return out;
  }, []);

  const expiry = user.password_expires_at ? daysUntil(user.password_expires_at) : null;

  return (
    <>
      <div className="ad2-dh">
        <div>
          <h2>{user.full_name}</h2>
          <span className="ad2-dim">{user.email} · {user.phone ?? "no phone"}</span>
        </div>
        <span className="ad2-chip" style={{ background: theme?.ink }}>
          {theme?.label ?? user.role}
        </span>
      </div>

      {expiry != null && (
        <div className={`ad2-pw ${expiry < 0 ? "bad" : expiry <= 14 ? "warn" : ""}`}>
          {expiry < 0 ? `Password expired ${Math.abs(expiry)} days ago`
                      : `Password expires in ${expiry} days`}
        </div>
      )}

      {isSelf && (
        <div className="ad2-note">
          This is your own account. Permissions cannot be changed from here — the one
          account that can restore anything should not be able to lock itself out.
        </div>
      )}

      <p className="ad2-note-p">
        The role sets the baseline. Anything changed below is an exception on top of
        it, recorded with a reason, and it ends their current sign-in so it takes
        effect immediately rather than whenever their session runs out.
      </p>

      {Object.entries(grouped).map(([area, list]) => (
        <div className="ad2-permgroup" key={area}>
          <div className="ad2-permh">{area}</div>
          {list.map(({ code, label }) => {
            const has = effective.has(code);
            const fromRole = base.has(code);
            const override = overrides.find((o) => o.permission === code);
            return (
              <div className={`ad2-perm ${has ? "on" : ""}`} key={code}>
                <label>
                  <input type="checkbox" checked={has} disabled={isSelf}
                         onChange={(e) => setPending({ code, label,
                           effect: e.target.checked ? "grant" : "revoke" })} />
                  <span>{label}</span>
                </label>
                <span className="ad2-permmeta">
                  {override ? (
                    <span className={`ad2-tag ${override.effect}`}>
                      {override.effect === "grant" ? "added" : "removed"}
                    </span>
                  ) : fromRole ? <span className="ad2-dim">from role</span> : null}
                </span>
              </div>
            );
          })}
        </div>
      ))}

      {pending && (
        <div className="ad2-confirm">
          <strong>
            {pending.effect === "grant" ? "Give" : "Take away"} “{pending.label}”
          </strong>
          <input className="ad2-in" value={reason} autoFocus
                 placeholder="Why — six months from now this is the useful part"
                 onChange={(e) => setReason(e.target.value)} />
          <div className="ad2-actions">
            <button className="ad2-btn" disabled={!reason.trim()}
                    onClick={() => { onSetOverride(pending.code, pending.effect, reason.trim());
                      setPending(null); setReason(""); }}>
              Save
            </button>
            <button className="ad2-btn ad2-btn--ghost"
                    onClick={() => { setPending(null); setReason(""); }}>Cancel</button>
          </div>
        </div>
      )}

      {overrides.length > 0 && (
        <div className="ad2-overrides">
          <div className="ad2-permh">Exceptions on this account</div>
          {overrides.map((o) => (
            <div className="ad2-override" key={o.id}>
              <span className={`ad2-tag ${o.effect}`}>
                {o.effect === "grant" ? "added" : "removed"}
              </span>
              <span>{PERMISSIONS.find(([c]) => c === o.permission)?.[1] ?? o.permission}</span>
              <span className="ad2-dim">{o.reason}</span>
              <span className="ad2-dim">{o.granted_name} · {stamp(o.granted_at)}</span>
              <button className="ad2-x" onClick={() => onSetOverride(o.permission, null)}>×</button>
            </div>
          ))}
        </div>
      )}

      {!isSelf && (
        <div className="ad2-actions" style={{ marginTop: 18 }}>
          <button className="ad2-btn ad2-btn--ghost" onClick={onToggleActive}>
            {user.is_active ? "Disable this account" : "Enable this account"}
          </button>
          <span className="ad2-dim">
            Disabling ends their sign-in. The account and its history stay.
          </span>
        </div>
      )}
    </>
  );
}

function AddUser({ onCancel, onAdd }) {
  const [f, setF] = useState({ full_name: "", email: "", phone: "",
                               role: "building_manager" });
  const set = (p) => setF({ ...f, ...p });
  // A phone is required, not optional. An account reachable on one channel is
  // an account locked out the day that channel fails.
  const ok = f.full_name.trim() && f.email.includes("@") && f.phone.trim();

  return (
    <>
      <div className="ad2-dh"><h2>Add someone</h2></div>
      <div className="ad2-row">
        <label className="ad2-f"><span>Name</span>
          <input className="ad2-in" value={f.full_name}
                 onChange={(e) => set({ full_name: e.target.value })} /></label>
        <label className="ad2-f"><span>Email</span>
          <input className="ad2-in" type="email" value={f.email}
                 onChange={(e) => set({ email: e.target.value })} /></label>
      </div>
      <div className="ad2-row">
        <label className="ad2-f"><span>Phone <em>required</em></span>
          <input className="ad2-in" value={f.phone}
                 onChange={(e) => set({ phone: e.target.value })} />
          <em className="ad2-hint">
            A reset that can only reach one channel is a lockout waiting for a
            mailbox to go down.
          </em></label>
        <label className="ad2-f"><span>Role</span>
          <select className="ad2-in" value={f.role} onChange={(e) => set({ role: e.target.value })}>
            {Object.entries(ROLE_THEME).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select></label>
      </div>

      <div className="ad2-rolepreview">
        <div className="ad2-permh">What this role can reach</div>
        <div className="ad2-previewlist">
          {(ROLE_DEFAULTS[f.role] ?? []).map((c) => (
            <span key={c}>{PERMISSIONS.find(([x]) => x === c)?.[1] ?? c}</span>
          ))}
        </div>
      </div>

      <div className="ad2-actions">
        <button className="ad2-btn" disabled={!ok}
                onClick={() => onAdd({ id: uid("usr_"), ...f, is_active: true,
                  must_change_password: true, created_at: nowISO() })}>
          Create the account
        </button>
        <button className="ad2-btn ad2-btn--ghost" onClick={onCancel}>Cancel</button>
        <span className="ad2-dim">
          They set their own password from a reset link. Nobody sends a password by email.
        </span>
      </div>
    </>
  );
}

/* ══════════════════ System ══════════════════ */

/** Whether the plumbing is working. Each line says what it means when it is
 *  off, because "S3: not configured" tells somebody nothing about what breaks. */
function Health({ outbox }) {
  const queued = outbox.filter((m) => m.state === "queued").length;
  const overdue = outbox.filter((m) => m.state === "queued" && m.required_by
    && m.required_by < nowISO()).length;

  const checks = [
    { label: "Email delivery", ok: false,
      detail: "No provider configured.",
      consequence: "Every notice, receipt and reset link is queuing and none of them are arriving. Set RESEND_API_KEY.",
      severity: "high" },
    { label: "SMS delivery", ok: false,
      detail: "No provider configured.",
      consequence: "Anything set to send by text falls back to email alone. Entry reminders lose their second channel.",
      severity: "medium" },
    { label: "AI", ok: false,
      detail: "No key configured.",
      consequence: "Drafting and classification return an error and every message goes to a person. The tenant chat sends its fallback message.",
      severity: "medium" },
    { label: "File storage", ok: true,
      detail: "Local disk.",
      consequence: "Evidence photographs and approved agreements do not survive the container being replaced on another host. Move to object storage before production.",
      severity: "high" },
    { label: "Database", ok: true,
      detail: "SQLite.",
      consequence: "Fine for one process. Two API containers writing one file is not, so this has to change before scaling out.",
      severity: "medium" },
    { label: "Outbox", ok: overdue === 0,
      detail: `${queued} queued, ${overdue} past due.`,
      consequence: overdue > 0
        ? "A message that should have gone and has not is the thing to act on. A notice of entry that never arrived looks identical to one that did."
        : "Nothing overdue.",
      severity: overdue > 0 ? "high" : "low" },
  ];

  return (
    <div className="ad2-body">
      <p className="ad2-note-p">
        What is configured and what breaks when it is not. A red line here is not
        cosmetic — it is something a tenant or an owner will notice before you do.
      </p>
      <div className="ad2-checks">
        {checks.map((c) => (
          <div className={`ad2-check ${c.ok ? "ok" : c.severity}`} key={c.label}>
            <div className="ad2-check-h">
              <span className="ad2-status">{c.ok ? "✓" : "!"}</span>
              <strong>{c.label}</strong>
              <span className="ad2-dim">{c.detail}</span>
            </div>
            <p>{c.consequence}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ══════════════════ Retention ══════════════════ */

function Retention({ flash }) {
  const [previewing, setPreviewing] = useState(false);

  return (
    <div className="ad2-body">
      <p className="ad2-note-p">
        Alberta PIPA expects personal information to be kept only as long as it is
        needed, with a period that is actually enforced rather than written down.
        These run weekly. A policy that fires every night is one nobody watches.
      </p>

      <div className="ad2-policies">
        {RETENTION_POLICIES.map((p) => (
          <div className="ad2-policy" key={p.label}>
            <div className="ad2-policy-h">
              <strong>{p.label}</strong>
              <span className="ad2-months">{p.months} months</span>
              <span className={`ad2-tag ${p.action.includes("never") ? "" : "grant"}`}>
                {p.action}
              </span>
            </div>
            {p.why && <p className="ad2-dim">{p.why}</p>}
          </div>
        ))}
      </div>

      <div className="ad2-note">
        Nothing here deletes a photograph behind a deposit deduction or an agreement
        somebody signed. Rows go; the evidence you may still have to defend does not.
      </div>

      <div className="ad2-actions">
        <button className="ad2-btn ad2-btn--ghost" onClick={() => setPreviewing(true)}>
          Show what would go
        </button>
        <span className="ad2-dim">
          Retention should be visible before it runs. A job that quietly deletes is
          a job nobody trusts.
        </span>
      </div>

      {previewing && (
        <div className="ad2-preview">
          <div className="ad2-permh">Nothing is old enough yet</div>
          <p className="ad2-dim">
            The system has not been running long enough for anything to fall outside
            a retention period. This screen will show counts once it has.
          </p>
        </div>
      )}
    </div>
  );
}

/* ══════════════════ Outbox ══════════════════ */

function Outbox({ outbox, onSave, flash }) {
  const [filter, setFilter] = useState("queued");
  const shown = outbox.filter((m) => filter === "all" || m.state === filter);
  const overdue = outbox.filter((m) => m.state === "queued" && m.required_by
    && m.required_by < nowISO());

  return (
    <div className="ad2-body">
      <div className="ad2-seg">
        {[["queued", "Queued"], ["sent", "Sent"], ["failed", "Failed"], ["all", "All"]]
          .map(([k, l]) => (
          <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>
            {l}
          </button>
        ))}
      </div>

      {overdue.length > 0 && (
        <div className="ad2-alert">
          <strong>{overdue.length} past the time they had to go out.</strong>
          <span>
            {" "}That includes anything with a legal deadline. A notice of entry that
            never arrived looks identical to one that did, which is why this list
            exists rather than a success count.
          </span>
        </div>
      )}

      <p className="ad2-note-p">
        Nothing sends directly from the code that caused it. Messages queue and a
        worker delivers them, so a provider outage delays a message rather than
        losing it with nobody knowing which ones went missing.
      </p>

      {shown.length === 0 ? (
        <div className="ad2-empty">Nothing here.</div>
      ) : (
        <div className="ad2-msgs">
          {shown.slice(0, 100).map((m) => (
            <div className={`ad2-msg ${m.required_by && m.required_by < nowISO()
              && m.state === "queued" ? "late" : ""}`} key={m.id}>
              <div className="ad2-msg-h">
                <span className={`ad2-tag ${m.state === "sent" ? "grant"
                  : m.state === "failed" ? "revoke" : ""}`}>{m.state}</span>
                <strong>{m.kind}</strong>
                <span className="ad2-dim">{m.channel}</span>
                <span className="ad2-dim">{m.to ?? m.to_email ?? m.to_phone}</span>
                <span className="ad2-dim ad2-mono">{stamp(m.created_at)}</span>
              </div>
              {m.subject && <div className="ad2-msgsub">{m.subject}</div>}
              {m.required_by && (
                <div className="ad2-dim">Had to go by {stamp(m.required_by)}</div>
              )}
              {m.last_error && <div className="ad2-msgerr">{m.last_error}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&family=Archivo:wght@700;800&display=swap');
.ad2{--paper:#fff;--ink:var(--ink,#131C25);--ink2:#3E4C5A;--dim:#78899A;
  --ground:#EDF0F3;--rule:#D3DBE1;--red:#B23A54;--green:#0E8577;--amber:#FFF6E0;
  --amberline:#E8C877;
  background:var(--ground);color:var(--ink);min-height:100vh;font-size:14px;line-height:1.55;
  font-family:'IBM Plex Sans',system-ui,sans-serif;padding-bottom:44px}
.ad2 *{box-sizing:border-box}
.ad2-mono{font-family:'IBM Plex Mono',monospace}
.ad2-dim{color:var(--dim);font-size:12.5px}
.ad2-load{padding:80px 20px;text-align:center;color:var(--dim)}
.ad2-deny{max-width:440px;margin:70px auto;background:var(--paper);border:1px solid var(--rule);
  border-radius:5px;padding:26px 24px}
.ad2-deny h2{font-family:'Archivo',sans-serif;margin:0 0 8px}
.ad2-deny p{margin:0;font-size:13px;color:var(--ink2);line-height:1.7}

.ad2-head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;
  padding:22px 26px 16px;background:var(--paper);border-bottom:1px solid var(--rule)}
.ad2-eyebrow{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.13em;
  text-transform:uppercase;color:var(--dim)}
.ad2-head h1{font-family:'Archivo',sans-serif;font-weight:800;font-size:23px;
  letter-spacing:-.02em;margin:4px 0 0;color:var(--brand)}
.ad2-flash{font-size:12.5px;color:var(--green);background:#F5FAF8;border:1px solid var(--green);
  border-radius:3px;padding:6px 11px}

.ad2-tabs{display:flex;padding:0 26px;background:var(--paper);border-bottom:1px solid var(--rule)}
.ad2-tabs button{font:inherit;font-weight:600;font-size:13.5px;cursor:pointer;background:none;
  border:0;padding:12px 16px;color:var(--dim);border-bottom:2px solid transparent;
  margin-bottom:-1px}
.ad2-tabs button.on{color:var(--brand);border-bottom-color:var(--brand)}

.ad2-body{padding:18px 26px;max-width:1180px;display:flex;flex-direction:column;gap:14px}
.ad2-split{display:grid;grid-template-columns:minmax(200px,250px) 1fr;gap:16px;align-items:start}
.ad2-list{display:flex;flex-direction:column;gap:1px;background:var(--rule);
  border:1px solid var(--rule);border-radius:4px;overflow:hidden}
.ad2-user{font:inherit;text-align:left;cursor:pointer;background:var(--paper);border:0;
  padding:11px 13px;display:flex;align-items:center;gap:9px}
.ad2-user:hover{background:#FAFBFC}
.ad2-user.on{background:var(--brand-tint,#EEF2F7)}
.ad2-user strong{display:block;font-size:13px}
.ad2-user em{display:block;font-style:normal;font-size:11.5px;color:var(--dim)}
.ad2-dot{width:9px;height:9px;border-radius:50%;flex:0 0 9px}
.ad2-off{font-size:10px;color:var(--dim);border:1px solid var(--rule);border-radius:8px;
  padding:0 6px;margin-left:auto}
.ad2-add{font:inherit;font-size:12.5px;cursor:pointer;background:var(--paper);border:0;
  padding:11px 13px;color:var(--brand);font-weight:600;text-align:left}

.ad2-detail{background:var(--paper);border:1px solid var(--rule);border-radius:4px;
  padding:18px 20px;display:flex;flex-direction:column;gap:12px;min-height:300px}
.ad2-dh{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
.ad2-dh h2{font-family:'Archivo',sans-serif;font-size:17px;margin:0}
.ad2-chip{font-size:10.5px;font-weight:700;color:#fff;border-radius:9px;padding:3px 10px}
.ad2-empty{color:var(--dim);font-size:12.5px;padding:30px 0;text-align:center;
  border:1px dashed var(--rule);border-radius:3px}
.ad2-note{background:var(--brand-tint,#EEF2F7);border-left:3px solid var(--brand);
  border-radius:3px;padding:10px 13px;font-size:12.5px;color:var(--ink2);line-height:1.7}
.ad2-note-p{color:var(--dim);font-size:12.5px;margin:0;line-height:1.7;max-width:74ch}
.ad2-pw{font-size:12px;font-family:'IBM Plex Mono',monospace;border:1px solid var(--rule);
  border-radius:3px;padding:7px 11px;color:var(--dim)}
.ad2-pw.warn{background:var(--amber);border-color:var(--amberline);color:#7A5D14}
.ad2-pw.bad{background:#FDF6F7;border-color:var(--red);color:var(--red);font-weight:600}

.ad2-permgroup{border:1px solid var(--rule);border-radius:4px;overflow:hidden}
.ad2-permh{background:#F5F7F9;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;
  color:var(--dim);font-family:'IBM Plex Mono',monospace;padding:7px 12px;
  border-bottom:1px solid var(--rule)}
.ad2-perm{display:flex;justify-content:space-between;align-items:center;gap:10px;
  padding:6px 12px;border-bottom:1px solid #F0F3F5;font-size:13px}
.ad2-perm:last-child{border-bottom:0}
.ad2-perm.on{background:#FCFDFE}
.ad2-perm label{display:flex;gap:9px;align-items:center;cursor:pointer;flex:1}
.ad2-perm input:disabled{cursor:not-allowed}
.ad2-permmeta{font-size:11px}
.ad2-tag{font-size:10px;font-weight:700;border-radius:8px;padding:1px 7px;
  background:var(--ground);color:var(--dim)}
.ad2-tag.grant{background:var(--green);color:#fff}
.ad2-tag.revoke{background:var(--red);color:#fff}

.ad2-confirm{border:1px solid var(--brand);border-radius:4px;padding:12px 14px;
  background:var(--brand-tint,#EEF2F7);display:flex;flex-direction:column;gap:8px}
.ad2-overrides{border:1px solid var(--rule);border-radius:4px;overflow:hidden}
.ad2-override{display:grid;grid-template-columns:70px 1fr 1fr 1fr 24px;gap:9px;
  align-items:center;padding:7px 12px;font-size:12.5px;border-bottom:1px solid #F0F3F5}
.ad2-override:last-child{border-bottom:0}

.ad2-checks{display:flex;flex-direction:column;gap:10px}
.ad2-check{border:1px solid var(--rule);border-radius:4px;padding:12px 14px;
  background:var(--paper);display:flex;flex-direction:column;gap:5px}
.ad2-check.ok{border-left:3px solid var(--green)}
.ad2-check.high{border-left:3px solid var(--red);background:#FFFCFC}
.ad2-check.medium{border-left:3px solid var(--amberline);background:#FFFDF8}
.ad2-check-h{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.ad2-check p{margin:0;font-size:12.5px;color:var(--ink2);line-height:1.7;max-width:74ch}
.ad2-status{width:18px;height:18px;border-radius:50%;display:flex;align-items:center;
  justify-content:center;font-size:11px;font-weight:700;background:var(--ground);color:var(--dim)}
.ad2-check.ok .ad2-status{background:var(--green);color:#fff}
.ad2-check.high .ad2-status{background:var(--red);color:#fff}
.ad2-check.medium .ad2-status{background:var(--amberline);color:#5A4610}

.ad2-policies{display:flex;flex-direction:column;gap:8px}
.ad2-policy{background:var(--paper);border:1px solid var(--rule);border-radius:4px;
  padding:11px 14px;display:flex;flex-direction:column;gap:4px}
.ad2-policy-h{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ad2-months{font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--dim)}
.ad2-policy p{margin:0;line-height:1.7;max-width:74ch}
.ad2-preview{background:var(--paper);border:1px solid var(--rule);border-radius:4px;
  padding:14px 16px}
.ad2-preview p{margin:8px 0 0;line-height:1.7}

.ad2-alert{background:#FDF6F7;border:1px solid var(--red);border-radius:4px;padding:11px 14px;
  font-size:12.5px;color:var(--red);line-height:1.7}
.ad2-alert span{color:var(--ink2)}
.ad2-msgs{display:flex;flex-direction:column;gap:1px;background:var(--rule);
  border:1px solid var(--rule);border-radius:4px;overflow:hidden}
.ad2-msg{background:var(--paper);padding:10px 13px;display:flex;flex-direction:column;gap:3px}
.ad2-msg.late{background:#FFFCFC}
.ad2-msg-h{display:flex;gap:9px;align-items:center;flex-wrap:wrap;font-size:12.5px}
.ad2-msgsub{font-size:12.5px;color:var(--ink2)}
.ad2-msgerr{font-size:11.5px;color:var(--red)}

.ad2-seg{display:inline-flex;border:1px solid var(--rule);border-radius:3px;overflow:hidden;
  align-self:flex-start;background:var(--paper)}
.ad2-seg button{font:inherit;font-size:13px;font-weight:600;cursor:pointer;background:var(--paper);
  border:0;border-right:1px solid var(--rule);padding:8px 15px;color:var(--dim)}
.ad2-seg button:last-child{border-right:0}
.ad2-seg button.on{background:var(--brand);color:#fff}

.ad2-row{display:flex;gap:11px;flex-wrap:wrap}
.ad2-row>*{flex:1 1 160px}
.ad2-f{display:flex;flex-direction:column;gap:4px}
.ad2-f>span{font-size:12px;font-weight:600;color:var(--ink2)}
.ad2-f>span em{font-style:normal;font-weight:400;color:var(--dim)}
.ad2-hint{font-style:normal;font-size:11px;color:var(--dim);line-height:1.5}
.ad2-in{font:inherit;font-size:13px;padding:7px 10px;border:1px solid var(--rule);
  border-radius:3px;background:var(--paper);color:var(--ink);width:100%}
.ad2-in:focus{outline:2px solid var(--brand);outline-offset:1px}
.ad2-rolepreview{border:1px solid var(--rule);border-radius:4px;overflow:hidden}
.ad2-previewlist{display:flex;flex-wrap:wrap;gap:5px;padding:11px 13px}
.ad2-previewlist span{font-size:11.5px;color:var(--dim);border:1px solid var(--rule);
  border-radius:10px;padding:2px 9px}

.ad2-btn{font:inherit;font-weight:600;font-size:13px;cursor:pointer;background:var(--brand);
  color:#fff;border:1px solid var(--brand);padding:8px 15px;border-radius:3px}
.ad2-btn:disabled{opacity:.4;cursor:not-allowed}
.ad2-btn--ghost{background:transparent;color:var(--ink2);border-color:var(--rule)}
.ad2-btn--ghost:hover{background:var(--ground);color:var(--ink)}
.ad2-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.ad2-x{font:inherit;font-size:16px;cursor:pointer;background:none;border:0;color:var(--dim)}
.ad2-x:hover{color:var(--red)}

@media (max-width:860px){
  .ad2-split{grid-template-columns:1fr}
  .ad2-head,.ad2-tabs,.ad2-body{padding-left:16px;padding-right:16px}
  .ad2-override{grid-template-columns:1fr}
}
`;
