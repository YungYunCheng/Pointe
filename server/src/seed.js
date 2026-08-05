import { db, uid, hashPassword } from "./db.js";
import { syncRbac } from "./rbac.js";
import { seedAccounting } from "./seed-accounting.js";
import { backfillNormalised } from "./screening.js";
import { seedAgreements } from "./seed-agreements.js";

const BUILDINGS = [
  ["370", "Baydo Pointe 370", "370 Clareview Station Drive NW, Edmonton, AB", 6, 118],
  ["374", "Baydo Pointe 374", "374 Clareview Station Drive NW, Edmonton, AB", 6, 94],
  ["378", "Baydo Pointe 378", "378 Clareview Station Drive NW, Edmonton, AB", 6, 118],
];

// code, label_en, label_zh, bedrooms, sqft, balcony, mirrored
const TYPES = [
  ["1C", "1 bed", "1房", 1, 462.8, 71, 0],
  ["1A", "1 bed", "1房", 1, 484.4, 71, 0],
  ["1A (M)", "1 bed", "1房", 1, 484.4, 71, 1],
  ["1B", "1 bed + den", "1房+書房", 1, 602.8, 71, 0],
  ["3A", "2 bed + den", "2房+書房", 3, 731.9, 71, 0],
  ["3A (M)", "2 bed + den", "2房+書房", 3, 731.9, 71, 1],
  ["2A", "2 bed 2 bath", "2房2衛", 2, 742.7, 71, 0],
  ["2A (M)", "2 bed 2 bath", "2房2衛", 2, 742.7, 71, 1],
];

const POOLS = [
  ["u370", "370", "Underground / Building 370", "地下 · 370棟", 52, 0, 0, 0, null],
  ["u374", "374", "Underground / Building 374", "地下 · 374棟", 62, 16, 0, 0,
   "Drawing labelling to be confirmed with the developer"],
  ["u378", "378", "Underground / Building 378", "地下 · 378棟", 52, 0, 0, 0, null],
  ["surface", null, "Surface / shared", "地面 · 全案共用", 56, 0, 6, 1, null],
];

// Per-floor unit layout taken from the marketing package floor plans.
const G374 = {101:"1A (M)",102:"1A",103:"2A",104:"2A (M)",105:"3A (M)",106:"3A",107:"2A",108:"2A (M)",109:"1A (M)",110:"1A",111:"2A (M)",112:"3A (M)",113:"3A",114:"2A"};
const T374 = {201:"1C",202:"1A (M)",203:"1A",204:"2A",205:"2A (M)",206:"3A (M)",207:"3A",208:"2A",209:"2A (M)",210:"1A (M)",211:"1A",212:"2A (M)",213:"2A (M)",214:"3A (M)",215:"3A",216:"2A"};
const G370 = {101:"1B",102:"1A",103:"1A (M)",104:"2A (M)",105:"2A",106:"1A (M)",107:"1A",108:"2A (M)",109:"3A (M)",110:"3A",111:"2A",112:"1A (M)",113:"1A",114:"2A (M)",115:"2A",116:"1A (M)",117:"1A",118:"2A (M)"};
const T370 = {201:"1C",202:"1A",203:"1A (M)",204:"2A (M)",205:"2A",206:"1A (M)",207:"1A",208:"2A (M)",209:"3A (M)",210:"3A",211:"2A",212:"1A (M)",213:"1A",214:"2A (M)",215:"2A",216:"1A (M)",217:"1A",218:"2A (M)",219:"3A (M)",220:"3A"};

const USERS = [
  ["admin@themizar.ca", "Admin", "admin", "Mizar@2026!", "en"],
  ["bowen.wang@themizar.ca", "Bowen Wang", "property_manager", "Agent@2026!", "zh-Hant"],
  ["rentals@themizar.ca", "Rentals", "building_manager", "Rentals@2026!", "en"],
];

// Alberta general holidays. Heritage Day is optional here, so it ships unobserved.
const HOLIDAYS = [
  ["2026-09-07", "Labour Day", "勞動節", 1],
  ["2026-10-12", "Thanksgiving", "感恩節", 1],
  ["2026-11-11", "Remembrance Day", "國殤日", 1],
  ["2026-12-25", "Christmas Day", "聖誕節", 1],
  ["2027-01-01", "New Year's Day", "元旦", 1],
  ["2026-08-03", "Heritage Day (optional in Alberta)", "Heritage Day（Alberta 選擇性假日）", 0],
];

export function ensureSeed() {
  syncRbac();
  seedAccounting();
  seedAgreements();
  // Contacts created before duplicate detection existed have no normalised
  // columns, and the checks scan those rather than the raw strings.
  const filled = backfillNormalised();
  if (filled) console.log(`[seed] normalised ${filled} contact(s)`);

  const insB = db.prepare(`INSERT OR IGNORE INTO buildings (id, code, name, address, storeys, unit_count)
                           VALUES (?,?,?,?,?,?)`);
  for (const b of BUILDINGS) insB.run(uid("bd_"), ...b);

  const insT = db.prepare(`INSERT OR IGNORE INTO unit_types (id, code, bedroom_label_en,
    bedroom_label_zh, bedrooms, area_sqft, balcony_sqft, is_mirrored) VALUES (?,?,?,?,?,?,?,?)`);
  for (const t of TYPES) insT.run(uid("ut_"), ...t);

  const insP = db.prepare(`INSERT OR IGNORE INTO parking_pools (id, code, building_code,
    label_en, label_zh, total_stalls, tandem_stalls, accessible_stalls, is_surface, note)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  for (const [code, bldg, en, zh, total, tandem, acc, surf, note] of POOLS)
    insP.run(uid("pp_"), code, bldg, en, zh, total, tandem, acc, surf, note);

  const insH = db.prepare(`INSERT OR IGNORE INTO holidays (holiday_date, name_en, name_zh, is_observed)
                           VALUES (?,?,?,?)`);
  for (const h of HOLIDAYS) insH.run(...h);

  // 330 units across the three buildings
  if (db.prepare("SELECT COUNT(*) n FROM units").get().n === 0) {
    const insU = db.prepare(`INSERT INTO units (id, building_code, unit_type_code, unit_number, floor)
                             VALUES (?,?,?,?,?)`);
    db.transaction(() => {
      for (const bldg of ["370", "374", "378"]) {
        const g = bldg === "374" ? G374 : G370;
        const t = bldg === "374" ? T374 : T370;
        for (const n of Object.keys(g).map(Number).sort((a, b) => a - b))
          insU.run(uid("un_"), bldg, g[n], `${bldg}-${n}`, 1);
        for (let f = 2; f <= 6; f++)
          for (const n of Object.keys(t).map(Number).sort((a, b) => a - b))
            insU.run(uid("un_"), bldg, t[n], `${bldg}-${f * 100 + (n % 100)}`, f);
      }
    })();
    console.log(`[seed] created ${db.prepare("SELECT COUNT(*) n FROM units").get().n} units`);
  }

  // Accounts: add any that are missing, leave existing ones alone
  const insUser = db.prepare(`INSERT INTO users (id, email, full_name, role_code, locale,
    password_algo, password_salt, password_hash) VALUES (?,?,?,?,?,?,?,?)`);
  for (const [email, name, role, pw, locale] of USERS) {
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) continue;
    const h = hashPassword(pw);
    insUser.run(uid("usr_"), email, name, role, locale, h.algo, h.salt, h.hash);
    console.log(`[seed] created account ${email} (${role})`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ensureSeed();
  console.log("[seed] done");
}
