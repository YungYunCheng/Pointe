# Web

Vite + React. Eleven tools behind one shell with role-filtered navigation.

```bash
npm install
npm run dev        # http://localhost:3000, proxies /api to the server
npm run build      # dist/
```

## Wiring the tools to the API

Every tool currently reads and writes `window.storage` directly, which is why
they work standalone. `src/lib/api.js` is the replacement. The mapping is one to
one:

| Storage key | Replace with |
|---|---|
| `baydo:session` | `api.login()` / `api.me()` |
| `baydo:pricing` | `api.pricing()` / `api.publishPricing()` |
| `baydo:overrides` | `api.units()` / `api.setStatus()` |
| `baydo:parking` | `api.parking()` / `api.requestStall()` / `api.releaseStall()` |
| `baydo:unitlocks` | `api.getLock()` / `api.acquireLock()` / `api.releaseLock()` |
| `baydo:moveouts` | `api.moveouts()` / `api.createMoveout()` / `api.vacate()` |
| `baydo:maintenance` | `api.maintenance()` / `api.createTicket()` |
| `baydo:schedule` | `api.get("/events")` |
| `baydo:leads` | `api.get("/leads")` |
| `baydo:audit` | `api.audit()` |
| `baydo:backups` | `api.backups()` / `api.restore()` |

Two calls change behaviour once they hit the server, and that is the point:

**`api.requestStall()`** settles who gets the last stall inside a transaction.
The browser version could hand the same stall to two people.

**`api.acquireLock()`** returns 409 with the holder's name if someone else
started signing that unit. The browser version cannot see other browsers at all.

## Errors

`ApiError` carries the server's message code rather than prose:

```js
try {
  await api.acquireLock(unit);
} catch (e) {
  if (e.code === "UNIT_ALREADY_TAKEN") {
    show(t("err.UNIT_ALREADY_TAKEN", e.payload));   // holder, since
  }
}
```

Codes are translated in `src/lib/i18n.js`. The server sends codes, not sentences,
so one message reads correctly for whoever opens it.

## Language

Staff tools are English. `TenantChat.jsx` is bilingual and follows whichever
language the tenant writes in.

The Chinese regex patterns in `AiInbox.jsx`, `LeaseIntake.jsx` and
`TenantChat.jsx` are deliberate. See CONTRIBUTING.md before touching them.
