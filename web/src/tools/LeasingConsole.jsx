import React, { useState, useEffect, useMemo, useCallback } from "react";
import { ai } from "../lib/ai.js";

/* ============================================================
   BAYDO POINTE — Pricing and parking console v2
   Source: Baydo Pointe Marketing Package (17NOV25)
   ============================================================ */

const TYPES = {
  "1A":     { bed: "1 bed",       sf: 484.4 },
  "1A (M)": { bed: "1 bed",       sf: 484.4 },
  "1B":     { bed: "1 bed + den", sf: 602.8 },
  "1C":     { bed: "1 bed",       sf: 462.8 },
  "2A":     { bed: "2 bed 2 bath",sf: 742.7 },
  "2A (M)": { bed: "2 bed 2 bath",sf: 742.7 },
  "3A":     { bed: "2 bed + den", sf: 731.9 },
  "3A (M)": { bed: "2 bed + den", sf: 731.9 },
};
const TYPE_ORDER = ["1C", "1A", "1A (M)", "1B", "3A", "3A (M)", "2A", "2A (M)"];

const G374 = { 101:"1A (M)",102:"1A",103:"2A",104:"2A (M)",105:"3A (M)",106:"3A",107:"2A",
               108:"2A (M)",109:"1A (M)",110:"1A",111:"2A (M)",112:"3A (M)",113:"3A",114:"2A" };
const T374 = { 201:"1C",202:"1A (M)",203:"1A",204:"2A",205:"2A (M)",206:"3A (M)",207:"3A",208:"2A",
               209:"2A (M)",210:"1A (M)",211:"1A",212:"2A (M)",213:"2A (M)",214:"3A (M)",215:"3A",216:"2A" };
const G370 = { 101:"1B",102:"1A",103:"1A (M)",104:"2A (M)",105:"2A",106:"1A (M)",107:"1A",108:"2A (M)",
               109:"3A (M)",110:"3A",111:"2A",112:"1A (M)",113:"1A",114:"2A (M)",115:"2A",116:"1A (M)",
               117:"1A",118:"2A (M)" };
const T370 = { 201:"1C",202:"1A",203:"1A (M)",204:"2A (M)",205:"2A",206:"1A (M)",207:"1A",208:"2A (M)",
               209:"3A (M)",210:"3A",211:"2A",212:"1A (M)",213:"1A",214:"2A (M)",215:"2A",216:"1A (M)",
               217:"1A",218:"2A (M)",219:"3A (M)",220:"3A" };

const BUILDINGS = [
  { id: "370", accent: "#1C6FA6", ground: G370, typical: T370, units: 118, pool: "u370" },
  { id: "374", accent: "#0E8577", ground: G374, typical: T374, units: 94,  pool: "u374" },
  { id: "378", accent: "#B23A54", ground: G370, typical: T370, units: 118, pool: "u378" },
];

function buildUnits() {
  const out = [];
  for (const b of BUILDINGS) {
    for (const n of Object.keys(b.ground).map(Number).sort((x, y) => x - y))
      out.push({ id: `${b.id}-${n}`, bldg: b.id, floor: 1, no: n, type: b.ground[n] });
    for (let f = 2; f <= 6; f++)
      for (const n of Object.keys(b.typical).map(Number).sort((x, y) => x - y))
        out.push({ id: `${b.id}-${f * 100 + (n % 100)}`, bldg: b.id, floor: f,
                   no: f * 100 + (n % 100), type: b.typical[n] });
  }
  return out;
}
const ALL_UNITS = buildUnits();
const UNIT_MAP = Object.fromEntries(ALL_UNITS.map((u) => [u.id, u]));

const DEFAULT_PRICING = {
  base: { "1C": "", "1A": "", "1A (M)": "", "1B": "", "3A": "", "3A (M)": "", "2A": "", "2A (M)": "" },
  depositMode: "oneMonth",
  depositFixed: "", catDeposit: "", dogDeposit: "", petRent: "", petLimit: "",
  parkUnderground: "", parkSurface: "", storage: "", appFee: "", utilities: "",
};

const DEFAULT_PARKING = {
  pools: [
    { id: "u370",    label: "Underground / 370", total: 52, note: "" },
    { id: "u374",    label: "Underground / 374", total: 62, note: "Includes 16 tandem stalls. Drawing labelling to be confirmed with the developer." },
    { id: "u378",    label: "Underground / 378", total: 52, note: "" },
    { id: "surface", label: "Surface / shared",  total: 56, note: "Includes 6 accessible stalls" },
  ],
  maxPerUnit: 1,
  crossBuilding: true,
  records: [],   // { rid, unitId, poolId, status:'assigned'|'waiting', ts }
};

const DEFAULT_ACCOUNTS = [
  { id: "ac-admin", name: "Admin", role: "admin", email: "", active: true },
];

const STATUSES = [
  { key: "available", label: "Available",              color: "#0E8577" },
  { key: "held",      label: "Signed, awaiting move-in", color: "#C98A15" },
  { key: "leased",    label: "Occupied",               color: "#8892A0" },
];

const money = (n) =>
  n === "" || n == null || isNaN(n) ? "—" : "$" + Math.round(Number(n)).toLocaleString("en-CA");
