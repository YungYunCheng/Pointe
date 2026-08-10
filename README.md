# Baydo Pointe

Leasing management for 370 / 374 / 378 Clareview Station Drive NW, Edmonton, AB —
330 units across three six-storey buildings.

---

## Layout

```
web/        Staff tools                              → Cloudflare Pages
tenant/     Public site and tenant portal, bilingual → Cloudflare Pages
worker/     Hono API, sessions, permissions, cron    → Cloudflare Workers
server-legacy/  Previous server kept as porting reference
docs/       ERD, schema, architecture notes
data/       Unit inventory spreadsheet
```

Two front ends, deliberately separate. The staff tools are internal and English
only; the tenant site is public, bilingual, and indexed. Keeping them apart means
a mistake in one cannot expose the other, and the public site can be cached hard
without touching the staff session.

---

## Running it

Install and build each package separately:

```bash
(cd worker && npm ci && npm run check && npm run check:sql)
(cd web && npm ci && npm run build)
(cd tenant && npm ci && npm run build)
```

Load `worker/schema/baydo_pointe_supabase_complete.sql` into a new Supabase
database, then replace the domain, Hyperdrive and KV placeholders in
`worker/wrangler.jsonc`. Deployment gaps and the staging checklist are in
[`docs/BACKEND-HARDENING-2026-08-10.zh-Hant.md`](docs/BACKEND-HARDENING-2026-08-10.zh-Hant.md).

---

## Seed accounts

| Email | Role |
|---|---|
| admin@themizar.ca | Admin |
| Other staff | Invite from Admin after first sign-in |

No seed password is stored. Use **Forgot password** for `admin@themizar.ca` to
set the first password through a one-time link, then invite every other staff
member so each person chooses their own password.

---

## Language

Staff tools are English. The tenant chat is bilingual and follows whichever
language the tenant writes in.

Three places keep Chinese on purpose. They are not oversights:

- **Hard-stop patterns** in `AiInbox.jsx`, `LeaseIntake.jsx` and `TenantChat.jsx`.
  Tenants write in both languages. A filter that only reads English would let a
  Chinese message about income source or a service animal through to an automatic
  reply, which is the single failure this system most needs to avoid.
- **The fee disclosure** in `LeaseIntake.jsx`, sent to tenants in both languages.
- **The notice of entry** in `BuildingManager.jsx`, generated in both.

Server responses carry a message code plus parameters rather than prose, so one
record reads correctly for whoever opens it. The dictionary is
`apps/tenant/src/i18n.js`.

---

## The tools

All under `web/src/tools/`.

| File | Purpose | Access |
|---|---|---|
| `AuthConsole.jsx` | Sign in, forgot password, reset | Everyone |
| `LeasingConsole.jsx` | Units, pricing, parking, accounts | Admin edits, others read |
| `LeadsCrm.jsx` | Leads, showing schedule, funnel | Building Manager |
| `Schedule.jsx` | Daily tasks, reminders, signing approval | PM and BM |
| `AiInbox.jsx` | Classifies tenant messages, drafts replies | Admin and PM |
| `LeaseIntake.jsx` | Intake, lease variables, signing lock | Property Manager |
| `Documents.jsx` | Template library, generation, approvals | Admin owns templates |
| `Operations.jsx` | Showing outcomes, move-out, deposits | PM, Admin can roll back |
| `BuildingManager.jsx` | Maintenance, entry notices, key handover | Building Manager |
| `AuditLog.jsx` | Change log, backup and restore | Admin only |
| `Accounting.jsx` | GL, AP, AR, rent runs, transaction search | Accounting; PM reads |
| `AccountingBanking.jsx` | Statement upload, reconciliation, period close | Accounting |
| `TenantChat.jsx` | Public chat widget | Prospective tenants |

---

## Why the server exists

Four things cannot work in a browser, and they are the reason `server/` is here:

**Permissions.** Every endpoint declares what it needs. Hiding a menu is not
access control — anyone with developer tools can change what the browser thinks
their role is.

**Audit.** Written at each mutation, append-only, with no update or delete path.
Front-end polling misses everything that happens while the page is closed.

**Signing locks.** One row per unit number, so two agents cannot start on the
same unit. First to sign wins.

**Parking concurrency.** The balance check and the write happen inside one
immediate transaction. Two simultaneous requests cannot both take the last stall.

Full API reference in [`server/README.md`](server/README.md).

---

## Three lines the AI does not cross

**It never decides whether to send.** It classifies and drafts; a hard-coded rule
decides. When something goes wrong you need to answer "why did this go out" with
a rule id someone can read, not with the model's judgement.

**It never writes clause text.** It fills variables in a template that counsel
has approved. A generated clause can be void or worse, and it reads convincingly
either way.

**It never states an amount.** Rent, deposits and fees are assembled by the
system and sent verbatim. In accounting this goes further: the monthly report
figures are computed in SQL from posted entries, and the model is given them
with an instruction not to recalculate. It writes the commentary, nothing else.

---

## Where things stand

[`docs/inventory-and-gaps.md`](docs/inventory-and-gaps.md) lists every function
that exists, every place the AI is used and what bounds it, and what is missing
in the order it should be built.

The short version: authentication, units, pricing, parking, lease lifecycle,
renewals, rent increases, core payments and tenant self-service now use the
Worker API. Several staff tools still need their legacy routes ported; see the
backend hardening report for the exact P0/P1 list.

---

## Before production

1. Run the complete SQL (or migration 011 on an existing database) and execute
   the staging checklist against real Supabase／Hyperdrive.
2. Replace Cloudflare placeholders and configure KV, R2, Resend and secrets.
3. Port staff workflow, signing/R2 and the rest of accounting before enabling
   the corresponding production menus.
4. Have Alberta counsel review the actual approved documents and notice flows.
5. Define and test data retention, backup restore and monitoring.

---

*Alberta has no RTB and no government rent-increase form — that is British
Columbia. Notices come from your own approved template.*
