import React, { useState, useEffect, useMemo, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, NavLink, Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { LOCALES } from "./lib/i18n.js";
import { LocaleProvider, useT } from "./lib/locale.jsx";
import TenantChat from "./TenantChat.jsx";
import Portal from "./portal/Portal.jsx";
import Booking from "./pages/Booking.jsx";
import Apply from "./pages/Apply.jsx";
import { Privacy, ConfirmReply } from "./pages/Privacy.jsx";
import Sign from "./pages/Sign.jsx";
import { Signup, VerifySignup, Claim, ResetPassword } from "./pages/Account.jsx";

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

const OFFICE_PHONE = "780-937-8677";
const OFFICE_EMAIL = "rentals@themizar.ca";
const DEFAULT_SITE = {
  en: {
    headline:"A short walk from Clareview LRT.",
    subheadline:"Three buildings, 330 homes and everyday amenities in one connected Edmonton community.",
    intro_title:"A place that keeps daily life close",
    intro_body:"Choose from one- and two-bedroom homes across 370, 374 and 378 Clareview Station Drive NW. Each building has spaces to work out, unwind and care for your pets.",
    amenities_title:"More than a place to sleep",
    amenities_body:"A gym, lounge, games room, pet wash and bicycle storage are available in every building, with shared outdoor space across the site.",
    neighbourhood_title:"Clareview at your door",
    neighbourhood_body:"Walk to Clareview LRT and connect to downtown, shopping, recreation and the rest of Edmonton without adding another stop to your day.",
    gallery_title:"See Baydo Pointe", cta_title:"Find the home that fits",
    cta_body:"Check current availability and live pricing, then book a viewing when you are ready.",
    footer_tagline:"Connected rental living beside Clareview LRT.",
    footer_address:"370 · 374 · 378 Clareview Station Drive NW\nEdmonton, Alberta",
  },
  zh: {
    headline:"走路就到 Clareview 輕軌站。",
    subheadline:"三棟樓、330 戶住宅與日常配套，組成交通便利的 Edmonton 社區。",
    intro_title:"讓日常生活更方便",
    intro_body:"370、374、378 Clareview Station Drive NW 提供一房與兩房戶型。每棟樓都有健身、休閒與寵物照護空間。",
    amenities_title:"不只是一處住所",
    amenities_body:"每棟樓均設健身房、Lounge、遊戲室、寵物清洗間與自行車儲存空間，社區另有共享戶外區域。",
    neighbourhood_title:"Clareview 就在門口",
    neighbourhood_body:"步行可達 Clareview LRT，輕鬆前往市中心、購物、休閒設施與 Edmonton 其他地區。",
    gallery_title:"看看 Baydo Pointe", cta_title:"找到適合你的房型",
    cta_body:"查看即時空房與租金，準備好後即可預約看房。",
    footer_tagline:"位於 Clareview 輕軌站旁的便利租住社區。",
    footer_address:"370 · 374 · 378 Clareview Station Drive NW\nEdmonton, Alberta",
  },
  contact:{ phone:OFFICE_PHONE, email:OFFICE_EMAIL },
};

let siteContentCache = null;
let siteContentRequest = null;
function loadSiteContent() {
  if (siteContentCache) return Promise.resolve(siteContentCache);
  if (!siteContentRequest) siteContentRequest = fetch("/api/public/site-content")
    .then((r) => r.ok ? r.json() : null)
    .then((data) => {
      if (data?.content) siteContentCache = data;
      return siteContentCache;
    }).catch(() => null).finally(() => { siteContentRequest = null; });
  return siteContentRequest;
}

function useSiteContent() {
  const [site, setSite] = useState(siteContentCache ?? { content:DEFAULT_SITE, images:[] });
  useEffect(() => {
    let live = true;
    loadSiteContent().then((data) => { if (live && data?.content) setSite(data); });
    return () => { live = false; };
  }, []);
  return site;
}

const siteImages = (site, slot) => (site?.images ?? []).filter((image) => image.slot === slot);

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
      try {
        const response = await fetch("/api/public/availability");
        if (response.ok) {
          const live = await response.json();
          const byType = Object.fromEntries((live.types ?? []).map((x) => [x.code, {
            free: Number(x.available ?? 0), dates: x.earliest ? [x.earliest] : [],
          }]));
          const base = Object.fromEntries((live.types ?? []).map((x) => [x.code, Number(x.rent) || null]));
          setData({ pricing: { base, petLimit: live.fees?.pet_limit }, byType,
            publicTypes: live.types ?? [], stalls: live.parking ?? { total: 0, free: 0 },
            waiting: Number(live.parking?.waiting ?? 0) });
          return;
        }
      } catch {}

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
  const [signedIn, setSignedIn] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const navigate = useNavigate();
  const link = ({ isActive }) => (isActive ? "on" : "");

  const checkSession = useCallback(async () => {
    try {
      const res = await fetch("/api/tenant/me", { credentials: "include" });
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || !type.toLowerCase().includes("application/json")) {
        setSignedIn(false);
        return;
      }
      const data = await res.json();
      // A Pages/Worker fallback can return 200 without returning a tenant
      // session. The header must validate the payload, not only the status.
      setSignedIn(Boolean(data?.tenant?.id || data?.tenant?.email || data?.account_state));
    } catch {
      setSignedIn(false);
    }
  }, []);

  useEffect(() => {
    checkSession();
    const onIn = () => setSignedIn(true);
    const onOut = () => setSignedIn(false);
    window.addEventListener("baydo:tenant-signed-in", onIn);
    window.addEventListener("baydo:tenant-signed-out", onOut);
    return () => {
      window.removeEventListener("baydo:tenant-signed-in", onIn);
      window.removeEventListener("baydo:tenant-signed-out", onOut);
    };
  }, [checkSession]);

  const logout = async (event) => {
    event.stopPropagation();
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await fetch("/api/tenant/logout", { method: "POST", credentials: "include" });
    } catch {}
    setSignedIn(false);
    setOpen(false);
    window.dispatchEvent(new CustomEvent("baydo:tenant-signed-out"));
    navigate("/portal", { replace: true });
    setLoggingOut(false);
  };

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
        {signedIn && (
          <button className="bt-signout" type="button" onClick={logout} disabled={loggingOut}>
            {loggingOut ? t("common.loading") : t("nav.signout")}
          </button>
        )}
        <Link to="/book" className="bt-cta">{t("nav.book")}</Link>
      </nav>
    </header>
  );
}

