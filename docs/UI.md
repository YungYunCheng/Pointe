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

## Still without a screen

**Escalation queue.** Raising one works and the email goes out; there is no
screen listing open threads with a clock. It belongs in the AI inbox.

**Signature detail.** The list shows progress; the full event history and the
certificate download are backend-only.

**Lead merge.** Duplicates are found by the API; nothing surfaces them.

**Shadow mode review.** Runs are recorded, but scoring them one by one — which
is the whole point — has no screen.

**Key release.** The Building Manager sees that keys are not released. The
Property Manager has no screen to release them; it is an API call.

**Signature verification.** `POST /api/signatures/verify` takes a hash and says
whether it matches something signed here. No screen.
