import React, { useState, useEffect, createContext, useContext } from "react";
import { useNavigate, useLocation, Navigate } from "react-router-dom";

/* ============================================================
   Who is signed in, on the tenant side

   Browsing is open: suites, the buildings, what is available and
   what it costs. Somebody deciding whether this is worth a visit
   should not have to hand over an email address first.

   Booking and applying are not. Those produce a slot in a diary
   and a decision somebody has to make, and both need a real
   person attached — a viewing booked by nobody is a half hour
   held for somebody who was never coming.

   The part that matters more than the gate: when we send somebody
   to sign up, we remember what they were doing and take them back
   to it. Sending them to a dashboard afterwards loses the
   intention they arrived with, and they do not come back to
   reconstruct it.
   ============================================================ */

const TenantAuth = createContext(null);

export function TenantAuthProvider({ children }) {
  const [session, setSession] = useState(undefined);   // undefined = still checking

  useEffect(() => {
    (async () => {
      let saved = null;
      try {
        const r = await window.storage.get("baydo:tenant-session");
        saved = r?.value ? JSON.parse(r.value) : null;
      } catch {}
      if (!saved?.token) { setSession(null); return; }

      // A stored session is not proof of a live one. Checking now means an
      // expired token sends somebody to sign in rather than to a page that
      // fails when they try to do something.
      try {
        const res = await fetch("/api/tenant/me", {
          headers: { Authorization: `Bearer ${saved.token}` },
          credentials: "include",
        });
        if (res.ok) {
          const d = await res.json();
          setSession({ ...saved, ...d.tenant, account_state: d.account_state });
        } else {
          await window.storage.delete("baydo:tenant-session").catch(() => {});
          setSession(null);
        }
      } catch {
        setSession(saved);   // offline: work from what we have
      }
    })();
  }, []);

  const signOut = async () => {
    try { await window.storage.delete("baydo:tenant-session"); } catch {}
    setSession(null);
  };

  return (
    <TenantAuth.Provider value={{ session, setSession, signOut }}>
      {children}
    </TenantAuth.Provider>
  );
}

export const useTenantAuth = () => useContext(TenantAuth) ?? { session: null };

/**
 * Sends somebody to sign in, carrying where they were going.
 *
 * The `next` parameter is the whole point. Somebody who clicked "book a
 * viewing" on a specific suite has told us exactly what they want; dropping
 * them on a dashboard after they sign up throws that away, and they rarely
 * reconstruct it.
 */
export function useRequireAuth() {
  const { session } = useTenantAuth();
  const navigate = useNavigate();
  const location = useLocation();

  return (to) => {
    if (session) { navigate(to); return true; }
    const next = encodeURIComponent(to);
    navigate(`/signup?next=${next}`);
    return false;
  };
}

/** Where to go after signing in or signing up. Only same-site paths, because
 *  a `next` taken from a URL is a redirect anybody can aim anywhere. */
export function nextFrom(search, fallback = "/portal") {
  const raw = new URLSearchParams(search).get("next");
  if (!raw) return fallback;
  const decoded = decodeURIComponent(raw);
  return decoded.startsWith("/") && !decoded.startsWith("//") ? decoded : fallback;
}

/**
 * A page that needs somebody signed in.
 *
 * Hiding the link is not the same as closing the page. Anybody who has the
 * URL, or who was signed in yesterday and bookmarked it, arrives at /apply
 * regardless of what the navigation shows — so the route checks too.
 *
 * It waits while the session is still being read rather than bouncing
 * immediately. Redirecting on undefined throws out everybody whose check has
 * not come back yet, which on a slow connection is everybody.
 */
export function RequireAuth({ children, fallback = null }) {
  const { session } = useTenantAuth();
  const location = useLocation();

  if (session === undefined) return fallback;

  if (!session) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/signup?next=${next}`} replace />;
  }
  return children;
}

/**
 * A button that needs somebody signed in.
 *
 * Says so before the click rather than after. A button that looks available
 * and then asks for an account is a small betrayal, and the second time
 * somebody meets it they stop trusting the rest of the page.
 */
export function GatedLink({ to, children, className, hint }) {
  const { session } = useTenantAuth();
  const go = useRequireAuth();

  return (
    <button
      className={className}
      title={session ? undefined : hint}
      onClick={() => go(to)}
    >
      {children}
      {!session && <span className="bt-lockdot" aria-hidden="true" />}
    </button>
  );
}