function Footer() {
  const { t, locale } = useT();
  const site = useSiteContent();
  const copy = { ...DEFAULT_SITE[locale], ...(site.content?.[locale] ?? {}) };
  const phone = site.content?.contact?.phone || OFFICE_PHONE;
  const email = site.content?.contact?.email || OFFICE_EMAIL;
  return (
    <footer className="bt-foot">
      <div className="bt-foot-in">
        <div className="bt-foot-brand">
          <Link to="/" className="bt-foot-logo"><span>BP</span>Baydo Pointe</Link>
          <p>{copy.footer_tagline}</p>
          <p className="bt-foot-address">{copy.footer_address}</p>
        </div>
        <nav className="bt-foot-nav" aria-label={locale === "zh" ? "頁尾導覽" : "Footer navigation"}>
          <strong>{locale === "zh" ? "網站導覽" : "Navigation"}</strong>
          <Link to="/suites">{t("nav.suites")}</Link>
          <Link to="/building">{t("nav.building")}</Link>
          <Link to="/apply">{t("nav.apply")}</Link>
          <Link to="/portal">{t("nav.portal")}</Link>
        </nav>
        <div className="bt-foot-contact">
          <strong>{locale === "zh" ? "聯絡我們" : "Contact us"}</strong>
          <a href={`tel:${phone}`}>{phone}</a>
          <a href={`mailto:${email}`}>{email}</a>
          <Link className="bt-foot-book" to="/book">{t("nav.book")} →</Link>
        </div>
        <div className="bt-foot-fair">
          <p>{t("footer.fairHousing")}</p>
          <p className="bt-dim">
            © {new Date().getFullYear()} {t("footer.legal")}{" "}
            <Link to="/privacy">{t("common.privacy")}</Link>
          </p>
        </div>
      </div>
    </footer>
  );
}

