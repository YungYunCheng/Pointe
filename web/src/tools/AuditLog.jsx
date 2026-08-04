import React, { useState, useEffect, useRef, useCallback } from "react";

/* ============================================================
   BAYDO POINTE — Change log and backups (Admin)
   · Diffs every data key once a minute and records anything that changed
   · Keeps an hourly snapshot when something changed, so Admin can roll back
   · Retains the last 24 snapshots; older ones are pruned
   ============================================================ */

const WATCH = [
  { k: "baydo:pricing",     label: "Pricing and fees" },
  { k: "baydo:overrides",   label: "Unit settings" },
  { k: "baydo:parking",     label: "Parking quotas and allocations" },
  { k: "baydo:schedule",    label: "Schedule and holidays" },
  { k: "baydo:doclib",      label: "Document templates" },
  { k: "baydo:docinst",     label: "Document instances" },
  { k: "baydo:agentqueue",  label: "Tenant submissions" },
  { k: "baydo:leads",       label: "Leads" },
  { k: "baydo:accounts",    label: "Accounts (legacy)" },
  { k: "baydo:db:users",    label: "Users table", sensitive: true },
];
const LOG_KEY = "baydo:audit";
const IDX_KEY = "baydo:backups";
const SNAP_PREFIX = "baydo:backup:";
const MAX_SNAPSHOTS = 24;
const POLL_MS = 60000;
const SNAP_INTERVAL_MS = 3600000;
const MAX_LOG = 500;
const MASK = ["password_hash", "password_salt", "token_hash", "password_iterations"];

const nowISO = () => new Date().toISOString();
const fmt = (iso) => (iso ? iso.slice(0, 19).replace("T", " ") : "—");
const short = (v) => {
  if (v === undefined) return "(none)";
  if (v === null) return "null";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > 70 ? s.slice(0, 70) + "…" : s;
};

/* ---------- Recursive diff, returns the paths that changed ---------- */
function diff(a, b, path = "", out = [], sensitive = false) {
  if (out.length > 60) return out;
  const isObj = (x) => x && typeof x === "object";
  if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      const mask = sensitive && MASK.some((m) => path.endsWith(m));
      out.push({ path: path || "(root)", before: mask ? "***" : a, after: mask ? "***" : b });
    }
    return out;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) out.push({ path: path + ".length", before: a.length, after: b.length });
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n && out.length <= 60; i++) diff(a[i], b[i], `${path}[${i}]`, out, sensitive);
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (out.length > 60) break;
    diff(a[k], b[k], path ? `${path}.${k}` : k, out, sensitive);
  }
  return out;
}

