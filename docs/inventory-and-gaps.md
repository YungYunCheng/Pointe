# What exists, what the AI does, and what is missing

Written 2026-08-04, against the current repository.

Read the gap tables first if you are deciding what to build next. The inventory
is there to check against, not to read start to finish.

---

## 1. The short version

| | Built | Wired to the server | Ready to use |
|---|---|---|---|
| Staff tools | 10 | 0 | no |
| Tenant site | 5 pages | 0 | no |
| API endpoints | 48 | — | yes |
| Background jobs | 4 | — | yes |
| AI touchpoints | 6 | 6 | prototype only |

**The single largest gap: nothing on the front end talks to the API yet.** Every
tool reads and writes browser storage. The endpoints exist and work; the wiring
does not. Until that is done, permissions, audit, signing locks and parking
concurrency are all decorative — anyone with developer tools can rewrite them.

The second largest: **there is no lease template.** The document tools cannot
produce a real document until a lawyer supplies one.

---

## 2. Staff tools

### 2.1 Sign in — `AuthConsole.jsx`

| Function | State |
|---|---|
| Sign in, sign out | Built, browser only |
| Forgot password, reset | Built, code shown on screen instead of emailed |
| Lockout after 5 failed attempts, 15 minutes | Built |
| Password rules, 10 chars with mixed case, digit, symbol | Built |
| Same message whether or not the account exists | Built |

Missing: email delivery, Argon2id (currently PBKDF2 in browser, scrypt on the
server), two-factor, session list with the ability to revoke one.

### 2.2 Leasing console — `LeasingConsole.jsx`

| Function | State |
|---|---|
| 330 units, floor stack per building | Built |
| Rent per unit type, per-unit override | Built |
| Deposit mode: one month or fixed | Built |
| Pet deposits, pet rent, limit | Built |
| Parking, storage, application fee, what rent includes | Built |
| Parking quotas and allocation, first come first served | Built |
| Waitlist with automatic promotion on release | Built |
| Unit status: available / signed / occupied | Built |
| Account management, three roles | Built |
| CSV export | Built |
| Ask the AI about the parking position | Built |

Missing: unit photos, floor plan images, turnover state between move-out and
re-listing, per-unit notes history.

### 2.3 Leads CRM — `LeadsCrm.jsx`

| Function | State |
|---|---|
| Seven-stage pipeline | Built |
| Overdue flags: 1h new, 48h contacted or viewed, 24h applied | Built |
| Contact log per lead | Built |
| Showing schedule read from the scheduler | Built |
| Funnel, source performance, loss reasons | Built |
| Do-not-contact flag for CASL | Built |

Missing: leads and contacts are separate records, so the same person appears
twice once they become a tenant. Deduplication. Retention purge.

### 2.4 Schedule — `Schedule.jsx`

| Function | State |
|---|---|
| Daily task list, ordered by time | Built |
| Reminders on the previous business day, Monday resolving to Friday | Built |
| Holiday table, Heritage Day unobserved by default | Built |
| Signing approval gate | Built |
| Conflict detection: one person, one thing at a time | Built |
| Vendor visits on the calendar without occupying staff time | Built |

Missing: actual notification delivery — reminders are written to a table and
nothing sends them. Nobody keeps a browser tab open all day.

### 2.5 AI inbox — `AiInbox.jsx`

Covered in section 4.

### 2.6 Lease intake — `LeaseIntake.jsx`

| Function | State |
|---|---|
| Conversational intake, one field at a time | Built |
| Off-limits question filter | Built |
| Fee disclosure assembled by the system, bilingual | Built |
| Acknowledgement snapshot, invalidated if fees change after | Built |
| Signing lock, first to sign wins | Built |
| Pre-assembly checks, deposit cap among them | Built |
| Clause library, included or omitted but never rewritten | Built |

Missing: **the actual lease template.** The clause list C-001 to C-011 is a
skeleton, not usable text.

### 2.7 Documents — `Documents.jsx`

| Function | State |
|---|---|
| Template library with an approval gate | Built |
| Blank detection from `{{markers}}` | Built |
| AI proposes each blank's data source | Built |
| Document generation, blanks filled | Built |
| Inbox grouped by type, new / read / handled | Built |
| Approval and release | Built |

Missing: PDF and Word parsing (browser cannot; needs server-side conversion),
e-signature integration, version comparison between template revisions.

### 2.8 Operations — `Operations.jsx`

| Function | State |
|---|---|
| Showing outcome prompt, 30 minutes after, overdue at 60 | Built |
| Outcome pushed back into the CRM stage | Built |
| Move-out in six steps | Built |
| Notice period calculated against lease type | Built |
| Vacancy confirmation releases stall and unit | Built |
| Deduction notice before the tenant response stage | Built |
| Dispute handling: withdraw or uphold, evidence required to uphold | Built |
| Refund deadline countdown | Built |
| Admin rollback and delete | Built |