/* ---------- home ---------- */
function Home() {
  const { t, money, locale } = useT();
  const d = useProperty();
  const site = useSiteContent();
  const copy = { ...DEFAULT_SITE[locale], ...(site.content?.[locale] ?? {}) };
  const hero = siteImages(site, "hero");
  const amenities = siteImages(site, "amenities");
  const neighbourhood = siteImages(site, "neighbourhood");
  const gallery = siteImages(site, "gallery");
  const totalFree = d ? (d.publicTypes
    ? d.publicTypes.reduce((s, x) => s + Number(x.available ?? 0), 0)
    : Object.values(d.byType).reduce((s, x) => s + x.free, 0)) : null;
  const rents = d ? (d.publicTypes
    ? d.publicTypes.map((x) => Number(x.rent)).filter((n) => n > 0)
    : Object.entries(d.byType).map(([c]) => Number(d.pricing.base?.[c])).filter((n) => n > 0)) : [];
  const from = rents.length ? Math.min(...rents) : null;

  return (
    <>
      <section className={`bt-hero ${hero.length ? "has-photo" : ""}`}>
        <div className="bt-hero-grid">
          <div className="bt-hero-in">
            <div className="bt-eyebrow">{t("home.address")}</div>
            <h1>{copy.headline}</h1>
            <p className="bt-lede">{copy.subheadline}</p>
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
          <div className="bt-hero-media">{hero.length
            ? <PhotoSlider images={hero} locale={locale} label={locale === "zh" ? "首頁照片" : "Property photos"} />
            : <div className="bt-photo-placeholder"><strong>370 · 374 · 378</strong><span>Clareview Station Drive NW</span></div>}</div>
        </div>
      </section>

      <section className="bt-home-intro">
        <div className="bt-section-number">01</div>
        <div><div className="bt-eyebrow">Baydo Pointe · Clareview</div><h2>{copy.intro_title}</h2></div>
        <p>{copy.intro_body}</p>
      </section>

      <section className="bt-feature-panel">
        <div className="bt-feature-media">{amenities.length
          ? <PhotoSlider images={amenities} locale={locale} label={locale === "zh" ? "設施照片" : "Amenity photos"} />
          : <div className="bt-photo-placeholder"><strong>{locale === "zh" ? "每栋都有" : "In every building"}</strong><span>Gym · Lounge · Pet wash · Bike storage</span></div>}</div>
        <div className="bt-feature-copy">
          <div className="bt-section-number">02</div><h2>{copy.amenities_title}</h2><p>{copy.amenities_body}</p>
          <div className="bt-amen">
            {["gym", "lounge", "petwash", "bike", "patio", "parking"].map((k) => (
              <div className="bt-amen-i" key={k}><span aria-hidden="true">↗</span>{t(`amen.${k}`)}</div>
            ))}
          </div>
          <Link to="/building" className="bt-text-link">{t("nav.building")} →</Link>
        </div>
      </section>

      <section className="bt-buildings-band">
        <div><div className="bt-section-number">03</div><h2>{locale === "zh" ? "三棟樓，一個社區" : "Three buildings. One community."}</h2></div>
        <div className="bt-blds">{[["370",118],["374",94],["378",118]].map(([code,n]) => <div className="bt-bld" key={code}><strong>{code}</strong><span>{n} {locale === "zh" ? "戶 · 6 層" : "homes · 6 floors"}</span></div>)}</div>
      </section>

      <section className="bt-feature-panel bt-feature-panel--reverse">
        <div className="bt-feature-media">{neighbourhood.length
          ? <PhotoSlider images={neighbourhood} locale={locale} label={locale === "zh" ? "社區照片" : "Neighbourhood photos"} />
          : <div className="bt-photo-placeholder bt-photo-placeholder--map"><strong>Clareview LRT</strong><span>{locale === "zh" ? "步行可达" : "Steps from home"}</span></div>}</div>
        <div className="bt-feature-copy"><div className="bt-section-number">04</div><h2>{copy.neighbourhood_title}</h2><p>{copy.neighbourhood_body}</p>
          <div className="bt-amen"><div className="bt-amen-i"><span>↗</span>{t("amen.transit")}</div><div className="bt-amen-i"><span>↗</span>{t("amen.busPad")}</div></div>
          <Link to="/book" className="bt-text-link">{t("home.ctaSecond")} →</Link></div>
      </section>

      {gallery.length > 0 && <section className="bt-gallery-sec"><div className="bt-gallery-head"><div className="bt-section-number">05</div><h2>{copy.gallery_title}</h2></div>
        <div className="bt-gallery">{gallery.map((image) => <figure key={image.id}><img loading="lazy" src={image.url} alt={locale === "zh" ? image.alt_zh || image.alt_en : image.alt_en} /></figure>)}</div></section>}

      <ParkingHonesty />

      <section className="bt-final-cta"><div><div className="bt-eyebrow">Baydo Pointe · Edmonton</div><h2>{copy.cta_title}</h2><p>{copy.cta_body}</p></div>
        <div className="bt-hero-cta"><Link to="/suites" className="bt-btn">{t("home.cta")}</Link><Link to="/book" className="bt-btn bt-btn--ghost">{t("home.ctaSecond")}</Link></div></section>
    </>
  );
}

