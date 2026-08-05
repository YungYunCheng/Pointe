import React, { useState, useEffect, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation } from "react-router-dom";

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
const LeasingConsole  = lazy(() => import("./tools/LeasingConsole.jsx"));
const LeadsCrm        = lazy(() => import("./tools/LeadsCrm.jsx"));
const Schedule        = lazy(() => import("./tools/Schedule.jsx"));
const AiInbox         = lazy(() => import("./tools/AiInbox.jsx"));
const LeaseIntake     = lazy(() => import("./tools/LeaseIntake.jsx"));
const Documents       = lazy(() => import("./tools/Documents.jsx"));
const Operations      = lazy(() => import("./tools/Operations.jsx"));
const BuildingManager = lazy(() => import("./tools/BuildingManager.jsx"));
const AuditLog        = lazy(() => import("./tools/AuditLog.jsx"));
const Accounting      = lazy(() => import("./tools/Accounting.jsx"));

const ALL = "admin property_manager building_manager accounting".split(" ");
const LEASING = ["admin", "property_manager", "building_manager"];
const TOOLS = [
  { path: "/units",       label: "Units",       el: LeasingConsole,  roles: ALL },
  { path: "/schedule",    label: "Schedule",    el: Schedule,        roles: LEASING },
  { path: "/leads",       label: "Leads",       el: LeadsCrm,        roles: ["admin", "building_manager"] },
  { path: "/site",        label: "On site",     el: BuildingManager, roles: ["admin", "building_manager"] },
  { path: "/inbox",       label: "AI inbox",    el: AiInbox,         roles: ["admin", "property_manager"] },
  { path: "/intake",      label: "Lease intake",el: LeaseIntake,     roles: ["admin", "property_manager"] },
  { path: "/operations",  label: "Operations",  el: Operations,      roles: ["admin", "property_manager"] },
  { path: "/documents",   label: "Documents",   el: Documents,       roles: LEASING },
  { path: "/accounting",  label: "Accounting",  el: Accounting,      roles: ["admin", "accounting", "property_manager"] },
  { path: "/audit",       label: "Audit",       el: AuditLog,        roles: ["admin"] },
];

const ROLE_LABEL = {
  admin: "Admin",
  property_manager: "Property Manager",
  building_manager: "Building Manager",
  accounting: "Accounting",
};
const ROLE_COLOR = { admin: "#131C25", property_manager: "#1C6FA6",
                     building_manager: "#7C5CBF", accounting: "#0E8577" };

function useSession() {
  const [session, setSession] = useState(undefined);   // undefined = still loading

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await window.storage?.get?.("baydo:session");
        const s = r?.value ? JSON.parse(r.value) : null;
        if (alive) setSession(s);
      } catch {
        if (alive) setSession(null);
      }
    };
    load();
    const onOut = () => setSession(null);
    window.addEventListener("baydo:signed-out", onOut);
    const poll = setInterval(load, 3000);   // picks up sign-in from the auth tool
    return () => { alive = false; clearInterval(poll); window.removeEventListener("baydo:signed-out", onOut); };
  }, []);

  return session;
}

function Shell() {
  const session = useSession();
  const loc = useLocation();

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
        </div>
      </nav>

      <main className="sh-main">
        <Suspense fallback={<div className="sh-load">Loading…</div>}>
          <Routes>
            <Route path="/" element={<Navigate to={visible[0]?.path ?? "/units"} replace />} />
            {visible.map((t) => <Route key={t.path} path={t.path} element={<t.el />} />)}
            {/* A tool this role cannot see redirects rather than 404s, so a
                shared link degrades quietly instead of looking broken. */}
            <Route path="*" element={<Navigate to={visible[0]?.path ?? "/units"} replace />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=Archivo:wght@700;800&display=swap');
*{box-sizing:border-box}
body{margin:0;font-family:'IBM Plex Sans',system-ui,sans-serif;background:#E9EDF0;color:#131C25}
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
.sh-links a.on{color:#131C25;border-bottom-color:#131C25}
.sh-who{display:flex;align-items:center;gap:8px;flex:0 0 auto;padding:12px 0}
.sh-chip{font-size:10.5px;font-weight:700;color:#fff;border-radius:9px;padding:2px 9px;white-space:nowrap}
.sh-name{font-size:13px;font-weight:600}
.sh-main{flex:1}
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
