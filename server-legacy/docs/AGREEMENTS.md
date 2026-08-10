# Agreements

The system does not produce an agreement. Admin uploads the file a lawyer
approved, and that file is what reaches the tenant, byte for byte.

---

## Why it works this way

A generated clause can be void, and it reads exactly as convincingly as a valid
one. The only way to be certain a tenant signed what counsel approved is for
those to be the same file.

So there is no assembly step, no clause library, and no AI task that writes or
reformats an agreement. What the system does instead is keep track:

- which version is live
- who approved it and when
- which version went to which tenant

That last one is the question asked in a dispute, and it is the one a generated
document cannot answer.

---

## Admin: uploading

```
Upload → Waiting for approval → Mark live → Superseded (when the next is approved)
```

**Upload** takes a PDF or Word file up to 25 MB. The file is hashed on the way
in. The same bytes uploaded twice under two labels is refused: that is a filing
mistake, not two versions.

**Nothing is usable until it is marked live.** An uploaded version sits there
until someone with the Admin role says it is the one.

**Approving supersedes the last.** There is exactly one live version of each
agreement at a time, which is what stops two tenants signing two different
leases in the same week.

**Withdrawing** pulls a version out of use without deleting it. Anything
already signed against it stays valid and stays retrievable — the point is to
stop it being sent again, not to pretend it never existed.

---

## Property Manager: using

The library shows only what has been approved. Sending one records the pairing
and queues the file.

**The particulars go in the covering message, not into the document.** Rent,
deposit and start date are captured at the moment of issue and recorded against
it. Merging them into the file would mean either rewriting the approved
document or filling form fields it may not have, and capturing them separately
means a price change next month cannot rewrite what this tenant was told.

---

## The set

Seeded empty on purpose. An empty library should look empty, so nobody
discovers it on the day they need a lease.

| | |
|---|---|
| Residential Tenancy Agreement | Nothing downstream completes without this |
| Parking Agreement | Separate, so a stall can be given up without reopening the tenancy |
| Storage Locker Agreement | |
| Pet Addendum | Service animals are not pets; this does not apply to them |
| Move-in Inspection Report | Required in Alberta; without it a deposit dispute is hard to defend |
| Move-out Inspection Report | Required in Alberta |
| Security Deposit Receipt | The deposit is in trust; the receipt states where |
| Key and Fob Acknowledgement | |
| Renewal Notice | |
| Notice of Termination | Notice periods come from the RTA — check this one carefully |
| Emergency Contact Form | |

`GET /api/agreements/readiness` reports what is missing, and flags whether the
lease specifically is absent.

---

## What changed elsewhere

**Lease intake** no longer assembles anything. It collects the details, checks
them against the deposit cap and the availability date, and works out which
agreements this tenancy needs. The files come from the library.

**Two AI tasks were removed** — the one that proposed template fields and the
one that reformatted documents. Both existed to support generation, and there
is no generation.

Eight AI tasks remain. None of them touch an agreement.

---

## Storage

Files live under `/app/data/agreements/<code>/` on the `api-data` volume, named
by hash. That volume was already in the backup routine for evidence; it now
holds the agreements too, which raises the cost of losing it considerably.

The hash is on every download response as `X-Content-SHA256`. A copy that does
not match is not the copy that was sent.
