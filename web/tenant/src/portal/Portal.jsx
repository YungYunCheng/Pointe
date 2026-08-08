import React, { useState, useEffect } from "react";
import { useT } from "../lib/locale.jsx";

/* ============================================================
   The tenant side.

   Two audiences, one door. Somebody looking for a flat and somebody who
   already lives here sign in the same way — what differs is what they see
   afterwards, and that is decided by the server rather than by which form
   they used.

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
};
const STATE_COLOR = {
  new: "#B23A54", scheduled: "#C98A15", in_progress: "#1C6FA6", done: "#0E8577",
};

export default function Portal() {
  const { t } = useT();
  const [session, setSession] = useState(undefined);
  const [prefs, setPrefs] = useState({ allow_email: true, allow_sms: true,
                                       allow_marketing: false });
  const [me, setMe] = useState(null);

  /* Which half of the portal this is. Read from the server rather than
     inferred from whether a unit happens to be on the session — the server
     is the only thing that knows, and it is the only thing that decides. */
  const isTenant = me?.account_state === "tenant";
  const [tab, setTab] = useState("home");

  useEffect(() => {
    (async () => {
      let saved = null;
      try {
        const r = await window.storage.get("baydo:tenant-session");
        saved = r?.value ? JSON.parse(r.value) : null;
      } catch {}
      if (!saved?.token) { setSession(saved); return; }

      // A stored session is not proof of a live one. Checking on load means an
      // expired token sends the tenant to sign in rather than to a page of
      // empty panels.
      try {
        const res = await fetch("/api/tenant/me", {
          headers: { Authorization: `Bearer ${saved.token}` }, credentials: "include" });
        if (res.ok) {
          const d = await res.json();
          setMe(d);
          setSession({ ...saved, ...d.tenant, lease: d.lease, parking: d.parking,
                       balance: d.balance });
          // Land somewhere useful. A prospect opening the portal wants their
          // viewings, not a summary of a tenancy they do not have.
          setTab("home");
        } else {
          await window.storage.delete("baydo:tenant-session").catch(() => {});
          setSession(null);
        }
      } catch {
        setSession(saved);   // offline: work from what we have
      }
    })();
  }, []);

  if (session === undefined) return <div className="bt-loading">{t("common.loading")}</div>;
  if (!session) return <SignIn onIn={setSession} />;

  return (
    <section className="bt-sec">
      <div className="bt-portal-h">
        <div>
          <h2>{t("portal.hello", { name: session.name })}</h2>
          <span className="bt-dim">{t("portal.yourSuite", { unit: session.unit })}</span>
        </div>
        <button className="bt-btn bt-btn--ghost bt-btn--sm"
                onClick={async () => { await window.storage.delete("baydo:tenant-session").catch(() => {});
                                       setSession(null); }}>
          {t("nav.signout")}
        </button>
      </div>

      {/* Two sets of tabs, not one set with things greyed out.
          Somebody without a suite should not be looking at a Rent tab that
          does nothing — an empty panel labelled Rent reads as broken, and a
          disabled one reads as being kept out of something. */}
      <nav className="bt-ptabs">
        {(isTenant
          ? [["home", "portal.tabHome"], ["rent", "portal.tabRent"],
             ["repairs", "portal.tabRepairs"], ["notices", "portal.tabNotices"],
             ["docs", "portal.tabDocs"]]
          : [["home", "portal.tabHome"], ["viewings", "portal.tabViewings"],
             ["applications", "portal.tabApplications"], ["sign", "portal.tabSign"]]
        ).map(([k, label]) => (
          <button key={k} className={tab === k ? "on" : ""}
                  onClick={() => setTab(k)}>{t(label)}</button>
        ))}
      </nav>

      {tab === "home" && (isTenant
        ? <Overview session={session} />
        : <ProspectHome session={session} me={me} t={t} zh={locale === "zh"} />)}
      {tab === "viewings"     && <MyViewings t={t} zh={locale === "zh"} />}
      {tab === "applications" && <MyApplications t={t} zh={locale === "zh"} />}
      {tab === "sign"         && <ToSign t={t} zh={locale === "zh"} />}
      {tab === "repairs" && <Repairs session={session} />}
      {tab === "notices" && <Notices session={session} />}
      {tab === "rent"    && <Ledger t={t} zh={locale === "zh"} />}
      {tab === "docs"    && (<>
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
  const { t } = useT();
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  /* Carry where they were going. Somebody sent here from "book a viewing"
     should land back on that suite once they have an account, not on a
     dashboard that has forgotten why they came. */
  const next = new URLSearchParams(window.location.search).get("next");
  const signupHref = next ? `/signup?next=${encodeURIComponent(next)}` : "/signup";

  const go = async () => {
    setBusy(true); setErr("");
    if (!email.trim() || !pw) { setErr(t("common.error")); setBusy(false); return; }

    try {
      const res = await fetch("/api/tenant/login", {
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

      const { token, tenant } = await res.json();
      const session = { ...tenant, token };
      await window.storage.set("baydo:tenant-session", JSON.stringify(session)).catch(() => {});
      onIn(session);

      // Back to whatever they were doing. Only same-site paths — a `next`
      // taken from a URL is a redirect anybody can aim anywhere.
      if (next && next.startsWith("/") && !next.startsWith("//"))
        window.location.href = next;
    } catch {
      setErr(t("common.error"));
    }
    setBusy(false);
  };

  const forgot = async () => {
    if (!email.trim()) { setErr(t("portal.emailFirst")); return; }
    setBusy(true); setErr("");
    try {
      await fetch("/api/tenant/forgot", {
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
      <button className="bt-btn" onClick={go} disabled={busy || !email.trim() || !pw}>
        {busy ? t("common.loading") : t("portal.signIn")}
      </button>
      {/* Sign in and the way out of it, on one line. Two buttons of equal
          weight side by side make somebody read both to find the one they
          want; a link reads as a link. */}
      <div className="bt-signrow">
        <button className="bt-btn" disabled={busy} onClick={go}>
          {busy ? t("portal.signingIn") : t("portal.signin")}
        </button>
        <button className="bt-linkbtn" onClick={forgot} disabled={busy}>
          {t("portal.forgot")}
        </button>
      </div>

      {/* Not "sign up" in the abstract. What an account is for, said as the
          thing somebody came here to do. */}
      <div className="bt-newhere">
        <h3>{t("portal.newHeading")}</h3>
        <p>{t("portal.newBody")}</p>
        <ul className="bt-newlist">
          <li>{t("portal.newBook")}</li>
          <li>{t("portal.newApply")}</li>
          <li>{t("portal.newTrack")}</li>
        </ul>
        <a className="bt-btn bt-btn--ghost" href={signupHref}>{t("portal.setUp")}</a>
        <p className="bt-hint">{t("portal.alreadyTenant")}</p>
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

/* ---------- repairs ---------- */
function Repairs({ session }) {
  const { t, date } = useT();
  const [list, setList] = useState([]);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ what: "", where: "", urgent: null, files: [] });
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const r = await window.storage.get("baydo:tenant-repairs");
      const all = r?.value ? JSON.parse(r.value) : [];
      setList(all.filter((x) => x.unit === session.unit));
    } catch { setList([]); }
  };
  useEffect(() => { load(); }, []);

  const submit = async () => {
    setBusy(true);
    const rec = { id: "r" + Date.now().toString(36), unit: session.unit,
                  what: f.what, where: f.where, urgent: f.urgent === true,
                  photos: f.files.map((x) => x.name), state: "new",
                  createdAt: new Date().toISOString() };
    try {
      const r = await window.storage.get("baydo:tenant-repairs");
      const all = r?.value ? JSON.parse(r.value) : [];
      await window.storage.set("baydo:tenant-repairs", JSON.stringify([...all, rec]));
    } catch {}
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
              <div className="bt-f">
                <label>{t("repairs.photos")}</label>
                <input className="bt-in" type="file" accept="image/*" multiple
                       onChange={(e) => setF({ ...f, files: Array.from(e.target.files || []) })} />
              </div>
              <p className="bt-hint">{t("repairs.entryConsent")}</p>
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
        const r = await window.storage.get("baydo:entrynotices");
        const all = r?.value ? JSON.parse(r.value) : [];
        setList(all.filter((n) => n.unitId === session.unit && n.state === "sent"));
      } catch { setList([]); }
    })();
  }, [session.unit]);

  if (!list.length) return <p className="bt-empty" style={{ marginTop: 20 }}>{t("notices.none")}</p>;

  return (
    <div className="bt-list" style={{ marginTop: 20 }}>
      {list.map((n) => {
        const [from, to] = (n.window || "").split("–");
        return (
          <div className="bt-item" key={n.id}>
            <div className="bt-item-h">
              <span className="bt-tag" style={{ "--c": "#1C6FA6" }}>{t("notices.entry")}</span>
              <span className="bt-dim">{date(n.sentAt)}</span>
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
        <strong>{money(session.rent)}</strong><em>{t("suites.perMonth")}</em>
      </div>
      <p className="bt-dim">{t("rent.dueOn", { day: 1 })}</p>
      {/* A payment is recorded once, by accounting, against the charge it
          settles. Recording it here as well would create a second version of
          the truth about money. */}
      <a className="bt-btn" href="#" onClick={(e) => e.preventDefault()}>{t("rent.payLink")}</a>
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


/* ══════════════════ Before there is a suite ══════════════════ */

const money = (n) => (n == null ? "—"
  : new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" })
      .format(Number(n)));

async function get(path, token) {
  const res = await fetch(path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: "include" });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

/** What a prospect sees first.
 *
 *  Says what is available now and what comes later, as a sequence rather than
 *  as a list of things they cannot have. Somebody who signed up to look at a
 *  flat should not open this and feel they are missing something. */
function ProspectHome({ session, me, t, zh }) {
  const c = me?.counts ?? {};

  return (
    <section className="bt-psec">
      <div className="bt-welcome">
        <h3>{zh ? `${session?.name}，你好` : `Hello ${session?.name}`}</h3>
        <p>
          {zh
            ? "你的帳號已經建立。現在可以預約看房、送出申請，並看到申請的進度。"
            : "Your account is set up. From here you can book a viewing, apply, and follow what happens to your application."}
        </p>
      </div>

      <div className="bt-pcounts">
        <div><em>{zh ? "預約" : "Viewings"}</em><strong>{c.viewings ?? 0}</strong></div>
        <div><em>{zh ? "申請" : "Applications"}</em><strong>{c.applications ?? 0}</strong></div>
        <div className={c.to_sign > 0 ? "bt-hot" : ""}>
          <em>{zh ? "待簽署" : "To sign"}</em><strong>{c.to_sign ?? 0}</strong>
        </div>
      </div>

      {c.to_sign > 0 && (
        <div className="bt-ok">
          {zh ? `有 ${c.to_sign} 份文件在等你簽署。`
              : `${c.to_sign} document${c.to_sign === 1 ? "" : "s"} waiting for your signature.`}
        </div>
      )}

      {/* What comes next. Stated plainly so nobody wonders whether the portal
          is broken or whether they are being kept out of something. */}
      <div className="bt-later">
        <div className="bt-later-h">{zh ? "簽約之後會出現的" : "After your lease is signed"}</div>
        <ul>
          <li>{zh ? "租金明細與繳款紀錄，可下載" : "Your rent and payment history, downloadable"}</li>
          <li>{zh ? "押金餘額與已累積的利息" : "Your deposit and the interest it has earned"}</li>
          <li>{zh ? "線上報修" : "Reporting repairs"}</li>
          <li>{zh ? "進入單位通知" : "Notices of entry"}</li>
        </ul>
        <p className="bt-hint">
          {zh
            ? "簽約完成後，我們會把這個帳號接到你的單位，上面這些就會自動出現。不用再註冊一次。"
            : "We connect this account to your suite once the lease is signed, and these appear on their own. You will not need to sign up again."}
        </p>
      </div>

      <div className="bt-actions">
        <a className="bt-btn" href="/booking">{zh ? "預約看房" : "Book a viewing"}</a>
        <a className="bt-btn bt-btn--ghost" href="/apply">{zh ? "送出申請" : "Apply"}</a>
      </div>
    </section>
  );
}

function MyViewings({ t, zh }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { get("/api/tenant/viewings").then((d) => setRows(d.viewings))
    .catch(() => setRows([])); }, []);

  if (rows === null) return <section className="bt-psec"><p>{zh ? "讀取中…" : "Loading…"}</p></section>;

  return (
    <section className="bt-psec">
      {rows.length === 0 ? (
        <div className="bt-pempty">
          <p>{zh ? "還沒有預約。" : "No viewings yet."}</p>
          <a className="bt-btn" href="/booking">{zh ? "預約看房" : "Book one"}</a>
        </div>
      ) : rows.map((v) => (
        <div className="bt-prow" key={v.id}>
          <div>
            <strong>{v.unit_number ?? v.unit_type}</strong>
            <div className="bt-dim">
              {v.starts_at
                ? String(v.starts_at).slice(0, 16).replace("T", " ")
                : (zh ? "等待確認時間" : "Waiting for a time")}
            </div>
          </div>
          <span className={`bt-tag ${v.state === "completed" ? "done" : ""}`}>{v.state}</span>
        </div>
      ))}
    </section>
  );
}

function MyApplications({ t, zh }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { get("/api/tenant/applications").then((d) => setRows(d.applications))
    .catch(() => setRows([])); }, []);

  if (rows === null) return <section className="bt-psec"><p>{zh ? "讀取中…" : "Loading…"}</p></section>;

  return (
    <section className="bt-psec">
      {rows.length === 0 ? (
        <div className="bt-pempty">
          <p>{zh ? "還沒有送出申請。" : "No applications yet."}</p>
          <a className="bt-btn" href="/apply">{zh ? "送出申請" : "Apply"}</a>
        </div>
      ) : rows.map((a) => (
        <div className="bt-prow" key={a.id}>
          <div>
            <strong>{a.unit_type}</strong>
            {/* In words. "screening" tells the person waiting nothing. */}
            <div className="bt-dim">{a.plain}</div>
            <div className="bt-dim">
              {zh ? "送出於 " : "Submitted "}{String(a.created_at).slice(0, 10)}
              {a.move_in_date && ` · ${zh ? "希望入住 " : "move in "}${a.move_in_date}`}
            </div>
          </div>
          <span className={`bt-tag ${a.state === "approved" ? "done"
            : a.state === "declined" ? "bad" : ""}`}>{a.state}</span>
        </div>
      ))}
    </section>
  );
}

function ToSign({ t, zh }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { get("/api/tenant/to-sign").then((d) => setRows(d.pending))
    .catch(() => setRows([])); }, []);

  if (rows === null) return <section className="bt-psec"><p>{zh ? "讀取中…" : "Loading…"}</p></section>;

  return (
    <section className="bt-psec">
      {rows.length === 0 ? (
        <div className="bt-pempty">
          <p>{zh ? "目前沒有要簽的文件。" : "Nothing waiting for your signature."}</p>
        </div>
      ) : rows.map((x) => (
        <div className="bt-prow" key={x.id}>
          <div>
            <strong>{zh ? x.name_zh : x.name_en}</strong>
            <div className="bt-dim">
              {x.unit_number} · {x.reference}
              {x.expires_at && ` · ${zh ? "有效至 " : "expires "}${String(x.expires_at).slice(0, 10)}`}
            </div>
          </div>
          <a className="bt-btn bt-btn--sm" href={`/sign/${x.access_token}`}>
            {zh ? "去簽署" : "Open"}
          </a>
        </div>
      ))}
    </section>
  );
}

/* ══════════════════ Once there is a suite ══════════════════ */

/**
 * The ledger.
 *
 * Everything charged, everything paid, and what the deposit is doing —
 * downloadable, because somebody proving what they paid to a bank or a
 * subsidy office should not have to ask the office for it.
 *
 * The deposit is shown separately rather than as a line in the rent history.
 * It is the tenant's money being held, not rent already paid, and showing it
 * all along is what stops move-out being the first time anybody looks at it.
 */
function Ledger({ t, zh }) {
  const [data, setData] = useState(null);
  useEffect(() => { get("/api/tenant/ledger").then(setData).catch(() => setData(false)); }, []);

  if (data === null)
    return <section className="bt-psec"><p>{zh ? "讀取中…" : "Loading…"}</p></section>;
  if (data === false)
    return <section className="bt-psec"><p>{zh ? "讀不到資料。" : "Could not load this."}</p></section>;

  const s = data.summary ?? {};

  return (
    <section className="bt-psec">
      <div className="bt-balance">
        <div>
          <em>{zh ? "應繳" : "Owing"}</em>
          <strong className={s.overdue > 0 ? "bt-bad" : ""}>{money(s.balance_owed)}</strong>
        </div>
        {s.overdue > 0 && (
          <div>
            <em>{zh ? "其中已逾期" : "Of which overdue"}</em>
            <strong className="bt-bad">{money(s.overdue)}</strong>
          </div>
        )}
        <a className="bt-btn bt-btn--ghost bt-btn--sm"
           href="/api/tenant/ledger/download">
          {zh ? "下載明細" : "Download statement"}
        </a>
      </div>

      {s.balance_owed > 0 && (
        <PayRent owed={s.balance_owed} t={t} zh={zh}
                 onDone={() => get("/api/tenant/ledger").then(setData).catch(() => {})} />
      )}

      {data.deposit && (
        <div className="bt-deposit">
          <div className="bt-deposit-h">{zh ? "押金" : "Security deposit"}</div>
          <div className="bt-deposit-g">
            <div><em>{zh ? "目前餘額" : "Held now"}</em>
              <strong>{money(data.deposit.held)}</strong></div>
            <div><em>{zh ? "原始金額" : "Received"}</em>
              <strong>{money(data.deposit.received)}</strong></div>
            <div><em>{zh ? "已累積利息" : "Interest"}</em>
              <strong>{money(data.deposit.interest)}</strong></div>
          </div>

          {/* Deductions with their basis, not just a smaller number.
              A deduction a tenant first learns of at move-out is a deduction
              they will contest — and they should, because a figure with no
              reason attached is not something anybody can agree or disagree
              with. */}
          {(data.deposit.deductions ?? []).length > 0 && (
            <div className="bt-deductions">
              <div className="bt-deposit-h">{zh ? "已扣除" : "Deducted"}</div>
              {data.deposit.deductions.map((d, i) => (
                <div className="bt-deduction" key={i}>
                  <span className="bt-mono">{String(d.txn_date).slice(0, 10)}</span>
                  <span className="bt-mono">{money(Math.abs(d.amount))}</span>
                  <span>{d.basis || (zh ? "未註明原因" : "no basis recorded")}</span>
                </div>
              ))}
              <p className="bt-hint">
                {zh
                  ? "如果不同意某一筆扣除，現在告訴我們。有異議時我們需要提出書面依據和照片才能維持扣除。"
                  : "If you disagree with any of these, say so. Where a deduction is disputed we have to show the basis and the evidence before it can stand."}
              </p>
            </div>
          )}

          <p className="bt-hint">
            {zh
              ? "押金存在信託帳戶，跟租金分開。那是你的錢由我們代管，不是已經繳掉的租金——退租時扣除正當的項目後退還。"
              : "Held in a trust account, separately from rent. It is your money being held, not rent already paid, and it comes back at the end of the tenancy less anything properly deducted."}
          </p>
        </div>
      )}

      <div className="bt-ledger">
        <div className="bt-ledger-h">{zh ? "收費" : "Charged"}</div>
        {(data.charges ?? []).length === 0 ? (
          <div className="bt-dim" style={{ padding: "10px 0" }}>
            {zh ? "沒有紀錄。" : "Nothing yet."}
          </div>
        ) : data.charges.map((x) => {
          const owing = Number(x.amount) - Number(x.paid_amount);
          const late = owing > 0 && new Date(x.due_date) < new Date();
          return (
            <div className={`bt-lrow ${late ? "late" : ""}`} key={x.id}>
              <span className="bt-mono">{x.due_date}</span>
              <span>{x.kind}</span>
              <span className="bt-mono">{money(x.amount)}</span>
              <span className="bt-mono bt-dim">
                {owing > 0 ? `${zh ? "尚欠 " : "owing "}${money(owing)}`
                           : (zh ? "已繳" : "paid")}
              </span>
            </div>
          );
        })}
      </div>

      <div className="bt-ledger">
        <div className="bt-ledger-h">{zh ? "已收款" : "Received"}</div>
        {(data.receipts ?? []).length === 0 ? (
          <div className="bt-dim" style={{ padding: "10px 0" }}>
            {zh ? "沒有紀錄。" : "Nothing yet."}
          </div>
        ) : data.receipts.map((x) => (
          <div className="bt-lrow" key={x.id}>
            <span className="bt-mono">{String(x.received_date).slice(0, 10)}</span>
            <span>{x.method ?? "—"}</span>
            <span className="bt-mono">{money(x.amount)}</span>
            <span className="bt-dim">{x.reference ?? ""}</span>
          </div>
        ))}
      </div>

      <p className="bt-hint">
        {zh
          ? "這份紀錄來自我們的帳，如果跟你的對不上，現在告訴我們比退租時再說容易處理。"
          : "This comes from our records. If it does not match yours, tell us now — it is easier to sort out than at move-out."}
      </p>
    </section>
  );
}

/* ══════════════════ How we contact you ══════════════════ */


/** Paying.
 *
 *  The fee is shown against each method before anything is chosen, not on the
 *  confirmation screen. A cost somebody discovers after deciding is a cost
 *  they resent, and on rent the difference between methods is real money —
 *  about $42 on a card against $12 by bank transfer.
 */
function PayRent({ owed, t, zh, onDone }) {
  const [methods, setMethods] = useState(null);
  const [method, setMethod] = useState(null);
  const [amount, setAmount] = useState(String(owed ?? ""));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    get("/api/tenant/payment-methods")
      .then((d) => { setMethods(d.methods); setMethod(d.methods?.[0]?.code); })
      .catch(() => setMethods([]));
  }, []);

  if (methods === null) return null;
  if (!methods.length) return (
    <div className="bt-note">
      <p>{zh ? "線上付款還沒開通。請照原本的方式繳款。"
             : "Online payment is not set up yet. Pay the usual way for now."}</p>
    </div>
  );

  const chosen = methods.find((m) => m.code === method);
  const value = Number(amount) || 0;
  const fee = chosen ? Math.round((value * chosen.fee_percent + chosen.fee_fixed) * 100) / 100 : 0;
  const surcharged = chosen?.fee_borne_by === "surcharge";
  const total = surcharged ? Math.round((value + fee) * 100) / 100 : value;

  const pay = async () => {
    setBusy(true); setErr("");
    try {
      const res = await fetch("/api/tenant/pay", {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ method_code: method, amount: value, purpose: "rent" }),
      });
      const d = await res.json();
      if (!res.ok) { setErr(d.detail ?? (zh ? "付款失敗" : "That did not go through")); }
      else { setDone(d); onDone?.(); }
    } catch { setErr(zh ? "連不上。" : "Could not reach us."); }
    setBusy(false);
  };

  if (done) return (
    <div className="bt-ok">
      {zh ? `已送出，參考編號 ${done.payment.reference}。${done.note ?? ""}`
          : `Sent. Reference ${done.payment.reference}. ${done.note ?? ""}`}
    </div>
  );

  return (
    <div className="bt-pay">
      <div className="bt-deposit-h">{zh ? "線上繳款" : "Pay online"}</div>

      <label className="bt-f">
        <span>{zh ? "金額" : "Amount"}</span>
        <input className="bt-in" type="number" step="0.01" value={amount}
               onChange={(e) => setAmount(e.target.value)} />
      </label>

      <div className="bt-methods">
        {methods.map((m) => {
          const f = Math.round((value * m.fee_percent + m.fee_fixed) * 100) / 100;
          return (
            <button key={m.code} className={`bt-method ${method === m.code ? "on" : ""}`}
                    onClick={() => setMethod(m.code)}>
              <strong>{zh ? m.label_zh : m.label_en}</strong>
              <span className="bt-dim">
                {m.fee_borne_by === "surcharge"
                  ? (zh ? `手續費 ${money(f)}` : `${money(f)} fee`)
                  : (zh ? "免手續費" : "No fee to you")}
                {" · "}
                {m.settlement_days === 0
                  ? (zh ? "立即" : "immediate")
                  : (zh ? `約 ${m.settlement_days} 個工作天` : `about ${m.settlement_days} business days`)}
              </span>
            </button>
          );
        })}
      </div>

      {surcharged && fee > 0 && (
        <div className="bt-feeline">
          <span>{zh ? "金額" : "Amount"}</span><span className="bt-mono">{money(value)}</span>
          <span>{zh ? "手續費" : "Processing fee"}</span><span className="bt-mono">{money(fee)}</span>
          <span><strong>{zh ? "合計扣款" : "Total charged"}</strong></span>
          <span className="bt-mono"><strong>{money(total)}</strong></span>
        </div>
      )}

      {err && <div className="bt-err">{err}</div>}

      <button className="bt-btn" disabled={busy || value <= 0} onClick={pay}>
        {busy ? (zh ? "處理中…" : "Sending…") : (zh ? `繳 ${money(total)}` : `Pay ${money(total)}`)}
      </button>

      <p className="bt-hint">
        {zh
          ? "款項會先沖銷最舊的租金。如果你想指定沖銷某一筆，付款前先跟我們說——這是你的錢，該由你決定。"
          : "Payments settle the oldest rent first. If you want it applied to something else, tell us before you pay — it is your money and your choice."}
      </p>
    </div>
  );
}

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
.bt-psec{display:flex;flex-direction:column;gap:14px;padding:4px 0}
.bt-welcome h3{margin:0 0 6px;font-size:17px}
.bt-welcome p{margin:0;color:var(--dim);line-height:1.75;max-width:64ch;font-size:13px}
.bt-pcounts{display:flex;gap:1px;background:var(--rule);border:1px solid var(--rule);
  border-radius:6px;overflow:hidden}
