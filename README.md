# Baydo Pointe

Leasing management for 370 / 374 / 378 Clareview Station Drive NW, Edmonton, AB —
330 units across three six-storey buildings.

---

## Layout

```
apps/
  staff/src/tools/     Ten internal tools, English only
  tenant/src/          Public chat widget, bilingual
server/                Node + SQLite API
docs/                  ERD, Postgres schema, architecture notes
data/                  Unit inventory spreadsheet
```

---

## Running it

**Server**

```bash
cd server
npm install
npm run seed          # creates 330 units, 8 unit types, 4 parking areas, 3 accounts
npm start             # http://localhost:4000
```

**Front end**

The files under `apps/` are self-contained React components. Drop one into a Vite
or Next project and render it, or open it in a React sandbox. Each holds its own
styles, so nothing else is needed to see it working.

Point them at the API by replacing the `window.storage` calls with `fetch`. Until
then they run entirely in the browser, which is fine for review and not fine for
anything else.

---

## Seed accounts

| Email | Role |
|---|---|
| admin@themizar.ca | Admin |
| bowen.wang@themizar.ca | Property Manager |
| rentals@themizar.ca | Building Manager |

The seed passwords were shared over chat and every account is flagged
`must_change_password`. **Rotate all three before this touches production**, and
keep them out of the repository.

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
system and sent verbatim.

---

## Before production

1. Lawyer-approved lease template and the rest of the document set. Nothing in
   `Documents.jsx` can produce a real document until these exist.
2. Confirm the Alberta figures: deposit cap, refund deadline, notice periods,
   entry notice lead time, the 365-day rule on increases. They are constants at
   the top of each file for exactly this reason.
3. Move Argon2id in place of scrypt for password hashing.
4. Postgres instead of SQLite. The schema in `docs/schema-postgres.sql` is
   already written; swap the immediate transaction for `SELECT ... FOR UPDATE`.
5. Evidence files to object storage rather than local disk.
6. Data retention. Alberta PIPA expects a defined period enforced by a job, not
   a sentence in a policy document.

---

*Alberta has no RTB and no government rent-increase form — that is British
Columbia. Notices come from your own approved template.*
