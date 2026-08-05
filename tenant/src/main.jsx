import React, { useState, useEffect, useMemo, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, NavLink, Link } from "react-router-dom";
import { LOCALES } from "./lib/i18n.js";
import { LocaleProvider, useT } from "./lib/locale.jsx";
import TenantChat from "./TenantChat.jsx";
import Portal from "./portal/Portal.jsx";
import Booking from "./pages/Booking.jsx";
import Apply from "./pages/Apply.jsx";
import { Privacy, ConfirmReply } from "./pages/Privacy.jsx";

/* ============================================================
   BAYDO POINTE — tenant site

   Public: what is available, what it costs, book a viewing, apply.
   Private: the portal, for tenants who have moved in.

   Bilingual throughout. The language follows the tenant's saved
   choice or their browser, not a default we picked.

   Two things this site does that most listing sites do not:

   · Parking scarcity is stated up front. There are 108 fewer stalls
     than suites. A tenant who finds that out after signing has a
     fair complaint; one who knew before does not.

   · Every cost appears before the application is submitted, not
     after approval. Alberta caps the deposit at one month's rent
     and counts a pet deposit inside it, so there is nothing to
     reveal later anyway.
   ============================================================ */

const OFFICE_PHONE = "306-974-1727";
const OFFICE_EMAIL = "chris.luczka@baydo.ca";

/* ---------- data ---------- */
const TYPES = {
  "1C": { beds: 1, den: false, sf: 462.8 }, "1A": { beds: 1, den: false, sf: 484.4 },
  "1A (M)": { beds: 1, den: false, sf: 484.4 }, "1B": { beds: 1, den: true, sf: 602.8 },
  "3A": { beds: 2, den: true, sf: 731.9 }, "3A (M)": { beds: 2, den: true, sf: 731.9 },
  "2A": { beds: 2, den: false, sf: 742.7 }, "2A (M)": { beds: 2, den: false, sf: 742.7 },
};
const LAYOUT = {
  en: { "1-0": "1 bedroom", "1-1": "1 bedroom + den", "2-0": "2 bedroom, 2 bathroom", "2-1": "2 bedroom + den" },
  zh: { "1-0": "一房", "1-1": "一房 + 書房", "2-0": "兩房兩衛", "2-1": "兩房 + 書房" },
};

function useProperty() {
  const [data, setData] = useState(null);
  useEffect(() => {
    (async () => {
      const read = async (k) => {
        try { const r = await window.storage.get(k); return r?.value ? JSON.parse(r.value) : null; }
        catch { return null; }
      };
      const pricing = (await read("baydo:pricing")) || {};
      const overrides = (await read("baydo:overrides")) || {};
      const parking = (await read("baydo:parking")) || { pools: [], records: [] };

      const byType = {};
      for (const [, o] of Object.entries(overrides)) {
        const code = o.type; if (!code || !TYPES[code]) continue;
        byType[code] ||= { free: 0, dates: [] };
        if ((o.status || "available") === "available") {
          byType[code].free++; if (o.date) byType[code].dates.push(o.date);
        }
      }
      const stalls = (parking.pools || []).reduce((acc, p) => {
        const used = (parking.records || []).filter((r) => r.status === "assigned" && r.poolId === p.id).length;
        return { total: acc.total + Number(p.total || 0), free: acc.free + (Number(p.total || 0) - used) };
      }, { total: 0, free: 0 });
      const waiting = (parking.records || []).filter((r) => r.status === "waiting").length;

      setData({ pricing, byType, stalls, waiting });
    })();
  }, []);
  return data;
}

