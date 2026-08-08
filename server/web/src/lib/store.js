import { useState, useEffect, useCallback, useRef } from "react";
import api, { ApiError, getToken } from "./api.js";

/* ============================================================
   Data layer

   Each tool asks for what it needs and gets back {data, loading,
   error, refresh, mutate}. Where the data comes from is decided
   here, once, rather than in thirteen components.

   Two sources:

     api      — the server. Locks, allocations and postings only
                mean anything here, because only the server can
                see what another browser is doing.

     storage  — browser storage. Every tool works standalone,
                which is what makes them reviewable without a
                running backend.

   Mode is detected: if the API answers, use it. That way a tool
   opened against a live server behaves correctly, and the same
   file opened in a sandbox still runs.
   ============================================================ */

let MODE = null;                 // null = not yet detected
let detecting = null;

/** One probe, shared by every caller. Thirteen tools mounting at once should
 *  not produce thirteen health checks. */
export async function detectMode() {
  if (MODE) return MODE;
  if (detecting) return detecting;
  detecting = (async () => {
    try {
      /* /api/health, not /api/auth/me.
         
         Health needs no session and always exists, so this answers "is there a
         server" without also answering "am I signed in". Asking an
         authenticated endpoint conflates the two: a signed-out browser against
         a perfectly good API would fall back to storage and quietly show
         nobody's data. */
      const res = await fetch("/api/health", { credentials: "include" });
      MODE = res.ok ? "api" : "storage";
    } catch {
      MODE = "storage";
    }
    detecting = null;
    return MODE;
  })();
  return detecting;
}

export const currentMode = () => MODE;
export const setMode = (m) => { MODE = m; };

/* ---------- storage helpers ---------- */

async function readKey(key, fallback) {
  try {
    const r = await window.storage?.get?.(key);
    return r?.value ? JSON.parse(r.value) : fallback;
  } catch { return fallback; }
}

async function writeKey(key, value) {
  try { await window.storage?.set?.(key, JSON.stringify(value)); return true; }
  catch { return false; }
}

/* ---------- resource map ----------

   Each entry says how to read a thing from the API and how to read the same
   thing from browser storage. The pair is declared side by side deliberately:
   when a tool is wired up, both halves are here rather than scattered through
   a component.

   `ported` says whether the endpoint exists on the Worker yet.

   It matters because the two are not one switch. The API is up long before
   every route is on it, and a resource that flips to API mode before its
   endpoint exists shows an empty table — which reads as "there is no data"
   rather than "this is not wired yet". So an unported resource stays on
   storage even when the server is answering, and says so.

   Delete the flag as each one lands. */

export const RESOURCES = {
  units:        { ported: true, key: "baydo:overrides",    load: () => api.units(),
                  pick: (r) => r.units },
  pricing:      { ported: true, key: "baydo:pricing",      load: () => api.pricing() },
  parking:      { ported: true, key: "baydo:parking",      load: () => api.parking() },
  leads:        { ported: false, key: "baydo:leads",        load: () => api.get("/leads"),
                  pick: (r) => r.leads },
  events:       { ported: false, key: "baydo:schedule",     load: () => api.get("/events"),
                  pick: (r) => r.events },
  moveouts:     { ported: false, key: "baydo:moveouts",     load: () => api.moveouts(),
                  pick: (r) => r.moveouts },
  maintenance:  { ported: false, key: "baydo:maintenance",  load: () => api.maintenance(),
                  pick: (r) => r.tickets },
  templates:    { ported: false, key: "baydo:doclib",       load: () => api.get("/templates"),
                  pick: (r) => r.templates },
  documents:    { ported: false, key: "baydo:docinst",      load: () => api.get("/documents"),
                  pick: (r) => r.documents },
  keyHandovers: { ported: false, key: "baydo:keyhandover",  load: () => api.get("/key-handovers"),
                  pick: (r) => r.handovers },
  entryNotices: { ported: false, key: "baydo:entrynotices", load: () => api.get("/entry-notices/pending"),
                  pick: (r) => r.pending },
  notifications:{ key: "baydo:notifications",load: () => api.notifications(),
                  pick: (r) => r.notifications },
  outbox:       { ported: false, key: "baydo:outbox",       load: () => api.get("/outbox"),
                  pick: (r) => r.messages },

  agreements:   { ported: false, key: "baydo:agreements",   load: () => api.get("/agreements"),
                  pick: (r) => r.agreements },
  agreementIssues:{ ported: false, key: "baydo:agreementissues",
                  load: () => api.get("/agreements/issues"), pick: (r) => r.issues },

  // Accounting
  coa:          { ported: false, key: "acct:coa",           load: () => api.get("/accounting/coa"),
                  pick: (r) => r.accounts },
  vendors:      { ported: false, key: "acct:vendors",       load: () => api.get("/accounting/vendors"),
                  pick: (r) => r.vendors },
  invoices:     { ported: false, key: "acct:invoices",      load: () => api.get("/accounting/ap/invoices"),
                  pick: (r) => r.invoices },
  charges:      { ported: false, key: "acct:charges",       load: () => api.get("/accounting/ar/charges"),
                  pick: (r) => r.charges },
  receipts:     { ported: false, key: "acct:receipts",      load: () => api.get("/accounting/ar/receipts"),
                  pick: (r) => r.receipts },
  schedules:    { ported: false, key: "acct:schedules",     load: () => api.get("/accounting/schedules"),
                  pick: (r) => r.schedules },
  journal:      { ported: false, key: "acct:entries",       load: () => api.get("/accounting/journal"),
                  pick: (r) => r.entries },
  periods:      { ported: false, key: "acct:periods",       load: () => api.get("/accounting/periods"),
                  pick: (r) => r.periods },
  statements:   { ported: false, key: "acct:statements",    load: () => api.get("/accounting/bank/statements"),
                  pick: (r) => r.statements },
  reports:      { ported: false, key: "acct:reports",       load: () => api.get("/accounting/reports"),
                  pick: (r) => r.reports },
  amendments:   { ported: false, key: "acct:amendments",    load: () => api.get("/accounting/amendments"),
                  pick: (r) => r.amendments },
  rates:        { ported: false, key: "acct:rates",         load: () => api.get("/accounting/interest-rates"),
                  pick: (r) => r.rates },
};

