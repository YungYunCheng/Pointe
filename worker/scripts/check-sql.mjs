#!/usr/bin/env node
/* ============================================================
   Schema checks.

   Every one of these caught a real bug in this file, and each was
   invisible until Postgres refused it three thousand lines in —
   at which point the error names a symptom somewhere else
   entirely.

   Run:  npm run check:sql
   ============================================================ */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = "schema";
const sql = readdirSync(dir)
  .filter((f) => /^\d\d\d_.*\.sql$/.test(f))
  .sort()
  .map((f) => readFileSync(join(dir, f), "utf8"))
  .join("\n");

const problems = [];

/* Splitting a column list on commas has to respect brackets, or a
   NUMERIC(14,2) becomes two columns and everything after it shifts. */
function splitColumns(body) {
  /* Both comment styles. Block comments contain commas and brackets, and a
     column list split without removing them first loses whatever follows —
     which then reads as a missing column rather than as a parsing failure. */
  const clean = body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "");
  const out = [];
  let depth = 0, cur = "";
  for (const ch of clean) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/* ---------- The tables ---------- */

const tables = new Map();
for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\);/g)) {
  const cols = new Map();
  for (const part of splitColumns(m[2])) {
    /* A column definition can wrap: a type on one line and its CHECK on the
       next. Collapsing whitespace first means the name and type are still
       adjacent, which they are not if the match is anchored to a line. */
    const flat = part.replace(/\s+/g, " ").trim();
    const cm = flat.match(/^(\w+) ([A-Z][\w]*(?:\([\d,\s]*\))?)/);
    if (!cm) continue;
    if (["PRIMARY", "UNIQUE", "CHECK", "FOREIGN", "CONSTRAINT"].includes(cm[1].toUpperCase()))
      continue;
    cols.set(cm[1], cm[2].toUpperCase());
  }
  tables.set(m[1], cols);
}

for (const m of sql.matchAll(/ALTER TABLE (\w+)([\s\S]*?);/g)) {
  const t = tables.get(m[1]);
  if (!t) continue;
  for (const c of m[2].matchAll(/ADD COLUMN IF NOT EXISTS (\w+)\s+([A-Z][\w]*(?:\([\d,\s]*\))?)/g))
    t.set(c[1], c[2].toUpperCase());
}

/* ---------- 1. A type with a name fragment welded to it ----------

   BOOLEANis_active. A regex ate the column-name prefix into the type, and
   every column it touched failed at CREATE TABLE — but the error a person
   saw was about a missing column three thousand lines later. */
for (const m of sql.matchAll(/\b(BOOLEAN|NUMERIC|TIMESTAMPTZ|INTEGER|TEXT|DATE)([a-z_]+)/g))
  problems.push(`Type has a name fragment on it: ${m[0]}`);

/* ---------- 2. INSERT columns the table does not have ---------- */
for (const m of sql.matchAll(/INSERT INTO (\w+)\s*\(([^)]+)\)/g)) {
  const cols = tables.get(m[1]);
  if (!cols) continue;
  for (const c of m[2].split(",").map((x) => x.trim()))
    if (c && !cols.has(c))
      problems.push(`INSERT INTO ${m[1]} names "${c}", which the table does not have.`);
}

/* ---------- 3. TRUE or FALSE going into an INTEGER ----------

   The one that stopped the paste. A boolean column left as INTEGER takes
   0 and 1 happily and refuses TRUE, and the message names the column rather
   than the conversion that missed it. */
