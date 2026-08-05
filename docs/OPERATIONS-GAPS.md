# Gap closure

The items raised against the inventory, and what was built for each.

---

## AuthConsole — contact details and password rotation

Every account now carries both an email and a phone, including the four staff
accounts. An account reachable on one channel is an account that gets locked
out the day that channel fails.

**Reset flow.** A reset queues an email through the outbox rather than sending
inline, so a provider outage delays the message instead of losing it. The link
is email only — a reset link sent by text is a gift to whoever has the phone.

**Rotation.** Passwords expire after 182 days. Two weeks out a warning goes to
the account holder; at expiry they can still sign in but nothing works until a
new one is set. Locking the account outright turns a routine expiry into a
Monday morning support call.

**History.** The last five hashes are kept and checked. Rotating between two
passwords is not a rotation.

---

## LeadsCrm — one application per person

**Hard stop:** an email or phone already on file. Gmail is normalised, because
`a.b+baydo@gmail.com` and `ab@gmail.com` are one mailbox and treating them as
two lets one person apply repeatedly.

**Flagged, not blocked:** a close resemblance. Name similarity above 70% *and*
a partial match on a contact detail raises a flag for a person to decide, with
the reason recorded.

This one is deliberate and worth stating plainly. Two people with the same
common surname are two people. Auto-refusing on name similarity would fall
unevenly across communities where a handful of surnames are shared by thousands
of families, and under the Alberta Human Rights Act that pattern is a problem
whatever was intended by the rule. A name alone never flags — it counts only
alongside a partial contact match.

"The system said no" is not a defensible answer to a complaint. A person
decides, and says why.

---

## Schedule — confirmations

Every booking can send a confirmation by email, text, or both. Defaults follow
what the message is: email for a viewing, both for a key handover or a vendor
visit, because somebody has to be there.

A step waiting on a confirmation does not advance on the assumption that a
message was read. The state shows as awaiting, confirmed or declined, and a
decline is the useful signal — it means the slot is free and somebody should
offer another one rather than turning up to a locked door.

---

## Documents — conversion

Content is restructured for whoever needs it next: PDF for signing, plain text
for reading on a phone in a corridor, CSV for figures going into the ledger.

Clauses, figures and `{{field}}` markers are never touched. This is formatting,
not editing.

The PDF itself is produced server-side. The browser cannot make one reliably,
and a wrong guess in a document somebody signs costs more than the step it
saves.

---

## Operations — deposits

The move-out screen now says what Accounting already covers, so nothing is done
twice. Deposits are held as a trust liability against a separate bank account,
interest accrues at the confirmed annual rate, and the posting and payment
happen in Accounting. The settlement figure is worked out here; the money moves
there.

---

## BuildingManager — entry windows and the second notice

**Windows.** When a tenant will and will not accept access, by weekday or on a
specific date. A refusal is recorded as carefully as availability.

This is advisory rather than enforced. A landlord keeps a right of entry on
proper notice, and an emergency does not wait for a convenient slot. But going
ahead over a stated objection should be a decision somebody makes on purpose,
not something the calendar does quietly.

**The second notice.** The notice of entry is the legal step and goes out
first. A reminder follows 24 hours before, by email or text or both, because a
notice read four days ago is not the same as knowing somebody is at the door
this afternoon — and the tenant may not be home.

Both are bilingual. Both are queued with a `required_by`, so a message that
should have gone and did not is visible rather than silently missing.

---

## AuditLog — search and export

**Search** runs across the action, the record, the person, the date range and
the field values. The useful detail is usually inside the before and after, not
in the label, so the search covers those too.

**Export** takes exactly what is filtered, as CSV or JSON. CSV writes one row
per changed field rather than one per entry, which is what makes it usable in
a spreadsheet.

Every export is itself recorded: who took it, covering what, and a SHA-256 of
the contents. The log is evidence, and a copy of unknown provenance is not
evidence. A file that does not match its recorded hash is not the file that
was taken.

---

## What the outbox is for

Nothing sends directly from the code that caused it. Messages queue, and a
worker delivers them.

That matters most for a notice of entry: "we sent it" has to be provable, and
"it failed and nobody noticed" has to be impossible. Anything with a
`required_by` that has passed and is still queued raises an alert.

**No provider is wired.** Until one is, messages queue and are marked for
review rather than being reported as sent. A silent success here would be worse
than an obvious failure.

Set `EMAIL_PROVIDER_KEY` and complete `deliver()` in `server/src/outbox.js`.
