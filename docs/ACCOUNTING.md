# Accounting

Double entry, per building, with a period close. This is the financial system
of record — there is nothing behind it.

---

## The one thing to get right

A security deposit is the tenant's money. Under the Alberta RTA it is held in
trust, it earns interest owed back to them, and it is never revenue.

In the ledger that means two accounts move together:

| | |
|---|---|
| `1020` Trust bank account | Asset. A separate bank account holding nothing else. |
| `2100` Security deposits held | Liability. What we owe tenants. |
| `2110` Deposit interest payable | Liability. Interest accrued and owed. |

`1020` must equal `2100 + 2110` at all times. The dashboard checks this on every
load and says so in red when it does not. A difference means either the trust
account paid for something it should not have, or a deposit was posted to the
wrong place. Both need finding before the next refund, not at year end.

Booking a deposit to revenue makes a year look good and leaves nothing to refund.
It is the most common way a small landlord ends up in front of RTDRS.

---

## Chart of accounts

Standard blocks so anyone who has seen a set of books can navigate:

```
1000  Assets          1010 operating bank · 1020 trust bank · 1100 AR · 1210 GST receivable
2000  Liabilities     2010 AP · 2100 deposits held · 2110 deposit interest · 2200 prepaid rent
3000  Equity          3010 capital · 3020 draws · 3900 retained earnings
4000  Revenue         4010 rent · 4020 parking · 4030 storage · 4040 pet rent · 4060 late fees
5000  Expenses        5010 repairs · 5020-5022 utilities · 5040 insurance · 5100 deposit interest
```

An account that has been posted to cannot change its type or normal side. That
would rewrite the meaning of every entry already made against it.

---

## Rent

**Charge schedules** define what each lease bills and on which day. One row per
charge, so rent, parking, storage and pet rent are separate lines against
separate revenue accounts rather than one blended figure.

The charge day is capped at the 28th. A schedule set to the 30th silently skips
February, and nobody notices until the year-end numbers look wrong.

**The rent run** raises the month's charges. It is idempotent: a unique index on
`(schedule, period)` means running it twice adds nothing. A retry after a crash
is safe rather than 330 double charges.

**Proration** happens automatically when a tenancy starts or ends mid-month. The
calculation is stored on the charge (`prorate_note`), so "why is this $1,161.29
and not $1,450" has an answer without anyone reconstructing it.

**Receipts** apply against specific charges. Money beyond what is owed goes to
`2200` prepaid rent, not income — it is still the tenant's until there is a
charge to set it against.

---

## Bills

A vendor invoice is entered as **draft**. Draft invoices are outside the ledger,
so a bill keyed by mistake never touches the accounts. **Approving** it posts:

```
  5010  Repairs and maintenance     682.50
  1210  GST receivable               34.13
    2010  Accounts payable                 716.63
```

The unique index on `(vendor, invoice_no)` catches the same bill entered twice,
which is the most common AP error and the hardest to spot afterwards.

---

## Reconciliation and the close

```
1  Statements uploaded        every bank account, including trust
2  Every line matched         an unmatched line is a transaction nobody accounted for
3  Period reconciled          statement balance equals ledger balance, to the cent
4  Period closed              nothing can post into it afterwards
```

Reconciling "with a small difference" is refused. A difference allowed once
becomes permanent and untraceable.

Statement rows are pasted as CSV rather than parsed from a PDF. Parsing a bank
PDF in the browser is a guess dressed up as a feature, and a wrong guess in the
bank reconciliation is worse than typing it.

A closed period rejects new postings. Something that turns up afterwards is
posted to the current month with a note, not backdated — backdating a closed
month changes a report someone has already read.

---

## Monthly reports

One per building, generated only once the period is reconciled.

The figures are computed in SQL from posted entries. The AI is handed those
figures plus a written derivation of each one, and told explicitly not to
recalculate anything. Its job is to say what the numbers show.