Missing: deposit interest. Alberta requires deposits held in trust to earn
interest, and the refund should be principal plus interest less deductions. Not
modelled anywhere, which means every refund is currently short.

### 2.9 Building manager — `BuildingManager.jsx`

| Function | State |
|---|---|
| Maintenance tickets, five states | Built |
| Rush flag, set by hand only | Built |
| Vendor scheduling onto the calendar | Built |
| Notice of entry for showings and vendor visits | Built |
| Short notice refused rather than warned about | Built |
| Key handover with a checklist | Built |

Missing: vendor directory, cost tracking per ticket, recurring maintenance,
photo attachments on tickets.

### 2.10 Audit — `AuditLog.jsx`

| Function | State |
|---|---|
| Change log with before and after values | Built, browser polling |
| Secrets masked | Built |
| Hourly snapshots when something changed | Built |
| Restore with a pre-restore snapshot | Built |

**This one is misleading in its current form.** Polling from the browser misses
everything that happens while the page is closed. The server-side audit is
correct and complete; this tool should read from it rather than diffing storage
keys itself.

---

## 3. Tenant site

| Page | Function | State |
|---|---|---|
| Home | Availability, amenities, parking position stated plainly | Built |
| Suites | Live vacancy by layout, current rents, mirrored layouts merged | Built |
| Buildings | The three buildings and what is in them | Built |
| Book | Slot picker, 24h notice respected for occupied suites | Built, slots generated locally |
| Apply | Six steps, draft saved, every cost shown before submission | Built |
| Portal | Repairs, notices, rent, documents | Built, sign-in is a stand-in |
| Chat | Ask a question, AI answers or hands off | Built |

Missing:

- **Suite photos.** The cards are typographic because there are no images. This
  is the single biggest thing missing from a tenant's point of view.
- **Real slot availability.** `Booking.jsx` generates slots from office hours. It
  does not know which are taken.
- **Tenant accounts.** Portal sign-in accepts anything. There is no tenant table,
  no invitation flow, no password reset.
- **Rent payment.** Links out to the accounting system, not wired up.
- **Application status.** A tenant who applies has no way to see what happened.

---

## 4. What the AI does

Six touchpoints. Every one is bounded by rules that run before or after the
model, never by the model's own judgement.

### 4.1 Reply drafting — `AiInbox.jsx`

Classifies an inbound message into one of 20 intents, then drafts a reply from
the property data.

**Before the model:** five hard-stop patterns. A match goes straight to a person
with no draft produced.

| Rule | Catches | Why |
|---|---|---|
| R-101 | Income source, AISH, credit, guarantor, "do I qualify" | Source of income is a protected ground in Alberta. An automatic reply here becomes written evidence of differential treatment. |
| R-102 | Wheelchair, accessible, service animal, accommodation | A service animal is not a pet. Accommodation carries a legal process; applying the ordinary rules amounts to refusing it. |
| R-103 | Race, religion, pregnancy, children, marital status, nationality, age, gender | Same reason as R-101. The audit log records the rule id only, never the content. |
| R-104 | Lawyer, human rights, RTDRS, eviction, complaint, claim | Correspondence in a dispute becomes evidence. |
| R-105 | Lease terms, send me the lease, hold the unit, discount, negotiate | Anything binding or off the published price needs a person. |

**After the model:** every dollar figure in the draft is checked against the
retrieved facts. One that is not found downgrades the whole reply to human
review. Confidence below 0.7 does the same, as does any missing data.

**The routing decision is a lookup table, not a judgement.** 10 intents send
automatically because the answer is a fact; 4 scheduling intents send because
they only move a calendar; 6 wait for approval.

### 4.2 Intake questions — `LeaseIntake.jsx`

Asks one field at a time and extracts what it can from each reply.

Constrained by: an off-limits pattern that blocks a generated question before the
tenant sees it; option values must match the list exactly or are discarded; the
model is told never to state an amount, because the fee disclosure is assembled
by the system and sent verbatim.

### 4.3 Field detection — `Documents.jsx`

Reads a template and proposes each blank plus where its value should come from —
system, tenant, or staff. A human confirms every source before it is used.

Instructed not to mark anything touching a protected ground as a tenant
question; those go to staff with a note that they need legal review.

### 4.4 Notice of entry — `BuildingManager.jsx`

Drafts the notice in English and Chinese from fixed facts: unit, tenant, date,
time window, purpose. Told not to cite any statute or section number.