const stamp = (ts) => {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export default function BaydoConsole() {
  const [pricing, setPricing] = useState(DEFAULT_PRICING);
  const [overrides, setOverrides] = useState({});
  const [parking, setParking] = useState(DEFAULT_PARKING);
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState("idle");
  const [tab, setTab] = useState("pricing");
  const [activeBldg, setActiveBldg] = useState("370");
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState("all");
  const [confirmReset, setConfirmReset] = useState(false);
  const [accounts, setAccounts] = useState(DEFAULT_ACCOUNTS);
  const [session, setSession] = useState(null);
  const [loginErr, setLoginErr] = useState("");
  const role = session?.role;

  /* ---------- Load ---------- */
  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get("baydo:pricing");
        if (r?.value) {
          const saved = JSON.parse(r.value);
          delete saved.floorPremium;          // dropped in v2
          setPricing({ ...DEFAULT_PRICING, ...saved });
        }
      } catch (e) {}
      try {
        const r = await window.storage.get("baydo:overrides");
        if (r?.value) setOverrides(JSON.parse(r.value));
      } catch (e) {}
      try {
        const r = await window.storage.get("baydo:parking");
        if (r?.value) setParking({ ...DEFAULT_PARKING, ...JSON.parse(r.value) });
      } catch (e) {}
      try {
        const r = await window.storage.get("baydo:accounts");
        if (r?.value) setAccounts(JSON.parse(r.value));
      } catch (e) {}
      try {
        const r = await window.storage.get("baydo:session");
        if (r?.value) {
          const s = JSON.parse(r.value);
          setSession(s);
          if (s.role !== "admin") setTab("units");
        }
      } catch (e) {}
      setLoading(false);
    })();
  }, []);

  const persist = useCallback(async (key, value) => {
    setSaveState("saving");
    try {
      const ok = await window.storage.set(key, JSON.stringify(value));
      setSaveState(ok ? "saved" : "error");
    } catch (e) { setSaveState("error"); }
    setTimeout(() => setSaveState((s) => (s === "saved" ? "idle" : s)), 1600);
  }, []);

  const updatePricing = (patch) => { const n = { ...pricing, ...patch }; setPricing(n); persist("baydo:pricing", n); };
  const updateBase = (t, v) => updatePricing({ base: { ...pricing.base, [t]: v } });
  const updateParking = (patch) => { const n = { ...parking, ...patch }; setParking(n); persist("baydo:parking", n); };

  const saveAccounts = (next) => { setAccounts(next); persist("baydo:accounts", next); };

  const login = (name) => {
    const acc = accounts.find(
      (a) => a.active !== false && a.name.trim().toLowerCase() === name.trim().toLowerCase()
    );
    if (!acc) { setLoginErr("No such account, or the account is disabled."); return; }
    const s = { accountId: acc.id, name: acc.name, role: acc.role, at: new Date().toISOString() };
    setSession(s); setLoginErr("");
    setTab(acc.role === "admin" ? "pricing" : "units");
    persist("baydo:session", s);
  };

  const logout = async () => {
    setSession(null);
    try { await window.storage.delete("baydo:session"); } catch (e) {}
  };

  const updateUnit = (id, patch) => {
    const next = { ...overrides, [id]: { ...(overrides[id] || {}), ...patch } };
    Object.keys(next[id]).forEach((k) => { if (next[id][k] === "" || next[id][k] == null) delete next[id][k]; });
    if (!Object.keys(next[id]).length) delete next[id];
    setOverrides(next); persist("baydo:overrides", next);
  };

  const resetAll = async () => {
    for (const k of ["baydo:pricing", "baydo:overrides", "baydo:parking"]) {
      try { await window.storage.delete(k); } catch (e) {}
    }
    setPricing(DEFAULT_PRICING); setOverrides({}); setParking(DEFAULT_PARKING);
    setConfirmReset(false); setSelected(null);
  };

  /* ---------- Rent ---------- */
  const rentOf = useCallback((u) => {
    const ov = overrides[u.id];
    if (ov?.rent) return Number(ov.rent);
    const b = Number(pricing.base[u.type]);
    return b || null;
  }, [pricing, overrides]);

  const statusOf = (u) => overrides[u.id]?.status || "available";
  const depositOf = (u) =>
    pricing.depositMode === "fixed" ? Number(pricing.depositFixed) || null : rentOf(u);

  /* ---------- Parking ---------- */
  const poolStats = useMemo(() => {
    const m = {};
    for (const p of parking.pools) {
      const used = parking.records.filter((r) => r.status === "assigned" && r.poolId === p.id).length;
      m[p.id] = { ...p, used, free: Number(p.total) - used };
    }
    return m;
  }, [parking]);

  const totals = useMemo(() => {
    const total = parking.pools.reduce((s, p) => s + Number(p.total || 0), 0);
    const used = parking.records.filter((r) => r.status === "assigned").length;
    const waiting = parking.records.filter((r) => r.status === "waiting").length;
    return { total, used, free: total - used, waiting };
  }, [parking]);

  const waitlist = useMemo(
    () => parking.records.filter((r) => r.status === "waiting").sort((a, b) => a.ts - b.ts),
    [parking]
  );
  const recordsOf = (unitId) => parking.records.filter((r) => r.unitId === unitId);

  // First come, first served: assign immediately if the pool has room, otherwise waitlist
  const requestStall = (unitId, poolId) => {
    const held = recordsOf(unitId).length;
    if (held >= Number(parking.maxPerUnit)) return;
    const free = poolStats[poolId]?.free > 0;
    const rec = {
      rid: `${unitId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      unitId, poolId, ts: Date.now(), status: free ? "assigned" : "waiting",
    };
    updateParking({ records: [...parking.records, rec] });
  };

  const releaseStall = (rid) => {
    const rec = parking.records.find((r) => r.rid === rid);
    let rest = parking.records.filter((r) => r.rid !== rid);
    // Releasing promotes the earliest waiting request in the same pool
    if (rec?.status === "assigned") {
      const nextUp = rest.filter((r) => r.status === "waiting" && r.poolId === rec.poolId)
                         .sort((a, b) => a.ts - b.ts)[0];
      if (nextUp) rest = rest.map((r) => (r.rid === nextUp.rid ? { ...r, status: "assigned" } : r));
    }
    updateParking({ records: rest });
  };

  const promote = (rid) =>
    updateParking({ records: parking.records.map((r) => (r.rid === rid ? { ...r, status: "assigned" } : r)) });

  const setPoolTotal = (poolId, v) =>
    updateParking({ pools: parking.pools.map((p) => (p.id === poolId ? { ...p, total: v } : p)) });

  /* ---------- Summary ---------- */
  const stats = useMemo(() => {
    let priced = 0, sum = 0;
    const byStatus = { available: 0, held: 0, leased: 0 };
    for (const u of ALL_UNITS) {
      const r = rentOf(u); if (r) { priced++; sum += r; }
      byStatus[statusOf(u)]++;
    }
    return { priced, avg: priced ? sum / priced : 0, potential: sum, byStatus };
  }, [rentOf, overrides]);

  /* ---------- Export ---------- */
  const exportCsv = () => {
    const head = ["Building","Floor","Unit","Type","Layout","Interior ft2","Rent","Deposit","Cat deposit","Dog deposit",
                  "Pet rent","Parking area","Stall status","Requested at","Stall rent","Storage","Unit status","Available from","Notes"];
    const lines = [head.join(",")];
    for (const u of ALL_UNITS) {
      const ov = overrides[u.id] || {};
      const rec = recordsOf(u.id)[0];
      const pool = rec ? parking.pools.find((p) => p.id === rec.poolId) : null;
      const fee = rec ? (rec.poolId === "surface" ? pricing.parkSurface : pricing.parkUnderground) : "";
      lines.push([
        u.bldg, u.floor, u.id, u.type, TYPES[u.type].bed, TYPES[u.type].sf,
        rentOf(u) ?? "", depositOf(u) ?? "", pricing.catDeposit, pricing.dogDeposit, pricing.petRent,
        pool ? pool.label : "", rec ? (rec.status === "assigned" ? "Assigned" : "Waiting") : "None",
        rec ? stamp(rec.ts) : "", rec && rec.status === "assigned" ? fee : "",
        pricing.storage, STATUSES.find((s) => s.key === statusOf(u)).label,
        ov.date || "", `"${(ov.notes || "").replace(/"/g, '""')}"`,
      ].join(","));
    }
    const blob = new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "baydo-pointe-rent-and-parking.csv";
    a.click(); URL.revokeObjectURL(a.href);
  };

  const accent = BUILDINGS.find((b) => b.id === activeBldg).accent;

  if (loading)
    return <div className="bp-root"><style>{CSS}</style><div className="bp-loading">Loading saved settings…</div></div>;

  if (!session)
    return <LoginGate accounts={accounts} err={loginErr} onLogin={login} CSS={CSS} />;

  return (
    <div className="bp-root" style={{ "--accent": accent }}>
      <style>{CSS}</style>

      <header className="bp-head">
        <div>
          <div className="bp-eyebrow">Clareview Station Drive NW · Edmonton</div>
          <h1 className="bp-title">Baydo Pointe <span>Leasing console</span></h1>
        </div>
        <div className="bp-headright">
          <div className="bp-user">
            <span className="bp-rolechip"
                  style={{ background: role === "admin" ? "#131C25"
                           : role === "building_manager" ? "#7C5CBF" : "#1C6FA6" }}>
              {role === "admin" ? "Admin"
               : role === "building_manager" ? "Building Manager" : "Property Manager"}
            </span>
            <span className="bp-uname">{session?.name}</span>
            <button className="bp-logout" onClick={logout}>Sign out</button>
          </div>
          <span className={`bp-save bp-save--${saveState}`}>
            {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved"
              : saveState === "error" ? "Save failed" : "Autosaves"}
          </span>
          <button className="bp-btn" onClick={exportCsv}>Export CSV</button>
        </div>
      </header>

      <div className="bp-stats">
        <Stat label="Total units" value="330" />
        <Stat label="Available" value={`${stats.byStatus.available}`} sub="/ 330" />
        <Stat label="Average rent" value={stats.priced ? money(stats.avg) : "—"} />
        <Stat label="Stalls assigned" value={`${totals.used}`} sub={`/ ${totals.total}`}
              tone={totals.free <= 0 ? "warn" : undefined} />
        <Stat label="Stall waitlist" value={`${totals.waiting}`} tone={totals.waiting > 0 ? "warn" : undefined} />
      </div>

      <nav className="bp-tabs">
        {role === "admin" && (
          <button className={tab === "pricing" ? "on" : ""} onClick={() => setTab("pricing")}>Pricing</button>
        )}
        <button className={tab === "parking" ? "on" : ""} onClick={() => setTab("parking")}>
          Parking{totals.waiting > 0 && <i className="bp-badge">{totals.waiting}</i>}
        </button>
        <button className={tab === "units" ? "on" : ""} onClick={() => setTab("units")}>Units</button>
        {role === "admin" && (
          <button className={tab === "accounts" ? "on" : ""} onClick={() => setTab("accounts")}>Accounts</button>
        )}
      </nav>

      {role !== "admin" && (
        <div className="bp-rolenote">
          {role === "building_manager" ? "Building Manager" : "Property Manager"} account:
          you can see vacancy and the <strong>resulting</strong> rent and fees, which is what quoting and showings need, and you can allocate stalls,
          but you cannot change the fee settings or the stall quotas. Those belong to Admin.
        </div>
      )}

      {tab === "accounts" && role === "admin" && (
        <AccountsPanel accounts={accounts} saveAccounts={saveAccounts} session={session} />
      )}

      {tab === "pricing" && role === "admin" && (
        <PricingPanel {...{ pricing, updatePricing, updateBase, confirmReset, setConfirmReset, resetAll }} />
      )}
      {tab === "parking" && (
        <ParkingPanel {...{ parking, updateParking, poolStats, totals, waitlist, promote, releaseStall,
                            requestStall, setPoolTotal, pricing, recordsOf, role, onPick: setSelected }} />
      )}
      {tab === "units" && (
        <UnitsPanel {...{ activeBldg, setActiveBldg, rentOf, statusOf, overrides, filter, setFilter,
                          recordsOf, onPick: setSelected }} />
      )}

      {selected && (
        <UnitEditor
          unit={selected} rent={rentOf(selected)} deposit={depositOf(selected)} pricing={pricing}
          ov={overrides[selected.id] || {}} records={recordsOf(selected.id)} pools={parking.pools}
          poolStats={poolStats} maxPerUnit={parking.maxPerUnit} waitlist={waitlist}
          onChange={(p) => updateUnit(selected.id, p)}
          onRequest={(poolId) => requestStall(selected.id, poolId)}
          onRelease={releaseStall} onClose={() => setSelected(null)}
        />
      )}

      <footer className="bp-foot">
        Built from the Baydo Pointe marketing package dated 2025-11-17. Parking is first come, first served: a request is assigned immediately if the area has room,
        otherwise it waits in request order, and a release promotes the earliest waiting request in that area.
      </footer>
    </div>
  );
}