/* ---------- shell ---------- */
function Header() {
  const { t, locale, setLocale } = useT();
  const [open, setOpen] = useState(false);
  const link = ({ isActive }) => (isActive ? "on" : "");
  return (
    <header className="bt-head">
      <Link to="/" className="bt-logo" onClick={() => setOpen(false)}>
        <strong>Baydo Pointe</strong>
        <span>Clareview, Edmonton</span>
      </Link>
      <button className="bt-burger" onClick={() => setOpen(!open)} aria-label="Menu" aria-expanded={open}>
        <span /><span /><span />
      </button>
      <nav className={`bt-nav ${open ? "open" : ""}`} onClick={() => setOpen(false)}>
        <NavLink to="/suites" className={link}>{t("nav.suites")}</NavLink>
        <NavLink to="/building" className={link}>{t("nav.building")}</NavLink>
        <NavLink to="/apply" className={link}>{t("nav.apply")}</NavLink>
        <NavLink to="/portal" className={link}>{t("nav.portal")}</NavLink>
        <div className="bt-lang" role="group">
          {LOCALES.map((l) => (
            <button key={l.code} className={locale === l.code ? "on" : ""}
                    onClick={(e) => { e.stopPropagation(); setLocale(l.code); }}>{l.short}</button>
          ))}
        </div>
        <Link to="/book" className="bt-cta">{t("nav.book")}</Link>
      </nav>
    </header>
  );
}

function Footer() {
  const { t } = useT();
  return (
    <footer className="bt-foot">
      <div className="bt-foot-in">
        <div>
          <strong>Baydo Pointe</strong>
          <p>370 · 374 · 378 Clareview Station Drive NW<br />Edmonton, AB</p>
        </div>
        <div>
          <strong>{t("common.office")}</strong>
          <p><a href={`tel:${OFFICE_PHONE}`}>{OFFICE_PHONE}</a><br />
             <a href={`mailto:${OFFICE_EMAIL}`}>{OFFICE_EMAIL}</a></p>
        </div>
        <div className="bt-foot-fair">
          <p>{t("footer.fairHousing")}</p>
          <p className="bt-dim">
            {t("footer.legal")}{" "}
            <Link to="/privacy">{t("common.privacy")}</Link>
          </p>
        </div>
      </div>
    </footer>
  );
}

/* ---------- home ---------- */
function Home() {
  const { t, money } = useT();
  const d = useProperty();
  const totalFree = d ? Object.values(d.byType).reduce((s, x) => s + x.free, 0) : null;
  const rents = d ? Object.entries(d.byType)
    .map(([c]) => Number(d.pricing.base?.[c])).filter((n) => n > 0) : [];
  const from = rents.length ? Math.min(...rents) : null;

  return (
    <>
      <section className="bt-hero">
        <div className="bt-hero-in">
          <div className="bt-eyebrow">{t("home.address")}</div>
          <h1>{t("home.headline")}</h1>
          <p className="bt-lede">{t("home.sub")}</p>
          <div className="bt-hero-facts">
            <span>{d ? t("home.availableNow", { n: totalFree }) : t("home.checking")}</span>
            {from ? <span>{t("home.fromRent", { rent: money(from) })}</span>
                  : d ? <span>{t("home.noPricing")}</span> : null}
          </div>
          <div className="bt-hero-cta">
            <Link to="/suites" className="bt-btn">{t("home.cta")}</Link>
            <Link to="/book" className="bt-btn bt-btn--ghost">{t("home.ctaSecond")}</Link>
          </div>
        </div>
      </section>

      <section className="bt-sec">
        <h2>{t("amen.title")}</h2>
        <div className="bt-amen">
          {["gym", "lounge", "petwash", "bike", "patio", "transit", "parking", "busPad"].map((k) => (
            <div className="bt-amen-i" key={k}><span aria-hidden="true">·</span>{t(`amen.${k}`)}</div>
          ))}
        </div>
      </section>

      <ParkingHonesty />
    </>
  );
}

/** Parking is short by 108 stalls. Saying so here costs a few enquiries and
 *  saves every one of those tenants a bad surprise after signing. */
function ParkingHonesty() {
  const { t } = useT();
  const d = useProperty();
  return (
    <section className="bt-sec bt-sec--tint">
      <h2>{t("parking.title")}</h2>
      <p className="bt-body">{t("parking.body")}</p>
      {d && (
        <div className="bt-chips">
          <span className={d.stalls.free > 0 ? "ok" : "warn"}>
            {d.stalls.free > 0 ? t("parking.free", { n: d.stalls.free }) : t("parking.none")}
          </span>
          {d.waiting > 0 && <span>{t("parking.waitlist", { n: d.waiting })}</span>}
        </div>
      )}
    </section>
  );
}

