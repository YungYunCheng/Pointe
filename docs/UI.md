# Colour, and what still has no screen

## The palette

Taken from the two marks. Mizar gives the navy and the steel blue; Baydo gives
the violet and the gold.

| Role | Colour | From |
|---|---|---|
| Admin | `#122542` deep navy | Mizar |
| Property Manager | `#2A6183` steel blue | Mizar |
| Building Manager | `#574A9E` violet | Baydo |
| Accounting | `#2F7D5E` green | Baydo gradient |
| Accent, shared | `#E9B21F` gold | Baydo |

**Each role gets its own.** Not decoration. With four people sharing a screen
and one of them able to post to the ledger, whose session this is should be
answerable at a glance rather than by reading a name in the corner.

What changes: the header, the active tab, primary buttons, focus rings, the
mark, and a three-pixel line along the top of every page.

**Semantic colours do not change.** Red is red for everyone. A warning that
shifted hue depending on who signed in would be a warning nobody learns to
recognise.

**Gold is shared** and belongs to no role, so it reads as "attention" rather
than as somebody's identity. It sits at the end of the top line and nowhere
else.

**Accounting is green rather than gold** because gold on white does not carry
enough contrast for a header, and money already has a colour people expect.

**Admin is the darkest** on purpose. That account restores backups and rewrites
permissions; it should feel like the serious one.

The public tenant site carries Mizar steel blue and Baydo gold rather than a
role colour — a prospective tenant has no role.

---

## What had no screen

Eight things were backend-only. Two new tools cover them.

### Admin console — `/admin`

| | |
|---|---|
| Accounts | Add somebody, set their role, disable them |
| Permissions | Grants and revokes on top of a role, each with a recorded reason |
| System | What is configured and **what breaks when it is not** |
| Retention | The PIPA periods and what each one does |
| Messages | The outbox, with anything past its deadline at the top |

Permissions layer on the role rather than replacing it. A revoke always beats a
grant, so removing something never depends on row order. A change ends that
account's sign-in immediately — otherwise somebody keeps access they were just
told they had lost.

Admin cannot change their own permissions. The one account that can restore
anything should not be able to lock itself out.

The System tab says what each failure costs rather than showing a status
light. "No email provider" means nothing; "every notice, receipt and reset link
is queuing and none of them are arriving" means something.

### Portfolio — `/portfolio`

| | |
|---|---|
| Renewals | 90 days ahead, with the 365-day rule checked before a decision is accepted |
| Turnover | Days vacant, **rent lost so far**, and the same checklist every time |
| Pricing signals | Showings against applications, and how often price was named |
| Owner | Statements, showing what was earned and what can be taken out |

Renewals warn on a large increase, because it is the most common reason a
tenant who would have stayed does not — and a turnover usually costs more than
the difference being argued about.

Pricing returns **flags, not a suggested rent**. What a unit should cost
depends on what else is available nearby, which this system cannot see, and a
number here would be read as an answer.

---

## The last nine

All built. Where each went:

| | Where |
|---|---|
| GST return | Accounting → Month end |
| Fixed assets and depreciation | Accounting → Month end |
| Escalation queue | AI inbox → Needs a person |
| Shadow mode scoring | AI inbox → Shadow mode |
| Signature event history | Agreements → Signing |
| Verify a signed copy | Agreements → Signing |
| Duplicate leads | Leads → Duplicates |
| Release keys | Operations → Release keys |
| Contact preferences | Tenant portal → Documents |

A few of these are worth a note.

**The escalation queue sorts overdue first**, and shows the clock rather than a
count. A tenant was told one business day; silence past that is what turns a
question into a complaint.

For the protected-ground rules the content is not shown in the list. The
notification did not repeat it either — what travels is the rule reference.

**Shadow mode reports the error rate on what would have sent**, not overall
accuracy. Drafts a person reviews anyway get caught either way; what decides
whether this can run unsupervised is how often something wrong would have gone
out with nobody looking. The threshold shown is 2% across at least a hundred
reviewed, and even then turning it on is a decision somebody makes.

**Verifying a copy** hashes the file in the browser and says whether it matches
something signed here. If somebody produces a lease and says it is the one,
that is how you find out — and a mismatch means it has been altered since
signing or was never signed through this system.

**Merging leads keeps the oldest record** because it holds the first contact
date, which is what the response-time figures are measured from, and takes the
furthest-along stage. Notes move rather than being discarded.

**Releasing keys** records whether the deposit and first month arrived. Both
can be skipped, and the screen says plainly why that is a bad idea: once
somebody has keys, the leverage is gone.

**Contact preferences cover marketing only.** A notice of entry is a legal
obligation and is not affected. The tenant is told that on the same screen, so
somebody who turns everything off and then receives an entry notice does not
think the switch was ignored.

---

## Still without a screen

Nothing on the feature list. What remains is the wiring: every tool still
reads browser storage rather than the API, which is the gap in
`docs/WIRING.md` and the reason locks and queues do not yet hold across two
browsers.
