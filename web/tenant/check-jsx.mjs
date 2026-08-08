#!/usr/bin/env node
/* ============================================================
   JSX tag pairing.

   Balanced brackets are not matched tags. An unclosed <Provider>
   looks fine to a bracket counter, and the failure it produces is
   not a syntax error — the component silently never wraps
   anything, every context read returns its fallback, and the app
   behaves as though nobody is signed in.

   That is what happened here: <TenantAuthProvider> was opened and
   never closed, so the navigation showed Apply to somebody with
   no account.

   Run:  npm run check:jsx
   ============================================================ */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = process.argv[2] ?? "src";
const problems = [];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.name.endsWith(".jsx")) out.push(path);
  }
  return out;
}

const files = walk(SRC).map((path) => ({ path, text: readFileSync(path, "utf8") }));

/* ---------- 6. JSX tags that never close ----------

   Brackets balancing is not the same as tags matching. An unclosed
   <Provider> leaves the file syntactically plausible to a bracket counter
   while the build fails or, worse, the component silently never wraps
   anything — and then a context read returns its fallback and everything
   downstream quietly behaves as though nobody is signed in.

   Only component tags, because HTML has void elements and this is not worth
   a parser. */
for (const { path, text } of files) {
  if (!path.endsWith(".jsx")) continue;

  const stack = [];
  /* Attributes can hold >, quotes and braces, and a self-closing tag can run
     across several lines. Matching lazily up to the first > gets the wrong
     one; this walks the attribute region properly, skipping anything inside
     quotes or braces. */
  const tagRe = /<(\/?)([A-Z][\w.]*)/g;

  for (const m of text.matchAll(tagRe)) {
    const [, closing, name] = m;

    // Walk to the closing > of this tag, ignoring anything in quotes or
    // braces. An attribute like onClick={() => a > b} contains a > that is
    // not the end of the tag.
    let i = m.index + m[0].length;
    let depth = 0, quote = null, selfClosing = false;
    while (i < text.length) {
      const ch = text[i];
      if (quote) { if (ch === quote) quote = null; }
      else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (depth === 0 && ch === ">") {
        selfClosing = text[i - 1] === "/";
        break;
      }
      i++;
    }
    if (selfClosing) continue;
    if (closing) {
      const open = stack.pop();
      if (open !== name) {
        const line = text.slice(0, m.index).split("\n").length;
        problems.push(`${path}:${line} — </${name}> closes ` +
          (open ? `<${open}>` : "nothing that is open") + ".");
        break;
      }
    } else {
      stack.push(name);
    }
  }

  if (stack.length)
    problems.push(`${path} — <${stack[stack.length - 1]}> is never closed.`);
}


if (problems.length) {
  console.error(`\n${problems.length} problem${problems.length === 1 ? "" : "s"}:\n`);
  for (const p of problems) console.error(`  \u2717 ${p}`);
  process.exit(1);
}
console.log(`\n  ${files.length} files, tags all match.\n`);
