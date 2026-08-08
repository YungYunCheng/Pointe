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

---

## Month end

Five things belong to a month, in this order. Fees, payroll and depreciation
are expenses of the month — a report issued before they land overstates the
income by exactly those amounts.

```
1  Rent raised
2  Management fee posted
3  Payroll posted
4  Depreciation posted
5  Bank reconciled  →  period reconciled  →  reports  →  closed
```

`GET /api/month-end/:period` returns the checklist and what is outstanding.

---

## What management is paid

The percentage and the wages are both money the property pays to the
management side. They post separately — different expense accounts, and one
carries GST while the other may not — but the console shows the **total** and
what it works out to as a percentage of gross.

That last figure is the useful one. An arrangement that reads as 4% and lands
at 11% once wages are in it is the thing an owner notices a year late.

### Which arrangement was agreed

Two possibilities, and the system cannot read the agreement:

| | |
|---|---|
| Wages on top | The percentage is the company's fee. Wages are charged separately. Total = both. |
| Wages included | The percentage covers everything. Charging wages as well pays twice. |

Which one applies is recorded, and the console says something when the
charging disagrees with it. Confirm it against the signed management agreement
before the first month is posted.

---

## Building the formula

A formula is a **list of parts**. Each part has its own basis, and the total is
their sum after any floor or ceiling.

| Basis | For |
|---|---|
| Percentage of income | The usual arrangement |
| Amount per unit | Wages — the work is there whether the suite is let or not |
| Flat amount | A retainer under a percentage, so a bad month still covers turning up |
| Per lease signed | A leasing fee, paid on work done rather than on the rent roll |
| Hourly | Rate × hours, entered each period |
| Banded percentage | Where the rate falls as income rises |

Parts combine, so "$500 base plus 3% of collected rent, minimum $1,200" is
configuration rather than a code change.

**GST is per part**, because a management fee usually carries it and a wage
does not. One rate on the whole total would put GST on a wage.

**Floors and ceilings belong to the formula, not to a part.** A minimum applied
per part would guarantee the minimum several times over. A ceiling can be
written as "not more than 6% of gross", which is how agreements usually word
it.

**Bands apply to the part of the income inside them**, not a flat rate on the
whole amount at the highest band reached. The latter steps sharply at the
boundary, and nobody agrees to that once they see the number.

**There is no free-text expression box.** A formula somebody can type is a
formula somebody can typo into a number nobody notices until an owner queries
it.

---

## The current arrangement

**4% of income collected, plus GST**, and **$30 per unit** for the building
manager. Both editable.

**Which income counts is the part owners argue about**, so it is listed rather
than assumed. The default scope is rent, parking, storage, pet rent and
laundry. Late fees and damage recovery are excluded: a percentage of a penalty
rewards the penalty, and an owner will eventually ask why the manager profited
from an arrear.

**Collected, not billed**, by default. Charging a percentage of rent that has
not arrived pays the manager on arrears they have not recovered. The basis is
switchable, and the calculation says which one it used.

Posts as:

```
  5030  Property management        4,120.00
  1210  GST receivable               206.00
    2420  Management fee payable            4,326.00
```

The GST is an input tax credit, recoverable on the return.

---

## Building manager payroll

**$30 per unit per month.** Both the rate and which units count are editable.

All 330 units by default — a manager looks after an empty suite as much as a
full one, arguably more during a turnover.

### The part that matters more than the arithmetic

**Employment or contract?** The system will not decide it, and getting it wrong
is a CRA assessment rather than a bookkeeping tidy-up.

| | Employee | Contractor |
|---|---|---|
| Withholding | CPP, EI, income tax | none |
| Employer pays | CPP matched, EI × 1.4 | nothing extra |
| GST | no | if registered |
| Cost of $9,900 gross | roughly $10,700 | $9,900, or $10,395 with GST |

The employer's share sits **on top of** the wage, not inside it. Treating it as
included understates what the position costs by about a tenth.

If the person works set hours under direction and cannot send somebody else,
CRA may treat it as employment whatever the agreement calls it. That is a
question for your accountant, and the assessment lands on the property, not on
them.

Deduction figures are entered, not calculated here — use CRA's payroll
deductions calculator for the period. A wage posted without them understates
what is owed to CRA.

---

## Editing a rate

Rates are **versioned by effective date, never edited in place.**

Change 4% to 4.5% from June and May still calculates at 4%. A rate that reached
backwards would restate months that have been reported and possibly paid, and
the system refuses to set a new rate over a period already posted.

Every calculation keeps its inputs and its method text, so "why was August
$412.80" has an answer without recalculating it from a formula that may since
have changed.

---

## GST filing

Calculated from posted entries: 2300 out, 1210 in, the difference to CRA.

Filing posts the settlement, so neither account carries a balance that belongs
to a period already filed.

Most residential rent is exempt from GST. If the collected figure looks large,
something has been coded to 2300 that should not have been — the method text
says so rather than leaving it to be noticed.

---

## Depreciation

Straight line or declining balance, monthly, idempotent per period. It will not
take an asset below salvage.

Posting produces **one entry for the month** rather than one per asset. Twenty
lines for the same monthly charge makes the account unreadable.

---

## Owner distributions

**Cash basis, not profit.**

```
Operating cash
  less unpaid vendor invoices
  less management fee posted and unpaid
  less payroll posted and unpaid
  less prepaid rent held
  less any reserve
= available
```

Prepaid rent is in that list on purpose: it is a tenant's money sitting in the
account until the charge it belongs to exists. Distributing it spends next
month's rent.

An owner who takes the accrual profit out of an account holding rent that has
not arrived writes a cheque the bank will not honour. That is why the owner
statement shows both figures and this screen shows only the cash one.

A distribution posts against **owner draws**, not as an expense. Booking it as
an expense understates what the property actually earned, which is the number
the owner is trying to see.

The trust account check runs before a distribution is allowed. If deposits and
the trust balance disagree, that is resolved first — distributing while they
are out means possibly distributing a tenant's deposit.
