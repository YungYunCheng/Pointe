import React, { useState, useEffect } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useT } from "../lib/locale.jsx";

/* ============================================================
   Tenant portal — for people who have already moved in.

   Four things a tenant actually needs between signing and moving out:
   report a repair, read notices, pay rent, find their documents.

   Two behaviours worth keeping when this is wired to the API:

   · The repair form asks whether anything is unsafe before it asks
     anything else. If the answer is yes it gives the office number
     and says to call. A form that quietly queues an active leak
     behind three other tickets is worse than no form.

   · Rent shows what is owed and how it was arrived at, but a payment
     is recorded once, by accounting, against the charge it settles.
     A second place to record a payment is a second place for it to
     disagree with the ledger.
   ============================================================ */

const OFFICE_PHONE = "306-974-1727";

const STATE_KEY = {
  new: "repairs.statusNew", scheduled: "repairs.statusScheduled",
  in_progress: "repairs.statusProgress", done: "repairs.statusDone",
  cancelled: "repairs.statusDone",
};
const STATE_COLOR = {
  new: "#B23A54", scheduled: "#C98A15", in_progress: "#1C6FA6", done: "#0E8577",
  cancelled: "#6B7280",
};

const normaliseSession = (d) => ({
  ...(d?.tenant || {}),
  account_state: d?.account_state || (d?.unit ? "tenant" : "prospect"),
  unit: d?.unit || d?.tenant?.unit || null,
  lease: d?.lease || null,
  term: d?.lease?.term_type || null,
  leaseEnd: d?.lease?.end_date || null,
  rent: Number(d?.lease?.rent || 0),
  parking: d?.parking?.status === "assigned" ? d.parking.label : null,
  waitlist: d?.parking?.status === "waiting" ? d.parking.waitlist_position : null,
  balance: Number(d?.balance || 0),
  overdue: Number(d?.overdue || 0),
  charges: d?.charges || [],
  counts: d?.counts || { viewings: 0, applications: 0, to_sign: 0 },
  note: d?.note || null,
});

export default function Portal() {
  const { t, locale } = useT();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get("next");
  const [session, setSession] = useState(undefined);
  const [prefs, setPrefs] = useState({ allow_email: true, allow_sms: true,
                                       allow_marketing: false });
  const [tab, setTab] = useState("home");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/tenant/me", {
          credentials: "include" });
        if (res.ok) {
          const d = await res.json();
          setSession(normaliseSession(d));
        } else {
          setSession(null);
        }
      } catch {
        setSession(null);
      }
    })();
  }, []);

  useEffect(() => {
    if (session && next?.startsWith("/")) {
      navigate(next, { replace: true });
    }
  }, [session, next, navigate]);

  const finishSignIn = async (signedInSession) => {
    try {
      const res = await fetch("/api/tenant/me", { credentials: "include" });
      setSession(res.ok ? normaliseSession(await res.json()) : signedInSession);
    } catch { setSession(normaliseSession({ tenant: signedInSession,
      unit: signedInSession?.unit,
      account_state: signedInSession?.unit ? "tenant" : "prospect" })); }
    if (next?.startsWith("/")) navigate(next, { replace: true });
  };

  if (session === undefined) return <>
    <div className="bt-loading">{t("common.loading")}</div>
    <style>{PORTAL_CSS}</style>
  </>;
  if (!session) return <>
    <SignIn onIn={finishSignIn} />
    <style>{PORTAL_CSS}</style>
  </>;

  const isTenant = session.account_state === "tenant" && !!session.unit;

  return (
    <section className="bt-sec">
      <div className="bt-portal-h">
        <div>
          <h2>{t("portal.hello", { name: session.name })}</h2>
          <span className="bt-dim">{isTenant
            ? t("portal.yourSuite", { unit: session.unit }) : session.email}</span>
        </div>
        <button className="bt-btn bt-btn--ghost bt-btn--sm"
                onClick={async () => {
                  await fetch("/api/tenant/logout", { method: "POST", credentials: "include" }).catch(() => {});
                  setSession(null);
                }}>
          {t("nav.signout")}
        </button>
      </div>

      <nav className="bt-ptabs">
        {(isTenant ? [["home", "portal.tabHome"], ["repairs", "portal.tabRepairs"],
          ["notices", "portal.tabNotices"], ["rent", "portal.tabRent"],
          ["docs", "portal.tabDocs"]] : [["home", "portal.tabHome"]]).map(([k, label]) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{t(label)}</button>
        ))}
      </nav>

      {tab === "home" && (isTenant ? <Overview session={session} /> : <ProspectHome session={session} />)}
      {isTenant && tab === "repairs" && <Repairs session={session} />}
      {isTenant && tab === "notices" && <Notices session={session} />}
      {isTenant && tab === "rent"    && <Rent session={session} />}
      {isTenant && tab === "docs"    && (<>
        <Docs />
        <ContactPreferences prefs={prefs} zh={locale === "zh"}
          onSave={async (v) => { setPrefs(v);
            try { await window.storage.set("baydo:tenant-prefs", JSON.stringify(v)); } catch {} }} />
      </>)}

      <style>{PORTAL_CSS}</style>
    </section>
  );
}

