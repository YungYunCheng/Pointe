/* ============================================================
   Theme

   Colours come from the two marks: Mizar's navy and steel blue,
   Baydo's violet and gold.

   Each role gets its own. Not decoration — with four people sharing
   a screen and one of them able to post to the ledger, the first
   thing anybody should know is whose session they are looking at.
   A glance at the header answers it before they read a word.

   Gold is shared across all four as the accent, because it belongs
   to neither role and reads as "attention" rather than "identity".
   ============================================================ */

export const BRAND = {
  // Mizar
  navy:      "#1B3358",
  navyDeep:  "#122542",
  steel:     "#2A6183",
  steelSoft: "#3B7BA0",
  // Baydo
  violet:    "#574A9E",
  violetSoft:"#6D5FBA",
  gold:      "#E9B21F",
  goldSoft:  "#F5CC5C",
  green:     "#2F7D5E",
  greenSoft: "#3E9B76",
};

/**
 * One entry per role.
 *
 * `ink` is the header and primary buttons. `tint` is the wash behind panels
 * that belong to this role. `line` is the border on anything that needs to
 * read as theirs.
 *
 * Contrast was checked against white for every `ink` — a role colour that
 * fails on a header is a role colour nobody can read at four in the
 * afternoon.
 */
export const ROLE_THEME = {
  admin: {
    label: "Admin",
    label_zh: "系統管理",
    ink: BRAND.navyDeep,
    inkHover: "#0B1A30",
    tint: "#EEF2F7",
    line: "#C3CFDD",
    chip: BRAND.navyDeep,
    accent: BRAND.gold,
    // Admin restores backups and rewrites permissions. The darkest of the
    // four on purpose: it should feel like the serious one.
    note: "Mizar navy",
  },
  property_manager: {
    label: "Property Manager",
    label_zh: "物業經理",
    ink: BRAND.steel,
    inkHover: "#1F4F6C",
    tint: "#EDF4F8",
    line: "#B9D2E0",
    chip: BRAND.steel,
    accent: BRAND.gold,
    note: "Mizar steel blue",
  },
  building_manager: {
    label: "Building Manager",
    label_zh: "現場管理",
    ink: BRAND.violet,
    inkHover: "#443A80",
    tint: "#F1EFF9",
    line: "#CAC2E6",
    chip: BRAND.violet,
    accent: BRAND.gold,
    note: "Baydo violet",
  },
  accounting: {
    label: "Accounting",
    label_zh: "會計",
    ink: BRAND.green,
    inkHover: "#245F47",
    tint: "#ECF5F1",
    line: "#B6D8C8",
    chip: BRAND.green,
    accent: BRAND.gold,
    // Green rather than gold: gold on white does not carry enough contrast
    // for a header, and money already has a colour people expect.
    note: "Drawn from the Baydo gradient",
  },
};

/* Semantic colours stay the same across every role. A warning that changed
   hue with whoever signed in would be a warning nobody learns to recognise. */
export const SEMANTIC = {
  ink:      "#131C25",
  ink2:     "#3E4C5A",
  dim:      "#78899A",
  paper:    "#FFFFFF",
  ground:   "#EDF0F3",
  rule:     "#D3DBE1",
  red:      "#B23A54",
  redSoft:  "#FDF6F7",
  amber:    "#FFF6E0",
  amberLine:"#E8C877",
  green:    "#0E8577",
  info:     "#2A6183",
};

/** The variables every tool reads. Applied once on the shell, so a component
 *  never has to know which role is signed in. */
export function themeVars(role) {
  const t = ROLE_THEME[role] ?? ROLE_THEME.admin;
  return {
    "--brand": t.ink,
    "--brand-hover": t.inkHover,
    "--brand-tint": t.tint,
    "--brand-line": t.line,
    "--accent-gold": t.accent,
    "--ink": SEMANTIC.ink,
    "--ink2": SEMANTIC.ink2,
    "--dim": SEMANTIC.dim,
    "--paper": SEMANTIC.paper,
    "--ground": SEMANTIC.ground,
    "--rule": SEMANTIC.rule,
    "--red": SEMANTIC.red,
    "--amber": SEMANTIC.amber,
    "--amberline": SEMANTIC.amberLine,
    "--green": SEMANTIC.green,
    "--accent": t.ink,
  };
}

export function applyTheme(role, element = document.documentElement) {
  const vars = themeVars(role);
  for (const [k, v] of Object.entries(vars)) element.style.setProperty(k, v);
  element.setAttribute("data-role", role ?? "admin");
}

export const roleLabel = (role, locale = "en") =>
  locale === "zh" ? (ROLE_THEME[role]?.label_zh ?? role)
                  : (ROLE_THEME[role]?.label ?? role);

export const roleColor = (role) => ROLE_THEME[role]?.ink ?? SEMANTIC.ink;

/* ---------- The mark ----------
   Drawn rather than loaded, so the header does not depend on a file being
   in the right place and does not flash while it fetches. */

export function MizarMark({ size = 26, color }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <circle cx="50" cy="50" r="38" fill={color ?? "currentColor"} />
      {/* The brushed ring, which is what makes the mark recognisable at
          small sizes rather than a plain disc. */}
      <path d="M50 6 A44 44 0 1 1 49 6" fill="none" stroke={color ?? "currentColor"}
            strokeWidth="3" strokeLinecap="round" opacity="0.55" />
      <path d="M26 66 L34 34 L50 60 L66 34 L74 66" fill="none" stroke="#fff"
            strokeWidth="4.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export const BRAND_CSS = `
:root{
  --brand:${BRAND.navyDeep};
  --brand-hover:#0B1A30;
  --brand-tint:#EEF2F7;
  --brand-line:#C3CFDD;
  --accent-gold:${BRAND.gold};
  --ink:${SEMANTIC.ink};
  --ink2:${SEMANTIC.ink2};
  --dim:${SEMANTIC.dim};
  --paper:${SEMANTIC.paper};
  --ground:${SEMANTIC.ground};
  --rule:${SEMANTIC.rule};
  --red:${SEMANTIC.red};
  --amber:${SEMANTIC.amber};
  --amberline:${SEMANTIC.amberLine};
  --green:${SEMANTIC.green};
  --accent:var(--brand);
}

/* A hairline of the role colour along the top of every screen. Quiet enough
   to ignore, present enough that switching accounts is obvious. */
body::before{
  content:"";position:fixed;top:0;left:0;right:0;height:3px;
  background:linear-gradient(90deg,var(--brand) 0%,var(--brand) 72%,var(--accent-gold) 100%);
  z-index:200;pointer-events:none;
}

@media (prefers-reduced-motion:no-preference){
  body::before{transition:background .35s ease}
}
`;