for (const m of sql.matchAll(/INSERT INTO (\w+)\s*\(([^)]+)\)\s*VALUES([\s\S]*?);/g)) {
  const cols = tables.get(m[1]);
  if (!cols) continue;
  const names = m[2].split(",").map((x) => x.trim());

  for (const row of m[3].matchAll(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
    const values = splitColumns(row[1]).map((v) => v.trim());
    if (values.length !== names.length) continue;
    names.forEach((name, i) => {
      const type = cols.get(name);
      const value = values[i];
      if (!type || !value) return;
      if (/^(TRUE|FALSE)$/i.test(value) && type.startsWith("INTEGER"))
        problems.push(`${m[1]}.${name} is INTEGER but is given ${value}.`);
      if (/^(TRUE|FALSE)$/i.test(value) === false && /^[01]$/.test(value)
          && type.startsWith("BOOLEAN"))
        problems.push(`${m[1]}.${name} is BOOLEAN but is given ${value}.`);
    });
  }
}

/* ---------- 4. A boolean-looking column left as INTEGER ----------

   Not an error on its own — is_active as INTEGER is valid SQL. But
   `WHERE is_active` fails against it, and that fails at the first query
   rather than at the paste. */
const BOOLISH = /^(is_|has_|must_|allow_|can_|reaches_|moves_|wants_|do_not_)/;
const COUNTERS = /^(charge_day|due_day|seq|sign_order|sort_order|attempts|failed_attempts|reminder_count|occupants|storeys|unit_count|bedrooms|total_stalls|tandem_stalls|accessible_stalls|max_per_unit|duration_min)$/;
for (const [table, cols] of tables)
  for (const [name, type] of cols)
    if (BOOLISH.test(name) && !COUNTERS.test(name) && type.startsWith("INTEGER"))
      problems.push(`${table}.${name} looks like a boolean but is INTEGER. ` +
        `\`WHERE ${name}\` will fail.`);

/* ---------- 5. A type whose extension is never created ----------

   CITEXT without CREATE EXTENSION citext fails at the first table that uses
   it, and the message names the column rather than the missing extension.
   Worse after a schema reset: dropping public removes the extension but
   leaves its row in pg_extension, so IF NOT EXISTS does nothing while the
   type is genuinely gone. */
const EXTENSION_TYPES = { CITEXT: "citext", HSTORE: "hstore", VECTOR: "vector" };
for (const [type, ext] of Object.entries(EXTENSION_TYPES)) {
  const used = new RegExp(`\\b${type}\\b`).test(sql);
  // With or without IF NOT EXISTS, and with or without a WITH SCHEMA clause.
  const created = new RegExp(`CREATE EXTENSION\\b[^;]*\\b${ext}\\b`, "i").test(sql);
  if (used && !created)
    problems.push(`${type} is used but the ${ext} extension is never created.`);
}

/* ---------- 6. Foreign keys ---------- */
const defined = new Set();
for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\);/g)) {
  for (const ref of m[2].matchAll(/REFERENCES\s+(\w+)\s*\((\w+)\)/g)) {
    if (ref[1] !== m[1] && !defined.has(ref[1]))
      problems.push(`${m[1]} references ${ref[1]}, which is created later.`);
    const target = tables.get(ref[1]);
    if (target && !target.has(ref[2]))
      problems.push(`${m[1]} references ${ref[1]}(${ref[2]}), which does not exist.`);
  }
  defined.add(m[1]);
}

/* ---------- 6. Types that need an extension ----------

   citext was declared in the original schema and my merge stripped every
   CREATE EXTENSION line while only adding pgcrypto back. The failure lands on
   the first column that uses it, which is line 113 of a four-thousand-line
   file — and says nothing about the line that was removed. */
const extensions = new Set(
  [...sql.matchAll(/CREATE EXTENSION IF NOT EXISTS (\w+)/g)].map((m) => m[1].toLowerCase()));

const NEEDS_EXTENSION = {
  citext: "citext",
  hstore: "hstore",
  vector: "vector",
  ltree: "ltree",
};

for (const [type, ext] of Object.entries(NEEDS_EXTENSION)) {
  const used = new RegExp(`\\b\\w+\\s+${type}\\b`, "i").test(sql);
  if (used && !extensions.has(ext))
    problems.push(`Columns use ${type.toUpperCase()} but the ${ext} extension is never created.`);
}

const FUNCTION_EXTENSION = {
  gen_random_uuid: "pgcrypto",
  uuid_generate_v4: "uuid-ossp",
  crypt: "pgcrypto",
  gen_salt: "pgcrypto",
};

for (const [fn, ext] of Object.entries(FUNCTION_EXTENSION))
  if (new RegExp(`\\b${fn}\\s*\\(`).test(sql) && !extensions.has(ext))
    problems.push(`${fn}() is used but the ${ext} extension is never created.`);

/* ---------- 7. Route INSERTs against the migrated schema ----------

   The original checker only read migration SQL. That let a route insert
   notifications(role_code, payload) while the real table called those
   columns audience and params. JavaScript parsed, the schema parsed, and the
   first live request failed. Check literal INSERT column lists in Worker
   source as well. */
function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path)
      : entry.isFile() && entry.name.endsWith(".js") ? [path] : [];
  });
}

for (const file of sourceFiles("src")) {
  const source = readFileSync(file, "utf8");
  for (const m of source.matchAll(/INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)/gi)) {
    const cols = tables.get(m[1]);
    if (!cols) continue;
    for (const c of m[2].split(",").map((x) => x.trim()))
      if (/^\w+$/.test(c) && !cols.has(c))
        problems.push(`${file}: INSERT INTO ${m[1]} names "${c}", which the table does not have.`);
  }
}

/* ---------- Report ---------- */

const unique = [...new Set(problems)];
if (unique.length) {
  console.error(`\n${unique.length} problem${unique.length === 1 ? "" : "s"}:\n`);
  for (const p of unique) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(`\n  ${tables.size} tables, nothing to report.\n`);