.bt-pcounts>div{flex:1;background:#fff;padding:12px 14px;display:flex;
  flex-direction:column;gap:2px}
.bt-pcounts em{font-style:normal;font-size:10.5px;color:var(--dim);
  text-transform:uppercase;letter-spacing:.05em}
.bt-pcounts strong{font-family:'IBM Plex Mono',monospace;font-size:22px}
.bt-hot strong{color:var(--accent)}
.bt-later{border:1px dashed var(--rule);border-radius:6px;padding:13px 16px}
.bt-later-h{font-size:11px;text-transform:uppercase;letter-spacing:.06em;
  color:var(--dim);margin-bottom:8px}
.bt-later ul{margin:0 0 8px;padding-left:18px;color:var(--ink2);line-height:1.9;font-size:13px}
.bt-prow{display:flex;justify-content:space-between;align-items:center;gap:12px;
  padding:11px 0;border-bottom:1px solid var(--rule)}
.bt-prow:last-child{border-bottom:0}
.bt-prow strong{font-size:14px}
.bt-pempty{text-align:center;padding:32px 0;display:flex;flex-direction:column;
  align-items:center;gap:12px;color:var(--dim)}
.bt-pempty p{margin:0}
.bt-balance{display:flex;gap:26px;align-items:flex-end;flex-wrap:wrap;
  border:1px solid var(--rule);border-radius:6px;padding:14px 16px}