The manager edits and approves. If there is under 24 hours' notice the send
button is disabled and the tool says to reschedule — a short notice is worse than
no notice.

### 4.5 Parking advice — `LeasingConsole.jsx`

Answers a manager's question with the live allocation numbers attached, so the
advice is about the actual position rather than parking in general.

### 4.6 Tenant chat — `TenantChat.jsx`

Same hard stops as the inbox, plus R-106 for emergencies — a leak, no heat, no
hot water — which tells the tenant to phone rather than wait.

Answers only from the property data. Anything not found gets "I will check and
come back to you." Every reply is labelled automated with a route to a person.

### 4.7 The three lines

**The AI never decides whether to send.** It classifies and drafts; a hard-coded
rule decides. When something goes wrong, "why did this go out" must be answerable
with a rule id, not with the model's judgement.

**The AI never writes clause text.** Clauses come from the approved library and
are included or omitted. A generated clause can be void and still read
convincingly.

**The AI never states an amount.** Rent, deposits and fees are assembled by the
system and sent verbatim.

### 4.8 What the AI is not used for, on purpose

Screening, prioritising leads, deciding a rent, judging whether a deduction is
fair, deciding whether a repair is urgent, or writing anything a tenant signs.

---

## 5. Server

48 endpoints, 25 permissions, 4 jobs. Complete and working.

Four things live here because they cannot work in a browser:

| Concern | How |
|---|---|
| Permissions | Every endpoint declares what it needs; undeclared is denied |
| Audit | Written at each mutation, append-only, no update or delete path |
| Signing locks | One row per unit number, so two agents cannot both start |
| Parking concurrency | Balance check and write inside one immediate transaction |

Jobs: hourly backup when something changed; renewal scan 30 days before expiry;
reminders on the previous business day; refund deadline warnings.

Missing:

- **Postgres.** The compose file and schema are ready; `db.js` still opens
  SQLite.
- **Email.** Reset links, confirmations and reminders all have nowhere to go.
- **Tenant authentication.** Staff accounts exist; tenants do not.
- **Public endpoints.** The tenant site has nowhere to post a booking or an
  application.
- **Retention jobs.** Alberta PIPA expects a defined period enforced by a job.

---

## 6. Gaps, ordered

### Before anyone uses this

1. **Wire the front end to the API.** Everything else is theatre until this is
   done. Order: AuthConsole, LeasingConsole, then the rest — the first two feed
   every other tool.
2. **Lease template and the document set**, from a lawyer. `Documents.jsx` cannot
   produce anything real without them.
3. **Confirm the Alberta figures** with your manager: deposit cap, refund
   deadline, notice periods, entry notice lead time, the 365-day rule. All are
   constants at the top of the files that use them.
4. **Rotate the three seed passwords.** They were shared over chat.
5. **Postgres, TLS, Argon2id.** See DEPLOY.md.

### Before tenants see it

6. **Suite photos.** A listing site without images is not a listing site.
7. **Tenant accounts**: table, invitation flow, password reset, real portal
   sign-in.
8. **Public endpoints** for bookings and applications.
9. **Email delivery.** Every confirmation currently goes nowhere.
10. **Real slot availability** in the booking page.

### Missing business processes

11. **Deposit interest.** Alberta requires it and nothing calculates it. Every
    refund is currently short by the interest owed.
12. **Turnover tracking** between move-out and re-listing. This is pure vacancy
    loss and the easiest money to recover.
13. **Renewals.** The server raises tasks; no UI acts on them. Keeping a tenant
    is far cheaper than finding one.
14. **Application status** for tenants who applied.
15. **Rent and arrears** — going to Yardi, which stays the system of record.

### Worth doing once there is data

16. Showing outcomes feeding back into pricing: which suites are viewed often and
    never taken.
17. Shadow mode for the AI before any automatic send: run the whole pipeline,
    send nothing, compare against what staff actually wrote.
18. Data retention purge jobs.
19. Audit table partitioning by month.
20. Push notifications, so reminders reach someone who does not have a tab open.

---

## 7. Decisions that are easy to undo by accident

**The Chinese regex patterns are load-bearing.** Tenants write in both languages.
Strip them and a Chinese message about income source or a service animal sails
past the filter into an automatic reply. They look like translation leftovers.
They are not.

**Legal constants sit at the top of each file** so there is one obvious place to
change them. Do not inline them.

**The audit table has no update or delete path**, not even for Admin. A log that
can be edited proves nothing.

**Parking and locks are correct because of the transaction**, not because of the
JavaScript around it. Checking a count and then writing will oversell the last
stall.

**Parking scarcity is stated on the public site.** 222 stalls against 330 suites.
It costs enquiries. A tenant who finds out after signing has a fair complaint;
one who knew does not.