function PhotoSlider({ images, locale, label }) {
  const [index, setIndex] = useState(0);
  useEffect(() => { setIndex(0); }, [images]);
  useEffect(() => {
    if (images.length < 2) return undefined;
    const timer = window.setInterval(() => setIndex((value) => (value + 1) % images.length), 6500);
    return () => window.clearInterval(timer);
  }, [images.length]);
  const current = images[index] ?? images[0];
  if (!current) return null;
  const alt = locale === "zh" ? current.alt_zh || current.alt_en : current.alt_en || current.alt_zh;
  const move = (amount) => setIndex((value) => (value + amount + images.length) % images.length);
  return <div className="bt-slider" aria-label={label}>
    <img key={current.id} src={current.url} alt={alt || ""} />
    {images.length > 1 && <>
      <button className="bt-slider-arrow prev" type="button" aria-label={locale === "zh" ? "上一張" : "Previous photo"} onClick={() => move(-1)}>‹</button>
      <button className="bt-slider-arrow next" type="button" aria-label={locale === "zh" ? "下一張" : "Next photo"} onClick={() => move(1)}>›</button>
      <div className="bt-slider-dots">{images.map((image, itemIndex) => <button key={image.id} type="button" className={itemIndex === index ? "on" : ""}
        aria-label={`${locale === "zh" ? "查看照片" : "View photo"} ${itemIndex + 1}`} aria-current={itemIndex === index ? "true" : undefined} onClick={() => setIndex(itemIndex)} />)}</div>
    </>}
  </div>;
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
    if (d.publicTypes) return d.publicTypes.map((x) => ({
      code: x.code, ...(TYPES[x.code] ?? {}), free: Number(x.available ?? 0),
      dates: x.earliest ? [x.earliest] : [], rent: Number(x.rent) || null,
      earliest: x.earliest || null, virtualTourUrl: x.virtual_tour_url || null,
      virtualTourProvider: x.virtual_tour_provider || null,
    })).filter((r) => filter === "all"
      || (filter === "1" && r.beds === 1) || (filter === "2" && r.beds === 2)
      || (filter === "den" && r.den)).sort((a, b) => a.sf - b.sf);
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
                {r.virtualTourUrl && <a href={r.virtualTourUrl} target="_blank" rel="noopener noreferrer"
                  className="bt-btn bt-btn--sm bt-btn--ghost">
                  {locale === "zh" ? "線上看房" : "Virtual tour"}
                </a>}
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

/* ---------- account gate for viewing / application ---------- */
function RequireTenantSession({ children }) {
  const location = useLocation();
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await fetch("/api/tenant/me", { credentials: "include" });
        if (live) setSignedIn(r.ok);
      } catch {
        if (live) setSignedIn(false);
      } finally {
        if (live) setReady(true);
      }
    })();
    return () => { live = false; };
  }, []);

  if (!ready) return <div className="bt-loading">Checking account…</div>;
  if (!signedIn) {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/portal?next=${encodeURIComponent(next)}`} replace />;
  }
  return children;
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
          <Route path="/book" element={<RequireTenantSession><Booking /></RequireTenantSession>} />
          <Route path="/apply" element={<RequireTenantSession><Apply /></RequireTenantSession>} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/confirm" element={<ConfirmReply />} />
          <Route path="/sign/:token" element={<Sign />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/verify" element={<VerifySignup />} />
          <Route path="/claim" element={<Claim />} />
          <Route path="/reset" element={<ResetPassword />} />
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
/* Mizar steel blue leads, Baydo gold accents. The public site is the property's
   face, so it carries the marks rather than the role colours — a prospective
   tenant has no role. */
.bt{--ink:#1B3358;--ink2:#3E4C5A;--dim:#78899A;--rule:#DFE5EA;--tint:#F4F7F9;
  --accent:#2A6183;--gold:#E9B21F;--violet:#574A9E;--green:#0E8577;--warn:#B23A54;--amber:#FFF6E0;--amberline:#E8C877;
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
.bt-signout{font:inherit;font-size:13px;font-weight:600;color:var(--warn);background:#fff;
  border:1px solid #D9B8C0;border-radius:4px;padding:7px 11px;cursor:pointer;white-space:nowrap}
.bt-signout:hover:not(:disabled){background:#FFF7F9;border-color:var(--warn)}
.bt-signout:disabled{cursor:wait;opacity:.6}
.bt-cta{background:var(--ink);color:#fff !important;padding:9px 16px !important;border-radius:22px;
  font-size:13.5px !important}
.bt-cta:hover{background:#000 !important}
.bt-burger{display:none;flex-direction:column;gap:4px;background:none;border:0;cursor:pointer;padding:10px}
.bt-burger span{width:20px;height:2px;background:var(--ink);display:block}

/* hero */
.bt-hero{background:linear-gradient(165deg,#F6F9FB 0%,#E7EDF2 100%);border-bottom:1px solid var(--rule)}
.bt-hero-grid{max-width:1440px;margin:0 auto;display:grid;grid-template-columns:minmax(0,1.05fr) minmax(360px,.95fr);min-height:min(720px,78vh)}
.bt-hero-in{padding:clamp(62px,9vw,126px) clamp(28px,6vw,88px);display:flex;flex-direction:column;justify-content:center}
.bt-hero-media{min-height:520px;overflow:hidden;background:#DCE5EB;position:relative}
.bt-hero-media img{width:100%;height:100%;object-fit:cover;display:block}
.bt-slider{height:100%;min-height:inherit;position:relative;overflow:hidden;background:#DCE5EB}.bt-slider>img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;animation:bt-photo-in .35s ease}.bt-slider-arrow{position:absolute;z-index:2;top:50%;transform:translateY(-50%);width:42px;height:42px;border:1px solid rgba(255,255,255,.6);border-radius:50%;background:rgba(12,27,43,.55);color:#fff;font-size:30px;line-height:1;cursor:pointer;display:grid;place-items:center}.bt-slider-arrow:hover{background:rgba(12,27,43,.85)}.bt-slider-arrow.prev{left:15px}.bt-slider-arrow.next{right:15px}.bt-slider-dots{position:absolute;z-index:2;left:50%;bottom:16px;transform:translateX(-50%);display:flex;gap:7px;padding:7px 10px;border-radius:20px;background:rgba(12,27,43,.45)}.bt-slider-dots button{width:8px;height:8px;border:0;border-radius:50%;padding:0;background:rgba(255,255,255,.55);cursor:pointer}.bt-slider-dots button.on{background:#fff;transform:scale(1.25)}@keyframes bt-photo-in{from{opacity:.35;transform:scale(1.01)}to{opacity:1;transform:scale(1)}}
.bt-photo-placeholder{height:100%;min-height:340px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:34px;color:#fff;background:linear-gradient(150deg,#173252 0%,#2A6183 58%,#8AA9BA 100%);position:relative;overflow:hidden}
.bt-photo-placeholder:before{content:"";position:absolute;width:380px;height:380px;border:1px solid rgba(255,255,255,.2);border-radius:50%;right:-120px;top:-150px}
.bt-photo-placeholder:after{content:"";position:absolute;width:250px;height:250px;border:1px solid rgba(255,255,255,.16);border-radius:50%;left:-80px;bottom:-120px}
.bt-photo-placeholder strong{font-family:'Archivo',sans-serif;font-size:clamp(24px,4vw,42px);letter-spacing:-.02em;z-index:1}.bt-photo-placeholder span{font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:.12em;text-transform:uppercase;z-index:1}
.bt-photo-placeholder--map{background:linear-gradient(150deg,#25485F,#638FA0)}
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

/* editorial home page */
.bt-section-number{font-family:'IBM Plex Mono',monospace;color:var(--accent);font-size:11px;letter-spacing:.12em;margin-bottom:8px}
.bt-home-intro{max-width:1180px;margin:0 auto;padding:clamp(58px,8vw,108px) 24px;display:grid;grid-template-columns:70px minmax(260px,.9fr) minmax(320px,1.1fr);gap:clamp(22px,5vw,72px);align-items:start}
.bt-home-intro h2,.bt-feature-copy h2,.bt-buildings-band h2,.bt-gallery-sec h2,.bt-final-cta h2{font-family:'Archivo',sans-serif;font-weight:800;letter-spacing:-.035em;line-height:1.08;margin:8px 0 0;font-size:clamp(28px,4.5vw,52px)}
.bt-home-intro>p,.bt-feature-copy>p,.bt-final-cta p{font-size:clamp(16px,2vw,20px);line-height:1.75;color:var(--ink2);margin:0}
.bt-feature-panel{max-width:1280px;margin:0 auto clamp(60px,8vw,110px);display:grid;grid-template-columns:minmax(0,1.1fr) minmax(360px,.9fr);background:#F0F4F6}
.bt-feature-panel--reverse{grid-template-columns:minmax(360px,.9fr) minmax(0,1.1fr)}
.bt-feature-panel--reverse .bt-feature-media{order:2}.bt-feature-panel--reverse .bt-feature-copy{order:1}
.bt-feature-media{min-height:520px;overflow:hidden}.bt-feature-media>img{width:100%;height:100%;display:block;object-fit:cover}.bt-feature-media .bt-photo-placeholder,.bt-feature-media .bt-slider{min-height:520px}
.bt-feature-copy{padding:clamp(38px,6vw,78px);display:flex;flex-direction:column;justify-content:center}.bt-feature-copy>p{margin:18px 0 22px}.bt-feature-copy .bt-amen{grid-template-columns:repeat(2,minmax(0,1fr));margin-bottom:24px}
.bt-text-link{align-self:flex-start;font-weight:700;text-decoration:none;color:var(--ink);padding-bottom:3px;border-bottom:1px solid var(--ink)}.bt-text-link:hover{color:var(--accent);border-color:var(--accent)}
.bt-buildings-band{background:var(--ink);color:#fff;padding:clamp(50px,8vw,92px) max(24px,calc((100vw - 1180px)/2));display:grid;grid-template-columns:minmax(280px,.9fr) minmax(420px,1.1fr);gap:clamp(30px,7vw,90px);align-items:end;margin-bottom:clamp(60px,8vw,110px)}
.bt-buildings-band .bt-section-number{color:#9EC1D1}.bt-buildings-band .bt-blds{display:grid;grid-template-columns:repeat(3,1fr);gap:0;margin:0;border-top:1px solid rgba(255,255,255,.25)}
.bt-buildings-band .bt-bld{border:0;border-right:1px solid rgba(255,255,255,.25);border-radius:0;padding:22px 18px 5px}.bt-buildings-band .bt-bld:last-child{border-right:0}.bt-buildings-band .bt-bld strong{font-size:clamp(28px,4vw,46px)}.bt-buildings-band .bt-bld span{color:#C4D0D8}
.bt-gallery-sec{max-width:1280px;margin:0 auto;padding:0 24px clamp(65px,9vw,120px)}.bt-gallery-head{display:flex;gap:22px;align-items:baseline;margin-bottom:28px}.bt-gallery{display:grid;grid-template-columns:repeat(12,1fr);grid-auto-rows:minmax(140px,20vw);gap:12px}.bt-gallery figure{margin:0;overflow:hidden;background:#E7EDF1}.bt-gallery figure:nth-child(6n+1),.bt-gallery figure:nth-child(6n+4){grid-column:span 7}.bt-gallery figure:nth-child(6n+2),.bt-gallery figure:nth-child(6n+3){grid-column:span 5}.bt-gallery figure:nth-child(6n+5),.bt-gallery figure:nth-child(6n+6){grid-column:span 6}.bt-gallery img{width:100%;height:100%;display:block;object-fit:cover;transition:transform .5s ease}.bt-gallery figure:hover img{transform:scale(1.025)}
.bt-final-cta{max-width:1180px;margin:0 auto;padding:clamp(65px,9vw,120px) 24px;display:flex;justify-content:space-between;align-items:flex-end;gap:42px}.bt-final-cta>div:first-child{max-width:700px}.bt-final-cta p{margin-top:18px;max-width:58ch}

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
.bt-foot{position:relative;overflow:hidden;background:#0D1724;color:#fff;margin-top:40px}.bt-foot:after{content:"";position:absolute;width:520px;height:520px;right:-180px;bottom:-370px;border:1px solid rgba(130,174,198,.22);border-radius:50%;box-shadow:0 0 0 70px rgba(101,148,174,.045),0 0 0 140px rgba(101,148,174,.035);pointer-events:none}
.bt-foot-in{position:relative;z-index:1;max-width:1240px;margin:0 auto;padding:70px 28px 28px;display:grid;grid-template-columns:minmax(280px,1.3fr) minmax(160px,.7fr) minmax(230px,.9fr);gap:clamp(36px,7vw,100px)}
.bt-foot strong{display:block;font-family:'Archivo',sans-serif;font-size:17px;margin-bottom:19px}.bt-foot p{margin:0;font-size:14px;color:#B8C4CF;line-height:1.75}.bt-foot a{color:#E6EDF3;text-decoration:none}.bt-foot a:hover{color:#fff;text-decoration:underline;text-underline-offset:4px}
.bt-foot-logo{display:flex;align-items:center;gap:12px;font-family:'Archivo',sans-serif;font-size:22px;font-weight:700;margin-bottom:24px;text-decoration:none!important}.bt-foot-logo span{display:grid;place-items:center;width:40px;height:40px;border:1px solid #D9E4EC;border-radius:50%;font:600 12px 'IBM Plex Mono',monospace}.bt-foot-brand>p:first-of-type{font-size:16px;max-width:34ch;color:#D7E0E7}.bt-foot-address{margin-top:18px!important;white-space:pre-line}.bt-foot-nav,.bt-foot-contact{display:flex;flex-direction:column;align-items:flex-start;gap:11px}.bt-foot-nav strong,.bt-foot-contact strong{margin-bottom:8px}.bt-foot-book{margin-top:12px;border-bottom:1px solid #93B4C7;padding-bottom:4px}.bt-foot-fair{grid-column:1/-1;border-top:1px solid rgba(255,255,255,.16);padding-top:22px;margin-top:20px;display:flex;justify-content:space-between;gap:28px;align-items:flex-end}.bt-foot-fair p{font-size:11.5px;max-width:74ch;color:#8696A5}.bt-foot-fair .bt-dim{flex:0 0 auto;color:#7D8D9C;text-align:right}.bt-foot-fair .bt-dim a{margin-left:9px;color:#AEBBC6}

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
  .bt-signout{margin:4px 12px;align-self:stretch;text-align:center;padding:10px 12px}
  .bt-cta{margin:4px 12px 8px;text-align:center}
  .bt-sec{padding-left:16px;padding-right:16px}
  .bt-hero-grid{grid-template-columns:1fr;min-height:0}.bt-hero-in{padding:48px 20px 42px}.bt-hero-media{min-height:56vw;order:-1}.bt-hero-media .bt-photo-placeholder{min-height:56vw}
  .bt-home-intro{grid-template-columns:1fr;padding:54px 20px;gap:14px}.bt-home-intro>.bt-section-number{margin-bottom:-10px}.bt-home-intro>p{margin-top:8px}
  .bt-feature-panel,.bt-feature-panel--reverse{grid-template-columns:1fr;margin-bottom:58px}.bt-feature-panel--reverse .bt-feature-media{order:1}.bt-feature-panel--reverse .bt-feature-copy{order:2}.bt-feature-media,.bt-feature-media .bt-photo-placeholder{min-height:65vw}.bt-feature-copy{padding:38px 20px}.bt-feature-copy .bt-amen{grid-template-columns:1fr}
  .bt-buildings-band{grid-template-columns:1fr;padding:54px 20px;margin-bottom:58px}.bt-buildings-band .bt-blds{grid-template-columns:1fr}.bt-buildings-band .bt-bld{border-right:0;border-bottom:1px solid rgba(255,255,255,.22);padding:16px 0}.bt-buildings-band .bt-bld:last-child{border-bottom:0}
  .bt-gallery-sec{padding:0 16px 60px}.bt-gallery{display:grid;grid-template-columns:1fr;grid-auto-rows:68vw}.bt-gallery figure:nth-child(n){grid-column:auto}.bt-gallery-head{display:block}
  .bt-final-cta{padding:56px 20px;align-items:flex-start;flex-direction:column;gap:24px}
  .bt-foot-in{padding:50px 20px 24px;grid-template-columns:1fr;gap:38px}.bt-foot-fair{display:block;margin-top:0}.bt-foot-fair .bt-dim{text-align:left;margin-top:12px}.bt-slider-arrow{width:36px;height:36px;font-size:25px}
}
`; }
