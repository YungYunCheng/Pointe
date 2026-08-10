#!/usr/bin/env node
/* ============================================================
   Checks that catch a class of mistake, not an instance.

   Every one of these was a real bug in this codebase. Fixing the
   instance and moving on means it comes back the next time
   somebody adds a route, which is why they are here rather than
   in a commit message.

   Run:  npm run check
   ============================================================ */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = "src";
const problems = [];
const warnings = [];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.name.endsWith(".js")) out.push(path);
  }
  return out;
}

const files = walk(SRC).map((path) => ({ path, text: readFileSync(path, "utf8") }));

/* ---------- 1. Multiple writes outside a transaction ----------

   Two writes that belong to one act must not be able to half-happen. A
   session created while the failed-attempt counter still says four locks out
   somebody who just signed in; a withdrawal with no event recorded is a
   notice that stopped applying with nothing to say who stopped it.

   This is the check that would have caught both. */
for (const { path, text } of files) {
  const handlers = [...text.matchAll(/r\.(get|post|patch|delete)\("([^"]+)"[^{]*\{/g)];
  for (const h of handlers) {
    const start = h.index + h[0].length;
    // The handler runs to the next route or the end of the file. Crude, and
    // it has never mattered: routes do not nest.
    const next = text.indexOf('\nr.', start);
    const body = text.slice(start, next > 0 ? next : text.length);

    const writes = (body.match(/await\s+(sql|tx)`\s*\n?\s*(INSERT|UPDATE|DELETE)/gi) ?? []).length;
    const hasTxn = body.includes(".begin(");

    if (writes >= 2 && !hasTxn)
      problems.push(`${path} · ${h[2]} — ${writes} writes and no transaction. ` +
        `If the second fails, the first stays.`);
  }
}

/* ---------- 2. Tables the schema does not have ----------

   The deposit statement queried `deposits`. The table is `deposit_ledger`, so
   the whole screen failed the first time a tenant opened it — and nothing
   caught it, because a query naming a table that does not exist is perfectly
   valid JavaScript. */
const schema = readdirSync("schema")
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(join("schema", f), "utf8"))
  .join("\n");

const known = new Set([
  ...[...schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]),
  ...[...schema.matchAll(/CREATE OR REPLACE VIEW (\w+)/g)].map((m) => m[1]),
  "information_schema",
]);

for (const { path, text } of files) {
  const referenced = [...text.matchAll(/(?:FROM|INTO|UPDATE|JOIN)\s+(\w+)/g)]
    .map((m) => m[1])
    .filter((t) => /^[a-z][a-z0-9_]*$/.test(t));

  for (const t of new Set(referenced))
    if (!known.has(t))
      problems.push(`${path} — queries "${t}", which is not in the schema.`);
}

/* ---------- 3. Tenant routes taking a unit from the caller ----------

   Reading the suite from the request is how a tenant portal leaks: change a
   number in the URL, see somebody else's tenancy. It has to come from the
   session, and this refuses the shape rather than trusting a review to spot
   it. */
for (const { path, text } of files) {
  if (!path.includes("tenant")) continue;
  const tenantRoutes = [...text.matchAll(/r\.\w+\("(\/tenant\/[^"]*)"/g)];
  for (const m of tenantRoutes)
    if (m[1].includes(":unit") || m[1].includes(":unit_number"))
      problems.push(`${path} · ${m[1]} — takes a unit from the URL. ` +
        `It must come from the session.`);
}

/* ---------- 4. Legal figures written inline ----------

   365 and 90 decide whether a notice is valid. Typed into a query they are
   invisible, and the day one of them changes somebody has to find every copy. */
const LEGAL = [
  [/INTERVAL '365 days'/g, "365 days"],
  [/INTERVAL '90 days'/g, "90 days"],
  [/\+\s*365\b/g, "365 days"],
];

/* Not every 365 is legal. A year of fee history is a reporting window, and
   flagging it teaches people to ignore the check — which is worse than not
   having it. */
const NOT_LEGAL_CONTEXT = /(fee|report|history|stat|summar|chart|trend|last_year)/i;

for (const { path, text } of files) {
  if (path.includes("rules.js")) continue;
  for (const [re, label] of LEGAL) {
    for (const m of text.matchAll(re)) {
      const line = text.slice(text.lastIndexOf("\n", m.index) + 1,
                              text.indexOf("\n", m.index));
      const context = text.slice(Math.max(0, m.index - 300), m.index + 100);
      if (NOT_LEGAL_CONTEXT.test(context)) continue;
      warnings.push(`${path} — ${label} inline: ${line.trim().slice(0, 60)}. ` +
        `The named constants are in lib/rules.js.`);
    }
  }
}

/* ---------- 5. Money as a JavaScript number in a query ----------

   Floating point cannot hold $0.10. Anything arithmetic on money should go
   through cents() before it reaches the database. */
for (const { path, text } of files) {
  const raw = [...text.matchAll(/amount\s*=\s*\$\{([^}]*[+\-*/][^}]*)\}/g)];
  for (const m of raw)
    if (!m[1].includes("cents("))
      warnings.push(`${path} — arithmetic on an amount without cents(): ${m[1].trim()}`);
}

/* ---------- Report ---------- */

if (problems.length) {
  console.error(`\n${problems.length} problem${problems.length === 1 ? "" : "s"}:\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
}
if (warnings.length) {
  console.warn(`\n${warnings.length} warning${warnings.length === 1 ? "" : "s"}:\n`);
  for (const w of warnings) console.warn(`  ! ${w}`);
}
if (!problems.length && !warnings.length)
  console.log("\n  Nothing to report.\n");

process.exit(problems.length ? 1 : 0);

