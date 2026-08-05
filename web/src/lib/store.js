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
      const res = await fetch("/api/auth/me", { credentials: "include" });
      // 401 still means a server is answering; it just wants a session.
      MODE = res.status < 500 ? "api" : "storage";
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
   thing from browser storage. The storage key and the endpoint are declared
   side by side deliberately: when a tool is wired up, the pair is right here
   rather than scattered through a component. */

export const RESOURCES = {
  units:        { key: "baydo:overrides",    load: () => api.units(),
                  pick: (r) => r.units },
  pricing:      { key: "baydo:pricing",      load: () => api.pricing() },
  parking:      { key: "baydo:parking",      load: () => api.parking() },
  leads:        { key: "baydo:leads",        load: () => api.get("/leads"),
                  pick: (r) => r.leads },
  events:       { key: "baydo:schedule",     load: () => api.get("/events"),
                  pick: (r) => r.events },
  moveouts:     { key: "baydo:moveouts",     load: () => api.moveouts(),
                  pick: (r) => r.moveouts },
  maintenance:  { key: "baydo:maintenance",  load: () => api.maintenance(),
                  pick: (r) => r.tickets },
  templates:    { key: "baydo:doclib",       load: () => api.get("/templates"),
                  pick: (r) => r.templates },
  documents:    { key: "baydo:docinst",      load: () => api.get("/documents"),
                  pick: (r) => r.documents },
  keyHandovers: { key: "baydo:keyhandover",  load: () => api.get("/key-handovers"),
                  pick: (r) => r.handovers },
  entryNotices: { key: "baydo:entrynotices", load: () => api.get("/entry-notices/pending"),
                  pick: (r) => r.pending },
  notifications:{ key: "baydo:notifications",load: () => api.notifications(),
                  pick: (r) => r.notifications },
  outbox:       { key: "baydo:outbox",       load: () => api.get("/outbox"),
                  pick: (r) => r.messages },

  // Accounting
  coa:          { key: "acct:coa",           load: () => api.get("/accounting/coa"),
                  pick: (r) => r.accounts },
  vendors:      { key: "acct:vendors",       load: () => api.get("/accounting/vendors"),
                  pick: (r) => r.vendors },
  invoices:     { key: "acct:invoices",      load: () => api.get("/accounting/ap/invoices"),
                  pick: (r) => r.invoices },
  charges:      { key: "acct:charges",       load: () => api.get("/accounting/ar/charges"),
                  pick: (r) => r.charges },
  receipts:     { key: "acct:receipts",      load: () => api.get("/accounting/ar/receipts"),
                  pick: (r) => r.receipts },
  schedules:    { key: "acct:schedules",     load: () => api.get("/accounting/schedules"),
                  pick: (r) => r.schedules },
  journal:      { key: "acct:entries",       load: () => api.get("/accounting/journal"),
                  pick: (r) => r.entries },
  periods:      { key: "acct:periods",       load: () => api.get("/accounting/periods"),
                  pick: (r) => r.periods },
  statements:   { key: "acct:statements",    load: () => api.get("/accounting/bank/statements"),
                  pick: (r) => r.statements },
  reports:      { key: "acct:reports",       load: () => api.get("/accounting/reports"),
                  pick: (r) => r.reports },
  amendments:   { key: "acct:amendments",    load: () => api.get("/accounting/amendments"),
                  pick: (r) => r.amendments },
  rates:        { key: "acct:rates",         load: () => api.get("/accounting/interest-rates"),
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

    if (m === "api" && getToken()) {
      try {
        const res = await spec.load();
        if (!alive.current) return;
        setData(spec.pick ? spec.pick(res) : res);
      } catch (e) {
        if (!alive.current) return;
        // A 401 is not an error to show: the shell sends the person to sign in.
        if (!(e instanceof ApiError && e.status === 401)) setError(e);
        setData(fallback);
      }
    } else {
      setData(await readKey(spec.key, fallback));
    }
    if (alive.current) setLoading(false);
  }, [name]);

  useEffect(() => { alive.current = true; load(); return () => { alive.current = false; }; }, [load]);

  const save = useCallback(async (next) => {
    setData(next);
    if (MODE === "api") return true;     // the server already has it
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

/** Shows which mode a tool is running in. Worth surfacing: a tool that looks
 *  identical in both is a tool where somebody will assume the lock works. */
export function useMode() {
  const [mode, setLocal] = useState(MODE);
  useEffect(() => { detectMode().then(setLocal); }, []);
  return mode;
}

export { api, ApiError };