/* ---------- suites ---------- */
function Suites() {
  const { t, locale, money, date } = useT();
  const d = useProperty();
  const [filter, setFilter] = useState("all");

  const rows = useMemo(() => {
    if (!d) return [];
    // Mirrored layouts are the same suite reversed, so they are merged here.
    // Splitting them would show a tenant two identical listings.
    const merged = {};
    for (const [code, meta] of Object.entries(TYPES)) {
      const base = code.replace(" (M)", "");
      merged[base] ||= { code: base, ...meta, free: 0, dates: [] };
      const b = d.byType[code];
      if (b) { merged[base].free += b.free; merged[base].dates.push(...b.dates); }
    }
    return Object.values(merged)
      .map((r) => ({ ...r, rent: Number(d.pricing.base?.[r.code]) || null,
                     earliest: r.dates.sort()[0] || null }))
      .filter((r) => filter === "all"
        || (filter === "1" && r.beds === 1) || (filter === "2" && r.beds === 2)
        || (filter === "den" && r.den))
      .sort((a, b) => a.sf - b.sf);
  }, [d, filter]);

  if (!d) return <div className="bt-loading">{t("common.loading")}</div>;

  return (
    <section className="bt-sec">
      <h2>{t("suites.title")}</h2>
      <p className="bt-body">{t("suites.sub")}</p>

      <div className="bt-filters">
        {[["all", "filterAll"], ["1", "filter1"], ["2", "filter2"], ["den", "filterDen"]].map(([k, label]) => (
          <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>
            {t(`suites.${label}`)}
          </button>
        ))}
      </div>

      {rows.length === 0 ? <p className="bt-empty">{t("suites.empty")}</p> : (
        <div className="bt-cards">
          {rows.map((r) => (
            <article className="bt-card" key={r.code}>
              <div className="bt-card-h">
                <span className="bt-code">{r.code}</span>
                <span className={`bt-avail ${r.free > 0 ? "" : "none"}`}>
                  {r.free > 0 ? t("suites.available", { n: r.free }) : t("suites.none")}
                </span>
              </div>
              <h3>{LAYOUT[locale][`${r.beds}-${r.den ? 1 : 0}`]}</h3>
              <div className="bt-card-meta">
                <span>{t("suites.sqft", { n: Math.round(r.sf) })}</span>
                <span>{t("suites.balcony")}</span>
              </div>
              <div className="bt-price">
                {r.rent ? <><strong>{money(r.rent)}</strong><em>{t("suites.perMonth")}</em></>
                        : <strong className="bt-ask">{t("suites.askRate")}</strong>}
              </div>
              {r.earliest && <div className="bt-dim">{t("suites.earliest", { date: date(r.earliest) })}</div>}
              <div className="bt-card-a">
                <Link to={`/book?type=${encodeURIComponent(r.code)}`} className="bt-btn bt-btn--sm">
                  {t("suites.book")}
                </Link>
                {r.free > 0 && (
                  <Link to={`/apply?type=${encodeURIComponent(r.code)}`} className="bt-btn bt-btn--sm bt-btn--ghost">
                    {t("suites.apply")}
                  </Link>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      <PetsNote />
    </section>
  );
}

function PetsNote() {
  const { t } = useT();
  const d = useProperty();
  const limit = d?.pricing?.petLimit;
  return (
    <div className="bt-note">
      <h3>{t("pets.title")}</h3>
      <p>{limit ? t("pets.limit", { limit }) : t("pets.noLimit")}</p>
      <p>{t("pets.deposit")}</p>
      {/* A service animal is not a pet. Saying so unprompted saves a tenant
          having to disclose a disability to find out. */}
      <p className="bt-note-strong">{t("pets.service")}</p>
    </div>
  );
}

/* ---------- buildings ---------- */
function Building() {
  const { t } = useT();
  return (
    <section className="bt-sec">
      <h2>{t("nav.building")}</h2>
      <p className="bt-body">{t("home.sub")}</p>
      <div className="bt-blds">
        {[["370", 118], ["374", 94], ["378", 118]].map(([code, n]) => (
          <div className="bt-bld" key={code}>
            <strong>{code}</strong>
            <span>{n} suites · 6 floors</span>
          </div>
        ))}
      </div>
      <div className="bt-amen">
        {["gym", "lounge", "petwash", "bike", "patio", "transit", "parking", "busPad"].map((k) => (
          <div className="bt-amen-i" key={k}><span aria-hidden="true">·</span>{t(`amen.${k}`)}</div>
        ))}
      </div>
      <ParkingHonesty />
    </section>
  );
}

/* ---------- app ---------- */
function Site() {
  return (
    <div className="bt">
      <Header />
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/suites" element={<Suites />} />
          <Route path="/building" element={<Building />} />
          <Route path="/book" element={<Booking />} />
          <Route path="/apply" element={<Apply />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/confirm" element={<ConfirmReply />} />
          <Route path="/portal/*" element={<Portal />} />
          <Route path="*" element={<Home />} />
        </Routes>
      </main>
      <Footer />
      <TenantChat />
    </div>
  );
}

const style = document.createElement("style");
style.textContent = CSS_TEXT();
document.head.appendChild(style);

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <LocaleProvider>
      <BrowserRouter><Site /></BrowserRouter>
    </LocaleProvider>
  </React.StrictMode>
);

function CSS_TEXT() { return `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500&family=Archivo:wght@700;800&display=swap');
*{box-sizing:border-box}
body{margin:0;background:#fff;color:#131C25;
  font-family:'IBM Plex Sans','PingFang TC','Microsoft JhengHei',system-ui,sans-serif;
  font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:inherit}
.bt{--ink:#131C25;--ink2:#3E4C5A;--dim:#78899A;--rule:#DFE5EA;--tint:#F4F7F9;
  --accent:#1C6FA6;--green:#0E8577;--warn:#B23A54;--amber:#FFF6E0;--amberline:#E8C877;
  min-height:100vh;display:flex;flex-direction:column}
.bt main{flex:1}
.bt-loading{padding:80px 20px;text-align:center;color:var(--dim)}
.bt-dim{color:var(--dim);font-size:13px}

/* header */
.bt-head{position:sticky;top:0;z-index:30;background:rgba(255,255,255,.94);
  backdrop-filter:blur(8px);border-bottom:1px solid var(--rule);
  display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 24px}
.bt-logo{text-decoration:none;padding:14px 0;flex:0 0 auto}
.bt-logo strong{display:block;font-family:'Archivo',sans-serif;font-size:17px;letter-spacing:-.02em}
.bt-logo span{display:block;font-size:11px;color:var(--dim)}
.bt-nav{display:flex;align-items:center;gap:4px}
.bt-nav a{font-size:14px;font-weight:600;color:var(--ink2);text-decoration:none;padding:8px 12px;
  border-radius:4px}
.bt-nav a:hover{background:var(--tint)}
.bt-nav a.on{color:var(--ink)}
.bt-lang{display:inline-flex;border:1px solid var(--rule);border-radius:4px;overflow:hidden;margin:0 6px}
.bt-lang button{font:inherit;font-size:12px;font-weight:600;cursor:pointer;background:#fff;border:0;
  border-right:1px solid var(--rule);padding:6px 11px;color:var(--dim)}
.bt-lang button:last-child{border-right:0}
.bt-lang button.on{background:var(--ink);color:#fff}
.bt-cta{background:var(--ink);color:#fff !important;padding:9px 16px !important;border-radius:22px;
  font-size:13.5px !important}
.bt-cta:hover{background:#000 !important}
.bt-burger{display:none;flex-direction:column;gap:4px;background:none;border:0;cursor:pointer;padding:10px}
.bt-burger span{width:20px;height:2px;background:var(--ink);display:block}

/* hero */
.bt-hero{background:linear-gradient(165deg,#F6F9FB 0%,#E7EDF2 100%);
  border-bottom:1px solid var(--rule);padding:clamp(48px,9vw,96px) 24px}
.bt-hero-in{max-width:820px;margin:0 auto}
.bt-eyebrow{font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:.12em;
  text-transform:uppercase;color:var(--dim)}
.bt-hero h1{font-family:'Archivo',sans-serif;font-weight:800;
  font-size:clamp(30px,5.5vw,52px);letter-spacing:-.03em;line-height:1.08;margin:12px 0 16px}
.bt-lede{font-size:clamp(15px,2vw,18px);color:var(--ink2);max-width:56ch;margin:0 0 20px}
.bt-hero-facts{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px}
.bt-hero-facts span{font-size:13px;font-weight:600;background:#fff;border:1px solid var(--rule);
  border-radius:20px;padding:6px 14px}
.bt-hero-cta{display:flex;gap:10px;flex-wrap:wrap}

.bt-btn{display:inline-block;font-weight:600;font-size:14.5px;text-decoration:none;cursor:pointer;
  background:var(--ink);color:#fff;border:1px solid var(--ink);padding:12px 22px;border-radius:24px}
.bt-btn:hover{background:#000}
.bt-btn--ghost{background:#fff;color:var(--ink);border-color:var(--rule)}
.bt-btn--ghost:hover{background:var(--tint);border-color:var(--ink)}
.bt-btn--sm{font-size:13px;padding:9px 16px}
.bt-btn:disabled{opacity:.4;cursor:not-allowed}

/* sections */
.bt-sec{max-width:960px;margin:0 auto;padding:clamp(40px,7vw,72px) 24px}
.bt-sec--tint{max-width:none;background:var(--tint);border-top:1px solid var(--rule);
  border-bottom:1px solid var(--rule)}
.bt-sec--tint>*{max-width:960px;margin-left:auto;margin-right:auto}
.bt-sec h2{font-family:'Archivo',sans-serif;font-weight:700;font-size:clamp(20px,3vw,28px);
  letter-spacing:-.02em;margin:0 0 12px}
.bt-body{color:var(--ink2);max-width:62ch;margin:0 0 18px}
.bt-empty{color:var(--dim);padding:30px 0}

.bt-amen{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px 20px;margin-top:8px}
.bt-amen-i{font-size:14px;color:var(--ink2);display:flex;gap:8px;padding:5px 0}
.bt-amen-i span{color:var(--accent);font-weight:700}

.bt-chips{display:flex;gap:8px;flex-wrap:wrap}
.bt-chips span{font-size:13px;font-weight:600;background:#fff;border:1px solid var(--rule);
  border-radius:20px;padding:6px 14px}
.bt-chips .ok{color:var(--green);border-color:var(--green)}
.bt-chips .warn{color:var(--warn);border-color:var(--warn)}

.bt-blds{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:24px}
.bt-bld{border:1px solid var(--rule);border-radius:8px;padding:14px 20px}
.bt-bld strong{display:block;font-family:'IBM Plex Mono',monospace;font-size:20px}
.bt-bld span{font-size:12.5px;color:var(--dim)}

/* suite cards */
.bt-filters{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:20px}
.bt-filters button{font:inherit;font-size:13.5px;font-weight:600;cursor:pointer;background:#fff;
  border:1px solid var(--rule);border-radius:20px;padding:7px 15px;color:var(--dim)}
.bt-filters button.on{background:var(--ink);color:#fff;border-color:var(--ink)}
.bt-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px}
.bt-card{border:1px solid var(--rule);border-radius:10px;padding:18px;display:flex;
  flex-direction:column;gap:6px;background:#fff}
.bt-card:hover{border-color:var(--ink)}
.bt-card-h{display:flex;justify-content:space-between;align-items:center;gap:8px}
.bt-code{font-family:'IBM Plex Mono',monospace;font-size:12px;font-weight:600;color:var(--dim)}
.bt-avail{font-size:11.5px;font-weight:700;color:var(--green)}
.bt-avail.none{color:var(--dim)}
.bt-card h3{font-family:'Archivo',sans-serif;font-size:17px;margin:2px 0 0;letter-spacing:-.01em}
.bt-card-meta{display:flex;gap:10px;font-size:12.5px;color:var(--dim);flex-wrap:wrap}
.bt-price{display:flex;align-items:baseline;gap:3px;margin-top:4px}
.bt-price strong{font-family:'IBM Plex Mono',monospace;font-size:22px;font-weight:600}
.bt-price em{font-style:normal;font-size:12.5px;color:var(--dim)}
.bt-ask{font-size:15px !important;color:var(--dim)}
.bt-card-a{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}

.bt-note{border:1px solid var(--amberline);background:var(--amber);border-radius:10px;
  padding:18px 20px;margin-top:28px}
.bt-note h3{font-family:'Archivo',sans-serif;font-size:16px;margin:0 0 8px}
.bt-note p{margin:0 0 8px;font-size:13.5px;color:#6B5410;line-height:1.65}
.bt-note p:last-child{margin-bottom:0}
.bt-note-strong{font-weight:600}

/* footer */
.bt-foot{border-top:1px solid var(--rule);background:var(--tint);margin-top:40px}
.bt-foot-in{max-width:960px;margin:0 auto;padding:36px 24px;display:grid;
  grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:24px}
.bt-foot strong{display:block;font-size:14px;margin-bottom:6px}
.bt-foot p{margin:0;font-size:13px;color:var(--ink2);line-height:1.7}
.bt-foot a{color:var(--accent);text-decoration:none}
.bt-foot-fair{grid-column:1/-1;border-top:1px solid var(--rule);padding-top:18px}
.bt-foot-fair p{font-size:12.5px;max-width:80ch}
.bt-foot-fair .bt-dim{margin-top:8px;font-size:11.5px;color:var(--dim)}

/* forms, shared by booking, apply and the portal */
.bt-form{max-width:560px;margin:0 auto}
.bt-f{display:flex;flex-direction:column;gap:6px;margin-bottom:16px}
.bt-f>label{font-size:13.5px;font-weight:600;color:var(--ink2)}
.bt-f>label em{font-style:normal;font-weight:400;color:var(--dim)}
.bt-in,.bt-sel,.bt-ta{font:inherit;font-size:15px;padding:12px 14px;border:1px solid var(--rule);
  border-radius:8px;background:#fff;color:var(--ink);width:100%}
.bt-in:focus,.bt-sel:focus,.bt-ta:focus{outline:none;border-color:var(--accent);
  box-shadow:0 0 0 3px rgba(28,111,166,.12)}
.bt-ta{resize:vertical;min-height:88px;line-height:1.6}
.bt-hint{font-size:12.5px;color:var(--dim);line-height:1.55}
.bt-opts{display:flex;gap:8px;flex-wrap:wrap}
.bt-opts button{font:inherit;font-size:14px;cursor:pointer;background:#fff;border:1px solid var(--rule);
  border-radius:8px;padding:11px 16px;color:var(--ink2)}
.bt-opts button.on{background:var(--ink);color:#fff;border-color:var(--ink);font-weight:600}
.bt-check{display:flex;gap:10px;align-items:flex-start;font-size:13.5px;color:var(--ink2);
  line-height:1.6;cursor:pointer}
.bt-check input{margin-top:3px;flex:0 0 auto;width:16px;height:16px}
.bt-err{font-size:13.5px;color:var(--warn);background:#FDF6F7;border:1px solid var(--warn);
  border-radius:8px;padding:11px 14px;margin-bottom:14px}
.bt-ok{font-size:13.5px;color:var(--green);background:#F4FAF8;border:1px solid var(--green);
  border-radius:8px;padding:11px 14px}

.bt-prose{max-width:760px}
.bt-prose h3{font-family:'Archivo',sans-serif;font-size:16px;margin:26px 0 8px;
  letter-spacing:-.01em}
.bt-prose p{color:var(--ink2);line-height:1.8;max-width:68ch}
.bt-prose ul{margin:0 0 16px;padding-left:20px;color:var(--ink2);line-height:1.8}
.bt-prose li{margin-bottom:8px;max-width:66ch}
.bt-table{width:100%;border-collapse:collapse;font-size:14px;margin:12px 0 8px}
.bt-table th{text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.05em;
  color:var(--dim);padding:8px 10px;border-bottom:1.5px solid var(--rule);font-weight:600}
.bt-table td{padding:9px 10px;border-bottom:1px solid var(--rule);color:var(--ink2)}

@media (max-width:760px){
  .bt-head{padding:0 16px}
  .bt-burger{display:flex}
  .bt-nav{position:absolute;top:100%;left:0;right:0;background:#fff;border-bottom:1px solid var(--rule);
    flex-direction:column;align-items:stretch;gap:0;padding:8px;display:none}
  .bt-nav.open{display:flex}
  .bt-nav a{padding:12px}
  .bt-lang{margin:8px 12px;align-self:flex-start}
  .bt-cta{margin:4px 12px 8px;text-align:center}
  .bt-sec,.bt-hero{padding-left:16px;padding-right:16px}
  .bt-foot-in{padding:28px 16px}
}
`; }
