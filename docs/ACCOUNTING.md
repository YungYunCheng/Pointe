# Accounting

Double entry, per building, with a period close. Roughly what Yardi does for
property and QuickBooks does for bookkeeping, scoped to 330 units.

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

**Yardi.** The compose file and earlier notes treat Yardi as the financial
system of record. This module makes that a decision rather than an assumption:
one of them owns the numbers. Two systems that both accept a rent receipt will
disagree within a month.
