# Electronic signature

DocuSign-shaped: send, sign in a browser, signed copy back to the Property
Manager and emailed to the tenant.

---

## What actually makes it hold up

Not the drawn mark. A squiggle on a PDF proves very little on its own.

What answers a challenge is the trail: that this person opened this document at
this time from this address, that they agreed beforehand to sign
electronically, and that the file hash before and after accounts for every
change.

Alberta's Electronic Transactions Act asks whether the parties consented to
sign electronically. "They clicked the sign button, so they must have" is not
an answer to that, which is why consent is a separate recorded step here.

---

## The flow

```
PM prepares      →  picks the approved version, adds parties, places fields
PM sends         →  first signer only, by email
Tenant opens     →  recorded: time, address, browser
Tenant reads     →  the document opens before the signature panel does
Tenant consents  →  recorded separately, with its own timestamp
Tenant signs     →  drawn or typed, plus any date and text fields
PM countersigns  →  invited automatically once the tenant has signed
Complete         →  signed file + certificate, to everyone who signed
```

**Ordered signing is the default.** A countersignature on a document the tenant
has not signed yet means nothing, so the second party is not invited until the
first is done.

**Reading comes before the pen.** A flow that puts the signature panel first is
one where somebody signs without reading, and that is the first thing raised
when a lease is disputed.

---

## The document is never modified

The source file — the version a lawyer approved — is stored once and never
touched. Signing produces a **new** file with the marks drawn on top.

Nothing in the text moves, reflows or is regenerated. A signature that pushed a
clause onto the next page would be worse than no signature.

Both hashes are recorded. Before signing, the source hash is verified against
what was sent: if the stored file no longer matches, the process stops rather
than signing something that has changed.

---

## The certificate

Appended to the signed document as extra pages, so nobody can forward the
pages they like without it. It carries:

- the agreement, version and filename
- the hash before signing and the hash after
- every party: email, when they consented, when they signed, from what address, and whether the mark was drawn or typed
- every event in order, with timestamps

Plus a plain-English note explaining what the hashes mean and that a copy which
does not match the second one is not the document that was signed.

`POST /api/signatures/verify` takes a hash and says whether it matches anything
signed here. If somebody produces a lease and says it is the one, that is how
you find out.

---

## Distribution

On completion the signed copy goes to **everyone who signed it**, not just the
staff side. A tenant who has to ask for a copy of their own lease has been
given a reason not to trust the process.

The Property Manager gets a notification, and the agreement issue moves to
signed automatically, so the record of which version went to whom does not need
updating by hand.

---

## Declining

Offered plainly on the signing page, not hidden. Hiding it is how somebody
signs something they did not want to sign.

A decline notifies the Property Manager with the reason. It is a normal
outcome — usually one term needs discussing — and the page says so.

---

## Drawn or typed

Both are accepted and both are recorded for what they are.

A typed name proves somebody had the link. A drawn mark is at least
characteristic, and the signing page says as much rather than pretending they
are equivalent.

---

## What is still manual

**Field placement** is by page and coordinates, in points from the bottom-left
of the page. `GET /api/signatures/inspect/:versionId` returns the page sizes so
the numbers are checked against the real document rather than guessed. A visual
placement tool would be better; this works and is honest about needing care —
a signature box over a clause hides the clause.

**Identity** is the email link. For a tenant who applied through the site and
has been corresponding from that address, that is proportionate. If you want
more, `signature_parties.access_code` exists for a second factor and nothing
uses it yet.

---

## Before relying on this

Have your lawyer look at the **process**, not the code: the consent wording,
what the certificate records, and how long the signed files are kept. Those are
the parts a challenge would go after, and they are settled by advice rather
than by engineering.
