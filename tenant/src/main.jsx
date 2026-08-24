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
const STAFF_URL = "https://pointe-worker.dcheng0726.workers.dev";

const DEFAULT_SITE = {
  en: {
    headline: "A short walk from Clareview LRT.",
    subheadline: "Three buildings, 330 homes and everyday amenities in one connected Edmonton community.",
    cta_title: "Come see Baydo Pointe",
    cta_body: "Tour an available suite and see how close everyday life can be.",
    footer_tagline: "Connected rental living beside Clareview LRT.",
    footer_address: "370 · 374 · 378 Clareview Station Drive NW\nEdmonton, Alberta",
  },
  zh: {
    headline: "走路就到 Clareview 輕軌站。",
    subheadline: "三棟樓、330 戶住宅與日常配套，組成交通便利的 Edmonton 社區。",
    cta_title: "預約參觀 Baydo Pointe",
    cta_body: "參觀目前可租房源，親自看看交通便利的社區生活。",
    footer_tagline: "位於 Clareview 輕軌站旁的便利租住社區。",
    footer_address: "370 · 374 · 378 Clareview Station Drive NW\nEdmonton, Alberta",
  },
  contact: { phone: OFFICE_PHONE, email: OFFICE_EMAIL },
};

let siteContentCache = null;
let siteContentRequest = null;

async function fetchSiteContent() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // Keep this URL stable so Cloudflare can serve its short public cache.
      // A timestamp here forced every visitor to wait for a fresh database
      // request before any uploaded photo could appear.
      const response = await fetch("/api/public/site-content");
      if (response.ok) return await response.json();
    } catch {}
    if (attempt === 0) await new Promise((resolve) => window.setTimeout(resolve, 650));
  }
  return null;
}

function loadSiteContent() {
  if (siteContentCache) return Promise.resolve(siteContentCache);
  if (!siteContentRequest) {
    siteContentRequest = fetchSiteContent()
      .then((data) => {
        if (data?.content) siteContentCache = data;
        return siteContentCache;
      })
      .catch(() => null)
      .finally(() => { siteContentRequest = null; });
  }
  return siteContentRequest;
}

function useSiteContent() {
  const [site, setSite] = useState(siteContentCache ?? { content: DEFAULT_SITE, images: [] });
  useEffect(() => {
    let active = true;
    loadSiteContent().then((data) => {
      if (active && data?.content) setSite(data);
    });
    return () => { active = false; };
  }, []);
  return site;
}

function siteImages(site, slot) {
  return (site?.images ?? []).filter((image) => image.slot === slot);
}

