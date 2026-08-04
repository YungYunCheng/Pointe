# Baydo Pointe API

Runs on localhost. The same service deploys to the web unchanged, and a mobile app
can talk to the same endpoints.

Source, comments and API responses are English. The **client** owns language: every
error carries a machine code, so switching the UI to Chinese also translates anything
that came back from here.

---

## Why this layer exists

The ten browser prototypes had the right logic in the wrong place:

| Prototype approach | Why it cannot hold |
|---|---|
| Hide menus to enforce roles | DevTools changes the role, or calls the data directly |
| Poll and diff to build an audit trail | Everything that happens while the tab is closed is lost |
| Keep the signing lock in a variable | Two browsers cannot see each other |
| Read the count, then write the stall | Two simultaneous requests both pass the check |

None of that is fixable in the browser.

---

## Running it

Node 20 or newer.

```bash
cd baydo-server
npm install
npm run seed      # 3 buildings, 330 suites, 8 unit types, 4 parking pools, 3 accounts
npm start         # http://localhost:4000
```

`npm run dev` restarts on save. `npm run reset` wipes the database and re-seeds.

Seed accounts — **rotate all three before go-live; every password appeared in chat:**

| Email | Role |
|---|---|
| admin@themizar.ca | Admin |
| bowen.wang@themizar.ca | Property Manager |
| rentals@themizar.ca | Building Manager |

---

## Permission matrix

Defined in `src/rbac.js`. Every route declares what it needs; anything undeclared is denied.

| Capability | Admin | PM | BM |
|---|:--:|:--:|:--:|
| Pricing, parking quotas, template approval, accounts, audit, restore, delete workflows | ✓ | | |
| Units, vacancies, resulting rents, parking allocation, schedule, browse leads, upload evidence | ✓ | ✓ | ✓ |
| AI inbox, signing and unit locks, document approval, move-out, renewals | ✓ | ✓ | |
| Leads and showing calendar, showing outcomes, maintenance, entry notices, key handover | ✓ | | ✓ |

Admin holds every permission. To change the model, edit `ROLE_PERMISSIONS`; `syncRbac()`
pushes it into the database on the next start.

---

## The four mechanisms that needed a server

**Parking cannot be over-allocated.** `POST /api/parking/request` runs inside an
`IMMEDIATE` transaction: re-read the count, decide, write, all in one. A second
concurrent request waits for the first to commit, so it sees the real number.
On Postgres, replace `txn()` with `SELECT ... FOR UPDATE`.

**Signing is first-come-first-served.** `unit_locks` uses `unit_number` as its primary
key, so only one live lock can exist per suite. The second person gets `409
LOCK_HELD_BY_OTHER` along with the holder's name and start time. Locks expire after two
hours and are released on submit.

**Audit is written at the point of change**, not polled. Password hashes and tokens are
stored as `***`. There is no update or delete route on `audit_log` — not even for Admin.
An audit trail that can be edited proves nothing.

**Backups run hourly, but only if something changed.** Before copying, a
`wal_checkpoint(TRUNCATE)` folds the WAL back into the main file, otherwise the copy
misses the newest writes. The last 48 are kept.

Restore is two-phase on purpose: snapshot the current state, write a `RESTORE_PENDING`
flag, then ask for a restart. Overwriting the database file with connections open would
leave in-flight transactions undefined.

---

## Endpoints

### Auth
```
POST   /api/auth/login              { email, password } -> { token, user }
GET    /api/auth/me
POST   /api/auth/logout
POST   /api/auth/forgot             { email }        returns dev_token outside production
POST   /api/auth/reset              { token, password }
POST   /api/auth/change-password    { current, password }
```
A failed login does not distinguish "no such account" from "wrong password". Five
failures locks the account for fifteen minutes. Resetting a password revokes every
existing session for that user.

### Units and pricing
```
GET    /api/units
PATCH  /api/units/:unitNumber/status
GET    /api/pricing                       readable by all roles
POST   /api/pricing                       Admin. Opens a new version, never overwrites
```

### Parking
```
GET    /api/parking
PATCH  /api/parking/pools/:code           Admin. Rejected if below the assigned count
POST   /api/parking/request               -> assigned or waiting
POST   /api/parking/:id/release           promotes the earliest waiting request
```

### Signing locks
```
GET    /api/locks/:unitNumber
POST   /api/locks/:unitNumber             409 returns holder and since
DELETE /api/locks/:unitNumber
```

