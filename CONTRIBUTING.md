# Working on this

## Do not remove the Chinese

Three places keep Chinese deliberately. They look like leftovers from the
translation and they are not:

- **Hard-stop regex patterns** in `AiInbox.jsx`, `LeaseIntake.jsx` and
  `TenantChat.jsx`. Tenants write in both languages. Strip the Chinese and a
  message about income source or a service animal sails past the filter into an
  automatic reply.
- **The fee disclosure** in `LeaseIntake.jsx` and **the notice of entry** in
  `BuildingManager.jsx`. Both are read by tenants.

Everything a staff member reads is English.

## Do not move the legal constants

Numbers that come from Alberta legislation live at the top of the file that uses
them, named and commented:

```js
const REFUND_DAYS = 10;          // deposit refund deadline after tenancy ends
const ENTRY_NOTICE_HOURS = 24;   // notice before entering an occupied unit
const NOTICE_REQUIRED = { periodic: 30, ... };
```

They are constants so that when the manager confirms the real figures, there is
one place to change and it is obvious. Do not inline them.

## Do not let the model decide whether to send

The AI classifies and drafts. A rule in `INTENT_RULES` decides whether anything
goes out. If you find yourself adding "let the model judge whether this is safe
to send", stop — the whole point is being able to answer "why did this go out"
with a rule id.

## Do not let the model touch clause text or amounts

Clauses come from the approved library and are included or omitted, never
rewritten. Rent, deposits and fees are assembled by the system and sent verbatim.

## Audit is append-only

No update path, no delete path, not even for Admin. A log that can be edited
proves nothing.

## Concurrency belongs in the database

Parking allocation and signing locks are correct because the read and the write
happen inside one immediate transaction. Checking a count in JavaScript and then
writing is not the same thing and will oversell the last stall.