/* ---------- sign in ---------- */
function SignIn({ onIn }) {
  const { t, locale } = useT();
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const go = async () => {
    setBusy(true); setErr("");
    if (!email.trim() || !pw) { setErr(t("common.error")); setBusy(false); return; }

    try {
      const res = await fetch("/api/public/tenant/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: email.trim(), password: pw }),
      });

      if (res.status === 423) {
        const d = await res.json();
        setErr(t("portal.locked", { until: String(d.locked_until ?? "").slice(11, 16) }));
        setBusy(false); return;
      }
      if (!res.ok) {
        // The same message whether the account exists or the password was
        // wrong. Anything else turns the login into an account checker.
        setErr(t("portal.badCredentials"));
        setBusy(false); return;
      }

      const { tenant } = await res.json();
      onIn(tenant);
    } catch {
      setErr(t("common.error"));
    }
    setBusy(false);
  };

  const forgot = async () => {
    if (!email.trim()) { setErr(t("portal.emailFirst")); return; }
    setBusy(true); setErr("");
    try {
      await fetch("/api/public/tenant/forgot", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
    } catch {}
    // Identical message either way, for the same reason as the login.
    setErr(t("portal.resetSent"));
    setBusy(false);
  };

  return (
    <section className="bt-sec"><div className="bt-form">
      <h2>{t("portal.title")}</h2>
      <p className="bt-body">{t("portal.signInSub")}</p>
      <div className="bt-f">
        <label>{t("portal.email")}</label>
        <input className="bt-in" type="email" value={email} autoComplete="username"
               onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} />
      </div>
      <div className="bt-f">
        <label>{t("portal.password")}</label>
        <input className="bt-in" type="password" value={pw} autoComplete="current-password"
               onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} />
      </div>
      {err && <div className="bt-err">{err}</div>}
      <div className="bt-auth-actions">
        <button className="bt-btn" onClick={go} disabled={busy || !email.trim() || !pw}>
          {busy ? t("common.loading") : t("portal.signIn")}
        </button>
        <button className="bt-linkbtn" onClick={forgot} disabled={busy}>
          {t("portal.forgot")}
        </button>
        <Link className="bt-linkbtn bt-linkbtn--muted" to="/claim">
          {t("portal.firstTime")}
        </Link>
        <Link className="bt-linkbtn bt-linkbtn--muted" to="/signup">
          {locale === "zh" ? "尚未簽約？建立租屋帳戶" : "Looking to rent? Create an account"}
        </Link>
      </div>
    </div></section>
  );
}

/* ---------- overview ---------- */
function Overview({ session }) {
  const { t, money, date } = useT();
  return (
    <div className="bt-cards" style={{ marginTop: 20 }}>
      <div className="bt-card">
        <h3>{t("portal.yourSuite", { unit: session.unit })}</h3>
        <div className="bt-dim">
          {session.term === "periodic" ? t("portal.leaseMonthly")
            : t("portal.leaseEnds", { date: date(session.leaseEnd) })}
        </div>
        <div className="bt-price"><strong>{money(session.rent)}</strong><em>{t("suites.perMonth")}</em></div>
      </div>
      <div className="bt-card">
        <h3>{t("parking.title")}</h3>
        <div className="bt-dim">
          {session.parking ? t("portal.parkingStall", { pool: session.parking })
            : session.waitlist ? t("portal.onWaitlist", { n: session.waitlist })
            : t("portal.noParking")}
        </div>
      </div>
    </div>
  );
}

