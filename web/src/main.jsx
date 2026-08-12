import React, { useState, useEffect, Suspense, lazy, Component } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation, useNavigate } from "react-router-dom";
import { applyTheme, ROLE_THEME, MizarMark, BRAND_CSS, roleColor } from "./lib/theme.jsx";
import api from "./lib/api.js";

/* ============================================================
   Entry point and shell

   Each tool is loaded lazily, so opening the leasing console does
   not pull in the document library or the audit log. They are large
   and rarely needed together.

   Navigation is filtered by role. That is convenience, not security:
   the server checks permissions on every endpoint, which is what
   actually stops anyone reaching what they should not.
   ============================================================ */

const AuthConsole     = lazy(() => import("./tools/AuthConsole.jsx"));
const UnitsConsole    = lazy(() => import("./tools/UnitsConsole.jsx"));
const LeadsCrm        = lazy(() => import("./tools/LeadsCrm.jsx"));
const Schedule        = lazy(() => import("./tools/Schedule.jsx"));
const AiInbox         = lazy(() => import("./tools/AiInbox.jsx"));
const LeaseIntake     = lazy(() => import("./tools/LeaseIntake.jsx"));
const Operations      = lazy(() => import("./tools/Operations.jsx"));
const BuildingManager = lazy(() => import("./tools/BuildingManager.jsx"));
const AuditLog        = lazy(() => import("./tools/AuditLog.jsx"));
const Accounting      = lazy(() => import("./tools/Accounting.jsx"));
const Agreements      = lazy(() => import("./tools/Agreements.jsx"));
const Portfolio       = lazy(() => import("./tools/Portfolio.jsx"));
const AdminConsole    = lazy(() => import("./tools/AdminConsole.jsx"));
const AiTrainingCenter = lazy(() => import("./tools/AiTrainingCenter.jsx"));
const Confirmations   = lazy(() => import("./tools/Confirmations.jsx"));
const FloorPlans      = lazy(() => import("./tools/FloorPlans.jsx"));
const MaintenanceWorkflow = lazy(() => import("./tools/MaintenanceWorkflow.jsx"));

const ALL = "admin property_manager building_manager accounting".split(" ");
const LEASING = ["admin", "property_manager", "building_manager"];
const TOOLS = [
  { path: "/confirmations", label: "Confirmations", el: Confirmations, roles: ALL },
  { path: "/units",       label: "Units",       el: UnitsConsole,    roles: ALL },
  { path: "/floor-plans", label: "Floor plans", el: FloorPlans,      roles: ALL },
  { path: "/maintenance", label: "Maintenance", el: MaintenanceWorkflow, roles: ["admin", "building_manager"] },
  { path: "/schedule",    label: "Schedule",    el: Schedule,        roles: LEASING },
  { path: "/leads",       label: "Leads",       el: LeadsCrm,        roles: ["admin", "building_manager"] },
  { path: "/site",        label: "On site",     el: BuildingManager, roles: ["admin", "building_manager"] },
  { path: "/inbox",       label: "AI inbox",    el: AiInbox,         roles: ["admin", "property_manager"] },
  { path: "/intake",      label: "Lease intake",el: LeaseIntake,     roles: ["admin", "property_manager"] },
  { path: "/operations",  label: "Operations",  el: Operations,      roles: ["admin", "property_manager", "building_manager"] },
  { path: "/agreements",  label: "Agreements",  el: Agreements,      roles: ["admin", "property_manager"] },
  { path: "/portfolio",   label: "Portfolio",   el: Portfolio,       roles: ["admin", "property_manager", "building_manager"] },
  { path: "/accounting",  label: "Accounting",  el: Accounting,      roles: ["admin", "accounting", "property_manager"] },
  { path: "/audit",       label: "Audit",       el: AuditLog,        roles: ["admin"] },
  { path: "/ai-training", label: "AI Training", el: AiTrainingCenter, roles: ["admin"] },
  { path: "/admin",       label: "Admin",       el: AdminConsole,    roles: ["admin"] },
];

/* Labels and colours come from the theme, so there is one place a role is
   described rather than four that can drift apart. */
const ROLE_LABEL = Object.fromEntries(
  Object.entries(ROLE_THEME).map(([k, v]) => [k, v.label]));
