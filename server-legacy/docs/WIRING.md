# Wiring the front end to the API

The API is complete: 159 endpoints, 72 tables. What was missing is that
nothing called it.

---

## What changed

**Missing routes are built.** Leads, schedule, documents, key handover,
public bookings and applications, and the tenant portal all have endpoints
now. Fourteen tables were added for them.

**AI moved to the server.** Zero direct calls to the model remain in either
front end. Three reasons, in the order they bite:

- The API key. Called from the browser it ends up in the bundle, so anyone who
  opens developer tools has it.
- The audit trail. A draft that reached a tenant should be traceable to a
  request, a person and a moment.
- The prompt. On the server it is one thing that can be reviewed. In the
  browser it is whatever version that user last loaded.

Ten named tasks live in `server/src/routes/ai.js`. A caller says what it wants
done and supplies facts; it does not get to send arbitrary instructions to the
model under this system's key.

**Email and SMS are implemented.** Resend and Twilio, both over plain HTTP so
nothing extra has to be installed. Without keys the queue holds and says so,
rather than reporting a send that did not happen.

---

## The data layer

`web/src/lib/store.js` decides where data comes from, once, instead of in
thirteen components.

```js
const { data: leads, loading, save, mode } = useResource("leads", []);
```

Two sources:

| | |
|---|---|
| `api` | The server. Locks, allocations and postings only mean anything here. |
| `storage` | Browser storage. Every tool still runs standalone. |

Mode is detected by one probe, shared across every caller. A tool opened
against a live server behaves correctly; the same file opened in a sandbox
still runs.

`RESOURCES` declares the storage key and the endpoint side by side, so when a
tool is wired the pair is in one place rather than scattered.

---

## Two calls that change behaviour

This is the whole reason for the server:

**`requestStall`** — the browser version can hand the same last stall to two
people. The server settles it inside one transaction.

**`acquireLock`** — the browser version cannot see other browsers at all. The
server returns 409 with the holder's name and when they started.

Both are exported from `store.js` with a local fallback, so a tool degrades
rather than breaking when there is no server.

---

## Configuration

```bash
ANTHROPIC_API_KEY=      # server only, never sent to the browser
RESEND_API_KEY=         # without it, messages queue and are flagged
TWILIO_ACCOUNT_SID=     # optional: without it "both" falls back to email
TWILIO_AUTH_TOKEN=
TWILIO_FROM=
```

All passed to the `api` container in `docker-compose.yml`. None reach either
front end.

---

## Tenant accounts

`tenant_accounts` is a separate table from `users`, on purpose. A tenant is not
a member of staff with fewer permissions — keeping them apart means one mistake
in a role check cannot expose the console.

Sessions last two weeks. A tenant signs in rarely, and a short session is
friction without a security benefit at that frequency.

---

## What is real now that was not

**Booking slots** come from the schedule rather than being generated locally. A
slot already taken is not offered, and an occupied unit needs 24 hours before
anyone can view it — so those slots are not offered rather than offered and
then cancelled.

**A booking creates a lead** at the moment it is made. That way the pipeline
shows people who booked and never turned up, which is the number worth
knowing.

**A tenant repair creates the maintenance ticket directly.** A form that queues
a request for somebody to retype is a step where things get lost. Urgent goes
straight through to the Building Manager.

**Applications are screened on submission.** A duplicate email or phone is
refused. A resemblance is flagged for a person, never refused automatically.

---

## Still to do

Wiring each tool means replacing its `window.storage` reads with
`useResource`. The mapping is in `RESOURCES`. Order:

1. `AuthConsole` — everything else needs a session
2. `LeasingConsole` — pricing and units feed most other tools
3. `Accounting` — the ledger benefits most from being single-source
4. The rest, in any order

Until a tool is wired it runs against browser storage, which is fine for
review and not fine for two people using it at once.
