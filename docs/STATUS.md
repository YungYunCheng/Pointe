# What exists, what the AI does, and what is missing

Baydo Pointe · 330 units · as of this commit

Written to be read top to bottom once, then used as a checklist. The gaps are in
the last two sections and they are the point of the document.

---

## 1. At a glance

| | Built | Wired to the API | Notes |
|---|:--:|:--:|---|
| Staff tools | 10 | 0 | Read and write browser storage |
| Tenant site | 5 pages | 0 | Same |
| API endpoints | 48 | — | Running, nothing calls them |
| AI touchpoints | 6 | 6 | Call Anthropic directly from the browser |
| Containers | 4 | 4 | web, tenant, api, db |

**The single largest gap: nothing in either front end talks to the API.** Every
tool works, and every tool works alone. Two agents in two browsers cannot see
each other, which means the signing lock and the parking queue — the two things
most likely to cause a real dispute — do not actually function yet.

---

## 2. Staff tools

### AuthConsole
Sign in, forgot password, reset. Failed attempts lock the account after five for
fifteen minutes. The same message appears whether or not the email exists.

**Missing:** nothing sends the reset email. The code is shown on screen, which is
fine for a prototype and not for anything else.

### LeasingConsole
Units, pricing, parking quotas, accounts.

- 330 units in a floor-stack view, filterable by status
- Rent by unit type, with a per-square-foot figure alongside
- Deposit mode, pet deposits and rent, parking and storage fees, application fee
- Parking areas with live free counts, request and waitlist handling
- Account creation and role assignment (Admin only)
- CSV export

**Missing:** publishing a price change does not version the old one in the
browser. The API does version it, so this resolves when the two are joined.

### LeadsCrm
Seven-stage pipeline, showing schedule, funnel.

- Overdue flags: new enquiry past 1 hour, contacted or viewed past 48, applied past 24
- Conversion by source, with a note not to trust small samples
- Reasons leads were lost, so "not enough parking" surfaces as a pattern

**Missing:** leads and contacts are separate records. The same person enquiring,
signing and renewing appears three times.

### Schedule
Daily task list, reminders, signing approval.

- Reminders go out on the previous business day, so Monday surfaces on Friday
- Observed holidays push it back further; the holiday list is editable
- Signing appointments can be booked automatically; the lease itself cannot be sent
  until a named person approves it

**Missing:** reminders are written to a table and never actually sent. No email,
no SMS, no push.

### AiInbox
Classifies tenant messages and drafts replies. Detail in section 4.

### LeaseIntake
Guided intake, lease variables, fee disclosure, signing lock.

- Ten fields collected conversationally, one at a time
- Rent and deposits filled from property data, never typed
- Fee disclosure assembled by the system and sent verbatim, in both languages
- A snapshot records what the tenant confirmed; if pricing changes afterwards,
  approval is blocked until it is disclosed again
- Deposit cap checked before anything can be sent

**Missing:** no lease template. Clause selection works, but the clause library is
empty until a lawyer provides one.

### Documents
Template library, field detection, generation, approval.

- Templates carry a status; only approved ones can generate a document
- `{{field}}` markers are detected automatically
- Inbox grouped by document type, split into new, read and handled

**Missing:** PDF and Word cannot be parsed in the browser. Templates have to be
pasted as text. This needs server-side conversion.

### Operations
Showing outcomes and move-outs.

- Outcome prompt appears 30 minutes after a booked showing, overdue at 60
- Outcomes feed back into the CRM stage
- Six-step move-out: accept notice, inspect, report, deduction notice, tenant
  response, refund
- Confirming a tenant has vacated releases their stall and promotes the waitlist
- Refund deadline tracked from the move-out date

The deduction flow is the part worth keeping exactly as it is: a deduction cannot
be upheld over a tenant's objection without a written basis and uploaded evidence.

**Missing:** deposit interest is not calculated. Alberta requires deposits to be
held in trust and to earn interest, so refunds are currently short.

### BuildingManager
Maintenance, notices of entry, key handover.

- Tickets by priority, with a rush flag the manager sets by hand
- Vendor visits go on the calendar without occupying staff time, so they never
  collide with a showing