const ROLE_COLOR = Object.fromEntries(
  Object.entries(ROLE_THEME).map(([k, v]) => [k, v.ink]));

function useSession() {
  const [session, setSession] = useState(undefined);   // undefined = still loading

  /* The whole shell recolours on sign-in. With four people sharing a screen
     and one of them able to post to the ledger, whose session this is should
     be answerable at a glance rather than by reading. */
  useEffect(() => {
    if (session === undefined) return;
    applyTheme(session?.role ?? "admin");
  }, [session?.role]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const { user } = await api.me();
        const s = { accountId: user.id, name: user.name, email: user.email,
          role: user.role, at: new Date().toISOString(),
          must_change_password: !!user.mustChangePassword };
        try { await window.storage?.set?.("baydo:session", JSON.stringify(s)); } catch {}
        if (alive) setSession(user.mustChangePassword ? null : s);
      } catch {
        try { await window.storage?.delete?.("baydo:session"); } catch {}
        if (alive) setSession(null);
      }
    };
    load();
    const onOut = () => setSession(null);
    const onIn = () => load();
    window.addEventListener("baydo:signed-out", onOut);
    window.addEventListener("baydo:signed-in", onIn);
    const poll = setInterval(load, 60000);
    return () => {
      alive = false; clearInterval(poll);
      window.removeEventListener("baydo:signed-out", onOut);
      window.removeEventListener("baydo:signed-in", onIn);
    };
  }, []);

  return session;
}

function Shell() {
  const session = useSession();
  const loc = useLocation();
  const navigate = useNavigate();
  const [loggingOut, setLoggingOut] = useState(false);

  const logout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try { await api.logout(); } catch {}
    try { await window.storage?.delete?.("baydo:session"); } catch {}
    window.dispatchEvent(new CustomEvent("baydo:signed-out"));
    navigate("/", { replace: true });
    setLoggingOut(false);
  };

  if (session === undefined)
    return <div className="sh-load">Loading…</div>;

  if (!session)
    return <Suspense fallback={<div className="sh-load">Loading…</div>}><AuthConsole /></Suspense>;

  const visible = TOOLS.filter((t) => t.roles.includes(session.role));

  return (
    <div className="sh">
      <nav className="sh-nav">
        <div className="sh-brand">
          <strong>Baydo Pointe</strong>
          <span>370 · 374 · 378 Clareview</span>
        </div>
        <div className="sh-links">
          {visible.map((t) => (
            <NavLink key={t.path} to={t.path}
                     className={({ isActive }) => (isActive ? "on" : "")}>{t.label}</NavLink>
          ))}
        </div>
        <div className="sh-who">
          <span className="sh-chip" style={{ background: ROLE_COLOR[session.role] }}>
            {ROLE_LABEL[session.role] ?? session.role}
          </span>
          <span className="sh-name">{session.name}</span>
          <button className="sh-logout" type="button" onClick={logout} disabled={loggingOut}>
            {loggingOut ? "Logging out…" : "Log out"}
          </button>
        </div>
      </nav>

      <main className="sh-main">
        <Suspense fallback={<div className="sh-load">Loading…</div>}>
          <Routes>
            <Route path="/" element={<Navigate to="/units" replace />} />
            {visible.map((t) => <Route key={t.path} path={t.path}
              element={<PageBoundary key={loc.pathname}><t.el session={session} /></PageBoundary>} />)}
            {/* A tool this role cannot see redirects rather than 404s, so a
                shared link degrades quietly instead of looking broken. */}
            <Route path="*" element={<Navigate to="/units" replace />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}

/* A failed lazy chunk or one broken tool must not erase the whole shell.
 * Navigating elsewhere remounts this boundary because it is keyed by path. */
class PageBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null, recovering: false }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) {
    console.error("[page]", error, info);
    const message = String(error?.message ?? error);
    const staleChunk = /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|chunkloaderror|loading chunk/i.test(message);
    if (!staleChunk) return;