/* ============================ Shared ============================ */

function LoginGate({ accounts, err, onLogin, CSS }) {
  const [name, setName] = useState("");
  return (
    <div className="bp-root">
      <style>{CSS}</style>
      <div className="bp-login">
        <div className="bp-loginbox">
          <div className="bp-eyebrow">Baydo Pointe</div>
          <h1 className="bp-title" style={{ fontSize: 22, marginBottom: 6 }}>Leasing console</h1>
          <p className="bp-note" style={{ marginTop: 0 }}>
            Sign in with your account name. What you can see depends on the role, and it cannot be switched afterwards.
          </p>
          <div className="bp-input" style={{ marginBottom: 10 }}>
            <input value={name} placeholder="Account name" autoFocus
                   onChange={(e) => setName(e.target.value)}
                   onKeyDown={(e) => e.key === "Enter" && onLogin(name)} />
          </div>
          {err && <div className="bp-loginerr">{err}</div>}
          <button className="bp-btn" style={{ width: "100%" }} onClick={() => onLogin(name)}>Sign in</button>
          <div className="bp-loginhint">
            Existing accounts: {accounts.filter((a) => a.active !== false).map((a) => `${a.name} (${a.role})`).join(", ")}
            <br />First run: sign in as Admin, then create the other accounts under the Accounts tab.
          </div>
          <div className="bp-loginwarn">
            This prototype has no password check. In production the server verifies the login and every endpoint checks the role;
            hiding things in the interface is presentation, not protection.
          </div>
        </div>
      </div>
    </div>
  );
}

function AccountsPanel({ accounts, saveAccounts, session }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("building_manager");

  const ROLE_OPTS = [
    { k: "admin",            label: "Admin",            desc: "Pricing, parking quotas, template library, accounts" },
    { k: "property_manager", label: "Property Manager", desc: "Signing, tenant documents, leads and pricing lookup" },
    { k: "building_manager", label: "Building Manager", desc: "Showings, maintenance tickets, key handover, notices of entry" },
  ];

  const add = () => {
    const n = name.trim();
    if (!n) return;
    if (accounts.some((a) => a.name.trim().toLowerCase() === n.toLowerCase())) return;
    saveAccounts([...accounts, { id: "ac-" + Date.now().toString(36), name: n,
                                 email: email.trim(), role, active: true }]);
    setName(""); setEmail("");
  };

  return (
    <div className="bp-body">
      <section className="bp-card">
        <h2>Accounts</h2>
        <p className="bp-note">
          The role on an account decides what that person sees. Roles are assigned here; users cannot switch their own.
        </p>
        <div className="bp-roledesc">
          {ROLE_OPTS.map((r) => (
            <div className="bp-rd" key={r.k}>
              <strong>{r.label}</strong>
              <span>{r.desc}</span>
            </div>
          ))}
        </div>
        <div className="bp-table">
          <div className="bp-tr bp-tr--head" style={{ gridTemplateColumns: "1fr 1fr 150px 90px" }}>
            <span>Name</span><span>Email</span><span>Role</span><span>Status</span>
          </div>
          {accounts.map((a) => (
            <div className="bp-tr" key={a.id} style={{ gridTemplateColumns: "1fr 1fr 150px 90px" }}>
              <span className="bp-strong">
                {a.name}{a.id === session.accountId && <em className="bp-you"> signed in</em>}
              </span>
              <span className="bp-dim">{a.email || "—"}</span>
              <span>
                <select className="bp-select" style={{ padding: "3px 6px", fontSize: 12 }}
                        value={a.role} disabled={a.id === session.accountId}
                        onChange={(e) => saveAccounts(accounts.map((x) =>
                          x.id === a.id ? { ...x, role: e.target.value } : x))}>
                  {ROLE_OPTS.map((r) => <option key={r.k} value={r.k}>{r.label}</option>)}
                </select>
              </span>
              <span>
                <button className="bp-btn bp-btn--sm bp-btn--ghost"
                        disabled={a.id === session.accountId}
                        onClick={() => saveAccounts(accounts.map((x) =>
                          x.id === a.id ? { ...x, active: a.active === false } : x))}>
                  {a.active === false ? "Disabled" : "Disable"}
                </button>
              </span>
            </div>
          ))}
        </div>

        <div className="bp-row">
          <Field label="Name" type="text" value={name} onChange={setName} placeholder="Full name" />
          <Field label="Email" type="text" value={email} onChange={setEmail} placeholder="optional" />
          <div className="bp-field">
            <span className="bp-field-l">Role</span>
            <select className="bp-select" value={role} onChange={(e) => setRole(e.target.value)}>
              {ROLE_OPTS.map((r) => <option key={r.k} value={r.k}>{r.label}</option>)}
            </select>
          </div>
          <button className="bp-btn" style={{ alignSelf: "flex-end", flex: "0 0 auto" }}
                  onClick={add} disabled={!name.trim()}>Create account</button>
        </div>
        <p className="bp-note">
          You cannot change your own role or disable yourself. That is what stops the last Admin locking themselves out.
        </p>
      </section>
    </div>
  );
}

function Stat({ label, value, sub, tone }) {
  return (
    <div className="bp-stat">
      <div className="bp-stat-l">{label}</div>
      <div className={`bp-stat-v ${tone === "warn" ? "warn" : ""}`}>
        {value}{sub && <em>{sub}</em>}
      </div>
    </div>
  );
}

function Field({ label, hint, prefix, value, onChange, type = "number", placeholder }) {
  return (
    <label className="bp-field">
      <span className="bp-field-l">{label}</span>
      <div className="bp-input">
        {prefix && <i>{prefix}</i>}
        <input type={type} inputMode={type === "number" ? "decimal" : undefined}
               value={value ?? ""} placeholder={placeholder}
               onChange={(e) => onChange(e.target.value)} />
      </div>
      {hint && <span className="bp-field-h">{hint}</span>}
    </label>
  );
}

/* ============================ Pricing ============================ */