Every report carries its method:

> Net operating income: revenue $412,300 less expenses $118,940 = $293,360.
> Accrual basis, so it counts what was billed and incurred, not what moved
> through the bank.
>
> Collection rate: $408,100 ÷ $412,300 = 99.0%. A receipt clearing an older
> arrear counts here, which is why collection can exceed 100%.

A number without its derivation is something to argue about later.

---

## Who can do what

| | Admin | Accounting | PM | BM |
|---|:--:|:--:|:--:|:--:|
| View ledgers and reports | ✓ | ✓ | ✓ | |
| Post entries, receipts, invoices | ✓ | ✓ | | |
| Approve vendor invoices | ✓ | ✓ | | |
| Upload statements, reconcile | ✓ | ✓ | | |
| Close a period | ✓ | ✓ | | |
| Edit the chart of accounts | ✓ | ✓ | | |

Accounting sees the money and the units it belongs to. Leads, applications and
tenant messages are not part of that role. Property Managers get read access
because arrears change how you handle a renewal.

---

## Jobs

| | | |
|---|---|---|
| Rent run | daily | Bills any schedule whose charge day is today |
| Schedule cleanup | daily | Ends schedules whose lease has ended |
| Arrears summary | daily | One notification, not one per overdue charge |
| Month-end prompt | 1st | Raises the close; nothing closes itself |

---

## Still open

**Deposit interest rate is a placeholder.** `deposit_interest_rates` ships with
0.0 for the current year. Set the published rate before accruing, or every
refund is short.

**GST returns.** `1210` and `2300` track it; the filing itself does not exist.

**Depreciation.** `1500` and `1510` exist and nothing posts to them.

**Owner statements and distributions.** Not built.

---

## Amendments

Nothing posted is edited in place and nothing is deleted.

**A draft** has never touched the ledger, so it edits freely.

**A posted document** amends: the original entry is reversed, a replacement is
posted, and both stay visible. The document keeps its id and its number — so
anything linked to it still resolves — and gains a version.

```
Invoice 4471  v1   $682.50   repairs           entry #118  (reversed)
                             ↓  amended: coded to the wrong account
Invoice 4471  v2   $745.00   elevator maint.   entry #131 reversal
                                               entry #132 replacement
```

This is what lets someone fix a keying error without unpicking the payments and
re-entering everything. It is also what an auditor expects: a correction is an
event, not a gap where a number used to be.

Two things are refused:

**An amendment below what has already been paid.** Refunding an overpayment is a
decision, not a side effect of correcting a typo.

**An amendment with no reason.** Six months later the reason matters more than
the number.

Amending a receipt unwinds what it was applied to and reapplies it, so the
charges it was covering return to open until the new amount is allocated.

### The change log

Every amendment records the fields that moved, computed by comparing snapshots.
That record does not depend on anyone remembering to describe what they changed.

Beside it, the AI writes one sentence:

> Invoice 4471 from Northgate Plumbing amended from $682.50 to $745.00 and moved
> from repairs to elevator maintenance, because the original was coded to the
> wrong account.

The sentence adds nothing to the record. It exists so that reading a month of
changes does not mean reading JSON. If the AI is unavailable the log still works
and still holds everything that matters.

---

## Deposit interest

Alberta sets the rate annually under the Security Deposit Interest Rate
Regulation. Every deposit held earns it and every refund includes it.

The AI looks the figure up and reports where it came from. It does not set it.

A wrong rate here multiplies across every deposit and is not discovered until
someone moves out and their refund is short — which is exactly the failure a
model is good at producing and nobody is watching for. So a proposal carries a
confidence and a source, an unverified one is flagged in red, and a person
confirms before the accrual has anything to run on.

Rates are stored per year, not as one setting: a deposit held across several
years accrues at each year's own rate.

Until a rate is confirmed the accrual does nothing, and a notification says so
rather than letting it fail quietly.