    // A tab kept open during a deployment can still reference the previous
    // hashed page chunk. Refresh once to load the new manifest, but keep the
    // normal error screen if the refreshed deployment is genuinely broken.
    const key = `baydo:chunk-reload:${window.location.pathname}`;
    const lastAttempt = Number(sessionStorage.getItem(key) || 0);
    if (Date.now() - lastAttempt < 30_000) return;
    sessionStorage.setItem(key, String(Date.now()));
    this.setState({ recovering: true }, () => window.location.reload());
  }
  render() {
    if (!this.state.error) return this.props.children;
    if (this.state.recovering) return <div className="sh-load">Updating this page…</div>;
    return <section className="sh-crash">
      <h2>This page could not open</h2>
      <p>The rest of Pointe is still available. This usually happens when an older browser tab requests a page file from the previous deployment.</p>
      <div><button onClick={() => window.location.reload()}>Reload this page</button>
        <button onClick={() => { window.history.pushState({}, "", "/units"); window.location.reload(); }}>Go to Units</button></div>
      <details><summary>Error details</summary><code>{String(this.state.error?.message ?? this.state.error)}</code></details>
    </section>;
  }
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=Archivo:wght@700;800&display=swap');
*{box-sizing:border-box}
body{margin:0;font-family:'IBM Plex Sans',system-ui,sans-serif;
  background:var(--ground);color:var(--ink)}
.sh{min-height:100vh;display:flex;flex-direction:column}
.sh-load{padding:80px 20px;text-align:center;color:#78899A;font-size:14px}
.sh-nav{display:flex;align-items:center;gap:20px;flex-wrap:wrap;padding:0 20px;background:#fff;
  border-bottom:1px solid #D3DBE1;position:sticky;top:0;z-index:30}
.sh-brand{padding:12px 0;flex:0 0 auto}
.sh-brand strong{display:block;font-family:'Archivo',sans-serif;font-size:15px;letter-spacing:-.01em}
.sh-brand span{display:block;font-size:10.5px;color:#78899A}
.sh-links{display:flex;gap:2px;flex:1;flex-wrap:wrap;min-width:0}
.sh-links a{font-size:13.5px;font-weight:600;color:#78899A;text-decoration:none;padding:16px 13px;
  border-bottom:2px solid transparent;margin-bottom:-1px;white-space:nowrap}
.sh-links a:hover{color:#131C25}
.sh-links a.on{color:var(--brand);border-bottom-color:var(--brand);font-weight:700}
.sh-who{display:flex;align-items:center;gap:8px;flex:0 0 auto;padding:12px 0}
.sh-chip{font-size:10.5px;font-weight:700;color:#fff;background:var(--brand);border-radius:9px;padding:3px 10px;letter-spacing:.01em;transition:background .35s ease}
.sh-name{font-size:13px;font-weight:600}
.sh-logout{font:inherit;font-size:12px;font-weight:600;color:#5F6F7E;background:#fff;border:1px solid #C7D1D9;
  border-radius:4px;padding:6px 10px;cursor:pointer;white-space:nowrap}
.sh-logout:hover:not(:disabled){color:#B23A54;border-color:#B23A54;background:#FFF8FA}
.sh-logout:disabled{cursor:wait;opacity:.6}
.sh-main{flex:1}
.sh-crash{max-width:720px;margin:54px auto;padding:26px;background:#fff;border:1px solid #D3DBE1;border-left:4px solid #B23A54}
.sh-crash h2{margin:0 0 8px}.sh-crash p{color:#5f6f7e;line-height:1.6}.sh-crash div{display:flex;gap:8px;margin:18px 0}.sh-crash button{font:inherit;border:1px solid #b9c5cf;background:#fff;border-radius:4px;padding:9px 14px;cursor:pointer}.sh-crash button:first-child{background:#173b5f;color:#fff;border-color:#173b5f}.sh-crash details{color:#718096}.sh-crash code{display:block;margin-top:8px;white-space:pre-wrap}
@media (max-width:720px){
  .sh-nav{gap:10px;padding:0 14px}
  .sh-links{order:3;width:100%;overflow-x:auto;padding-bottom:2px}
  .sh-links a{padding:10px}
}
`;

const style = document.createElement("style");
style.textContent = CSS;
document.head.appendChild(style);

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter><Shell /></BrowserRouter>
  </React.StrictMode>
);
