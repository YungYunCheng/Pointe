# Optimisations and gap closures

What was built for each item on the list. Two were skipped as agreed: the
lawyer-approved agreements, and confirming the Alberta figures.

---

## Security and infrastructure

**Argon2id** replaces scrypt. `server/src/crypto.js` loads the native module
lazily and falls back to scrypt if it is unavailable — a password system that
cannot start is worse than one on the older algorithm. The algorithm is stored
with each hash, so a hash made under one is still verifiable after a switch and
nobody has to reset a password. `needsRehash()` marks the old ones; the next
successful login is the right moment to upgrade, because the plaintext is in
hand and the user notices nothing.

**Object storage.** `server/src/storage.js` writes to S3, R2, MinIO or Spaces
when `S3_BUCKET` is set, local disk otherwise. Same interface either way.

This matters more than it looks: the volume holds the photographs behind every
deposit deduction and the agreement files a lawyer approved. Neither can be
recreated, and on local disk neither survives a container being replaced on
another host.

There is no `remove()`. The retention job deletes database rows, not the
evidence behind a deduction somebody may still have to defend.

**TLS.** Caddy in front of both sites, certificates automatic.

```bash
docker compose --profile tls up -d
```

Without it, session cookies set `secure` in production are never sent and
sign-in fails in a way that looks exactly like a wrong password.

---

## Retention

`server/src/retention.js` enforces the periods rather than describing them.

| | Period | What happens |
|---|---|---|
| Leads that never converted | 12 months | Anonymised |
| Viewing requests | 12 months | Anonymised |
| Declined applications | 24 months | Anonymised, uploaded documents deleted |
| Messages | 3 years | Content removed, delivery record kept |
| Confirmation tokens | 6 months | Deleted |
| Tenancy records | 7 years | Flagged, never automatic |
| Accounting records | 6 years | Flagged, never automatic |

**Leads are anonymised, not deleted.** Removing the row would quietly rewrite
last year's conversion rate. What goes is the part that identifies somebody.

**Declined applications lose their uploaded documents.** Identity documents are
the most sensitive thing collected and the least defensible to keep.

**Tenancies and financial records are never pruned by a job.** Deleting those is
a decision somebody makes.

Runs weekly, not nightly — a policy that fires every night is one nobody
watches. `GET /api/retention/policy` previews before anything runs.

---

## Privacy policy

A real one at `/privacy` on the tenant site, bilingual.

It names the AI provider explicitly. Under PIPA, sending tenant messages to a
third party is a disclosure whether or not it feels like one, and saying so is
not optional. It also says which messages are *not* sent — anything touching
income, accessibility or another protected ground goes straight to a person.

---

## Renewals

`GET /api/renewals` looks 90 days ahead and returns each lease with days left,
when the notice is due, and whether rent can legally be raised.

**The 365-day rule is checked before a decision is accepted**, not trusted to
whoever is typing. An increase inside that window does not just get refused
later — it can invalidate the notice entirely.

Sending the offer is bilingual and one call.

---

## Turnover

Between a tenant leaving and the unit being back on the market is pure vacancy
loss, and it was unmeasured because no single person owns it.

Each turnover opens with a standard task list, so the same things get done
every time rather than whatever somebody remembers. The dashboard shows days
vacant, **lost rent so far**, days to list and days to lease.

---

## Pricing signals

`GET /api/pricing-signals` counts showings against applications by unit type,
with average days vacant and how often price was named as the reason.

It returns flags, not a suggested rent:

```
shown_often_no_applications  ·  price_named_repeatedly
slow_to_fill                 ·  converting_well
```

Deliberately. What a unit should rent for depends on the local market, which
this system cannot see, and a number here would be treated as an answer.

---

## Accounting gaps

**GST.** Calculated from posted entries — 2300 out, 1210 in, net to CRA. The
method text warns that most residential rent is exempt, so a large figure means
something has been coded wrongly rather than that a large payment is due.

**Depreciation.** Straight line or declining balance, monthly, idempotent per
period. It will not take an asset below salvage: unchecked, a long-lived asset
ends up with a negative book value and the balance sheet stops making sense.

**Owner statements.** Per building, per period, with both figures:

- **Net operating income** — accrual, what was earned
- **Distributable** — cash collected less expenses, what can actually be taken out

Those differ whenever rent has been billed and not paid, and confusing them is
how an owner takes a distribution the bank account cannot cover.

---

## Shadow mode

`AI_SHADOW_MODE=1` runs the AI the whole way through and sends nothing. Each
run is recorded with what it would have done and whether it would have sent
unsupervised.

The status endpoint reports **the error rate on what would have sent**, not
overall accuracy. Accuracy across drafts a person reviews anyway flatters the
result; what matters is how often something wrong would have gone out with
nobody looking.

Two to four weeks and at least a hundred reviewed before drawing a conclusion.

---

## Fallback

When the model is unavailable, the tenant chat sends a fixed bilingual message
and points urgent matters at the phone. The failure lands in the audit log.

Silence reads as being ignored, and a tenant cannot tell an outage from being
brushed off.

Staff-facing tasks fail loudly instead. A draft that silently becomes a
template is worse than a button that says the service is down, because somebody
would send it.

---

## Lead and contact merge

`GET /api/leads/duplicates` groups by normalised email or phone.

Merging keeps the **oldest** record — it holds the first contact date, which is
what response-time figures are measured from — and takes the **furthest-along**
stage. Somebody who signed a lease is not "new" because they enquired again
about a second unit.

Notes move rather than being discarded. What somebody was told is usually the
useful part of an old record.

---

## Tenant portal

Wired to the real backend. Sign-in, lockout after five attempts, forgot
password, and a session check on load so an expired token sends the tenant to
sign in rather than to a page of empty panels.

The same message whether the account exists or the password was wrong.
Anything else turns the login into an account checker.

---

## Confirmation replies

`/confirm?token=…` on the tenant site. One tap, no sign-in.

The token identifies one question and is useless for anything else. Putting an
account in front of "does this time work" is how a confirmation rate goes to
nothing.

Declining is framed as helpful, because it is: it frees the slot instead of
costing somebody a wasted trip.

---

## Still open

**Postgres.** `pg` is a dependency and the compose file is wired for it;
`db.js` still opens SQLite. The driver swap and changing the immediate
transaction to `SELECT ... FOR UPDATE` remain.

**Front-end API wiring.** `store.js` and `api.js` are ready; each tool still
reads browser storage.

**Photographs and floor plans.** No assets to upload.

**Electronic signature.** The agreement goes out and signing is marked by hand.