.bt-balance>div{display:flex;flex-direction:column;gap:2px}
.bt-balance em{font-style:normal;font-size:10.5px;color:var(--dim);
  text-transform:uppercase;letter-spacing:.05em}
.bt-balance strong{font-family:'IBM Plex Mono',monospace;font-size:24px}
.bt-balance .bt-btn{margin-left:auto}
.bt-bad{color:#B23A54}
.bt-deposit{border:1px solid var(--rule);border-radius:6px;padding:13px 16px}
.bt-deposit-h{font-size:11px;text-transform:uppercase;letter-spacing:.06em;
  color:var(--dim);margin-bottom:9px}
.bt-deposit-g{display:flex;gap:26px;flex-wrap:wrap;margin-bottom:9px}
.bt-deposit-g>div{display:flex;flex-direction:column;gap:2px}
.bt-deposit-g em{font-style:normal;font-size:10.5px;color:var(--dim)}
.bt-deposit-g strong{font-family:'IBM Plex Mono',monospace;font-size:17px}
.bt-pay{border:1px solid var(--accent);border-radius:6px;padding:14px 16px;
  display:flex;flex-direction:column;gap:11px}
.bt-methods{display:flex;flex-direction:column;gap:7px}
.bt-method{font:inherit;text-align:left;cursor:pointer;background:#fff;
  border:1.5px solid var(--rule);border-radius:6px;padding:11px 14px;
  display:flex;flex-direction:column;gap:2px}
.bt-method.on{border-color:var(--accent);background:var(--tint)}
.bt-method strong{font-size:13.5px}
.bt-feeline{display:grid;grid-template-columns:1fr auto;gap:5px 14px;
  border-top:1px solid var(--rule);padding-top:9px;font-size:13px}
.bt-feeline>span:nth-child(even){text-align:right}
.bt-deductions{border-top:1px solid var(--rule);padding-top:10px;margin-top:4px}
.bt-deduction{display:grid;grid-template-columns:100px 100px 1fr;gap:10px;
  padding:5px 0;font-size:12.5px;color:var(--ink2)}
.bt-ledger{border:1px solid var(--rule);border-radius:6px;overflow:hidden}
.bt-ledger-h{background:var(--tint);font-size:11px;text-transform:uppercase;
  letter-spacing:.06em;color:var(--dim);padding:8px 14px;border-bottom:1px solid var(--rule)}
.bt-lrow{display:grid;grid-template-columns:100px 1fr 100px 1fr;gap:10px;
  padding:8px 14px;font-size:13px;border-bottom:1px solid var(--rule)}
.bt-lrow:last-child{border-bottom:0}
.bt-lrow.late{background:#FFFCFC}
.bt-mono{font-family:'IBM Plex Mono',monospace;font-variant-numeric:tabular-nums}
.bt-tag.done{background:var(--green,#0E8577)}
.bt-tag.bad{background:#B23A54}
.bt-row{display:flex;gap:11px;flex-wrap:wrap}
.bt-row>*{flex:1 1 160px}
.bt-pref{display:flex;gap:11px;align-items:flex-start;padding:10px 0;
  border-bottom:1px solid var(--rule);cursor:pointer}
.bt-pref:last-of-type{border-bottom:0}
.bt-pref input{margin-top:3px}
.bt-pref strong{display:block;font-size:13.5px}
.bt-pref em{display:block;font-style:normal;font-size:12px;color:var(--dim);margin-top:1px}
.bt-tag{font-size:11px;font-weight:700;color:#fff;background:var(--c);border-radius:10px;padding:2px 9px}
/* Sign in and the way out of it, on one line.
   
   Two buttons of equal weight side by side make somebody read both to find
   the one they want. The primary action looks like a button and the escape
   hatch looks like a link, which is the difference between them. */
.bt-signrow{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-top:4px}
.bt-signrow .bt-btn{min-width:132px}
.bt-linkbtn{font:inherit;font-size:13px;background:none;border:0;color:var(--accent);
  cursor:pointer;padding:4px 0}
.bt-linkbtn:hover{text-decoration:underline}

/* What an account is for, as the thing somebody came here to do rather than
   as an abstract invitation to register. */
.bt-newhere{border-top:1px solid var(--rule);margin-top:26px;padding-top:20px}
.bt-newhere h3{margin:0 0 6px;font-size:15px}
.bt-newhere p{margin:0 0 10px;font-size:13px;color:var(--dim);line-height:1.7}
.bt-newlist{margin:0 0 16px;padding:0;list-style:none;display:flex;
  flex-direction:column;gap:7px}
.bt-newlist li{font-size:13.5px;color:var(--ink2);padding-left:20px;position:relative}
.bt-newlist li::before{content:"";position:absolute;left:4px;top:8px;width:5px;height:5px;
  border-radius:50%;background:var(--accent)}
.bt-newhere .bt-hint{margin-top:12px}
.bt-firsttime{border-top:1px solid var(--rule);margin-top:18px;padding-top:16px;
  display:flex;flex-direction:column;gap:7px;align-items:flex-start}
.bt-firsttime strong{font-size:13.5px}
.bt-firsttime p{margin:0;font-size:12.5px;color:var(--dim);line-height:1.7}
`;
