import { db, uid, nowISO } from "./db.js";

/* ============================================================
   Application screening

   An email or a phone that is already on file is a hard stop: the
   same person cannot apply twice under the same contact details.

   A resemblance is not a hard stop, and this is deliberate. Two
   people with the same common surname are two people. Refusing one
   of them automatically would fall unevenly across communities where
   a handful of surnames are shared by thousands of families, and
   under the Alberta Human Rights Act that pattern is a problem
   whatever the intention behind the rule.

   So a close match is flagged and a person decides. The flag records
   what matched and by how much, so the decision is made on the facts
   rather than on a score nobody can see.
   ============================================================ */

const SIMILARITY_FLAG = 0.70;   // flags for review; never rejects on its own

export const normEmail = (s) => {
  const e = String(s ?? "").trim().toLowerCase();
  if (!e.includes("@")) return e;
  const [local, domain] = e.split("@");
  // Gmail ignores dots and anything after a plus, so a.b+baydo@gmail.com and
  // ab@gmail.com are one mailbox. Treating them as two lets one person apply
  // repeatedly with what looks like different addresses.
  if (/^(gmail|googlemail)\.com$/.test(domain))
    return `${local.split("+")[0].replace(/\./g, "")}@gmail.com`;
  return `${local.split("+")[0]}@${domain}`;
};

export const normPhone = (s) => {
  const d = String(s ?? "").replace(/\D/g, "");
  // North American numbers are ten digits; a leading 1 is the country code.
  if (d.length === 11 && d.startsWith("1")) return d.slice(1);
  return d;
};

const normName = (s) => String(s ?? "").trim().toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ");

/** Levenshtein, normalised to 0–1. Good enough for "Wei-Lun Chen" against
 *  "Weilun Chen" and honest about "Chen" against "Chan". */
function similarity(a, b) {
  const s = normName(a), t = normName(b);
  if (!s || !t) return 0;
  if (s === t) return 1;
  const m = s.length, n = t.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
                        prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

/** Word overlap, so a reordered name still scores. "Chen Wei-Lun" and
 *  "Wei-Lun Chen" are the same person written two ways. */
function tokenOverlap(a, b) {
  const s = new Set(normName(a).split(" ").filter(Boolean));
  const t = new Set(normName(b).split(" ").filter(Boolean));
  if (!s.size || !t.size) return 0;
  let hit = 0;
  for (const x of s) if (t.has(x)) hit++;
  return hit / Math.max(s.size, t.size);
}

export function nameSimilarity(a, b) {
  return Math.max(similarity(a, b), tokenOverlap(a, b));
}

/**
 * Checks an application against everyone already on file.
 *
 *   duplicate — an exact email or phone match. Refused.
 *   review    — a close resemblance. Flagged for a person to decide.
 *   clear     — nothing matched.
 */
export function screen({ email, phone, full_name, applicationId, excludeContactId }) {
  const e = normEmail(email);
  const p = normPhone(phone);

  if (e) {
    const hit = db.prepare(`SELECT id, full_name, email, phone, created_at FROM contacts
      WHERE normalised_email = ? ${excludeContactId ? "AND id <> ?" : ""} LIMIT 1`)
      .get(...(excludeContactId ? [e, excludeContactId] : [e]));
    if (hit) return {
      result: "duplicate", matched_type: "email", matched_id: hit.id, similarity: 1,
      detail: `This email is already on file for ${hit.full_name}, added ${String(hit.created_at).slice(0, 10)}.`,
      match: hit,
    };
  }

  if (p && p.length >= 10) {
    const hit = db.prepare(`SELECT id, full_name, email, phone, created_at FROM contacts
      WHERE normalised_phone = ? ${excludeContactId ? "AND id <> ?" : ""} LIMIT 1`)
      .get(...(excludeContactId ? [p, excludeContactId] : [p]));
    if (hit) return {
      result: "duplicate", matched_type: "phone", matched_id: hit.id, similarity: 1,
      detail: `This phone number is already on file for ${hit.full_name}.`,
      match: hit,
    };
  }

  // Resemblance. A name alone is never enough — a shared surname is common
  // and means nothing on its own. It counts only alongside a partial match
  // on a contact detail.
  if (full_name) {
    const candidates = db.prepare(`SELECT id, full_name, email, phone, normalised_email,
      normalised_phone, created_at FROM contacts WHERE full_name IS NOT NULL LIMIT 2000`).all();
    let best = null;
    for (const c of candidates) {
      if (excludeContactId && c.id === excludeContactId) continue;
      const nameScore = nameSimilarity(full_name, c.full_name);
      if (nameScore < SIMILARITY_FLAG) continue;

      const emailScore = e && c.normalised_email ? similarity(e, c.normalised_email) : 0;
      const phoneScore = p && c.normalised_phone
        ? (p.slice(-7) === String(c.normalised_phone).slice(-7) ? 0.9
           : similarity(p, c.normalised_phone)) : 0;
      const contactScore = Math.max(emailScore, phoneScore);
      if (contactScore < 0.5) continue;      // name alone does not flag

      const combined = nameScore * 0.5 + contactScore * 0.5;
      if (!best || combined > best.similarity)
        best = { result: "review", matched_type: "similarity", matched_id: c.id,
                 similarity: Number(combined.toFixed(3)),
                 detail: `Resembles ${c.full_name} (${c.email ?? c.phone ?? "no contact on file"}): name ${(nameScore * 100).toFixed(0)}% alike, contact details ${(contactScore * 100).toFixed(0)}% alike.`,
                 match: c };
    }
    if (best) return best;
  }

  return { result: "clear", matched_type: null, matched_id: null, similarity: 0, detail: null };
}

export function recordScreen(applicationId, input, outcome) {
  const id = uid("scr_");
  db.prepare(`INSERT INTO application_screens (id, application_id, email, phone, full_name,
    result, matched_type, matched_id, similarity, detail) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, applicationId, normEmail(input.email), normPhone(input.phone),
         input.full_name ?? null, outcome.result, outcome.matched_type,
         outcome.matched_id, outcome.similarity, outcome.detail);
  return id;
}

/** Keeps the normalised columns in step. Without them the checks above scan
 *  raw strings and miss the variants they exist to catch. */
export function upsertContact({ id, full_name, email, phone, locale }) {
  const e = normEmail(email), p = normPhone(phone);
  const cid = id ?? uid("ct_");
  db.prepare(`INSERT INTO contacts (id, full_name, email, phone, locale,
    normalised_email, normalised_phone) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET full_name=excluded.full_name, email=excluded.email,
    phone=excluded.phone, normalised_email=excluded.normalised_email,
    normalised_phone=excluded.normalised_phone`)
    .run(cid, full_name ?? null, email ?? null, phone ?? null, locale ?? "en", e || null, p || null);
  return cid;
}

/** One-off backfill for contacts created before normalisation existed. */
export function backfillNormalised() {
  const rows = db.prepare(`SELECT id, email, phone FROM contacts
    WHERE normalised_email IS NULL OR normalised_phone IS NULL`).all();
  const up = db.prepare("UPDATE contacts SET normalised_email=?, normalised_phone=? WHERE id=?");
  const run = db.transaction(() => {
    for (const r of rows) up.run(normEmail(r.email) || null, normPhone(r.phone) || null, r.id);
  });
  run();
  return rows.length;
}