- Notices of entry drafted by AI, approved before sending
- Under 24 hours' notice, the send button is disabled rather than warned about
- Key handover with a checklist that must be complete

**Missing:** vendor visits to occupied units are listed in the notice queue, but
nothing links a sent notice back to the ticket.

### AuditLog
Change log and backups, Admin only.

- Diffs every data key each minute, records what changed
- Password hashes and reset codes recorded as `***`
- Hourly snapshot when something changed, 24 kept, restore takes a safety copy first

**Missing:** this only sees changes while the page is open. The API does it
properly at every write. This tool should read from the API, not poll.

---

## 3. Tenant site

| Page | What it does | Missing |
|---|---|---|
| Home | Live availability, amenities, parking position stated plainly | No photographs |
| Suites | Vacancy and current rent by layout, mirrored types merged | No floor plans |
| Buildings | The three buildings and shared amenities | Thin |
| Book | Slot picker, 30 minutes, office hours | Slots are generated locally, not real availability |
| Apply | Six steps, draft saved as you go, every cost shown before submission | Documents upload nowhere |
| Portal | Repairs, notices, rent, documents | Sign-in is a stand-in; rent link goes nowhere |

Bilingual throughout, 191 strings in each language.

The application asks how many people will live in the suite and nothing else
about them. Household composition, marital status, nationality, religion, age
and source of income are protected grounds and appear nowhere in the form.

---

## 4. What the AI does

Six touchpoints. Each one is narrow on purpose.

| # | Where | Task | Can it send on its own? |
|---|---|---|---|
| 1 | AiInbox | Classify a message, draft a reply | Only for the 12 lookup intents |
| 2 | LeaseIntake | Ask the next intake question, extract fields | No — fills a form |
| 3 | Documents | Propose the field list from a template | No — suggests, staff confirm |
| 4 | BuildingManager | Draft a notice of entry, both languages | No — approved before sending |
| 5 | LeasingConsole | Answer parking questions from live numbers | No — advice to staff |
| 6 | TenantChat | Answer a tenant from property data | Yes, outside the hard stops |

### The three lines

**It never decides whether to send.** It classifies and drafts; a hard-coded rule
in `INTENT_RULES` decides. When something goes wrong, "why did this go out" has
to be answerable with a rule id, not with the model's judgement.

**It never writes clause text.** Clauses come from an approved library and are
included or omitted. A generated clause can be void, and it reads convincingly
either way.

**It never states an amount.** Rent, deposits and fees are assembled by the system
and sent verbatim. The intake prompt says explicitly: if asked about cost, say the
breakdown is coming separately.

### Hard stops

Six rules, run before any model call, in both the staff inbox and the tenant chat.
Patterns are bilingual because tenants write in both languages.

| Rule | Catches | Why it is a rule and not a judgement |
|---|---|---|
| R-101 | Income, AISH, credit, guarantor, "do I qualify" | Source of income is a protected ground. An automatic reply becomes written evidence of differential treatment. |
| R-102 | Wheelchair, accessible, service animal, accommodation | A service animal is not a pet. Applying the pet policy amounts to refusing accommodation. |
| R-103 | Race, religion, children, marital status, nationality | Same as R-101. The audit log records the rule id and never the content. |
| R-104 | Lawyer, RTDRS, eviction, complaint, claim | Correspondence in a dispute is evidence. |
| R-105 | Lease terms, holding a unit, discounts, negotiation | Binding commitments need a person. Booking a signing slot is not caught. |
| R-106 | Leak, no heat, no hot water, fire, gas | Tenant chat only. Answers with the office number rather than a reply. |

### The fact layer

Everything the AI answers with comes from live property data assembled into a
text block. Drafts are checked afterwards: any dollar figure not present in that
block downgrades the reply for human review.

`missing_info` is a required field in the response. If a rent is not set, the AI
says it will confirm rather than estimating.

### What the AI is not allowed to do, and is not doing

- Decide who qualifies as a tenant
- Read or judge credit or income documents
- Rank or prioritise leads
- Set or negotiate a price
- Approve a document, a deduction or a refund
- Mark a maintenance ticket as urgent — that is a human judgement made on site

---

## 5. Gaps, ordered