### Move-out
```
POST   /api/moveouts                      validates the notice period, notifies PM/Admin/BM
GET    /api/moveouts
POST   /api/moveouts/:id/steps/:step
POST   /api/moveouts/:id/vacate           releases parking and the unit, sets turnover
POST   /api/moveouts/:id/deductions
POST   /api/moveouts/:id/deductions/notify
PATCH  /api/deductions/:id                upholding requires a basis and evidence
```

### Evidence
```
POST   /api/evidence                      multipart, up to 10 files x 25 MB
GET    /api/evidence/:entityType/:entityId
GET    /api/evidence/file/:id
```
Each file stores a SHA-256, uploader, upload time and an optional capture time.
**There is no delete endpoint.** Evidence that turns out to be wrong gets a note.

### Maintenance and entry notices
```
GET    /api/maintenance
POST   /api/maintenance
PATCH  /api/maintenance/:id               scheduling a vendor writes a calendar entry with blocking = 0
POST   /api/maintenance/:id/notes
GET    /api/entry-notices/pending         showings and vendor visits, flags short lead times
POST   /api/entry-notices
POST   /api/entry-notices/:id/send        under 24 hours returns 409; reschedule instead
```

### Renewals
```
GET    /api/renewals
PATCH  /api/renewals/:id                  renew_fixed | to_periodic | not_renew
POST   /api/renewals/:id/send
```
A task is raised 30 days before expiry and notified to PM and Admin. If the last
increase was under 365 days ago, `increase_ok` is 0 and sending is blocked.

### Admin
```
GET  /api/admin/users     POST /api/admin/users     PATCH /api/admin/users/:id
GET  /api/admin/audit
GET  /api/admin/backups   POST /api/admin/backups   POST /api/admin/backups/:id/restore
GET  /api/admin/permissions
```
Nobody can change their own role or disable themselves. Demoting or disabling an
account revokes its sessions immediately.

---

## Errors and localisation

Every error response carries a code:

```json
{ "code": "LOCK_HELD_BY_OTHER", "error": "Another user has already started signing this unit",
  "holder": "Bowen Wang", "since": "2026-07-31T14:02:11.000Z" }
```

The client looks up the code in its own dictionary. Never key off the message text —
it is a developer-facing fallback and may change.

The full list is in `src/errors.js`. Notifications work the same way: the database
stores a `title_key` plus JSON `params`, rendered client-side.

---

## Background jobs

| Job | Frequency | What it does |
|---|---|---|
| Backup | hourly | snapshot only if the audit log grew |
| Renewal scan | every 6 h | raise a task 30 days out, notify PM and Admin |
| Reminders | every 6 h | fire on the previous business day (Monday's go out Friday) |
| Refund deadlines | every 6 h | warn at 3 days out and after the deadline |

---

## Yardi

**Yardi is the system of record for money. This service tracks workflow state only.**

`leases.yardi_ref` is the join key. Rent, deposit balances and receipts should be read
from Yardi and displayed. Do not create a second editable copy here — if both sides can
write, they will disagree.

Add `src/yardi.js` with read-only functions when you wire it up.

---

## Jurisdiction notes

Defaults live as named constants at the top of `src/routes/workflow.js`:

```js
NOTICE_REQUIRED_DAYS  = { periodic: 30, fixed_12: 0, fixed_6: 0 }
REFUND_DEADLINE_DAYS  = 10
ENTRY_NOTICE_HOURS    = 24
RENEWAL_MIN_DAYS_BETWEEN_INCREASES = 365
```

Confirm each with your manager before go-live.

**Alberta has no RTB.** That is British Columbia, with prescribed forms such as RTB-7.
Alberta's dispute path is RTDRS, and there is **no government-issued rent increase
form** — notice must be written and properly served, with three months' notice for
periodic tenancies. Rent increase notices therefore come from your own approved
template; this service only fills the blanks.

---

## Going to production

| Now | Production |
|---|---|
| SQLite | Postgres — schema is nearly identical, `txn()` becomes `FOR UPDATE` |
| scrypt | Argon2id |
| Files on local disk | S3 or equivalent with lifecycle rules |
| Backups on local disk | Off-site, with restore drills |
| Reset token returned in the response | Real email delivery |
| HTTP | HTTPS, `secure` cookies |
| Rate limit on login only | Across the board |

## Not built yet

- Retention cleanup (PIPA requires keeping data only as long as needed)
- Rent collection and arrears (goes through Yardi)
- Turnover tasks (the `turnover` status exists; the work queue does not)
- Deposit interest
- Email and push delivery