function SiteSlideshow({ images, locale, className = "", label = "Photos" }) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex((current) => Math.min(current, Math.max(images.length - 1, 0)));
  }, [images.length]);

  useEffect(() => {
    if (images.length < 2) return undefined;
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % images.length);
    }, 5500);
    return () => window.clearInterval(timer);
  }, [images.length]);

  if (!images.length) return null;
  const current = images[index] ?? images[0];
  const alt = current?.[`alt_${locale}`] || current?.filename || label;
  const move = (amount) => setIndex((currentIndex) =>
    (currentIndex + amount + images.length) % images.length);

  return (
    <div className={`bt-site-slideshow ${className}`.trim()} aria-label={label}>
      <img key={current.id} src={current.url} alt={alt} />
      {images.length > 1 && (
        <>
          <button className="bt-slide-arrow prev" type="button"
                  aria-label="Previous photo" onClick={() => move(-1)}>‹</button>
          <button className="bt-slide-arrow next" type="button"
                  aria-label="Next photo" onClick={() => move(1)}>›</button>
          <div className="bt-slide-dots" role="group" aria-label="Choose photo">
            {images.map((image, dotIndex) => (
              <button key={image.id} type="button"
                      className={dotIndex === index ? "on" : ""}
                      aria-label={`Photo ${dotIndex + 1}`}
                      aria-current={dotIndex === index ? "true" : undefined}
                      onClick={() => setIndex(dotIndex)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function GalleryShowcase({
  images, locale, title, introText = "", eyebrowText = "", embedded = false,
}) {
  const [startIndex, setStartIndex] = useState(0);
  const [moving, setMoving] = useState(false);
  const [paused, setPaused] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(null);

  const imageAt = useCallback((index) =>
    images[(index + images.length) % images.length], [images]);
  const displayed = useMemo(() => Array.from(
    { length: Math.min(images.length, 5) },
    (_, position) => ({
      image: imageAt(startIndex + position),
      index: (startIndex + position) % images.length,
    })
  ), [imageAt, images.length, startIndex]);

  const advance = useCallback(() => {
    if (moving || selectedIndex !== null || images.length <= 4) return;
    setMoving(true);
    window.setTimeout(() => {
      setStartIndex((current) => (current + 1) % images.length);
      setMoving(false);
    }, 680);
  }, [images.length, moving, selectedIndex]);

  const previous = () => {
    if (moving || selectedIndex !== null || images.length <= 4) return;
    setStartIndex((current) => (current - 1 + images.length) % images.length);
  };

  useEffect(() => {
    if (paused || selectedIndex !== null || images.length <= 4) return undefined;
    const timer = window.setInterval(advance, 3600);
    return () => window.clearInterval(timer);
  }, [advance, images.length, paused, selectedIndex]);

  useEffect(() => {
    if (selectedIndex === null) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") setSelectedIndex(null);
      if (event.key === "ArrowLeft") {
        setSelectedIndex((current) => (current - 1 + images.length) % images.length);
      }
      if (event.key === "ArrowRight") {
        setSelectedIndex((current) => (current + 1) % images.length);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [images.length, selectedIndex]);

  if (!images.length) return null;
  const active = selectedIndex === null ? null : imageAt(selectedIndex);
  const altFor = (image, fallback) =>
    image?.[`alt_${locale}`] || image?.filename || fallback;
  const intro = introText || (locale === "zh"
    ? "用更緊湊的方式看看 Baydo Pointe 的住宅與生活空間。"
    : "A compact look at the suites and everyday spaces at Baydo Pointe.");
  const eyebrow = eyebrowText || (locale === "zh" ? "探索社區" : "Explore the property");

  return (
    <section className={`${embedded ? "bt-gallery-embedded" : "bt-sec"} bt-site-gallery`}
             aria-label={title}>
      <div className="bt-gallery-heading">
        <div>
          <span className="bt-gallery-eyebrow">{eyebrow}</span>
          <h2>{title}</h2>
        </div>
        <p>{intro}</p>
        <div className="bt-gallery-count">
          <span>{String(startIndex + 1).padStart(2, "0")}</span>
          <i />
          <span>{String(images.length).padStart(2, "0")}</span>
        </div>
      </div>

      <div className={`bt-gallery-viewport ${moving ? "is-moving" : ""}`}
           onMouseEnter={() => setPaused(true)}
           onMouseLeave={() => setPaused(false)}>
        <div className="bt-gallery-track">
          {displayed.map(({ image, index }, position) => (
            <button key={`${image.id}-${startIndex}-${position}`}
                    className={`bt-gallery-card card-${position}`} type="button"
                    tabIndex={position < 4 ? 0 : -1}
                    aria-label={`${locale === "zh" ? "放大照片" : "Open photo"} ${index + 1}`}
                    onClick={() => {
                      if (position < 4 && !moving) setSelectedIndex(index);
                    }}>
              <img src={image.url} alt={altFor(image, `${title} ${index + 1}`)} />
              <span className="bt-gallery-shade" />
              <span className="bt-gallery-card-copy">
                <small>{String(index + 1).padStart(2, "0")}</small>
                <strong>{altFor(image, title)}</strong>
              </span>
              <span className="bt-gallery-card-open">↗</span>
            </button>
          ))}
        </div>

        {images.length > 4 && (
          <>
            <button className="bt-gallery-rail-arrow previous" type="button" onClick={previous}
                    aria-label="Previous photo">‹</button>
            <button className="bt-gallery-rail-arrow next" type="button" onClick={advance}
                    aria-label="Next photo">›</button>
          </>
        )}
      </div>

      {images.length > 4 && (
        <div className="bt-gallery-rail-footer">
          <span className={paused ? "paused" : ""}>
            <i /> {paused
              ? (locale === "zh" ? "已暫停" : "Paused")
              : (locale === "zh" ? "自動播放" : "Auto advancing")}
          </span>
          <button type="button" onClick={advance}>
            {locale === "zh" ? "下一組" : "Next set"} <b>→</b>
          </button>
        </div>
      )}

      {active && (
        <div className="bt-gallery-lightbox" role="dialog" aria-modal="true" aria-label={title}
             onMouseDown={(event) => {
               if (event.target === event.currentTarget) setSelectedIndex(null);
             }}>
          <button className="bt-lightbox-close" type="button" onClick={() => setSelectedIndex(null)}
                  aria-label="Close">×</button>
          {images.length > 1 && (
            <button className="bt-lightbox-prev" type="button"
                    onClick={() => setSelectedIndex((selectedIndex - 1 + images.length) % images.length)}
                    aria-label="Previous photo">‹</button>
          )}
          <img src={active.url} alt={altFor(active, title)} />
          {images.length > 1 && (
            <button className="bt-lightbox-next" type="button"
                    onClick={() => setSelectedIndex((selectedIndex + 1) % images.length)}
                    aria-label="Next photo">›</button>
          )}
          <span>{selectedIndex + 1} / {images.length}</span>
        </div>
      )}
    </section>
  );
}

function AvailabilityPreview({ type, fallbackImage, locale }) {
  const [floorplanFailed, setFloorplanFailed] = useState(false);
  const typeCode = type?.code || type?.unit_type_code || null;
  useEffect(() => { setFloorplanFailed(false); }, [typeCode]);

  // Do not make the interaction depend on the availability response having
  // the newest optional fields. Older responses call the code
  // `unit_type_code`, which is still enough for the public image route.
  const floorplanSource = typeCode
    ? `/api/public/floorplan-images/${encodeURIComponent(typeCode)}?v=2`
    : type?.floorplan_image_url;
  const showFloorplan = !!floorplanSource && !floorplanFailed;
  const source = showFloorplan ? floorplanSource : fallbackImage?.url;
  const fallbackAlt = fallbackImage?.[`alt_${locale}`] || fallbackImage?.filename || "Baydo Pointe";
  const typeLabel = type
    ? (locale === "zh" ? type.bedroom_label_zh : type.bedroom_label_en)
    : null;

  return (
    <aside className={`bt-availability-preview ${showFloorplan ? "floorplan" : "photo"}`}>
      {source ? (
        <img key={`${typeCode || "property"}-${source}`} src={source}
             alt={showFloorplan ? `${typeLabel || typeCode} floor plan` : fallbackAlt}
             onError={() => { if (showFloorplan) setFloorplanFailed(true); }} />
      ) : (
        <div className="bt-preview-empty">Baydo Pointe</div>
      )}
      <div className="bt-preview-label">
        {showFloorplan ? <><span>Floor plan</span><strong>{typeLabel || typeCode}</strong></>
          : <><span>Baydo Pointe</span><strong>{locale === "zh" ? "將滑鼠移到戶型上查看平面圖" : "Hover over a suite type to see its floor plan"}</strong></>}
      </div>
    </aside>
  );
}

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

const AVAILABILITY_CACHE_KEY = "baydo:public-availability";

function propertyFromAvailability(live) {
  const publicTypes = (live.types ?? []).map((type) => ({
    ...type,
    code: type.code || type.unit_type_code,
  }));
  const byType = Object.fromEntries(publicTypes.map((type) => [type.code, {
    free: Number(type.available ?? 0), dates: type.earliest ? [type.earliest] : [],
  }]));
  const base = Object.fromEntries(publicTypes.map((type) =>
    [type.code, Number(type.rent) || null]));
  return {
    pricing: { base, petLimit: live.fees?.pet_limit },
    byType,
    publicTypes,
    stalls: live.parking ?? { total: 0, free: 0 },
    waiting: Number(live.parking?.waiting ?? 0),
  };
}

function readAvailabilityCache() {
  try {
    const cached = JSON.parse(window.localStorage.getItem(AVAILABILITY_CACHE_KEY));
    return cached?.types?.length ? cached : null;
  } catch { return null; }
}

async function fetchAvailability() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch("/api/public/availability");
      if (response.ok) return await response.json();
    } catch {}
    if (attempt < 2) await new Promise((resolve) =>
      window.setTimeout(resolve, 600 * (attempt + 1)));
  }
  return null;
}

function useProperty() {
  const [data, setData] = useState(() => {
    const cached = readAvailabilityCache();
    return cached ? propertyFromAvailability(cached) : null;
  });
  useEffect(() => {
    let active = true;
    (async () => {
      const live = await fetchAvailability();
      if (live?.types?.length) {
        try { window.localStorage.setItem(AVAILABILITY_CACHE_KEY, JSON.stringify(live)); }
        catch {}
        if (active) setData(propertyFromAvailability(live));
        return;
      }
      if (readAvailabilityCache()) return;

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

      if (active) setData({ pricing, byType, stalls, waiting });
    })();
    return () => { active = false; };
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
      setSignedIn(res.ok);
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
  const staffUrl = site.staff_url || STAFF_URL;

  return (
    <footer className="bt-foot">
      {/* The building, drawn rather than photographed.
          
          Three towers, six storeys, which is what is actually there. When
          there are photographs of Baydo Pointe this becomes a background-image
          and the rest of the footer does not change — the layout was built
          around a picture either way. */}
      <div className="bt-foot-art" aria-hidden="true">
        <svg viewBox="0 0 640 260" preserveAspectRatio="xMaxYMax slice">
          <defs>
            <linearGradient id="fg" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#2A6183" stopOpacity=".30" />
              <stop offset="100%" stopColor="#0B1420" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[[300, 96, 164], [420, 60, 200], [524, 118, 148]].map(([x, y, w], i) => (
            <g key={i}>
              <rect x={x} y={y} width={w} height={260 - y} fill="url(#fg)" />
              <rect x={x} y={y} width={w} height="1.5" fill="#2A6183" opacity=".5" />
              {Array.from({ length: 6 }, (_, f) => (
                <g key={f}>
                  <line x1={x} y1={y + 14 + f * 24} x2={x + w} y2={y + 14 + f * 24}
                        stroke="#2A6183" strokeWidth=".6" opacity=".28" />
                  {Array.from({ length: Math.floor(w / 26) }, (_, c) => (
                    <rect key={c} x={x + 9 + c * 26} y={y + 6 + f * 24}
                          width="13" height="11" rx="1"
                          fill="#E9B21F"
                          opacity={(f * 7 + c * 3 + i * 5) % 11 < 3 ? ".16" : ".04"} />
                  ))}
                </g>
              ))}
            </g>
          ))}
        </svg>
      </div>

      <div className="bt-foot-in">
        <div className="bt-foot-brand">
          <div className="bt-foot-mark">
            <span className="bt-foot-dot" />
            <strong>Baydo Pointe</strong>
          </div>
          <p className="bt-foot-tag">{copy.footer_tagline}</p>
          <p className="bt-foot-addr">{copy.footer_address}</p>
        </div>

        <nav className="bt-foot-col">
          <h4>{t("footer.navigation")}</h4>
          <Link to="/">{t("nav.home")}</Link>
          <Link to="/suites">{t("nav.suites")}</Link>
          <Link to="/building">{t("nav.building")}</Link>
          {/* Only what they can actually reach. A footer link that bounces
              somebody to a sign-up page is a link that taught them not to
              trust the others. */}
          <Link to="/apply">{t("nav.apply")}</Link>
          <Link to="/book">{t("nav.book")}</Link>
          <Link to="/portal">{t("nav.portal")}</Link>
          <a className="bt-foot-staff" href={staffUrl}>{t("footer.staffLogin")} →</a>
        </nav>

        <div className="bt-foot-col">
          <h4>{t("footer.contact")}</h4>
          <a href={`tel:${phone}`}>{phone}</a>
          <a href={`mailto:${email}`}>{email}</a>
          <span className="bt-foot-hours">{t("footer.hours")}</span>

          <h4 className="bt-foot-h2">{t("footer.residents")}</h4>
          <Link to="/portal">{t("footer.portalLink")}</Link>
          <Link to="/portal">{t("footer.repairLink")}</Link>
        </div>
      </div>

      <div className="bt-foot-base">
        <div className="bt-foot-base-left">
          <p className="bt-ai-note">
            {locale === "zh"
              ? "以上圖片由 AI 合成，僅供示意。"
              : "Images shown above are AI-generated for illustrative purposes."}
          </p>
          <p>© {new Date().getFullYear()} Baydo Development Corporation. {t("footer.rights")}</p>
        </div>
        <div className="bt-foot-legal">
          <Link to="/privacy">{t("common.privacy")}</Link>
          {/* Said on every page rather than once on a policy nobody opens.
              It costs a line and it is the sort of thing a tribunal notices
              the absence of. */}
          <span>{t("footer.fairHousing")}</span>
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
  const [previewCode, setPreviewCode] = useState(null);
  const [touchPreviewCode, setTouchPreviewCode] = useState(null);
  const copy = { ...DEFAULT_SITE[locale], ...(site.content?.[locale] ?? {}) };
  const heroImages = siteImages(site, "hero");
  const amenityImages = siteImages(site, "amenities");
  const neighbourhoodImages = siteImages(site, "neighbourhood");
  const galleryImages = siteImages(site, "gallery");

  const totalFree = d ? (d.publicTypes
    ? d.publicTypes.reduce((s, x) => s + Number(x.available ?? 0), 0)
    : Object.values(d.byType).reduce((s, x) => s + x.free, 0)) : null;

  const available = (d?.publicTypes ?? [])
    .filter((x) => Number(x.available) > 0)
    .sort((a, b) => Number(a.rent) - Number(b.rent));

  const from = available.length ? Number(available[0].rent) : null;
  const previewType = available.find((type) =>
    (type.code || type.unit_type_code) === previewCode) ?? null;
  const defaultPreviewImage = galleryImages[0] ?? heroImages[0]
    ?? neighbourhoodImages[0] ?? amenityImages[0] ?? null;

  return (
    <>
      {/* One statement, one number, one action.
          
          The previous version said how many suites were free in the headline
          facts, again on every card, and again on the suites page. Repeating a
          figure does not reinforce it — it makes the page feel like it is
          padding, and somebody scrolling stops reading. So the count lives in
          exactly one place: the line under the heading. */}
      <section className={`bt-hero ${heroImages.length ? "bt-hero--photo" : ""}`}>
        {heroImages.length ? (
          <div className="bt-hero-media">
            <SiteSlideshow images={heroImages} locale={locale} label="Baydo Pointe" />
          </div>
        ) : (
          <div className="bt-hero-art" aria-hidden="true">
            <svg viewBox="0 0 1200 560" preserveAspectRatio="xMidYMax slice">
              <defs>
                <linearGradient id="hg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#2A6183" stopOpacity=".10" />
                  <stop offset="100%" stopColor="#2A6183" stopOpacity="0" />
                </linearGradient>
              </defs>
              {[[690, 250, 175], [872, 190, 210], [1090, 288, 150]].map(([x, y, w], i) => (
                <g key={i}>
                  <rect x={x} y={y} width={w} height={560 - y} fill="url(#hg)" />
                  <rect x={x} y={y} width={w} height="1.5" fill="#2A6183" opacity=".18" />
                  {Array.from({ length: 6 }, (_, f) => (
                    <line key={f} x1={x} y1={y + 16 + f * 32} x2={x + w} y2={y + 16 + f * 32}
                          stroke="#2A6183" strokeWidth=".7" opacity=".1" />
                  ))}
                </g>
              ))}
            </svg>
          </div>
        )}

        <div className="bt-hero-in">
          <div className="bt-eyebrow">{t("home.address")}</div>
          <h1>{copy.headline}</h1>
          <p className="bt-lede">
            {d && totalFree > 0
              ? t("home.leadAvailable", { n: totalFree, rent: money(from) })
              : copy.subheadline}
          </p>
          <div className="bt-hero-cta">
            <Link to="/suites" className="bt-btn">{t("home.cta")}</Link>
            <Link to="/book" className="bt-btn bt-btn--ghost">
              {t("home.ctaSecond")}
            </Link>
          </div>
        </div>
      </section>

      {(copy.intro_title || copy.intro_body) && (
        <section className="bt-sec bt-site-intro">
          {copy.intro_title && <h2>{copy.intro_title}</h2>}
          {copy.intro_body && <p>{copy.intro_body}</p>}
        </section>
      )}

      {/* The layouts, as a table.
          
          Cards for four items is a lot of chrome around very little
          information — a border, a shadow and a padded box each, to hold four
          numbers. A table puts the numbers in columns where they can be
          compared, which is the actual thing somebody is doing here. */}
      {(!d || available.length > 0) && (
        <section className="bt-sec bt-availability-section">
          <div className="bt-availability-showcase" onMouseLeave={() => setPreviewCode(null)}>
            <div className="bt-availability-list">
              <div className="bt-sec-h">
                <h2>{t("home.availableTitle")}</h2>
                <Link to="/suites" className="bt-more">{t("home.seeAll")} →</Link>
              </div>

              <div className="bt-avail">
                {!d ? (
                  <div className="bt-avail-loading" role="status">
                    {locale === "zh" ? "正在載入戶型與平面圖…" : "Loading suites and floor plans…"}
                  </div>
                ) : available.slice(0, 5).map((x) => {
                  const typeCode = x.code || x.unit_type_code;
                  return (
                  <Link to="/suites" className={`bt-avail-row ${previewCode === typeCode ? "previewing" : ""}`}
                        key={typeCode} onPointerEnter={() => setPreviewCode(typeCode)}
                        onFocus={() => setPreviewCode(typeCode)}
                        onClick={(event) => {
                          if (window.matchMedia("(hover: none)").matches && touchPreviewCode !== typeCode) {
                            event.preventDefault(); setPreviewCode(typeCode); setTouchPreviewCode(typeCode);
                          }
                        }}>
                    <span className="bt-avail-n">
                      {locale === "zh" ? x.bedroom_label_zh : x.bedroom_label_en}
                    </span>
                    <span className="bt-avail-a">{x.area_sqft} ft²</span>
                    <span className="bt-avail-r">
                      {Number(x.rent) > 0 ? money(x.rent) : t("suites.askRate")}
                    </span>
                    <span className="bt-avail-c">{t("suites.available", { n: x.available })}</span>
                    <span className="bt-avail-go" aria-hidden="true">→</span>
                  </Link>
                  );
                })}
              </div>
            </div>
            <AvailabilityPreview type={previewType} fallbackImage={defaultPreviewImage} locale={locale} />
          </div>
        </section>
      )}

      {/* Amenities and location together, because they answer one question —
          what is it like to live here — and separating them made two thin
          sections where one full one belongs. */}
      <section className="bt-sec bt-two">
        <div className="bt-site-feature">
          <SiteSlideshow images={amenityImages} locale={locale}
                         label={copy.amenities_title || t("amen.title")} />
          <h2>{copy.amenities_title || t("amen.title")}</h2>
          {copy.amenities_body && <p className="bt-site-feature-copy">{copy.amenities_body}</p>}
          <ul className="bt-amen">
            {["gym", "lounge", "petwash", "bike", "patio", "busPad"].map((k) => (
              <li key={k}>{t(`amen.${k}`)}</li>
            ))}
          </ul>
        </div>
        <div className="bt-site-feature">
          <SiteSlideshow images={neighbourhoodImages} locale={locale}
                         label={copy.neighbourhood_title || t("home.locationTitle")} />
          <h2>{copy.neighbourhood_title || t("home.locationTitle")}</h2>
          {copy.neighbourhood_body && <p className="bt-site-feature-copy">{copy.neighbourhood_body}</p>}
          <dl className="bt-loc">
            {[["home.locTransit", null], ["home.locDowntown", null],
              ["home.locShops", null], ["home.locSchools", null]].map(([key]) => (
              <div key={key}>
                <dt>{t(`${key}.v`)}</dt>
                <dd>{t(`${key}.l`)}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {galleryImages.length > 0 && (
        <GalleryShowcase images={galleryImages} locale={locale}
                         title={copy.gallery_title || "Baydo Pointe"} />
      )}

      <ParkingHonesty />

      <section className="bt-cta-band">
        <div>
          <h2>{copy.cta_title || t("home.bandTitle")}</h2>
          <p>{copy.cta_body || t("home.bandBody")}</p>
        </div>
        <Link to="/book" className="bt-btn">
          {t("home.ctaSecond")}
        </Link>
      </section>
    </>
  );
}

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
            {d.stalls.free > 0
              ? t("parking.free", { n: d.stalls.free })
              : t("parking.none")}
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
  const { t, locale } = useT();
  const site = useSiteContent();
  const copy = { ...DEFAULT_SITE[locale], ...(site.content?.[locale] ?? {}) };
  const amenityImages = siteImages(site, "amenities");
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
      <GalleryShowcase
        images={amenityImages}
        locale={locale}
        title={copy.amenities_title || t("amen.title")}
        introText={copy.amenities_body || (locale === "zh"
          ? "健身房、Lounge、寵物清洗間與其他共享設施。"
          : "Gym, lounge, pet wash and other shared spaces across the community.")}
        eyebrowText={locale === "zh" ? "社區設施" : "Shared amenities"}
        embedded
      />
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
    <div className="bt bt-app">
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
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&family=Noto+Serif+TC:wght@500;600&family=Noto+Sans+TC:wght@400;500&display=swap');

/* Two families, and the reason matters more than the names.
   
   Archivo at 800 is a billboard weight. It has no Chinese, so the browser
   falls back to a system sans for the Chinese characters — and a heavy Latin
   face next to a regular Chinese one is exactly the mismatch that reads as
   cheap. Every mixed heading was doing this.
   
   Fraunces is a serif with weight in the strokes rather than in the mass, and
   Noto Serif TC sits beside it without either looking borrowed. The pairing
   works because both are serifs of similar contrast, not because they were
   designed together. */
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
.bt-logo strong{display:block;font-family:'Fraunces','Noto Serif TC',Georgia,serif;font-size:17px;letter-spacing:-.02em}
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
.bt-hero{background:linear-gradient(165deg,#F6F9FB 0%,#E7EDF2 100%);
  border-bottom:1px solid var(--rule);padding:clamp(48px,9vw,96px) 24px}
.bt-hero-in{max-width:820px;margin:0 auto}
.bt-eyebrow{font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:.12em;
  text-transform:uppercase;color:var(--dim)}
.bt-hero h1{font-family:'Fraunces','Noto Serif TC',Georgia,serif;font-weight:500;
  font-size:clamp(30px,5.5vw,52px);letter-spacing:-.03em;line-height:1.08;margin:12px 0 16px}
.bt-lede{font-size:clamp(15px,2vw,18px);color:var(--ink2);max-width:56ch;margin:0 0 20px}
/* The old pill-shaped facts are replaced by the ruled row below. */
.bt-hero-cta{display:flex;gap:10px;flex-wrap:wrap}

.bt-btn{display:inline-block;font-weight:600;font-size:14.5px;text-decoration:none;cursor:pointer;
  background:var(--ink);color:#fff;border:1px solid var(--ink);padding:12px 22px;border-radius:24px}
.bt-btn:hover{background:#000}
.bt-btn--ghost{background:transparent;color:var(--ink);border-color:var(--ink)}
.bt-btn--ghost:hover{background:var(--tint);border-color:var(--ink)}
.bt-btn--sm{font-size:13px;padding:9px 16px}
.bt-btn:disabled{opacity:.4;cursor:not-allowed}

/* sections */
.bt-sec{max-width:1120px;margin:0 auto;padding:clamp(40px,7vw,72px) 32px}
.bt-sec--tint{max-width:none;background:var(--tint);border-top:1px solid var(--rule);
  border-bottom:1px solid var(--rule)}
.bt-sec--tint>*{max-width:960px;margin-left:auto;margin-right:auto}
.bt-sec h2{font-family:'Fraunces','Noto Serif TC',Georgia,serif;font-weight:500;font-size:clamp(19px,2.2vw,24px);
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
.bt-card h3{font-family:'Fraunces','Noto Serif TC',Georgia,serif;font-size:17px;margin:2px 0 0;letter-spacing:-.01em}
.bt-card-meta{display:flex;gap:10px;font-size:12.5px;color:var(--dim);flex-wrap:wrap}
.bt-price{display:flex;align-items:baseline;gap:3px;margin-top:4px}
.bt-price strong{font-family:'IBM Plex Mono',monospace;font-size:22px;font-weight:600}
.bt-price em{font-style:normal;font-size:12.5px;color:var(--dim)}
.bt-ask{font-size:15px !important;color:var(--dim)}
.bt-card-a{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}

.bt-note{border:1px solid var(--amberline);background:var(--amber);border-radius:10px;
  padding:18px 20px;margin-top:28px}
.bt-note h3{font-family:'Fraunces','Noto Serif TC',Georgia,serif;font-size:16px;margin:0 0 8px}
.bt-note p{margin:0 0 8px;font-size:13.5px;color:#6B5410;line-height:1.65}
.bt-note p:last-child{margin-bottom:0}
.bt-note-strong{font-weight:600}

/* footer */


.bt-foot strong{display:block;font-size:14px;margin-bottom:6px}
.bt-foot p{margin:0;font-size:13px;color:var(--ink2);line-height:1.7}
.bt-foot a{color:var(--accent);text-decoration:none}




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
.bt-prose h3{font-family:'Fraunces','Noto Serif TC',Georgia,serif;font-size:16px;margin:26px 0 8px;
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
  .bt-sec,.bt-hero{padding-left:16px;padding-right:16px}
  
}

/* ══════════════════ Footer ══════════════════

   Dark, because the page above it is not — the change of ground is what
   tells somebody they have reached the end rather than a horizontal rule
   they have to notice.

   The building sits behind it at low contrast. Drawn rather than
   photographed for now; when there are photographs of Baydo Pointe this
   becomes a background-image and nothing else moves. */

.bt-foot{position:relative;background:#0B1420;color:#C9D3DC;margin-top:64px;
  overflow:hidden}
/* The building sits in the right third only.
   
   Behind the navigation columns it competes with them for attention and the
   links become hard to read — which is the opposite of what a decorative
   element is for. Confined right, and faded out towards the text. */
.bt-foot-art{position:absolute;right:0;bottom:0;top:0;width:52%;
  pointer-events:none;opacity:.55;
  -webkit-mask-image:linear-gradient(90deg,transparent 0%,#000 45%);
  mask-image:linear-gradient(90deg,transparent 0%,#000 45%)}
.bt-foot-art svg{width:100%;height:100%;display:block}
.bt-foot-in{position:relative;max-width:1080px;margin:0 auto;
  padding:54px 26px 40px;display:grid;
  grid-template-columns:1.5fr 1fr 1fr;gap:40px}

.bt-foot-mark{display:flex;align-items:center;gap:11px;margin-bottom:16px}
.bt-foot-dot{width:26px;height:26px;min-width:26px;border-radius:50%;
  flex:0 0 26px;border:1.5px solid var(--gold);position:relative;
  display:inline-block}
.bt-foot-dot::after{content:"";position:absolute;inset:6px;border-radius:50%;
  background:var(--gold);opacity:.85}
.bt-foot-mark strong{font-family:'Fraunces','Noto Serif TC',Georgia,serif;font-size:17px;
  letter-spacing:.13em;text-transform:uppercase;color:#fff;font-weight:700}
.bt-foot-tag{margin:0 0 18px;font-size:13.5px;color:#8FA3B5;line-height:1.75;
  max-width:34ch}
.bt-foot-addr{margin:0;font-size:12.5px;color:#8FA3B5;line-height:1.9;white-space:pre-line}

.bt-foot-col{display:flex;flex-direction:column;align-items:flex-start;gap:11px}
.bt-foot-col h4{font-family:'Fraunces','Noto Serif TC',Georgia,serif;font-size:14px;font-weight:700;
  color:#fff;margin:0 0 4px;letter-spacing:.01em}
.bt-foot-h2{margin-top:22px!important}
.bt-foot-col a{color:#C9D3DC;text-decoration:none;font-size:13.5px;
  transition:color .15s}
.bt-foot-col a:hover{color:var(--gold)}
.bt-foot-hours{font-size:12px;color:#6F8398;line-height:1.7}

.bt-foot-base{position:relative;border-top:1px solid rgba(255,255,255,.09);
  max-width:1080px;margin:0 auto;padding:18px 26px 26px;
  display:flex;justify-content:space-between;align-items:center;
  gap:16px;flex-wrap:wrap}
.bt-foot-base p{margin:0;font-size:11.5px;color:#5F7285}
.bt-foot-base-left{display:flex;flex-direction:column;gap:7px;align-items:flex-start}
.bt-foot-base .bt-ai-note{color:#8FA3B5}
.bt-foot-legal{display:flex;gap:18px;align-items:center;flex-wrap:wrap;
  font-size:11.5px;color:#5F7285}
.bt-foot-legal a{color:#8FA3B5;text-decoration:none}
.bt-foot-legal a:hover{color:var(--gold)}

@media (max-width:820px){
  .bt-foot-in{grid-template-columns:1fr 1fr;gap:32px}
  .bt-foot-brand{grid-column:1/-1}
}
@media (max-width:560px){
  .bt-foot-in{grid-template-columns:1fr;gap:28px;padding:40px 18px 30px}
  .bt-foot-base{padding:16px 18px 22px;flex-direction:column;align-items:flex-start}
}

/* The band at the bottom lost its button to a flex rule that let the text
   take the whole row. */
.bt-app .bt-cta-band>div{flex:1 1 300px}
.bt-app .bt-cta-band>.bt-btn{flex:0 0 auto;white-space:nowrap}

/* ══════════════════ Home ══════════════════

   Type first.

   The old heading was clamp(30px, 4.4vw, 46px) — a scale that works for
   English, where 46px still fits a sentence on one line. In Chinese each
   character is a full em, so twelve of them filled the line and the heading
   broke in two. Large type that wraps badly reads as worse than smaller type
   that does not.

   So the ceiling comes down to 34px and the line-height opens up. A heading
   is meant to be read in one glance, and two cramped lines is two glances. */

.bt-hero{position:relative;overflow:hidden}
.bt-hero-art{position:absolute;right:0;top:0;bottom:0;width:56%;
  pointer-events:none;
  -webkit-mask-image:linear-gradient(90deg,transparent 0,#000 40%);
  mask-image:linear-gradient(90deg,transparent 0,#000 40%)}
.bt-hero-art svg{width:100%;height:100%;display:block}

.bt-hero-in{position:relative;max-width:1080px;margin:0 auto;
  padding:88px 26px 76px;max-width:min(1080px,100%)}
.bt-hero .bt-eyebrow{font-family:'IBM Plex Mono',monospace;font-size:11px;
  letter-spacing:.16em;text-transform:uppercase;color:var(--dim);margin:0 0 18px}
.bt-hero h1{font-size:clamp(26px,3.2vw,34px);line-height:1.42;
  letter-spacing:-.005em;font-weight:700;margin:0 0 16px;max-width:22ch;
  color:var(--ink)}
.bt-hero .bt-lede{font-size:15px;line-height:1.9;color:var(--ink2);
  max-width:44ch;margin:0 0 30px}

.bt-hero-cta{display:flex;gap:11px;flex-wrap:wrap}
.bt-hero-cta .bt-btn{background:var(--ink);color:#fff;border-color:var(--ink)}
.bt-hero-cta .bt-btn--ghost{background:transparent;color:var(--ink);
  border-color:var(--rule)}
.bt-hero-cta .bt-btn--ghost:hover{border-color:var(--ink);background:transparent}

/* The one number on the page that changes, so the one worth showing live. */
.bt-hero-live{display:flex;align-items:center;gap:8px;margin:24px 0 0;
  font-size:13px;color:var(--dim)}
.bt-hero-live span{width:7px;height:7px;border-radius:50%;
  background:var(--rule);flex:0 0 7px}
.bt-hero-live span.on{background:var(--green);
  box-shadow:0 0 0 3px rgba(14,133,119,.14)}

/* ---------- Layouts ---------- */

.bt-sec-h{display:flex;justify-content:space-between;align-items:baseline;
  gap:16px;margin-bottom:20px}
.bt-sec-h h2{margin:0}
.bt-more{font-size:13px;color:var(--accent);text-decoration:none;
  white-space:nowrap}
.bt-more:hover{text-decoration:underline}

.bt-plans{display:grid;grid-template-columns:repeat(auto-fill,minmax(196px,1fr));
  gap:10px}
.bt-plan{display:flex;flex-direction:column;gap:5px;padding:17px 19px 18px;
  text-decoration:none;color:inherit;background:#fff;
  border:1px solid var(--rule);border-radius:8px;
  transition:border-color .15s,box-shadow .15s}
.bt-plan:hover{border-color:var(--accent);
  box-shadow:0 4px 14px rgba(27,51,88,.06)}
.bt-plan-top{display:flex;justify-content:space-between;align-items:baseline;
  gap:10px}
.bt-plan-top strong{font-size:15px;font-weight:600}
.bt-plan-free{font-size:11px;color:var(--green);font-weight:600;
  white-space:nowrap}
/* A layout with nothing free is still shown — somebody will wait a month for
   the right flat, and they will not come back to check. */
.bt-plan-none{font-size:11px;color:var(--dim);white-space:nowrap}
.bt-plan-rent{font-family:'IBM Plex Mono',monospace;font-size:20px;
  font-weight:500;line-height:1.2;margin-top:2px}
.bt-plan-rent em{font-style:normal;font-size:11px;color:var(--dim);
  font-family:'IBM Plex Sans',sans-serif;margin-left:3px}
.bt-plan-size{font-size:11.5px;color:var(--dim)}

/* ---------- Living ---------- */

.bt-living{display:grid;grid-template-columns:1fr 1fr;gap:34px}
.bt-living-col h3{font-size:12px;font-weight:700;color:var(--dim);
  text-transform:uppercase;letter-spacing:.09em;margin:0 0 13px}
.bt-living-col ul{list-style:none;margin:0;padding:0;display:flex;
  flex-direction:column;gap:9px}
.bt-living-col li{font-size:14px;color:var(--ink2);padding-left:15px;
  position:relative;line-height:1.6}
.bt-living-col li::before{content:"";position:absolute;left:0;top:9px;
  width:4px;height:4px;border-radius:50%;background:var(--rule)}

.bt-living-num li{display:flex;align-items:baseline;gap:11px;padding-left:0}
.bt-living-num li::before{display:none}
.bt-living-num b{font-family:'IBM Plex Mono',monospace;font-size:15px;
  font-weight:500;color:var(--ink);min-width:62px}
.bt-living-num span{font-size:13.5px;color:var(--dim)}

@media (max-width:700px){
  .bt-hero-in{padding:56px 18px 48px}
  .bt-hero-art{width:100%;opacity:.5}
  .bt-living{grid-template-columns:1fr;gap:26px}
}

/* ---------- Spacing and the heading, corrected against a render ----------

   Three things the first pass got wrong, all visible only once it was on a
   screen at a real width.

   The hero had 88px above the eyebrow, which on a 1000px viewport pushed the
   buttons below the fold — the two things somebody came to click.

   The heading still broke across two lines at 34px, because 22ch is wider
   than the column at this size. Chinese counts one character per em, so the
   measure has to be set in characters rather than trusted to wrap well.

   And the sections sat 64px apart, which reads as unfinished rather than
   spacious when each one is only three or four lines tall. */

.bt-app .bt-hero-in{padding:54px 26px 52px}
.bt-app .bt-hero h1{font-size:clamp(24px,2.6vw,30px);line-height:1.45;
  max-width:17ch;margin:0 0 14px}
.bt-app .bt-hero .bt-lede{max-width:40ch;margin:0 0 26px;font-size:14.5px;
  line-height:1.85}
.bt-app .bt-hero .bt-eyebrow{margin:0 0 14px}
.bt-app .bt-hero-live{margin-top:20px}


.bt-app .bt-sec h2{font-size:19px;letter-spacing:-.005em;margin:0 0 18px}
.bt-app .bt-sec-h{margin-bottom:16px}

/* The parking note is the last thing before the footer and should not float
   in the middle of an empty screen. */
.bt-app .bt-honest{margin-top:8px;padding:18px 20px;background:var(--tint);
  border-left:3px solid var(--gold);border-radius:0 6px 6px 0}
.bt-app .bt-honest h3{margin:0 0 6px;font-size:14px}
.bt-app .bt-honest p{margin:0;font-size:13.5px;color:var(--ink2);line-height:1.8;
  max-width:66ch}

.bt-app .bt-living{gap:44px}
.bt-app .bt-plans{gap:11px}

@media (max-width:700px){
  .bt-app .bt-hero-in{padding:40px 18px 40px}
  .bt-app .bt-sec{padding:30px 18px 0}
}

/* The last two, again only visible on a render.

   The hero art was preserveAspectRatio="xMidYMax slice", which centres the
   drawing and then crops whatever does not fit — so the right-hand tower ran
   off the edge. xMaxYMax anchors it to the corner instead, which is where a
   skyline belongs anyway.

   And the hero still had more space above the eyebrow than below the live
   line, which makes the whole block sit low. */

/* slice fills the box and crops; anchored right so the crop happens on the
   left, where the drawing fades out behind the text anyway. meet shrank the
   whole skyline into the corner instead. */
.bt-app .bt-hero-in{padding:44px 26px 46px}
.bt-app .bt-hero-art{width:54%;opacity:.95;
  -webkit-mask-image:linear-gradient(90deg,transparent 0,#000 38%);
  mask-image:linear-gradient(90deg,transparent 0,#000 38%)}

/* ══════════════════ Home ══════════════════

   Quieter than the last version, in three ways.

   The heading is a serif at 500 rather than a sans at 800. Weight in the
   strokes rather than in the mass, which is the difference between a
   building's name and a sale sign.

   The available count appears once. It was in the hero facts, on every card
   and on the suites page — repeating a number does not reinforce it, it makes
   the page read as padding.

   The layouts are a table rather than cards. Four numbers per layout do not
   need a bordered, shadowed, padded box each; in columns they can be compared,
   which is what somebody is actually doing.
   ═══════════════════════════════════════════ */

.bt-app .bt-hero{position:relative;overflow:hidden}
.bt-app .bt-hero-art{position:absolute;inset:0;pointer-events:none}
.bt-app .bt-hero-art svg{width:100%;height:100%;display:block}
.bt-app .bt-hero-in{position:relative;max-width:1080px;margin:0 auto;
  padding:86px 26px 74px}

.bt-app .bt-eyebrow{font-family:'IBM Plex Mono',monospace;font-size:10.5px;
  letter-spacing:.16em;text-transform:uppercase;color:var(--dim);
  margin-bottom:20px}
.bt-app .bt-hero h1{font-family:'Fraunces','Noto Serif TC',Georgia,serif;
  font-weight:500;font-size:clamp(30px,3.6vw,44px);line-height:1.24;
  letter-spacing:-.012em;margin:0 0 18px;max-width:17ch;color:var(--ink)}
.bt-app .bt-lede{font-size:15.5px;line-height:1.85;color:var(--ink2);
  max-width:44ch;margin:0 0 30px}
.bt-app .bt-lede strong{font-weight:600;color:var(--ink)}
.bt-app .bt-hero-cta{display:flex;gap:10px;flex-wrap:wrap}

.bt-app .bt-sec{max-width:1080px;margin:0 auto;padding:52px 26px}
.bt-app .bt-sec h2{font-family:'Fraunces','Noto Serif TC',Georgia,serif;
  font-weight:500;font-size:clamp(19px,2.1vw,23px);letter-spacing:-.008em;
  margin:0 0 18px;color:var(--ink)}
.bt-app .bt-sec-h{display:flex;justify-content:space-between;align-items:baseline;
  gap:16px;margin-bottom:16px}
.bt-app .bt-sec-h h2{margin:0}
.bt-app .bt-more{font-size:12.5px;color:var(--accent);text-decoration:none;
  white-space:nowrap}
.bt-app .bt-more:hover{text-decoration:underline}

/* The layouts. A row per layout, columns that line up. */
.bt-app .bt-avail{border-top:1px solid var(--rule)}
.bt-app .bt-avail-row{display:grid;
  grid-template-columns:1fr 90px 108px 78px 20px;
  align-items:center;gap:14px;padding:15px 4px;
  border-bottom:1px solid var(--rule);text-decoration:none;color:inherit;
  transition:background .12s}
.bt-app .bt-avail-row:hover{background:var(--tint)}
.bt-app .bt-avail-n{font-size:15px;font-weight:500}
.bt-app .bt-avail-a,.bt-app .bt-avail-r,.bt-app .bt-avail-c{
  font-family:'IBM Plex Mono',monospace;font-variant-numeric:tabular-nums;
  font-size:13.5px;text-align:right}
.bt-app .bt-avail-a{color:var(--dim)}
.bt-app .bt-avail-c{color:var(--accent);font-size:12.5px}
.bt-app .bt-avail-go{color:var(--rule);text-align:right;font-size:13px}
.bt-app .bt-avail-row:hover .bt-plan-go{color:var(--accent)}

/* Amenities and where it is, side by side. One question, one section. */
.bt-app .bt-two{display:grid;grid-template-columns:1fr 1fr;gap:52px}
.bt-app .bt-amen{list-style:none;margin:0;padding:0;
  display:grid;grid-template-columns:1fr 1fr;gap:9px 20px}
.bt-app .bt-amen li{font-size:13.5px;color:var(--ink2);padding-left:15px;
  position:relative;line-height:1.6}
.bt-app .bt-amen li::before{content:"";position:absolute;left:0;top:9px;
  width:5px;height:1px;background:var(--accent)}

.bt-app .bt-loc{margin:0;display:flex;flex-direction:column}
.bt-app .bt-loc>div{display:flex;align-items:baseline;gap:14px;
  padding:11px 0;border-bottom:1px solid var(--rule)}
.bt-app .bt-loc>div:first-child{padding-top:0}
.bt-app .bt-loc dt{font-family:'IBM Plex Mono',monospace;font-size:15px;
  color:var(--ink);flex:0 0 76px}
.bt-app .bt-loc dd{margin:0;font-size:13px;color:var(--dim);line-height:1.6}

.bt-app .bt-cta-band{max-width:1080px;margin:26px auto 0;padding:34px 26px;
  display:flex;align-items:center;justify-content:space-between;gap:26px;
  flex-wrap:wrap;border-top:1px solid var(--rule)}
.bt-app .bt-cta-band>div{flex:1 1 300px}
.bt-app .bt-cta-band h2{margin:0 0 6px}
.bt-app .bt-cta-band p{margin:0;font-size:13.5px;color:var(--dim);
  line-height:1.8;max-width:50ch}
.bt-app .bt-cta-band>.bt-btn{flex:0 0 auto;white-space:nowrap}

.bt-app .bt-btn{font-family:'IBM Plex Sans','Noto Sans TC',sans-serif;
  font-weight:500;font-size:14px;padding:11px 22px;border-radius:3px;
  letter-spacing:.01em}
.bt-app .bt-hero-cta .bt-btn{background:var(--ink);color:#fff;border-color:var(--ink)}
.bt-app .bt-btn--ghost{background:transparent;color:var(--ink);
  border-color:var(--rule)}
.bt-app .bt-btn--ghost:hover{background:transparent;border-color:var(--ink)}

@media (max-width:760px){
  .bt-app .bt-two{grid-template-columns:1fr;gap:38px}
  .bt-app .bt-hero-in{padding:56px 20px 48px}
  .bt-app .bt-sec{padding:38px 20px}
  .bt-app .bt-avail-row{grid-template-columns:1fr auto auto;gap:10px;
    padding:13px 2px}
  .bt-app .bt-avail-a,.bt-app .bt-avail-go{display:none}
}

/* Footer layout and contrast. Keep the building art decorative instead of
   allowing it to compete with the contact information. */
.bt-app .bt-foot-art{width:46%;opacity:.28;
  -webkit-mask-image:linear-gradient(90deg,transparent 0%,#000 58%);
  mask-image:linear-gradient(90deg,transparent 0%,#000 58%)}
.bt-app .bt-foot-in{grid-template-columns:minmax(280px,1.4fr) minmax(160px,.75fr) minmax(220px,1fr);
  gap:64px;padding-top:58px;padding-bottom:48px}
.bt-app .bt-foot-mark strong,.bt-app .bt-foot-col h4{
  font-family:'IBM Plex Sans','Noto Sans TC',sans-serif}
.bt-app .bt-foot-mark strong{letter-spacing:.08em;font-size:18px}
.bt-app .bt-foot-col h4{font-size:13px;letter-spacing:.08em;text-transform:uppercase}
.bt-app .bt-foot-tag{color:#A9B8C5;max-width:38ch}
.bt-app .bt-foot-col a{line-height:1.55}
.bt-app .bt-foot-hours{color:#8FA3B5}

@media (max-width:820px){
  .bt-app .bt-foot-in{grid-template-columns:1fr 1fr;gap:34px}
}
@media (max-width:560px){
  .bt-app .bt-foot-in{grid-template-columns:1fr;gap:28px}
  .bt-app .bt-foot-art{width:85%;opacity:.18}
}

/* Everything on one measure.
   
   The hero was full-bleed while the sections below were centred at 1080, so
   the left edge moved as you scrolled — which reads as things being slightly
   broken without anybody being able to say why. */
.bt-app .bt-hero-in,
.bt-app .bt-sec,
.bt-app .bt-cta-band{max-width:1120px;margin-left:auto;margin-right:auto}
.bt-app .bt-sec{padding-left:32px;padding-right:32px}
.bt-app .bt-hero-in{padding-left:32px;padding-right:32px}
.bt-app .bt-cta-band{padding-left:32px;padding-right:32px}

/* The available table should not stretch to the full measure — a row of five
   short columns across 1120px puts the rent a long way from the layout name,
   and the eye loses the line. */
.bt-app .bt-avail{max-width:660px}

@media (max-width:760px){
  .bt-app .bt-hero-in,.bt-app .bt-sec,.bt-app .bt-cta-band{
    padding-left:20px;padding-right:20px}
}

/* ══════════════════ Home, final pass ══════════════════ */

/* Two buttons of the same weight make somebody read both to find the one
   they want. The first is filled, the second is not. */
.bt-app .bt-hero-cta .bt-btn{background:var(--ink);color:#fff;
  border:1px solid var(--ink)}
.bt-app .bt-hero-cta .bt-btn--ghost{background:transparent;color:var(--ink);
  border:1px solid var(--rule)}
.bt-app .bt-hero-cta .bt-btn--ghost:hover{border-color:var(--ink);
  background:transparent;color:var(--ink)}

/* The section heading sits on the same left edge as the hero heading. A
   measure that shifts between sections reads as slightly broken without
   anybody being able to say why. */
.bt-app .bt-sec,
.bt-app .bt-hero-in,
.bt-app .bt-cta-band{max-width:1120px;margin-left:auto;margin-right:auto;
  padding-left:32px;padding-right:32px;box-sizing:border-box}
.bt-app .bt-sec-h{max-width:660px}

@media (max-width:760px){
  .bt-app .bt-sec,.bt-app .bt-hero-in,.bt-app .bt-cta-band{
    padding-left:20px;padding-right:20px}
}

/* Photos published from Admin > Website content. */
.bt-app .bt-site-slideshow{position:relative;overflow:hidden;background:#E7EDF2}
.bt-app .bt-site-slideshow img{display:block;width:100%;aspect-ratio:16/10;
  object-fit:cover;animation:bt-photo-in .35s ease}
@keyframes bt-photo-in{from{opacity:.35;transform:scale(1.012)}to{opacity:1;transform:scale(1)}}
.bt-app .bt-slide-arrow{position:absolute;top:50%;z-index:2;transform:translateY(-50%);
  width:38px;height:38px;border:1px solid rgba(255,255,255,.55);border-radius:50%;
  background:rgba(11,20,32,.56);color:#fff;font:28px/1 Georgia,serif;cursor:pointer;
  display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)}
.bt-app .bt-slide-arrow:hover{background:rgba(11,20,32,.78)}
.bt-app .bt-slide-arrow.prev{left:14px}.bt-app .bt-slide-arrow.next{right:14px}
.bt-app .bt-slide-dots{position:absolute;z-index:2;left:50%;bottom:13px;
  transform:translateX(-50%);display:flex;gap:7px;padding:7px 9px;
  border-radius:18px;background:rgba(11,20,32,.42);backdrop-filter:blur(4px)}
.bt-app .bt-slide-dots button{width:7px;height:7px;padding:0;border:0;border-radius:50%;
  background:rgba(255,255,255,.52);cursor:pointer}
.bt-app .bt-slide-dots button.on{background:#fff;box-shadow:0 0 0 2px rgba(255,255,255,.2)}

.bt-app .bt-hero-media{position:absolute;z-index:0;right:0;top:0;bottom:0;width:58%;
  -webkit-mask-image:linear-gradient(90deg,transparent 0,#000 30%);
  mask-image:linear-gradient(90deg,transparent 0,#000 30%)}
.bt-app .bt-hero-media .bt-site-slideshow,.bt-app .bt-hero-media img{height:100%}
.bt-app .bt-hero-media img{aspect-ratio:auto}
.bt-app .bt-hero--photo .bt-hero-in{z-index:1}
.bt-app .bt-hero--photo .bt-hero-in::before{content:"";position:absolute;z-index:-1;
  inset:-24px 48% -24px -24px;background:linear-gradient(90deg,rgba(246,249,251,.97) 0%,
  rgba(246,249,251,.86) 72%,transparent 100%);pointer-events:none}

.bt-app .bt-site-intro{padding-top:40px;padding-bottom:8px}
.bt-app .bt-site-intro h2{margin-bottom:10px}
.bt-app .bt-site-intro p{max-width:70ch;margin:0;color:var(--ink2);line-height:1.85}
.bt-app .bt-site-feature>.bt-site-slideshow{margin-bottom:24px;border-radius:4px}
.bt-app .bt-site-feature-copy{margin:-6px 0 18px;color:var(--dim);font-size:13.5px;
  line-height:1.75;max-width:54ch}
.bt-app .bt-site-gallery{padding-top:42px;padding-bottom:44px}
.bt-app .bt-gallery-heading{display:grid;grid-template-columns:minmax(240px,1fr) minmax(240px,.72fr) auto;
  gap:32px;align-items:end;margin-bottom:18px;padding-top:20px;border-top:1px solid var(--rule)}
.bt-app .bt-gallery-heading h2{margin:5px 0 0;font-size:clamp(30px,3.5vw,44px);line-height:1.04}
.bt-app .bt-gallery-eyebrow{font:9px 'IBM Plex Mono',monospace;color:var(--accent);
  text-transform:uppercase;letter-spacing:.16em}
.bt-app .bt-gallery-heading p{max-width:42ch;margin:0 0 3px;color:var(--dim);font-size:13px;line-height:1.65}
.bt-app .bt-gallery-count{display:flex;align-items:center;gap:9px;padding-bottom:4px;color:var(--dim);
  font:9px 'IBM Plex Mono',monospace;letter-spacing:.1em}
.bt-app .bt-gallery-count i{width:38px;height:1px;background:var(--rule)}
.bt-app .bt-gallery-viewport{--bt-gallery-gap:10px;position:relative;width:100%;overflow:hidden;
  border-radius:14px}
.bt-app .bt-gallery-track{display:flex;align-items:stretch;gap:var(--bt-gallery-gap);width:100%}
.bt-app .bt-gallery-card{position:relative;flex:0 0 calc((100% - (var(--bt-gallery-gap) * 3))/4);
  height:270px;min-width:0;padding:0;overflow:hidden;border:0;border-radius:14px;
  background:#DDE5EB;color:#fff;cursor:zoom-in;isolation:isolate;text-align:left;transform:translateX(0)}
.bt-app .bt-gallery-card img{display:block;width:100%;height:100%;object-fit:cover;
  transition:transform .65s cubic-bezier(.2,.75,.25,1),filter .35s ease}
.bt-app .bt-gallery-card:hover img{transform:scale(1.035);filter:brightness(.86)}
.bt-app .bt-gallery-shade{position:absolute;inset:38% 0 0;z-index:1;
  background:linear-gradient(transparent,rgba(8,18,31,.78));opacity:0;transition:opacity .3s ease}
.bt-app .bt-gallery-card-copy{position:absolute;z-index:2;left:16px;right:40px;bottom:15px;
  display:flex;flex-direction:column;gap:2px;opacity:0;transform:translateY(8px);
  transition:opacity .3s ease,transform .3s ease}
.bt-app .bt-gallery-card-copy small{font:8px 'IBM Plex Mono',monospace;letter-spacing:.13em;
  color:rgba(255,255,255,.72)}
.bt-app .bt-gallery-card-copy strong{font:16px 'Fraunces','Noto Serif TC',serif;
  font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-app .bt-gallery-card-open{position:absolute;z-index:2;right:16px;bottom:15px;font-size:18px;
  opacity:0;transform:translateY(8px);transition:opacity .3s ease,transform .3s ease}
.bt-app .bt-gallery-card:hover .bt-gallery-shade,
.bt-app .bt-gallery-card:hover .bt-gallery-card-copy,
.bt-app .bt-gallery-card:hover .bt-gallery-card-open{opacity:1;transform:translateY(0)}
.bt-app .bt-gallery-card.card-4{pointer-events:none}
.bt-app .bt-gallery-viewport.is-moving .bt-gallery-card{animation:bt-gallery-shift 680ms cubic-bezier(.22,.72,.2,1) forwards;
  pointer-events:none}
.bt-app .bt-gallery-viewport.is-moving .bt-gallery-card.card-0{animation-name:bt-gallery-fade-left}
.bt-app .bt-gallery-viewport.is-moving .bt-gallery-card.card-4{animation-name:bt-gallery-enter-right}
@keyframes bt-gallery-shift{from{transform:translateX(0)}
  to{transform:translateX(calc(-100% - var(--bt-gallery-gap)))}}
@keyframes bt-gallery-fade-left{0%{opacity:1;transform:translateX(0) scale(1)}
  68%{opacity:0}100%{opacity:0;transform:translateX(calc(-100% - var(--bt-gallery-gap))) scale(.96)}}
@keyframes bt-gallery-enter-right{0%{opacity:0;transform:translateX(20px) scale(.97)}
  30%{opacity:0}100%{opacity:1;transform:translateX(calc(-100% - var(--bt-gallery-gap))) scale(1)}}
.bt-app .bt-gallery-rail-arrow{position:absolute;z-index:4;top:50%;display:flex;align-items:center;
  justify-content:center;width:35px;height:47px;padding:0;transform:translateY(-50%);
  border:1px solid rgba(255,255,255,.5);background:rgba(9,20,34,.58);color:#fff;cursor:pointer;
  font:28px/1 Georgia,serif;opacity:0;backdrop-filter:blur(6px);transition:opacity .25s,background .25s}
.bt-app .bt-gallery-viewport:hover .bt-gallery-rail-arrow{opacity:1}
.bt-app .bt-gallery-rail-arrow:hover{background:rgba(9,20,34,.82)}
.bt-app .bt-gallery-rail-arrow.previous{left:9px;border-radius:0 7px 7px 0}
.bt-app .bt-gallery-rail-arrow.next{right:9px;border-radius:7px 0 0 7px}
.bt-app .bt-gallery-rail-footer{display:flex;justify-content:space-between;align-items:center;
  min-height:36px;padding:7px 2px 0}
.bt-app .bt-gallery-rail-footer>span{display:flex;align-items:center;gap:7px;color:var(--dim);
  font:8px 'IBM Plex Mono',monospace;text-transform:uppercase;letter-spacing:.12em}
.bt-app .bt-gallery-rail-footer>span i{width:5px;height:5px;border-radius:50%;
  background:var(--accent);animation:bt-gallery-pulse 1.8s ease infinite}
.bt-app .bt-gallery-rail-footer>span.paused i{background:#D7AF63;animation:none}
@keyframes bt-gallery-pulse{50%{opacity:.28}}
.bt-app .bt-gallery-rail-footer>button{padding:3px 0;border:0;background:transparent;color:var(--ink);
  cursor:pointer;font:9px 'IBM Plex Mono',monospace;text-transform:uppercase;letter-spacing:.1em}
.bt-app .bt-gallery-rail-footer>button b{margin-left:7px;font:16px/1 Georgia,serif;font-weight:400}
.bt-app .bt-gallery-lightbox{position:fixed;z-index:1000;inset:0;display:flex;align-items:center;justify-content:center;
  padding:58px 74px;background:rgba(5,12,21,.94);backdrop-filter:blur(8px)}
.bt-app .bt-gallery-lightbox img{display:block;max-width:100%;max-height:calc(100vh - 116px);object-fit:contain;
  box-shadow:0 22px 70px rgba(0,0,0,.38)}
.bt-app .bt-gallery-lightbox>button{position:absolute;border:1px solid rgba(255,255,255,.35);background:rgba(0,0,0,.18);
  color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center}
.bt-app .bt-lightbox-close{right:24px;top:20px;width:42px;height:42px;font:31px/1 Arial,sans-serif}
.bt-app .bt-lightbox-prev,.bt-app .bt-lightbox-next{top:50%;width:44px;height:58px;
  transform:translateY(-50%);font:34px/1 Georgia,serif}
.bt-app .bt-lightbox-prev{left:18px}.bt-app .bt-lightbox-next{right:18px}
.bt-app .bt-gallery-lightbox>span{position:absolute;left:50%;bottom:22px;transform:translateX(-50%);
  color:rgba(255,255,255,.78);font:10px 'IBM Plex Mono',monospace;letter-spacing:.14em}

.bt-app .bt-availability-showcase{display:grid;grid-template-columns:minmax(0,660px) minmax(280px,1fr);
  gap:38px;align-items:stretch}
.bt-app .bt-availability-list{min-width:0}
.bt-app .bt-availability-preview{position:relative;min-height:390px;overflow:hidden;
  border:1px solid var(--rule);border-radius:4px;background:#E7EDF2}
.bt-app .bt-availability-preview img{display:block;width:100%;height:100%;min-height:390px;
  object-fit:cover;animation:bt-photo-in .25s ease}
.bt-app .bt-availability-preview.floorplan{background:#fff}
.bt-app .bt-availability-preview.floorplan img{object-fit:contain;padding:22px;background:#fff}
.bt-app .bt-preview-empty{height:100%;min-height:390px;display:flex;align-items:center;
  justify-content:center;font-family:'Fraunces','Noto Serif TC',serif;font-size:24px;color:#9AABB9}
.bt-app .bt-preview-label{position:absolute;left:0;right:0;bottom:0;padding:16px 18px;
  display:flex;flex-direction:column;gap:2px;color:#fff;
  background:linear-gradient(transparent,rgba(11,20,32,.82))}
.bt-app .bt-availability-preview.floorplan .bt-preview-label{color:var(--ink);
  background:linear-gradient(transparent,rgba(255,255,255,.98))}
.bt-app .bt-preview-label span{font:10px 'IBM Plex Mono',monospace;text-transform:uppercase;
  letter-spacing:.12em;opacity:.78}
.bt-app .bt-preview-label strong{font-size:13px;font-weight:500;line-height:1.5}
.bt-app .bt-avail-row.previewing{background:var(--tint)}
.bt-app .bt-avail-row.previewing .bt-avail-go{color:var(--accent)}
.bt-app .bt-avail-loading{min-height:355px;display:flex;align-items:center;
  justify-content:center;border-bottom:1px solid var(--rule);color:var(--dim);
  font:12px 'IBM Plex Mono',monospace;letter-spacing:.03em}

@media (max-width:760px){
  .bt-app .bt-hero-media{inset:0;width:100%;opacity:.42;
    -webkit-mask-image:none;mask-image:none}
  .bt-app .bt-hero--photo::after{content:"";position:absolute;inset:0;
    background:linear-gradient(90deg,rgba(246,249,251,.96),rgba(246,249,251,.7));
    pointer-events:none}
  .bt-app .bt-hero--photo .bt-hero-in{z-index:2}
  .bt-app .bt-hero--photo .bt-hero-in::before{display:none}
  .bt-app .bt-hero-media .bt-slide-arrow,.bt-app .bt-hero-media .bt-slide-dots{display:none}
  .bt-app .bt-site-intro{padding-top:30px;padding-bottom:0}
  .bt-app .bt-site-gallery{padding-top:34px;padding-bottom:36px}
  .bt-app .bt-gallery-heading{grid-template-columns:1fr auto;gap:18px;margin-bottom:18px}
  .bt-app .bt-gallery-heading p{grid-column:1/-1;grid-row:2}
  .bt-app .bt-gallery-heading h2{font-size:34px}
  .bt-app .bt-gallery-count{grid-column:2;grid-row:1}
  .bt-app .bt-gallery-card{height:220px}
  .bt-app .bt-gallery-lightbox{padding:64px 14px}
  .bt-app .bt-lightbox-prev,.bt-app .bt-lightbox-next{width:38px;height:48px;background:rgba(0,0,0,.48)}
  .bt-app .bt-lightbox-prev{left:8px}.bt-app .bt-lightbox-next{right:8px}
  .bt-app .bt-lightbox-close{right:12px;top:12px}
  .bt-app .bt-availability-showcase{grid-template-columns:1fr;gap:22px}
  .bt-app .bt-availability-preview{min-height:300px;order:-1}
  .bt-app .bt-availability-preview img,.bt-app .bt-preview-empty{min-height:300px}
}
@media (max-width:560px){
  .bt-app .bt-gallery-heading{grid-template-columns:1fr;gap:10px}
  .bt-app .bt-gallery-heading p{grid-column:1;grid-row:auto;font-size:12px}
  .bt-app .bt-gallery-count{display:none}
  .bt-app .bt-gallery-card{flex-basis:78%;height:240px;border-radius:13px}
  .bt-app .bt-gallery-viewport{border-radius:13px}
  .bt-app .bt-gallery-rail-arrow{opacity:1;width:33px;height:44px}
  .bt-app .bt-gallery-shade,.bt-app .bt-gallery-card-copy,.bt-app .bt-gallery-card-open{
    opacity:1;transform:none}
}
`; }
