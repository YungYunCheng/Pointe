# Tenant site

Public listings, viewings, applications, and the portal for people who have
moved in. Bilingual throughout, following the tenant's saved choice or their
browser.

```bash
npm install
npm run dev        # http://localhost:3001
npm run build
```

## Pages

| Route | What it does |
|---|---|
| `/` | Availability, amenities, and the parking position |
| `/suites` | Live vacancy by layout, with current rents |
| `/building` | The three buildings |
| `/book` | Pick a slot for a viewing |
| `/apply` | Six-step application, draft saved as you go |
| `/portal` | Repairs, notices, rent, documents |

The chat widget sits on every page.

## Two things this site says out loud

**Parking is short.** 222 stalls against 330 suites. It is on the home page, the
buildings page and inside the application. A tenant who learns this after signing
has a fair complaint; one who knew before signing does not.

**Every cost appears before the application is submitted**, not after approval.
Alberta caps the security deposit at one month's rent and counts a pet deposit
inside that cap, so there is nothing to hold back. Step 4 shows the monthly total
and the move-in total, and asks the tenant to confirm they have read them.

## What the application does not ask

Household composition, marital status, nationality, immigration status, religion,
age, gender and source of income are protected grounds under the Alberta Human
Rights Act. None of them appear in the form.

The number of occupants is asked, because occupancy limits are legitimate, and
the form says why it is asked.

A service animal is not a pet. Ticking that box removes the pet deposit and the
pet rent and says so, rather than leaving the tenant to argue it later.

## Wiring to the API

Currently writes to browser storage. Replace with `fetch` when the endpoints
exist:

| Storage key | Endpoint |
|---|---|
| `baydo:bookings` | `POST /api/public/showings` |
| `baydo:applications` | `POST /api/public/applications` |
| `baydo:apply-draft` | stays local — a draft should not leave the browser |
| `baydo:tenant-session` | `POST /api/tenant/login` |
| `baydo:tenant-repairs` | `POST /api/tenant/repairs` |

The portal reads `baydo:entrynotices` for notices of entry. That one already has
a server table behind it.

## Not built yet

- Real slot availability. `Booking.jsx` generates slots from office hours; the
  server knows which are taken and whether a suite needs 24 hours' notice.
- Photos. There are no suite images, so the cards are typographic.
- Rent payment links out to the accounting system and is not wired up.