### Blocking anything real

**1. Nothing calls the API.** Every tool works alone. Two agents cannot see each
other's locks; the parking queue is per-browser. Order: AuthConsole, then
LeasingConsole, then the rest.

**2. No lease template.** Documents and LeaseIntake are complete machinery around
an empty library. Nothing can be generated until a lawyer provides one.

**3. Alberta figures unconfirmed.** Deposit cap, refund deadline, notice periods,
entry notice lead time, the 365-day rule. All are named constants at the top of
each file so there is one place to change each. Confirm with your manager.

**4. Nothing is sent.** No email, no SMS, no push. Reminders, confirmations,
notices of entry and reset codes are all written to tables and go nowhere.

**5. Still SQLite.** The compose file is wired for Postgres and the schema is
written; `server/src/db.js` still opens a file. Change the driver and the
immediate transaction becomes `SELECT ... FOR UPDATE`.

### Costing money quietly

**6. No renewals workflow in the UI.** The API raises a task 30 days out and the
365-day rule is checked, but no screen shows it. Keeping a tenant is far cheaper
than finding one.

**7. No turnover tracking.** Between move-out and re-listing is pure vacancy loss,
and it is unmeasured. The `turnover` status exists; nothing uses it.

**8. Showing outcomes do not feed pricing.** A unit shown twelve times without an
application is telling you something. Nobody is listening.

**9. No deposit interest.** Alberta requires deposits held in trust to earn
interest. Refunds are currently short by that amount.

### Legal exposure

**10. No data retention.** Alberta PIPA expects a defined period enforced by a
job. Leads, messages and applications currently accumulate forever.

**11. Third-party disclosure not documented.** Tenant messages go to an AI
provider. Under PIPA that is a disclosure and belongs in the privacy policy.

**12. No privacy policy.** The tenant site collects names, contact details and
uploaded documents, and links to nothing.

**13. Evidence on local disk.** It does not survive a container being replaced.
This is the proof behind every deposit deduction.

**14. AI called from the browser.** The API key would be visible in the bundle.
These calls belong on the server, which also puts them in the audit log.

### Should exist before launch

**15. Rent collection and arrears.** Going to Yardi. Define which system owns the
number before both do.

**16. No shadow mode.** The architecture describes running the AI without sending
for two to four weeks to measure error rates. Worth doing.

**17. No fallback message.** When the AI is unavailable, a fixed "received, someone
will reply" should go out. Currently nothing does.

**18. Portal sign-in is a stand-in.** It accepts any email and password.

### Smaller

**19.** Leads and contacts are separate records for the same person.
**20.** Notices of entry for vendor visits do not link back to the ticket.
**21.** No suite photographs or floor plans on the tenant site.
**22.** Booking slots are generated locally, not from real availability.
**23.** AuditLog polls the browser instead of reading the API.
**24.** No mobile-specific flow for showings, though the pages are responsive.

---

## 6. What is solid

Worth saying, because the list above is long:

**The permission matrix.** One source of truth, every endpoint declares what it
needs, and a role change revokes existing sessions.

**The audit design.** Append-only, no update or delete path, secrets scrubbed,
protected-ground content never copied.

**Concurrency.** Parking allocation and signing locks are correct because the read
and the write happen in one transaction. This is the part most systems get wrong.

**The deduction flow.** Notice before response, evidence required to uphold,
withdrawal always available. This is the shape that survives a dispute.

**The AI boundaries.** Narrow, rule-gated, and each decision traceable to a rule
id rather than to a model.

**Saying the awkward thing early.** Parking scarcity on the home page, every cost
before the application is submitted. Both cost enquiries and both prevent the
complaint that follows finding out later.

---

## 7. Suggested order

**Now:** API wiring (1), lease template (2), Alberta figures (3), move AI calls
server-side (14).

**Before launch:** email and SMS (4), Postgres (5), privacy policy and disclosure
(11, 12), evidence to object storage (13), fallback message (17), portal sign-in
(18).

**First quarter after:** renewals (6), turnover (7), deposit interest (9),
retention (10), shadow mode (16).

**Once there is data:** showing outcomes into pricing (8), lead and contact merge
(19), photographs (21), real slot availability (22).