function ProspectHome({ session }) {
  const { locale } = useT();
  const zh = locale === "zh";
  return (
    <div style={{ marginTop: 20 }}>
      <div className="bt-panel">
        <h3>{zh ? "你的租屋進度" : "Your rental progress"}</h3>
        <p className="bt-body">{session.note || (zh
          ? "簽署租約並由管理人員連結單位後，租金、維修與通知會出現在這裡。"
          : "Rent, repairs and notices appear here after a lease is signed and staff connect your suite.")}</p>
        <div className="bt-chips">
          <span>{zh ? `看房預約 ${session.counts.viewings}` : `Viewings ${session.counts.viewings}`}</span>
          <span>{zh ? `申請 ${session.counts.applications}` : `Applications ${session.counts.applications}`}</span>
          <span>{zh ? `待簽文件 ${session.counts.to_sign}` : `To sign ${session.counts.to_sign}`}</span>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 18, flexWrap: "wrap" }}>
          <Link to="/book" className="bt-btn">{zh ? "預約看房" : "Book a viewing"}</Link>
          <Link to="/apply" className="bt-btn bt-btn--ghost">{zh ? "送出申請" : "Apply"}</Link>
        </div>
      </div>
    </div>
  );
}

/* ---------- repairs ---------- */
function Repairs({ session }) {
  const { t, date } = useT();
  const [list, setList] = useState([]);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ what: "", where: "", urgent: null, files: [] });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = async () => {
    try {
      const r = await fetch("/api/tenant/repairs", { credentials: "include" });
      if (!r.ok) throw new Error("repairs");
      const d = await r.json();
      setList((d.repairs || []).map((x) => ({ ...x,
        state: x.ticket_state || "new", where: x.where_in_unit,
        createdAt: x.created_at, scheduledAt: x.scheduled_at })));
    } catch { setList([]); }
  };
  useEffect(() => { load(); }, [session.unit]);

  const submit = async () => {
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/tenant/repairs", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ what: f.what, where_in_unit: f.where,
          urgent: f.urgent === true }),
      });
      if (!r.ok) throw new Error("repair");
    } catch { setErr(t("common.error")); setBusy(false); return; }
    setF({ what: "", where: "", urgent: null, files: [] });
    setOpen(false); setBusy(false); load();
  };

  return (
    <div style={{ marginTop: 20 }}>
      <div className="bt-rowhead">
        <h3>{t("repairs.title")}</h3>
        {!open && <button className="bt-btn bt-btn--sm" onClick={() => setOpen(true)}>{t("repairs.new")}</button>}
      </div>

      {open && (
        <div className="bt-panel">
          <div className="bt-f">
            <label>{t("repairs.urgentQ")}</label>
            <div className="bt-opts">
              <button className={f.urgent === true ? "on" : ""} onClick={() => setF({ ...f, urgent: true })}>
                {t("repairs.urgentYes")}
              </button>
              <button className={f.urgent === false ? "on" : ""} onClick={() => setF({ ...f, urgent: false })}>
                {t("repairs.urgentNo")}
              </button>
            </div>
          </div>

          {/* Asked first, and answered first. A leak should not wait in a queue. */}
          {f.urgent === true && (
            <div className="bt-note" style={{ margin: "0 0 16px" }}>
              <p>{t("repairs.urgentCall", { phone: OFFICE_PHONE })}</p>
              <a className="bt-btn bt-btn--sm" href={`tel:${OFFICE_PHONE}`}>{OFFICE_PHONE}</a>
            </div>
          )}

          {f.urgent !== null && (
            <>
              <div className="bt-f">
                <label>{t("repairs.what")}</label>
                <textarea className="bt-ta" value={f.what} onChange={(e) => setF({ ...f, what: e.target.value })} />
              </div>
              <div className="bt-f">
                <label>{t("repairs.where")}</label>
                <input className="bt-in" value={f.where} onChange={(e) => setF({ ...f, where: e.target.value })} />
              </div>
              <p className="bt-hint">{t("repairs.entryConsent")}</p>
              {err && <div className="bt-err">{err}</div>}
              <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                <button className="bt-btn" disabled={!f.what.trim() || busy} onClick={submit}>
                  {t("repairs.submit")}
                </button>
                <button className="bt-btn bt-btn--ghost" onClick={() => setOpen(false)}>{t("common.close")}</button>
              </div>
            </>
          )}
        </div>
      )}

      {list.length === 0 ? <p className="bt-empty">{t("repairs.none")}</p> : (
        <div className="bt-list">
          {list.slice().reverse().map((r) => (
            <div className="bt-item" key={r.id}>
              <div className="bt-item-h">
                <span className="bt-tag" style={{ "--c": STATE_COLOR[r.state] }}>{t(STATE_KEY[r.state])}</span>
                {r.urgent && <span className="bt-tag" style={{ "--c": "#B23A54" }}>{t("repairs.rush")}</span>}
                <span className="bt-dim">{date(r.createdAt)}</span>
              </div>
              <p>{r.what}</p>
              {r.where && <div className="bt-dim">{r.where}</div>}
              {r.scheduledAt && <div className="bt-dim">{t("repairs.scheduledFor", { date: date(r.scheduledAt) })}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- notices ---------- */
function Notices({ session }) {
  const { t, date } = useT();
  const [list, setList] = useState([]);
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/tenant/notices", { credentials: "include" });
        if (!r.ok) throw new Error("notices");
        const d = await r.json();
        setList(d.notices || []);
      } catch { setList([]); }
    })();
  }, [session.unit]);

  if (!list.length) return <p className="bt-empty" style={{ marginTop: 20 }}>{t("notices.none")}</p>;

  return (
    <div className="bt-list" style={{ marginTop: 20 }}>
      {list.map((n) => {
        const clock = (v) => {
          const s = String(v || "");
          return s.includes("T") ? s.slice(11, 16) : s.slice(0, 5);
        };
        const from = clock(n.window_from);
        const to = clock(n.window_to);
        return (
          <div className="bt-item" key={n.id}>
            <div className="bt-item-h">
              <span className="bt-tag" style={{ "--c": "#1C6FA6" }}>{t("notices.entry")}</span>
              <span className="bt-dim">{date(n.sent_at)}</span>
            </div>
            <p>{t("notices.entryBody", { date: date(n.entry_date || n.date),
                 from: from || "—", to: to || "—", reason: n.purpose })}</p>
            <div className="bt-dim">{t("notices.entryReschedule")}</div>
          </div>
        );
      })}
    </div>
  );
}

/* ---------- rent ---------- */
function Rent({ session }) {
  const { t, money } = useT();
  return (
    <div style={{ marginTop: 20 }}>
      <h3>{t("rent.title")}</h3>
      <div className="bt-price" style={{ marginBottom: 4 }}>
        <strong>{money(session.balance)}</strong><em>{t("rent.title")}</em>
      </div>
      <p className="bt-dim">{t("rent.dueOn", { day: 1 })}</p>
      {/* A payment is recorded once, by accounting, against the charge it
          settles. Recording it here as well would create a second version of
          the truth about money. */}
      <a className="bt-btn" href="/api/tenant/ledger/download">{t("docs.download")}</a>
      <p className="bt-hint" style={{ marginTop: 10 }}>{t("rent.external")}</p>
    </div>
  );
}

/* ---------- documents ---------- */
function Docs() {
  const { t } = useT();
  const docs = [
    { k: "docs.lease" }, { k: "docs.inspection" }, { k: "docs.receipt" },
  ];
  return (
    <div className="bt-list" style={{ marginTop: 20 }}>
      {docs.map((d) => (
        <div className="bt-item bt-item--row" key={d.k}>
          <span>{t(d.k)}</span>
          <button className="bt-btn bt-btn--ghost bt-btn--sm">{t("docs.download")}</button>
        </div>
      ))}
    </div>
  );
}

/* ══════════════════ How we contact you ══════════════════ */

/** Marketing consent, and only marketing.
 *
 *  A notice of entry is a legal obligation and does not depend on a
 *  preference. Saying so here matters: a tenant who turns everything off and
 *  then receives an entry notice should not think the switch was ignored. */
function ContactPreferences({ prefs, onSave, zh }) {
  const set = (patch) => onSave({ ...prefs, ...patch });

  return (
    <section className="bt-card">
      <h3>{zh ? "聯絡方式" : "How we contact you"}</h3>

      <label className="bt-pref">
        <input type="checkbox" checked={prefs.allow_email !== false}
               onChange={(e) => set({ allow_email: e.target.checked })} />
        <span>
          <strong>Email</strong>
          <em>{zh ? "收據、通知、文件" : "Receipts, notices, documents"}</em>
        </span>
      </label>

      <label className="bt-pref">
        <input type="checkbox" checked={prefs.allow_sms !== false}
               onChange={(e) => set({ allow_sms: e.target.checked })} />
        <span>
          <strong>{zh ? "簡訊" : "Text message"}</strong>
          <em>{zh ? "時間提醒、緊急事項" : "Time reminders and anything urgent"}</em>
        </span>
      </label>

      <label className="bt-pref">
        <input type="checkbox" checked={!!prefs.allow_marketing}
               onChange={(e) => set({ allow_marketing: e.target.checked })} />
        <span>
          <strong>{zh ? "社區消息" : "Building news"}</strong>
          <em>{zh ? "活動、設施更新，與租約無關的內容"
                 : "Events and amenity updates, nothing to do with your tenancy"}</em>
        </span>
      </label>

      <p className="bt-hint">
        {zh
          ? "進入單位通知、租金收據這類與租約有關的通知是法定義務，不受這裡的設定影響。關掉一個管道，我們會用另一個送。"
          : "Notices required by your tenancy — a notice of entry, for instance — are a legal obligation and are not affected by these. Turn a channel off and we use the other one."}
      </p>
    </section>
  );
}

const PORTAL_CSS = `
.bt-portal-h{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
.bt-portal-h h2{margin:0}
.bt-ptabs{display:flex;gap:2px;flex-wrap:wrap;border-bottom:1px solid var(--rule);margin-top:18px}
.bt-ptabs button{font:inherit;font-size:14px;font-weight:600;cursor:pointer;background:none;border:0;
  padding:11px 14px;color:var(--dim);border-bottom:2px solid transparent;margin-bottom:-1px}
.bt-ptabs button.on{color:var(--ink);border-bottom-color:var(--ink)}
.bt-rowhead{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:14px}
.bt-rowhead h3{font-family:'Archivo',sans-serif;font-size:18px;margin:0}
.bt-panel{border:1px solid var(--rule);border-radius:10px;padding:18px;margin-bottom:18px;background:#fff}
.bt-list{display:flex;flex-direction:column;gap:10px}
.bt-item{border:1px solid var(--rule);border-radius:10px;padding:14px 16px;background:#fff}
.bt-item--row{display:flex;justify-content:space-between;align-items:center;gap:12px}
.bt-item-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}
.bt-item p{margin:0 0 4px;font-size:14.5px;line-height:1.6}
.bt-pref{display:flex;gap:11px;align-items:flex-start;padding:10px 0;
  border-bottom:1px solid var(--rule);cursor:pointer}
.bt-pref:last-of-type{border-bottom:0}
.bt-pref input{margin-top:3px}
.bt-pref strong{display:block;font-size:13.5px}
.bt-pref em{display:block;font-style:normal;font-size:12px;color:var(--dim);margin-top:1px}
.bt-tag{font-size:11px;font-weight:700;color:#fff;background:var(--c);border-radius:10px;padding:2px 9px}
/* Same text-link treatment as the staff sign-in screen: this is an action,
   but it should not visually compete with the primary Sign in button. */
.bt-auth-actions{display:flex;flex-direction:column;align-items:flex-start;gap:3px;margin-top:2px}
.bt-linkbtn{font:inherit;font-size:12.5px;cursor:pointer;background:none;border:0;color:var(--accent);
  padding:2px;text-align:left}
.bt-linkbtn:hover{text-decoration:underline}
.bt-linkbtn--muted{color:var(--dim)}
.bt-linkbtn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
`;