/**
 * useResource("leads", [])
 *
 * Returns { data, loading, error, refresh, save, mode }.
 *
 * `save` writes back. Against storage it persists the whole collection;
 * against the API it is a no-op, because the server owns the record and
 * writing a local copy over it is how two browsers start disagreeing.
 */
export function useResource(name, fallback = []) {
  const spec = RESOURCES[name];
  if (!spec) throw new Error(`Unknown resource: ${name}`);

  const [data, setData] = useState(fallback);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [mode, setLocalMode] = useState(MODE);
  const alive = useRef(true);

  const load = useCallback(async () => {
    setError(null);
    const m = await detectMode();
    if (!alive.current) return;
    setLocalMode(m);

    /* Three conditions, not one.
       
       The server has to be up, the person has to be signed in, and this
       particular resource has to exist on it. The third is the one that
       matters during a port: the API is answering long before every route is
       on it, and a resource that switches early shows an empty table — which
       reads as "there is no data" rather than "this is not wired yet". */
    const useApi = m === "api" && !!getToken() && spec.ported;

    if (useApi) {
      try {
        const res = await spec.load();
        if (!alive.current) return;
        setData(spec.pick ? spec.pick(res) : res);
        setLocalMode("api");
      } catch (e) {
        if (!alive.current) return;

        /* A 404 means the endpoint is not there after all, so the flag is
           wrong. Fall back rather than showing an empty screen — being one
           deploy behind should not look like having lost the data. */
        if (e instanceof ApiError && e.status === 404) {
          setData(await readKey(spec.key, fallback));
          setLocalMode("storage");
          console.warn(`[store] ${name} is marked ported but the endpoint answered 404.`);
        } else if (e instanceof ApiError && e.status === 401) {
          // Not an error to show: the shell sends the person to sign in.
          setData(fallback);
        } else {
          setError(e);
          setData(fallback);
        }
      }
    } else {
      setData(await readKey(spec.key, fallback));
      setLocalMode(m === "api" && !spec.ported ? "pending" : "storage");
    }
    if (alive.current) setLoading(false);
  }, [name]);

  useEffect(() => { alive.current = true; load(); return () => { alive.current = false; }; }, [load]);

  const save = useCallback(async (next) => {
    setData(next);
    // Only the server owns a ported resource. Writing a local copy over it is
    // how two browsers start disagreeing about the same suite.
    if (MODE === "api" && spec.ported) return true;
    return writeKey(spec.key, next);
  }, [name]);

  return { data, loading, error, refresh: load, save, mode };
}

/* ---------- Writes ----------
   Against the API these go through the endpoint that owns the rule. Against
   storage they fall back to a local mutation, so a tool still works alone.

   Two of these behave differently once the server is involved, and that
   difference is the whole point of having a server:

     requestStall  — the browser version can hand the same last stall to two
                     people. The server settles it inside a transaction.

     acquireLock   — the browser version cannot see other browsers at all.
                     The server returns 409 with the holder's name.
*/

export async function requestStall({ pool_code, unit_number, max_per_unit }, local) {
  if (MODE === "api") return api.requestStall({ pool_code, unit_number, max_per_unit });
  return local?.();
}

export async function acquireLock(unit, local) {
  if (MODE === "api") return api.acquireLock(unit);
  return local?.();
}

/** AI runs on the server. Called from the browser the key ends up in the
 *  bundle, and the call leaves nothing in the audit trail. */
export async function runAiTask(task, input, ref = {}) {
  if (MODE !== "api") throw new ApiError(503, { code: "AI_REQUIRES_SERVER" });
  return api.post(`/ai/${task}`, { input, ...ref });
}

export async function publicAiChat(input) {
  const res = await fetch("/api/public/ai/chat", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => ({})));
  return res.json();
}

/**
 * Three states, not two.
 *
 *   api      the server owns this, and locks and allocations mean something
 *   pending  the server is up but this route is not on it yet
 *   storage  no server; everything is local to this browser
 *
 * The middle one is worth its own word. "Storage" on a screen where the API
 * is plainly working reads as a fault, and somebody will go looking for one.
 */

/** Shows which mode a tool is running in. Worth surfacing: a tool that looks
 *  identical in both is a tool where somebody will assume the lock works. */
export function useMode() {
  const [mode, setLocal] = useState(MODE);
  useEffect(() => { detectMode().then(setLocal); }, []);
  return mode;
}

export { api, ApiError };
