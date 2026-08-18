# worker

One backend, both front ends. Deployed to Cloudflare Workers.

```
web/     staff front end    → staff.your-domain
tenant/  tenant front end   → www.your-domain
worker/  this               → /api/* on both of those
```

The same Worker answers on both hostnames, so each site calls `/api` on its
own domain and nothing is cross-origin. No preflight, no `SameSite` problem,
no allowed-origins list to keep in step.

---

## Getting it running

```powershell
cd worker
npm install
npm run dev
```

`http://localhost:8787/api/health` should answer. That proves the Worker runs.

Then the database:

```powershell
npx wrangler hyperdrive create pointe-db --connection-string="postgres://..."
```

Put the id in `wrangler.jsonc`, load the schema, and check
`/api/db-health` returns 330 units.

Do not commit a `localConnectionString` containing a database password. Keep
local credentials in an untracked Wrangler override or use a remote binding
for local development.

**Hyperdrive is not optional.** A Worker has no long-lived process to hold a
connection pool in, so without it every request opens its own connection and
the database runs out of them long before the traffic justifies it.

### Workers AI

`wrangler.jsonc` contains a Workers AI binding named `AI` and uses the
multilingual `@cf/zai-org/glm-4.7-flash` model. There is no OpenAI key and no
Python service to keep running.

On an existing Supabase database, run `schema/019_workers_ai_cloud.sql` once.
Then deploy the Worker. `/api/ai-health` (staff session required) shows the
binding, model, Supabase audit storage, database answers, model calls and human
handoffs without calling the model or spending inference quota.

The public chat uses this order:

1. Query current Supabase pricing, vacancy, parking and fee rows.
2. Answer known questions directly from those rows, without AI usage.
3. Send only safe unmatched questions plus a narrow public data snapshot to
   Workers AI.
4. Create a real Confirmations item when facts are missing, the model fails,
   or the question involves eligibility, accommodation, legal matters or a
   private account.

Every outcome is recorded in `ai_chat_runs`; daily provider counts are stored
in `ai_usage_daily`. Sensitive handoffs store a withheld marker rather than the
visitor's message text.

---

## The boundary

```
/api/public/*    no session, anyone
/api/tenant/*    a tenant session
everything else  a staff session
```

Enforced in one middleware in `src/index.js`, and it **denies by default**. A
route added without thinking about auth ends up behind a staff session, which
is the safe direction to be wrong in. Listing what needs protecting instead
fails open the day somebody forgets a line.

Signing in lives under `/api/public/auth/login` because it is how a session is
obtained and so cannot require one — under the public prefix rather than as an
exception in the middleware, because an exception list is a thing that grows.

### A tenant route never takes a unit from the caller

`tenantUnit(c)` reads it from the session. There is no route that accepts one
as a parameter, and the middleware refuses a request that tries.

Reading it from the URL is how a tenant portal leaks: change a number, see
somebody else's lease. Taking the parameter away means the mistake cannot be
made rather than being caught when somebody remembers to check.

For the few routes that do take an id — a repair, a document — `mustBeTheirs()`
checks the row and throws **404** rather than 403. Telling somebody a record
exists but is not theirs confirms it exists, which is worth something to
whoever is trying numbers.

---

## What is here

| | |
|---|---|
| `src/index.js` | Routing, the boundary, sessions, permissions |
| `src/lib/db.js` | Postgres through Hyperdrive, transactions, row locks |
| `src/lib/crypto.js` | PBKDF2 password hashing, hashes, tokens |
| `src/lib/jobs.js` | Cron: rent run, renewals, outbox |
| `src/routes/auth.js` | Staff sign in, reset, password change, session |
| `src/routes/core.js` | Units, pricing, parking, legal service address |
| `src/routes/tenant.js` | Availability, slots, tenant auth, applications, repairs, ledger |
| `src/routes/signup.js` | Prospect signup, verification, staff invite, account-to-lease link |
| `src/routes/leases.js` | Lease creation and commencement |
| `src/routes/renewals.js` | Renewal workflow and tenant response |
| `src/routes/increases.js` | Alberta rent-increase eligibility and service |
| `src/routes/payments.js` | Tenant/manual payments, application and reversal |
| `src/routes/health.js` | Runtime, database, email and Workers AI health |
| `schema/` | Postgres schema and seed |

---

## Still to port

The remaining modules in `server-legacy/`. Recommended order:

```
1. workflow      staff maintenance, entry notices, documents, move-out
2. signing       agreement library, R2 files, signature ceremony
3. accounting    GL, AP, banking, period close, reports
4. CRM/admin     leads, schedules and remaining admin routes
```

**Every `db.prepare` becomes an awaited query.** There are 793 of them in
`server/`, and every function containing one becomes `async`. Mechanical, and
there is no shortcut — but it fails loudly rather than silently: a missing
`await` yields a Promise, and the first `.id` after it is `undefined`.

Keep `server-legacy/` until this is finished. During the port it is the only correct
reference for what a rule actually did, and reading the code is more reliable
than reading a memory of it.

---

## Two things that will not port

**Argon2 does not run here.** It is a native module and Workers has none —
this is not a configuration problem and there is no flag. `src/lib/crypto.js`
uses PBKDF2-SHA512 at 600,000 rounds, which is what OWASP recommends where
Argon2 is unavailable.

That is a real trade rather than an equivalent swap: PBKDF2 is weaker against
an attacker with GPUs. It is the right one here because the alternative is not
Argon2 — it is scrypt in JavaScript, which is slower for the user and no
stronger.

A hash made by the old container returns `PASSWORD_NEEDS_RESET` and says so
plainly, rather than failing as though the password were wrong. Somebody would
otherwise try the same password all afternoon.

**There is no disk.** Evidence photographs and approved agreements must go to
R2. On the container that was advisable; here `node:fs` does not exist.

---

## Cron

Triggers fire in UTC and Alberta observes daylight saving, so every job works
out the local date itself rather than trusting the hour it fired.

A rent run on the wrong side of midnight bills the wrong month, and it does it
without an error.
