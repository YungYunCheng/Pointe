# Workflow changes

Seven changes, and why each is shaped the way it is.

---

## 1. Adding staff, and per-user permissions

Admin can create an account and grant or revoke individual permissions on top
of the role. That way one person can get one extra thing without inventing a
fifth role for them.

**A revoke always beats a grant**, so taking something away never depends on
which order the rows were written in.

**A permission change revokes that account's sessions immediately.** Otherwise
somebody keeps access they were just told they had lost, until their session
happens to expire.

**Admin cannot change their own.** The one account that can restore anything
should not be able to lock itself out by mistake.

---

## 2. The schedule is split by role

| | Building Manager | Property Manager |
|---|---|---|
| Viewings | ✓ | |
| Key handover | ✓ | |
| Vendor visits | ✓ | |
| Signings | | ✓ |
| Renewals | | ✓ |
| Follow-ups and early questions | | ✓ |

Both see the whole calendar; only the owner can book their own type. With one
person in each role, "anyone books anything" means both diaries fill with the
other person's appointments.

**Confirming is not optional** for anything the tenant attends. Booking a time
and not telling them is how a viewing becomes a wasted trip. Email, text, or
both — and a decline is the useful signal, because it means the slot is free
again rather than somebody standing at a locked door.

---

## 3. Keys wait for the lease

```
PM confirms the lease is signed  →  BM can book the handover
```

Until that confirmation exists, the unit shows in the key handover list as
**not released** with no way to book a time. The check is server-side.

Handing over possession against an unsigned lease leaves nothing to enforce,
and it is not a mistake that can be undone quietly.

The Property Manager's sign-off also records whether the deposit and first
month arrived — the two things that are awkward to collect once somebody has
the keys.

---

## 4. Escalation is an email, not a badge

The AI passing a message to a person used to mean a flag on a screen. Now it
queues an email to whoever owns it, with a four-hour clock, **and tells the
tenant a person has it**.

Silence is what turns a question into a complaint. Somebody may not be at a
console for hours.

For R-101, R-102 and R-103 — income, accessibility, protected grounds — the
content is not copied into the notification. The person opens the thread to
read it; what travels is the rule id.

---

## 5. Viewings belong to the Building Manager

Recording an outcome needs `showings.manage`, which the Building Manager has
and the Property Manager does not. The Property Manager still sees every
showing and every outcome — arrears and conversion matter to leasing — but the
work is one role's.

---

## 6. Purchase orders, and the bill

```
BM raises        →  AI can draft it from the ticket. Estimate only.
BM confirms      →  actual amount, and a variance needs a reason
→ copied to bill →  Accounting approves, and that is what posts
```

**A purchase order does not touch the ledger.** It is a commitment, not a
liability. Only the bill posts to accounts payable — which is also how
QuickBooks treats it, and for the same reason.

**The two steps exist because the amount changes.** A vendor quotes $680, opens
the wall, finds the shut-off valve has gone as well, and invoices $745. One
step would mean either booking a number nobody agreed to or re-entering the
whole thing.

**A variance needs a reason.** An unexplained difference is the one thing an
owner will ask about, and "I do not remember" is not an answer six months on.

The AI drafts line items from the ticket description and picks an expense
account from the real list. It is told not to invent a price it has no basis
for: a line it cannot estimate comes back as zero with a note that it needs a
quote.

---

## 7. Receipts go out when the money is confirmed

Accounting records the payment; the receipt to the tenant is queued at that
moment, bilingual, showing what it settled and what is left outstanding.

**Never on the promise of money.** A receipt for a payment that later bounces
is worse than no receipt.

`GET /api/receipts/pending` lists money confirmed with no receipt sent, so it
is not something that gets remembered only when a tenant asks.

---

## 8. Audit retention

| | Kept |
|---|---|
| Snapshots | 31 days |
| Change entries | Indefinitely |

Two different things with two different rules.

Snapshots are for rolling back a mistake, and a month is long enough for a
mistake to surface. They are large, so keeping them forever trades real storage
for a case that does not arise. The most recent is kept even if it falls
outside the window — a gap with nothing to restore from is worse than one stale
file.

Change entries are the record of who did what. They are small, and the reason
they exist is precisely that somebody asks in two years.

**Every entry carries an actor.** A startup check counts entries with no actor
recorded and warns, because an entry that cannot say who is an entry that
cannot answer the question the log exists for.

Pruning is itself recorded.