export default function AuditConsole() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [log, setLog] = useState([]);
  const [backups, setBackups] = useState([]);
  const [tab, setTab] = useState("log");
  const [status, setStatus] = useState("");
  const [filterKey, setFilterKey] = useState("all");
  const [openId, setOpenId] = useState(null);
  const [confirmRestore, setConfirmRestore] = useState(null);
  const [busy, setBusy] = useState(false);
  const lastState = useRef({});
  const lastSnapAt = useRef(0);
  const dirty = useRef(false);

  const read = useCallback(async (k) => {
    try { const r = await window.storage.get(k); return r?.value ? JSON.parse(r.value) : null; }
    catch (e) { return null; }
  }, []);
  const write = useCallback(async (k, v) => {
    try { await window.storage.set(k, JSON.stringify(v)); return true; } catch (e) { return false; }
  }, []);

  /* ---------- Read every watched key ---------- */
  const snapshotAll = useCallback(async () => {
    const out = {};
    for (const w of WATCH) out[w.k] = await read(w.k);
    return out;
  }, [read]);

  /* ---------- Scan for changes ---------- */
  const scan = useCallback(async (opts = {}) => {
    const cur = await snapshotAll();
    const entries = [];
    const actor = session?.name || "unknown";
    for (const w of WATCH) {
      const before = lastState.current[w.k];
      const after = cur[w.k];
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      const action = before == null ? "created" : after == null ? "deleted" : "updated";
      entries.push({
        id: "au_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        at: nowISO(), actor, key: w.k, label: w.label, action,
        changes: diff(before, after, "", [], !!w.sensitive),
      });
    }
    lastState.current = cur;

    if (entries.length) {
      dirty.current = true;
      const next = [...entries, ...log].slice(0, MAX_LOG);
      setLog(next); await write(LOG_KEY, next);
      setStatus(`${entries.length} change(s) detected`);
      setTimeout(() => setStatus(""), 2500);
    }

    // Snapshot hourly, and only if something actually changed
    const due = Date.now() - lastSnapAt.current >= SNAP_INTERVAL_MS;
    if (opts.force || (due && dirty.current)) {
      await makeSnapshot(cur, opts.force ? "manual" : "hourly");
      dirty.current = false;
      lastSnapAt.current = Date.now();
    }
  }, [log, session, snapshotAll, write]);

  /* ---------- Create a snapshot ---------- */
  const makeSnapshot = useCallback(async (data, reason) => {
    const id = SNAP_PREFIX + Date.now();
    const ok = await write(id, data);
    if (!ok) { setStatus("Snapshot failed to write — the data may be over the size limit."); return; }
    const meta = { id, at: nowISO(), reason, by: session?.name || "system",
                   size: JSON.stringify(data).length,
                   counts: Object.fromEntries(WATCH.map((w) => [w.k, countOf(data[w.k])])) };
    let idx = [meta, ...backups];
    const drop = idx.slice(MAX_SNAPSHOTS);
    idx = idx.slice(0, MAX_SNAPSHOTS);
    for (const d of drop) { try { await window.storage.delete(d.id); } catch (e) {} }
    setBackups(idx); await write(IDX_KEY, idx);
    setStatus(`Snapshot created (${reason})`);
    setTimeout(() => setStatus(""), 2500);
  }, [backups, session, write]);

  /* ---------- Restore ---------- */
  const restore = async (meta) => {
    setBusy(true);
    const data = await read(meta.id);
    if (!data) { setStatus("That snapshot could not be read."); setBusy(false); setConfirmRestore(null); return; }
    // Snapshot the current state first, so a restore can itself be undone
    await makeSnapshot(await snapshotAll(), "pre-restore snapshot");
    for (const w of WATCH) {
      if (data[w.k] == null) { try { await window.storage.delete(w.k); } catch (e) {} }
      else await write(w.k, data[w.k]);
    }
    lastState.current = data;
    const entry = { id: "au_" + Date.now().toString(36), at: nowISO(),
                    actor: session?.name || "unknown", key: "(system)", label: "Data restore",
                    action: "restored", changes: [{ path: "restored_from", before: "—", after: fmt(meta.at) }] };
    const next = [entry, ...log].slice(0, MAX_LOG);
    setLog(next); await write(LOG_KEY, next);
    setConfirmRestore(null); setBusy(false);
    setStatus(`Restored to ${fmt(meta.at)}. Reload the other tools.`);
  };

  /* ---------- Init ---------- */
  useEffect(() => {
    (async () => {
      const s = await read("baydo:session"); if (s) setSession(s);
      const l = await read(LOG_KEY); if (l) setLog(l);
      const b = await read(IDX_KEY);
      if (b) { setBackups(b); if (b[0]) lastSnapAt.current = new Date(b[0].at).getTime(); }
      lastState.current = await snapshotAll();
      setLoading(false);
    })();
  }, [read, snapshotAll]);

  /* ---------- Polling ---------- */
  useEffect(() => {
    if (loading) return;
    const t = setInterval(() => { scan(); }, POLL_MS);
    return () => clearInterval(t);
  }, [loading, scan]);

  if (loading) return <div className="ad"><style>{CSS}</style><div className="ad-load">Loading the change log…</div></div>;

  if (session && session.role !== "admin") return (
    <div className="ad"><style>{CSS}</style>
      <div className="ad-deny">
        <h2>No access</h2>
        <p>The change log and restore are Admin only. You are signed in as {session.name}.</p>
      </div>
    </div>
  );

  const shown = filterKey === "all" ? log : log.filter((e) => e.key === filterKey);

  return (
    <div className="ad">
      <style>{CSS}</style>

      <header className="ad-head">
        <div>
          <div className="ad-eyebrow">Baydo Pointe · Admin</div>
          <h1>Change log and backups</h1>
        </div>
        <div className="ad-headr">
          {status && <span className="ad-status">{status}</span>}
          <button className="ad-btn ad-btn--ghost" onClick={() => scan()}>Scan now</button>
          <button className="ad-btn" onClick={() => scan({ force: true })}>Back up now</button>
        </div>
      </header>

      <div className="ad-stats">
        <S l="Changes" v={log.length} />
        <S l="Snapshots" v={`${backups.length} / ${MAX_SNAPSHOTS}`} />
        <S l="Latest backup" v={backups[0] ? fmt(backups[0].at).slice(5, 16) : "—"} small />
        <S l="Auto scan" v="every 60s" small />
      </div>

      <nav className="ad-tabs">
        <button className={tab === "log" ? "on" : ""} onClick={() => setTab("log")}>Change log</button>
        <button className={tab === "backup" ? "on" : ""} onClick={() => setTab("backup")}>
          Backups <i>{backups.length}</i>
        </button>
      </nav>

      <div className="ad-warn">
        This tool only sees changes while it is open. In production the record must be written <strong>on the server at every write</strong>,
        not polled from the browser: anything that happens while the page is closed is lost. Backups belong on a server schedule for the same reason.
      </div>

      {tab === "log" && (
        <div className="ad-body">
          <div className="ad-chips">
            <button className={filterKey === "all" ? "on" : ""} onClick={() => setFilterKey("all")}>All</button>
            {WATCH.map((w) => (
              <button key={w.k} className={filterKey === w.k ? "on" : ""}
                      onClick={() => setFilterKey(w.k)}>{w.label}</button>
            ))}
          </div>

          {shown.length === 0 ? (
            <div className="ad-empty">
              Nothing recorded yet. Change something in another tool, come back and press Scan now.
            </div>
          ) : (
            <div className="ad-list">
              {shown.map((e) => (
                <div className="ad-entry" key={e.id}>
                  <button className="ad-eh" onClick={() => setOpenId(openId === e.id ? null : e.id)}>
                    <span className={`ad-act ad-act--${e.action}`}>{e.action}</span>
                    <strong>{e.label}</strong>
                    <span className="ad-dim">{e.changes.length} field(s)</span>
                    <span className="ad-mono ad-dim ad-at">{fmt(e.at)}</span>
                    <span className="ad-actor">{e.actor}</span>
                    <span className="ad-caret">{openId === e.id ? "▾" : "▸"}</span>
                  </button>
                  {openId === e.id && (
                    <div className="ad-changes">
                      {e.changes.length === 0 && <div className="ad-dim">No field-level differences to show.</div>}
                      {e.changes.map((c, i) => (
                        <div className="ad-ch" key={i}>
                          <span className="ad-mono ad-path">{c.path}</span>
                          <span className="ad-before">{short(c.before)}</span>
                          <span className="ad-arrow">→</span>
                          <span className="ad-after">{short(c.after)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "backup" && (
        <div className="ad-body">
          <p className="ad-note">
            One snapshot an hour when something changed, up to {MAX_SNAPSHOTS}. A restore saves the current state first,
            so pressing it by mistake is recoverable.
          </p>

          {backups.length === 0 ? (
            <div className="ad-empty">No snapshots yet. Press Back up now to create the first one.</div>
          ) : (
            <div className="ad-list">
              {backups.map((b, i) => (
                <div className="ad-snap" key={b.id}>
                  <div className="ad-snaph">
                    <strong className="ad-mono">{fmt(b.at)}</strong>
                    {i === 0 && <span className="ad-latest">Latest</span>}
                    <span className="ad-dim">{b.reason} · {b.by}</span>
                    <span className="ad-dim ad-mono">{(b.size / 1024).toFixed(1)} KB</span>
                  </div>
                  <div className="ad-counts">
                    {WATCH.map((w) => {
                      const n = b.counts?.[w.k];
                      return n == null ? null : (
                        <span className="ad-cnt" key={w.k}>{w.label} <em>{n}</em></span>
                      );
                    })}
                  </div>
                  {confirmRestore === b.id ? (
                    <div className="ad-confirm">
                      <span>
                        Restoring overwrites <strong>everything</strong> with this snapshot,
                        including leads, submissions and stall allocations created since. Are you sure?
                      </span>
                      <button className="ad-btn ad-btn--danger" disabled={busy}
                              onClick={() => restore(b)}>{busy ? "Restoring…" : "Restore"}</button>
                      <button className="ad-btn ad-btn--ghost"
                              onClick={() => setConfirmRestore(null)}>Cancel</button>
                    </div>
                  ) : (
                    <button className="ad-btn ad-btn--sm ad-btn--ghost"
                            onClick={() => setConfirmRestore(b.id)}>Restore to this</button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <footer className="ad-foot">
        Password hashes and reset codes never appear in the log; they are written as ***. In production the audit table should be append-only:
        if even Admin can edit or delete entries, the log proves nothing.
      </footer>
    </div>
  );
}

function S({ l, v, small }) {
  return <div className="ad-stat"><div className="ad-stat-l">{l}</div>
    <div className={`ad-stat-v ${small ? "sm" : ""}`}>{v}</div></div>;
}

function countOf(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v.length;
  if (typeof v === "object") {
    if (Array.isArray(v.records)) return v.records.length;
    if (Array.isArray(v.events)) return v.events.length;
    if (Array.isArray(v.docs)) return v.docs.length;
    return Object.keys(v).length;
  }
  return 1;
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=Archivo:wght@700;800&display=swap');
.ad{--ink:#131C25;--ink2:#3E4C5A;--dim:#78899A;--paper:#fff;--ground:#E9EDF0;--rule:#D3DBE1;
  --amber:#FFF6E0;--amberline:#E8C877;--red:#B23A54;--green:#0E8577;--accent:#1C6FA6;
  background:var(--ground);color:var(--ink);min-height:100vh;font-size:14px;line-height:1.55;
  font-family:'IBM Plex Sans','PingFang TC','Microsoft JhengHei',system-ui,sans-serif;padding-bottom:44px}
.ad *{box-sizing:border-box}
.ad-mono{font-family:'IBM Plex Mono',monospace;font-variant-numeric:tabular-nums}
.ad-dim{color:var(--dim);font-size:12px}
.ad-load{padding:80px 20px;text-align:center;color:var(--dim)}
.ad-deny{max-width:440px;margin:70px auto;background:var(--paper);border:1px solid var(--rule);
  border-radius:5px;padding:26px 24px}
.ad-deny h2{font-family:'Archivo',sans-serif;margin:0 0 8px}
.ad-deny p{margin:0;font-size:13px;color:var(--ink2);line-height:1.7}

.ad-head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;
  padding:24px 28px 16px;background:var(--paper);border-bottom:1px solid var(--rule)}
.ad-eyebrow{font-family:'IBM Plex Mono',monospace;font-size:10.5px;letter-spacing:.13em;
  text-transform:uppercase;color:var(--dim)}
.ad-head h1{font-family:'Archivo','PingFang TC',sans-serif;font-weight:800;font-size:24px;
  letter-spacing:-.02em;margin:4px 0 0}
.ad-headr{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.ad-status{font-size:12px;color:var(--green);font-weight:600}

.ad-btn{font:inherit;font-weight:600;font-size:13px;cursor:pointer;background:var(--ink);color:#fff;
  border:1px solid var(--ink);padding:8px 15px;border-radius:3px}
.ad-btn:hover:not(:disabled){background:#000}
.ad-btn:disabled{opacity:.4;cursor:not-allowed}
.ad-btn--ghost{background:transparent;color:var(--ink2);border-color:var(--rule)}
.ad-btn--ghost:hover{background:var(--ground);color:var(--ink)}
.ad-btn--danger{background:var(--red);border-color:var(--red)}
.ad-btn--sm{padding:5px 11px;font-size:12px;align-self:flex-start}
.ad-btn:focus-visible,.ad-eh:focus-visible,.ad-tabs button:focus-visible,
.ad-chips button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

.ad-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));background:var(--paper);
  border-bottom:1px solid var(--rule)}
.ad-stat{padding:13px 28px;border-right:1px solid var(--rule)}
.ad-stat:last-child{border-right:0}
.ad-stat-l{font-size:10.5px;letter-spacing:.06em;color:var(--dim);text-transform:uppercase;
  font-family:'IBM Plex Mono',monospace}
.ad-stat-v{font-family:'IBM Plex Mono',monospace;font-size:20px;font-weight:600;margin-top:2px}
.ad-stat-v.sm{font-size:14px;padding-top:5px}

.ad-tabs{display:flex;padding:0 28px;background:var(--paper);border-bottom:1px solid var(--rule)}
.ad-tabs button{font:inherit;font-weight:600;font-size:13.5px;cursor:pointer;background:none;border:0;
  padding:12px 18px;color:var(--dim);border-bottom:2px solid transparent;margin-bottom:-1px;
  display:flex;align-items:center;gap:7px}
.ad-tabs button.on{color:var(--ink);border-bottom-color:var(--ink)}
.ad-tabs i{font-style:normal;font-family:'IBM Plex Mono',monospace;font-size:10.5px;
  background:var(--ground);border-radius:8px;padding:1px 7px;color:var(--ink2)}

.ad-warn{background:#FFF8E6;border-bottom:1px solid var(--amberline);padding:10px 28px;font-size:12px;
  color:#7A5D14;line-height:1.65}

.ad-body{padding:18px 28px;display:flex;flex-direction:column;gap:12px;max-width:1200px}
.ad-note{color:var(--dim);font-size:12.5px;margin:0;line-height:1.65}
.ad-empty{color:var(--dim);font-size:12.5px;padding:24px 0;text-align:center;background:var(--paper);
  border:1px dashed var(--rule);border-radius:4px}

.ad-chips{display:flex;gap:5px;flex-wrap:wrap}
.ad-chips button{font:inherit;font-size:12px;cursor:pointer;background:var(--paper);
  border:1px solid var(--rule);border-radius:14px;padding:4px 12px;color:var(--dim)}
.ad-chips button.on{background:var(--ink);color:#fff;border-color:var(--ink)}

.ad-list{display:flex;flex-direction:column;gap:1px;background:var(--rule);border:1px solid var(--rule);
  border-radius:4px;overflow:hidden}
.ad-entry{background:var(--paper)}
.ad-eh{font:inherit;width:100%;text-align:left;cursor:pointer;background:none;border:0;padding:9px 13px;
  display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ad-eh:hover{background:#F6F9FB}
.ad-eh strong{font-size:13px}
.ad-act{font-size:10.5px;font-weight:700;color:#fff;border-radius:9px;padding:1px 8px}
.ad-act--created{background:var(--green)}
.ad-act--updated{background:var(--accent)}
.ad-act--deleted{background:var(--red)}
.ad-act--restored{background:#7C5CBF}
.ad-at{margin-left:auto;font-size:11px}
.ad-actor{font-size:11.5px;color:var(--ink2);font-weight:600}
.ad-caret{color:var(--dim);font-size:11px}
.ad-changes{padding:4px 13px 12px;display:flex;flex-direction:column;gap:4px;
  border-top:1px dotted var(--rule)}
.ad-ch{display:grid;grid-template-columns:minmax(120px,1fr) 1fr 16px 1fr;gap:8px;align-items:baseline;
  font-size:11.5px;padding:3px 0}
.ad-path{color:var(--accent);word-break:break-all}
.ad-before{color:var(--dim);text-decoration:line-through;word-break:break-all}
.ad-arrow{color:var(--dim);text-align:center}
.ad-after{color:var(--ink);word-break:break-all}

.ad-snap{background:var(--paper);padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.ad-snaph{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.ad-snaph strong{font-size:13.5px}
.ad-latest{font-size:10.5px;font-weight:700;color:#fff;background:var(--green);border-radius:9px;
  padding:1px 8px}
.ad-counts{display:flex;gap:6px;flex-wrap:wrap}
.ad-cnt{font-size:11px;color:var(--ink2);background:var(--ground);border-radius:2px;padding:2px 7px}
.ad-cnt em{font-style:normal;font-family:'IBM Plex Mono',monospace;font-weight:600;margin-left:3px}
.ad-confirm{display:flex;gap:9px;align-items:center;flex-wrap:wrap;background:#FDF6F7;
  border:1px solid var(--red);border-radius:3px;padding:10px 12px;font-size:12.5px;color:var(--ink2)}

.ad-foot{padding:4px 28px 0;color:var(--dim);font-size:11.5px;max-width:90ch;line-height:1.7}

@media (max-width:760px){
  .ad-head,.ad-tabs,.ad-body,.ad-warn,.ad-foot{padding-left:16px;padding-right:16px}
  .ad-stat{padding:11px 16px}
  .ad-ch{grid-template-columns:1fr}
  .ad-arrow{display:none}
  .ad-at{margin-left:0;width:100%}
}
`;