function PricingPanel({ pricing, updatePricing, updateBase, confirmReset, setConfirmReset, resetAll }) {
  return (
    <div className="bp-body">
      <section className="bp-card">
        <h2>Rent by unit type</h2>
        <p className="bp-note">Set once and it applies to every unit of that type. To price one unit differently, open it under Units and override there.</p>
        <div className="bp-table">
          <div className="bp-tr bp-tr--head"><span>Type</span><span>Layout</span><span>Interior</span><span>Monthly rent</span><span>Per ft²</span></div>
          {TYPE_ORDER.map((t) => {
            const v = pricing.base[t];
            const psf = v ? Number(v) / TYPES[t].sf : null;
            return (
              <div className="bp-tr" key={t}>
                <span className="bp-mono bp-strong">{t}</span>
                <span>{TYPES[t].bed}</span>
                <span className="bp-mono">{TYPES[t].sf} ft²</span>
                <span>
                  <div className="bp-input bp-input--sm"><i>$</i>
                    <input type="number" inputMode="decimal" value={v} placeholder="—"
                           onChange={(e) => updateBase(t, e.target.value)} />
                  </div>
                </span>
                <span className="bp-mono bp-dim">{psf ? `$${psf.toFixed(2)}` : "—"}</span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="bp-card">
        <h2>Security deposit</h2>
        <div className="bp-seg">
          <button className={pricing.depositMode === "oneMonth" ? "on" : ""}
                  onClick={() => updatePricing({ depositMode: "oneMonth" })}>One month’s rent</button>
          <button className={pricing.depositMode === "fixed" ? "on" : ""}
                  onClick={() => updatePricing({ depositMode: "fixed" })}>Fixed amount</button>
        </div>
        {pricing.depositMode === "fixed" && (
          <div className="bp-row">
            <Field label="Deposit amount" prefix="$" value={pricing.depositFixed}
                   onChange={(v) => updatePricing({ depositFixed: v })} />
          </div>
        )}
        <p className="bp-note">
          Alberta caps the security deposit at one month’s rent, and a pet deposit counts inside that cap. To charge pet owners more,
          the usual route is monthly pet rent instead. Confirm the wording with your manager before relying on it.
        </p>
      </section>

      <section className="bp-card">
        <h2>Pets</h2>
        <div className="bp-row bp-row--3">
          <Field label="Cat deposit" prefix="$" value={pricing.catDeposit} onChange={(v) => updatePricing({ catDeposit: v })} />
          <Field label="Dog deposit" prefix="$" value={pricing.dogDeposit} onChange={(v) => updatePricing({ dogDeposit: v })} />
          <Field label="Pet rent (per animal)" prefix="$" value={pricing.petRent} onChange={(v) => updatePricing({ petRent: v })} />
        </div>
        <div className="bp-row">
          <Field label="Limit per unit" type="text" value={pricing.petLimit}
                 placeholder="e.g. 2 animals, under 25 kg"
                 onChange={(v) => updatePricing({ petLimit: v })}
                 hint="All three buildings have a pet wash room. Worth leading with." />
        </div>
      </section>

      <section className="bp-card">
        <h2>Parking and other monthly fees</h2>
        <div className="bp-row bp-row--3">
          <Field label="Underground stall / month" prefix="$" value={pricing.parkUnderground}
                 onChange={(v) => updatePricing({ parkUnderground: v })} />
          <Field label="Surface stall / month" prefix="$" value={pricing.parkSurface}
                 onChange={(v) => updatePricing({ parkSurface: v })} />
          <Field label="Storage locker / month" prefix="$" value={pricing.storage}
                 onChange={(v) => updatePricing({ storage: v })} />
        </div>
        <div className="bp-row">
          <Field label="Application fee" prefix="$" value={pricing.appFee} onChange={(v) => updatePricing({ appFee: v })} />
          <Field label="Included in rent" type="text" value={pricing.utilities}
                 placeholder="e.g. water and heat included, electricity separate"
                 onChange={(v) => updatePricing({ utilities: v })} />
        </div>
        <p className="bp-note">Stall counts and allocation live on the Parking tab. This is price only.</p>
      </section>

      <section className="bp-card bp-card--quiet">
        <h2>Clear data</h2>
        {confirmReset ? (
          <div className="bp-row bp-row--tight">
            <span className="bp-note">Clear every fee, unit and parking setting? This cannot be undone.</span>
            <button className="bp-btn bp-btn--danger" onClick={resetAll}>Clear everything</button>
            <button className="bp-btn bp-btn--ghost" onClick={() => setConfirmReset(false)}>Cancel</button>
          </div>
        ) : (
          <button className="bp-btn bp-btn--ghost" onClick={() => setConfirmReset(true)}>Clear all settings</button>
        )}
      </section>
    </div>
  );
}

/* ============================ Parking ============================ */

function ParkingPanel({ parking, updateParking, poolStats, totals, waitlist, promote, releaseStall,
                        requestStall, setPoolTotal, recordsOf, role, onPick }) {
  const isAdmin = role === "admin";
  const [q, setQ] = useState("");
  const [pool, setPool] = useState("u370");

  const matches = useMemo(() => {
    const s = q.trim();
    if (!s) return [];
    return ALL_UNITS.filter((u) => u.id.includes(s)).slice(0, 8);
  }, [q]);

  const assigned = useMemo(
    () => parking.records.filter((r) => r.status === "assigned").sort((a, b) => a.ts - b.ts),
    [parking]
  );

  return (
    <div className="bp-body">
      {/* Quota overview */}
      <section className="bp-card">
        <h2>Stall quotas</h2>
        <p className="bp-note">
          330 units against {totals.total} stalls, a shortfall of {330 - totals.total}. The counts are editable:
          two underground areas are both labelled 370 on the drawings, one of which is probably 374, and the total is one off the 167 in the summary.
          Update these once Baydo confirms.
        </p>
        <div className="bp-pools">
          {parking.pools.map((p) => {
            const s = poolStats[p.id];
            const pct = s.total > 0 ? Math.min(100, (s.used / s.total) * 100) : 0;
            const tone = s.free <= 0 ? "full" : s.free <= 5 ? "low" : "ok";
            return (
              <div className={`bp-pool bp-pool--${tone}`} key={p.id}>
                <div className="bp-pool-h">
                  <strong>{p.label}</strong>
                  <span className="bp-mono">{s.used} / {s.total}</span>
                </div>
                <div className="bp-bar"><i style={{ width: `${pct}%` }} /></div>
                <div className="bp-pool-f">
                  <span className={s.free <= 0 ? "bp-red" : "bp-dim"}>
                    {s.free > 0 ? `${s.free} free` : "Full"}
                  </span>
                  <label className="bp-inline">
                    Total
                    {isAdmin ? (
                      <div className="bp-input bp-input--xs">
                        <input type="number" inputMode="numeric" value={p.total}
                               onChange={(e) => setPoolTotal(p.id, e.target.value)} />
                      </div>
                    ) : (
                      <span className="bp-mono bp-lock">{p.total}</span>
                    )}
                  </label>
                </div>
                {p.note && <div className="bp-pool-n">{p.note}</div>}
              </div>
            );
          })}
        </div>
        <div className="bp-row">
          {isAdmin ? (
            <Field label="Stall limit per unit" value={parking.maxPerUnit}
                   onChange={(v) => updateParking({ maxPerUnit: v })}
                   hint="Stalls are far scarcer than units. Keep this at 1 until the waitlist clears." />
          ) : (
            <div className="bp-field">
              <span className="bp-field-l">Stall limit per unit</span>
              <span className="bp-mono bp-lock">{parking.maxPerUnit} — set by Admin</span>
            </div>
          )}
        </div>
      </section>

      {/* Request */}
      <section className="bp-card">
        <h2>Request a stall</h2>
        <p className="bp-note">
          First come, first served. If the area has room the moment you submit, the stall is assigned; if not it joins the waitlist in request order.
        </p>
        <div className="bp-row">
          <Field label="Unit number" type="text" value={q} onChange={setQ}
                 placeholder="e.g. 370-412" />
          <label className="bp-field">
            <span className="bp-field-l">Parking area</span>
            <select className="bp-select" value={pool} onChange={(e) => setPool(e.target.value)}>
              {parking.pools.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} ({poolStats[p.id].free} free)
                </option>
              ))}
            </select>
          </label>
        </div>
        {matches.length > 0 && (
          <div className="bp-matches">
            {matches.map((u) => {
              const held = recordsOf(u.id).length;
              const full = held >= Number(parking.maxPerUnit);
              return (
                <div className="bp-match" key={u.id}>
                  <span className="bp-mono bp-strong">{u.id}</span>
                  <span className="bp-dim">{u.type} · {u.floor}F</span>
                  {full ? <span className="bp-tag">{held} stall(s) held</span> : (
                    <button className="bp-btn bp-btn--sm"
                            onClick={() => { requestStall(u.id, pool); setQ(""); }}>
                      {poolStats[pool].free > 0 ? "Request · assign now" : "Request · waitlist"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {q.trim() && matches.length === 0 && <p className="bp-note">No unit with that number.</p>}
      </section>

      {/* Waitlist */}
      <section className="bp-card">
        <h2>Waitlist <span className="bp-count">{waitlist.length}</span></h2>
        {waitlist.length === 0 ? (
          <p className="bp-note">Nobody is waiting. When a stall is released, the earliest request in that area is promoted automatically.</p>
        ) : (
          <div className="bp-list">
            {waitlist.map((r, i) => {
              const free = poolStats[r.poolId].free > 0;
              return (
                <div className="bp-item" key={r.rid}>
                  <span className="bp-rank">{i + 1}</span>
                  <button className="bp-link bp-mono" onClick={() => onPick(UNIT_MAP[r.unitId])}>{r.unitId}</button>
                  <span className="bp-dim">{parking.pools.find((p) => p.id === r.poolId)?.label}</span>
                  <span className="bp-dim bp-mono bp-ts">{stamp(r.ts)}</span>
                  <div className="bp-item-a">
                    {free && <button className="bp-btn bp-btn--sm" onClick={() => promote(r.rid)}>Assign</button>}
                    <button className="bp-btn bp-btn--sm bp-btn--ghost" onClick={() => releaseStall(r.rid)}>Cancel</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Assigned */}
      <section className="bp-card">
        <h2>Assigned stalls <span className="bp-count">{assigned.length}</span></h2>
        {assigned.length === 0 ? (
          <p className="bp-note">No stalls assigned yet.</p>
        ) : (
          <div className="bp-list">
            {assigned.map((r) => (
              <div className="bp-item" key={r.rid}>
                <span className="bp-rank bp-rank--ok">✓</span>
                <button className="bp-link bp-mono" onClick={() => onPick(UNIT_MAP[r.unitId])}>{r.unitId}</button>
                <span className="bp-dim">{parking.pools.find((p) => p.id === r.poolId)?.label}</span>
                <span className="bp-dim bp-mono bp-ts">{stamp(r.ts)}</span>
                <div className="bp-item-a">
                  <button className="bp-btn bp-btn--sm bp-btn--ghost" onClick={() => releaseStall(r.rid)}>Release</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <ParkingAdvisor parking={parking} poolStats={poolStats} totals={totals} waitlist={waitlist} />
    </div>
  );
}

/* ---------- AI advisor ---------- */

function ParkingAdvisor({ parking, poolStats, totals, waitlist }) {
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const presets = [
    "What are the risks in the current allocation?",
    "How should we communicate the waitlist to tenants?",
    "Should we open up a second stall per unit?",
  ];

  const ask = async (question) => {
    if (!question.trim() || busy) return;
    setBusy(true); setErr(""); setAnswer("");
    const state = [
      `Property: Baydo Pointe, Edmonton. 330 units (370: 118, 374: 94, 378: 118).`,
      `Stalls: ${totals.total} total, ${totals.used} assigned, ${totals.free} free, ${totals.waiting} waiting.`,
      `Limit per unit: ${parking.maxPerUnit}. Rule: first come, first served, ordered by request time.`,
      `By area: ` + parking.pools.map((p) => {
        const s = poolStats[p.id];
        return `${p.label} ${s.used}/${s.total} (${s.free} free)${p.note ? " — " + p.note : ""}`;
      }).join("；"),
      waitlist.length
        ? `Next in line: ` + waitlist.slice(0, 5).map((r, i) =>
            `${i + 1}.${r.unitId}(${parking.pools.find((p) => p.id === r.poolId)?.label})`).join("、")
        : `Nobody is waiting.`,
    ].join("\n");

    try {
      const text = await ai("parking_advice", { state, question },
        { ref_type: "parking", ref_id: null });
      setAnswer(text || "No response came back. Try again.");
    } catch (e) {
      setErr("The request failed. Try again shortly.");
    }
    setBusy(false);
  };

  return (
    <section className="bp-card bp-card--ai">
      <h2>Ask the AI</h2>
      <p className="bp-note">The live allocation numbers above are sent with your question, so the answer is about your actual position.</p>
      <div className="bp-presets">
        {presets.map((p) => (
          <button key={p} className="bp-chip" disabled={busy} onClick={() => { setQ(p); ask(p); }}>{p}</button>
        ))}
      </div>
      <div className="bp-row bp-row--tight bp-ask">
        <div className="bp-input" style={{ flex: "1 1 240px" }}>
          <input type="text" value={q} placeholder="Or type your own question…"
                 onChange={(e) => setQ(e.target.value)}
                 onKeyDown={(e) => { if (e.key === "Enter") ask(q); }} />
        </div>
        <button className="bp-btn" disabled={busy || !q.trim()} onClick={() => ask(q)}>
          {busy ? "Thinking…" : "Send"}
        </button>
      </div>
      {err && <div className="bp-err">{err}</div>}
      {answer && <div className="bp-answer">{answer}</div>}
    </section>
  );
}

/* ============================ Units ============================ */

function UnitsPanel({ activeBldg, setActiveBldg, rentOf, statusOf, overrides, filter, setFilter, recordsOf, onPick }) {
  const bldgUnits = useMemo(() => ALL_UNITS.filter((u) => u.bldg === activeBldg), [activeBldg]);
  const visible = (u) => filter === "all" || statusOf(u) === filter;

  return (
    <div className="bp-body">
      <div className="bp-bldgbar">
        {BUILDINGS.map((b) => (
          <button key={b.id} className={`bp-bldg ${activeBldg === b.id ? "on" : ""}`}
                  style={{ "--c": b.accent }} onClick={() => setActiveBldg(b.id)}>
            <strong>{b.id}</strong><em>{b.units} units</em>
          </button>
        ))}
        <div className="bp-legend">
          <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>All</button>
          {STATUSES.map((s) => (
            <button key={s.key} className={filter === s.key ? "on" : ""} onClick={() => setFilter(s.key)}>
              <i style={{ background: s.color }} />{s.label}
            </button>
          ))}
        </div>
      </div>

      <p className="bp-note bp-note--wide">
        Each row is one floor, 6 down to 1, in the same order as the floor plans. A blue dot means that unit has been overridden;
        ᴘ means a stall is held. First come, first served throughout: no unit is held before signing.
      </p>

      {(() => {
        const today = new Date().toISOString().slice(0, 10);
        const late = ALL_UNITS.filter((u) => {
          const o = overrides[u.id];
          return o?.status === "held" && o.date && o.date < today;
        });
        return late.length === 0 ? null : (
          <div className="bp-expired">
            <strong>{late.length} unit(s) signed but past the move-in date and still not marked occupied</strong>: 
            {late.slice(0, 8).map((u) => u.id).join(", ")}{late.length > 8 ? " and others" : ""}.
            Check whether the tenant has moved in, or whether something has gone wrong with the unit.
          </div>
        );
      })()}

      <div className="bp-stack">
        {[6, 5, 4, 3, 2, 1].map((f) => {
          const row = bldgUnits.filter((u) => u.floor === f && visible(u));
          return (
            <div className="bp-floor" key={f}>
              <div className="bp-floor-l">{f}F</div>
              <div className="bp-floor-units">
                {row.length === 0 && <span className="bp-empty">No matching units on this floor</span>}
                {row.map((u) => {
                  const r = rentOf(u);
                  const st = STATUSES.find((s) => s.key === statusOf(u));
                  const rec = recordsOf(u.id)[0];
                  const o = overrides[u.id];
                  const stale = o?.status === "held" && o.date &&
                                o.date < new Date().toISOString().slice(0, 10);
                  return (
                    <button key={u.id} className={`bp-unit ${stale ? "stale" : ""}`}
                            onClick={() => onPick(u)} style={{ "--s": st.color }}>
                      <span className="bp-unit-no">{u.no}</span>
                      <span className="bp-unit-t">{u.type}</span>
                      <span className="bp-unit-r">{r ? money(r) : "No price"}</span>
                      {overrides[u.id] && <i className="bp-dot" />}
                      {rec && <i className={`bp-p ${rec.status === "waiting" ? "wait" : ""}`}>ᴘ</i>}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ============================ Unit editor ============================ */

function UnitEditor({ unit, rent, deposit, pricing, ov, records, pools, poolStats, maxPerUnit,
                      waitlist, onChange, onRequest, onRelease, onClose }) {
  const t = TYPES[unit.type];
  const defaultPool = BUILDINGS.find((b) => b.id === unit.bldg).pool;
  const [pool, setPool] = useState(defaultPool);
  const canAdd = records.length < Number(maxPerUnit);

  return (
    <div className="bp-drawer-wrap" onClick={onClose}>
      <aside className="bp-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="bp-drawer-head">
          <div>
            <div className="bp-eyebrow">Building {unit.bldg} · Floor {unit.floor}</div>
            <h3>{unit.id}</h3>
            <div className="bp-dim">{unit.type} · {t.bed} · {t.sf} ft² · 71 ft² balcony</div>
          </div>
          <button className="bp-x" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="bp-drawer-body">
          <Field label="Rent for this unit" prefix="$" value={ov.rent ?? ""}
                 placeholder={rent ? String(Math.round(rent)) : "No rent set for this type yet"}
                 onChange={(v) => onChange({ rent: v })}
                 hint={ov.rent ? "Overriding the type price. Clear it to go back."
                       : rent ? `Using the type price of ${money(rent)}` : "Set a rent for this type under Pricing first."} />

          <div className="bp-field">
            <span className="bp-field-l">Status</span>
            <div className="bp-seg bp-seg--sm">
              {STATUSES.map((s) => (
                <button key={s.key} className={(ov.status || "available") === s.key ? "on" : ""}
                        onClick={() => onChange({ status: s.key })}>{s.label}</button>
              ))}
            </div>
            <span className="bp-field-h">
              First come, first served throughout, with no holds. A unit stays Available until signing completes;
              the signing flow sets Signed, and it becomes Occupied once the tenant actually moves in.
            </span>
          </div>

          <Field label="Available from" type="date" value={ov.date ?? ""} onChange={(v) => onChange({ date: v })} />
          <Field label="Notes" type="text" value={ov.notes ?? ""}
                 placeholder="e.g. west-facing, overlooks parking, showing booked" onChange={(v) => onChange({ notes: v })} />

          {/* Parking */}
          <div className="bp-field">
            <span className="bp-field-l">Parking</span>
            {records.length === 0 && <span className="bp-field-h">No stall requested.</span>}
            {records.map((r) => {
              const rank = r.status === "waiting" ? waitlist.findIndex((w) => w.rid === r.rid) + 1 : null;
              return (
                <div className="bp-stallrow" key={r.rid}>
                  <div>
                    <div className="bp-strong">{pools.find((p) => p.id === r.poolId)?.label}</div>
                    <div className="bp-dim bp-mono">
                      {r.status === "assigned" ? "Assigned" : `Waitlist position ${rank}`} · {stamp(r.ts)}
                    </div>
                  </div>
                  <button className="bp-btn bp-btn--sm bp-btn--ghost" onClick={() => onRelease(r.rid)}>
                    {r.status === "assigned" ? "Release" : "Cancel"}
                  </button>
                </div>
              );
            })}
            {canAdd && (
              <div className="bp-row bp-row--tight" style={{ marginTop: 8 }}>
                <select className="bp-select" value={pool} onChange={(e) => setPool(e.target.value)}
                        style={{ flex: "1 1 auto" }}>
                  {pools.map((p) => (
                    <option key={p.id} value={p.id}>{p.label} ({poolStats[p.id].free} free)</option>
                  ))}
                </select>
                <button className="bp-btn bp-btn--sm" onClick={() => onRequest(pool)}>
                  {poolStats[pool].free > 0 ? "Request and assign" : "Join waitlist"}
                </button>
              </div>
            )}
          </div>

          <div className="bp-summary">
            <div className="bp-summary-h">Fees applying to this unit</div>
            <Line k="Rent" v={money(ov.rent || rent)} />
            <Line k="Deposit" v={money(deposit)} n={pricing.depositMode === "oneMonth" ? "= one month's rent" : undefined} />
            <Line k="Cat deposit" v={money(pricing.catDeposit)} />
            <Line k="Dog deposit" v={money(pricing.dogDeposit)} />
            <Line k="Pet rent" v={money(pricing.petRent)} n={pricing.petLimit || undefined} />
            {records.filter((r) => r.status === "assigned").map((r) => (
              <Line key={r.rid} k="Stall rent"
                    v={money(r.poolId === "surface" ? pricing.parkSurface : pricing.parkUnderground)}
                    n={pools.find((p) => p.id === r.poolId)?.label} />
            ))}
            <Line k="Storage" v={money(pricing.storage)} />
            <Line k="Application fee" v={money(pricing.appFee)} />
            {pricing.utilities && <Line k="Rent includes" v={pricing.utilities} />}
            {unit.type === "1B" && <Line k="Extra" v="135 ft² patio" />}
          </div>
        </div>
      </aside>
    </div>
  );
}

function Line({ k, v, n }) {
  return (
    <div className="bp-line">
      <span>{k}</span>
      <span className="bp-mono">{v}{n && <em> {n}</em>}</span>
    </div>
  );
}

/* ============================ Styles ============================ */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=Archivo:wght@600;700;800&display=swap');

.bp-root{
  --ink:#131C25; --ink2:#3E4C5A; --dim:#78899A;
  --paper:#FFFFFF; --ground:#E9EDF0; --rule:#D3DBE1;
  --amber:#FFF6E0; --amberline:#E8C877; --red:#B23A54; --green:#0E8577;
  --accent:#1C6FA6;
  background:var(--ground); color:var(--ink); min-height:100vh;
  font-family:'IBM Plex Sans','PingFang TC','Microsoft JhengHei',system-ui,sans-serif;
  font-size:14px; line-height:1.55; padding:0 0 64px;
}
.bp-root *{box-sizing:border-box}
.bp-mono{font-family:'IBM Plex Mono',ui-monospace,monospace; font-variant-numeric:tabular-nums}
.bp-strong{font-weight:600}
.bp-dim{color:var(--dim); font-size:12.5px}
.bp-red{color:var(--red); font-weight:600; font-size:12.5px}
.bp-loading{padding:80px 24px; text-align:center; color:var(--dim)}

.bp-head{display:flex; justify-content:space-between; align-items:flex-end; gap:16px; flex-wrap:wrap;
  padding:26px 28px 20px; background:var(--paper); border-bottom:1px solid var(--rule)}
.bp-eyebrow{font-family:'IBM Plex Mono',monospace; font-size:10.5px; letter-spacing:.13em;
  text-transform:uppercase; color:var(--dim)}
.bp-title{font-family:'Archivo','PingFang TC',sans-serif; font-weight:800; font-size:26px;
  letter-spacing:-.02em; margin:4px 0 0}
.bp-title span{font-weight:600; font-size:17px; color:var(--dim); letter-spacing:0; margin-left:8px}
.bp-headright{display:flex; align-items:center; gap:12px}
.bp-save{font-family:'IBM Plex Mono',monospace; font-size:11px; color:var(--dim);
  padding:4px 9px; border:1px solid var(--rule); border-radius:3px}
.bp-save--saved{color:var(--green); border-color:var(--green)}
.bp-save--error{color:var(--red); border-color:var(--red)}

.bp-btn{font:inherit; font-weight:600; font-size:13px; cursor:pointer; background:var(--ink); color:#fff;
  border:1px solid var(--ink); padding:8px 16px; border-radius:3px}
.bp-btn:hover{background:#000}
.bp-btn:disabled{opacity:.45; cursor:not-allowed}
.bp-btn--sm{padding:5px 11px; font-size:12px}
.bp-btn--ghost{background:transparent; color:var(--ink2); border-color:var(--rule)}
.bp-btn--ghost:hover{background:var(--ground); color:var(--ink)}
.bp-btn--danger{background:var(--red); border-color:var(--red)}
.bp-btn:focus-visible,.bp-unit:focus-visible,.bp-bldg:focus-visible,.bp-tabs button:focus-visible,
.bp-seg button:focus-visible,.bp-legend button:focus-visible,.bp-chip:focus-visible,
.bp-select:focus-visible,.bp-link:focus-visible{outline:2px solid var(--accent); outline-offset:2px}

.bp-stats{display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
  background:var(--paper); border-bottom:1px solid var(--rule)}
.bp-stat{padding:16px 28px; border-right:1px solid var(--rule)}
.bp-stat:last-child{border-right:0}
.bp-stat-l{font-size:11px; letter-spacing:.06em; color:var(--dim); text-transform:uppercase;
  font-family:'IBM Plex Mono',monospace}
.bp-stat-v{font-family:'IBM Plex Mono',monospace; font-size:21px; font-weight:600; margin-top:3px;
  font-variant-numeric:tabular-nums}
.bp-stat-v.warn{color:var(--red)}
.bp-stat-v em{font-style:normal; font-size:12px; color:var(--dim); margin-left:5px; font-weight:400}

.bp-tabs{display:flex; gap:2px; padding:0 28px; background:var(--paper); border-bottom:1px solid var(--rule)}
.bp-tabs button{font:inherit; font-weight:600; font-size:13.5px; cursor:pointer; background:none; border:0;
  padding:12px 18px; color:var(--dim); border-bottom:2px solid transparent; margin-bottom:-1px;
  display:flex; align-items:center; gap:6px}
.bp-tabs button.on{color:var(--ink); border-bottom-color:var(--ink)}
.bp-badge{font-style:normal; font-family:'IBM Plex Mono',monospace; font-size:10px; background:var(--red);
  color:#fff; border-radius:8px; padding:1px 6px}
.bp-user{display:flex;align-items:center;gap:8px}
.bp-rolechip{font-size:10.5px;font-weight:700;color:#fff;border-radius:9px;padding:2px 9px;
  letter-spacing:.04em}
.bp-uname{font-size:13px;font-weight:600}
.bp-logout{font:inherit;font-size:12px;cursor:pointer;background:none;border:1px solid var(--rule);
  border-radius:3px;padding:4px 10px;color:var(--dim)}
.bp-logout:hover{color:var(--ink);border-color:var(--ink)}
.bp-roledesc{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;
  margin:4px 0 10px}
.bp-rd{border:1px solid var(--rule);border-radius:3px;padding:9px 12px;background:#FCFDFE;
  display:flex;flex-direction:column;gap:2px}
.bp-rd strong{font-size:12.5px}
.bp-rd span{font-size:11.5px;color:var(--dim);line-height:1.5}
.bp-you{font-style:normal;font-size:10.5px;color:var(--accent);font-weight:600}

.bp-login{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.bp-loginbox{background:var(--paper);border:1px solid var(--rule);border-radius:5px;padding:28px 26px;
  width:min(400px,100%)}
.bp-loginerr{font-size:12.5px;color:var(--red);margin-bottom:10px}
.bp-loginhint{font-size:11.5px;color:var(--dim);line-height:1.7;margin-top:14px;padding-top:12px;
  border-top:1px solid var(--rule)}
.bp-loginwarn{font-size:11px;color:#7A5D14;background:#FFF8E6;border:1px solid var(--amberline);
  border-radius:3px;padding:9px 11px;line-height:1.6;margin-top:12px}
.bp-rolenote{background:#F2F7FB;border-bottom:1px solid #C7D6E2;padding:10px 28px;font-size:12.5px;
  color:var(--ink2);line-height:1.6}
.bp-lock{font-size:12.5px;color:var(--dim);background:var(--ground);border:1px solid var(--rule);
  border-radius:2px;padding:3px 8px}
.bp-expired{background:#FDF6F7;border:1px solid var(--red);border-radius:4px;padding:10px 14px;
  font-size:12.5px;color:var(--ink2);line-height:1.65;margin-bottom:12px}
.bp-expired strong{color:var(--red)}
.bp-unit.stale{border-color:var(--red);background:#FFFCFC}

.bp-body{padding:24px 28px; display:flex; flex-direction:column; gap:18px; max-width:1180px}
.bp-card{background:var(--paper); border:1px solid var(--rule); border-radius:4px; padding:20px 22px}
.bp-card--quiet{background:transparent; border-style:dashed}
.bp-card--ai{border-color:#C7D6E2; background:linear-gradient(180deg,#F7FAFC 0%,#FFFFFF 60%)}
.bp-card h2{font-family:'Archivo',sans-serif; font-weight:700; font-size:15px; margin:0 0 4px;
  letter-spacing:-.01em; display:flex; align-items:center; gap:8px}
.bp-count{font-family:'IBM Plex Mono',monospace; font-size:12px; font-weight:500; color:var(--dim);
  border:1px solid var(--rule); border-radius:10px; padding:0 8px}
.bp-note{color:var(--dim); font-size:12.5px; margin:6px 0 14px; max-width:72ch}
.bp-note--wide{max-width:none; margin:0 0 14px}

.bp-table{border:1px solid var(--rule); border-radius:3px; overflow:hidden; margin-top:12px}
.bp-tr{display:grid; grid-template-columns:90px 1fr 90px 130px 70px; gap:12px; padding:8px 14px;
  align-items:center; border-bottom:1px solid var(--rule); font-size:13px}
.bp-tr:last-child{border-bottom:0}
.bp-tr--head{background:var(--ground); font-size:11px; letter-spacing:.06em; text-transform:uppercase;
  color:var(--dim); font-family:'IBM Plex Mono',monospace; padding:7px 14px}
.bp-tr:not(.bp-tr--head):nth-child(even){background:#FAFBFC}

.bp-row{display:flex; gap:16px; flex-wrap:wrap; margin-top:12px}
.bp-row>*{flex:1 1 200px}
.bp-row--3>*{flex:1 1 160px}
.bp-row--tight{align-items:center; gap:10px}
.bp-row--tight>*{flex:0 0 auto}
.bp-field{display:flex; flex-direction:column; gap:5px}
.bp-field-l{font-size:12px; font-weight:600; color:var(--ink2)}
.bp-field-h{font-size:11.5px; color:var(--dim); line-height:1.45}
.bp-input{display:flex; align-items:center; background:var(--amber); border:1px solid var(--amberline);
  border-radius:3px; overflow:hidden}
.bp-input:focus-within{border-color:var(--accent); box-shadow:0 0 0 2px rgba(28,111,166,.15)}
.bp-input i{font-style:normal; padding:0 2px 0 9px; color:var(--dim);
  font-family:'IBM Plex Mono',monospace; font-size:13px}
.bp-input input{flex:1; min-width:0; border:0; background:transparent; padding:8px 10px 8px 4px;
  font-family:'IBM Plex Mono',monospace; font-size:13.5px; color:var(--ink); outline:none;
  font-variant-numeric:tabular-nums}
.bp-input input::placeholder{color:#B6A57A; font-size:12.5px}
.bp-input--sm input{padding:5px 8px 5px 3px}
.bp-input--xs{width:64px}
.bp-input--xs input{padding:3px 6px; font-size:12.5px; text-align:right}
.bp-select{font:inherit; font-size:13px; padding:8px 10px; border:1px solid var(--rule);
  border-radius:3px; background:var(--paper); color:var(--ink); cursor:pointer}

.bp-seg{display:inline-flex; border:1px solid var(--rule); border-radius:3px; overflow:hidden; margin-top:8px}
.bp-seg button{font:inherit; font-size:12.5px; font-weight:500; cursor:pointer; background:var(--paper);
  border:0; border-right:1px solid var(--rule); padding:7px 14px; color:var(--ink2)}
.bp-seg button:last-child{border-right:0}
.bp-seg button.on{background:var(--ink); color:#fff}

/* Parking quotas */
.bp-pools{display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:12px; margin-top:14px}
.bp-pool{border:1px solid var(--rule); border-radius:3px; padding:12px 14px; background:#FCFDFE}
.bp-pool--low{border-color:#E8C877; background:#FFFDF6}
.bp-pool--full{border-color:var(--red); background:#FDF6F7}
.bp-pool-h{display:flex; justify-content:space-between; align-items:baseline; gap:8px; font-size:13px}
.bp-pool-h strong{font-weight:600}
.bp-bar{height:5px; background:var(--rule); border-radius:3px; overflow:hidden; margin:9px 0 8px}
.bp-bar i{display:block; height:100%; background:var(--accent)}
.bp-pool--low .bp-bar i{background:#C98A15}
.bp-pool--full .bp-bar i{background:var(--red)}
.bp-pool-f{display:flex; justify-content:space-between; align-items:center; gap:8px}
.bp-pool-n{font-size:11px; color:var(--dim); margin-top:8px; line-height:1.45}
.bp-inline{display:flex; align-items:center; gap:6px; font-size:11.5px; color:var(--dim)}

.bp-matches{display:flex; flex-direction:column; gap:1px; background:var(--rule); border:1px solid var(--rule);
  border-radius:3px; overflow:hidden; margin-top:12px}
.bp-match{display:flex; align-items:center; gap:12px; padding:8px 12px; background:var(--paper); font-size:13px}
.bp-match>span:last-of-type{margin-right:auto}
.bp-tag{font-size:11.5px; color:var(--dim); border:1px solid var(--rule); border-radius:2px; padding:2px 7px}

.bp-list{display:flex; flex-direction:column; gap:1px; background:var(--rule); border:1px solid var(--rule);
  border-radius:3px; overflow:hidden; margin-top:12px; max-height:320px; overflow-y:auto}
.bp-item{display:flex; align-items:center; gap:12px; padding:8px 12px; background:var(--paper); font-size:13px}
.bp-rank{flex:0 0 22px; height:22px; border-radius:50%; background:var(--ink); color:#fff;
  font-family:'IBM Plex Mono',monospace; font-size:11px; display:flex; align-items:center;
  justify-content:center; font-weight:600}
.bp-rank--ok{background:var(--green)}
.bp-link{font:inherit; font-weight:600; font-size:13px; background:none; border:0; padding:0; cursor:pointer;
  color:var(--accent); text-decoration:underline; text-underline-offset:2px}
.bp-ts{margin-left:auto; font-size:11.5px}
.bp-item-a{display:flex; gap:6px; flex:0 0 auto}

/* AI */
.bp-presets{display:flex; flex-wrap:wrap; gap:6px; margin-bottom:4px}
.bp-chip{font:inherit; font-size:12px; cursor:pointer; background:var(--paper); border:1px solid var(--rule);
  border-radius:14px; padding:5px 12px; color:var(--ink2)}
.bp-chip:hover:not(:disabled){border-color:var(--accent); color:var(--accent)}
.bp-chip:disabled{opacity:.5; cursor:not-allowed}
.bp-ask{margin-top:10px}
.bp-ask .bp-input input{padding:8px 10px}
.bp-answer{margin-top:14px; padding:14px 16px; background:var(--paper); border:1px solid var(--rule);
  border-left:3px solid var(--accent); border-radius:3px; font-size:13.5px; line-height:1.7;
  white-space:pre-wrap}
.bp-err{margin-top:12px; color:var(--red); font-size:12.5px}

/* Buildings and floor stack */
.bp-bldgbar{display:flex; gap:8px; align-items:center; flex-wrap:wrap}
.bp-bldg{font:inherit; cursor:pointer; background:var(--paper); border:1px solid var(--rule); border-radius:3px;
  padding:8px 16px; display:flex; align-items:baseline; gap:8px; border-bottom:3px solid transparent}
.bp-bldg strong{font-family:'IBM Plex Mono',monospace; font-size:15px; font-weight:600}
.bp-bldg em{font-style:normal; font-size:11.5px; color:var(--dim)}
.bp-bldg.on{border-bottom-color:var(--c); background:#fff}
.bp-bldg.on strong{color:var(--c)}
.bp-legend{display:flex; gap:4px; margin-left:auto; flex-wrap:wrap}
.bp-legend button{font:inherit; font-size:11.5px; cursor:pointer; background:transparent;
  border:1px solid transparent; border-radius:3px; padding:5px 9px; color:var(--dim);
  display:flex; align-items:center; gap:5px}
.bp-legend button.on{background:var(--paper); border-color:var(--rule); color:var(--ink)}
.bp-legend i{width:8px; height:8px; border-radius:2px; display:block}

.bp-stack{display:flex; flex-direction:column; gap:1px; background:var(--rule); border:1px solid var(--rule);
  border-radius:4px; overflow:hidden}
.bp-floor{display:flex; background:var(--paper)}
.bp-floor-l{flex:0 0 52px; display:flex; align-items:center; justify-content:center;
  font-family:'IBM Plex Mono',monospace; font-size:13px; font-weight:600; color:var(--dim);
  background:#F5F7F9; border-right:1px solid var(--rule)}
.bp-floor-units{display:flex; flex-wrap:wrap; gap:5px; padding:9px 11px; flex:1}
.bp-empty{color:var(--dim); font-size:12px; padding:4px 2px}
.bp-unit{font:inherit; cursor:pointer; position:relative; text-align:left; background:var(--paper);
  border:1px solid var(--rule); border-left:3px solid var(--s); border-radius:2px; padding:5px 8px;
  min-width:84px; display:flex; flex-direction:column}
.bp-unit:hover{background:#F5F9FC; border-color:var(--accent); border-left-color:var(--s)}
.bp-unit-no{font-family:'IBM Plex Mono',monospace; font-size:13px; font-weight:600; line-height:1.3}
.bp-unit-t{font-size:10.5px; color:var(--dim); line-height:1.3}
.bp-unit-r{font-family:'IBM Plex Mono',monospace; font-size:11px; color:var(--ink2); line-height:1.4}
.bp-dot{position:absolute; top:4px; right:4px; width:5px; height:5px; border-radius:50%; background:var(--accent)}
.bp-p{position:absolute; bottom:4px; right:5px; font-style:normal; font-size:11px; color:var(--green);
  font-weight:700}
.bp-p.wait{color:#C98A15}

/* Drawer */
.bp-drawer-wrap{position:fixed; inset:0; background:rgba(19,28,37,.42); display:flex;
  justify-content:flex-end; z-index:50}
.bp-drawer{background:var(--paper); width:min(420px,100%); height:100%; overflow-y:auto;
  border-left:1px solid var(--rule); animation:bpIn .22s cubic-bezier(.2,.8,.3,1)}
@keyframes bpIn{from{transform:translateX(24px); opacity:.4} to{transform:none; opacity:1}}
@media (prefers-reduced-motion:reduce){.bp-drawer{animation:none}}
.bp-drawer-head{display:flex; justify-content:space-between; gap:12px; padding:22px 22px 16px;
  border-bottom:1px solid var(--rule)}
.bp-drawer-head h3{font-family:'IBM Plex Mono',monospace; font-size:22px; font-weight:600;
  margin:3px 0 4px; letter-spacing:-.02em}
.bp-x{font:inherit; font-size:24px; line-height:1; cursor:pointer; background:none; border:0;
  color:var(--dim); padding:0 4px; height:fit-content}
.bp-x:hover{color:var(--ink)}
.bp-drawer-body{padding:20px 22px 40px; display:flex; flex-direction:column; gap:18px}
.bp-stallrow{display:flex; justify-content:space-between; align-items:center; gap:10px;
  border:1px solid var(--rule); border-radius:3px; padding:9px 11px; font-size:13px; margin-top:4px}

.bp-summary{border-top:1px solid var(--rule); padding-top:16px}
.bp-summary-h{font-size:11px; letter-spacing:.07em; text-transform:uppercase; color:var(--dim);
  font-family:'IBM Plex Mono',monospace; margin-bottom:9px}
.bp-line{display:flex; justify-content:space-between; gap:12px; padding:5px 0;
  border-bottom:1px dotted var(--rule); font-size:13px}
.bp-line:last-child{border-bottom:0}
.bp-line>span:first-child{color:var(--ink2)}
.bp-line em{font-style:normal; font-size:11px; color:var(--dim)}

.bp-foot{padding:8px 28px 0; color:var(--dim); font-size:11.5px; max-width:82ch; line-height:1.6}

@media (max-width:640px){
  .bp-head,.bp-tabs,.bp-body,.bp-foot{padding-left:16px; padding-right:16px}
  .bp-stat{padding:13px 16px}
  .bp-tr{grid-template-columns:70px 1fr 110px; gap:8px}
  .bp-tr>span:nth-child(3),.bp-tr>span:nth-child(5){display:none}
  .bp-legend{margin-left:0; width:100%}
  .bp-floor-l{flex-basis:40px}
  .bp-ts{display:none}
}
`;
