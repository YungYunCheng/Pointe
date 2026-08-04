# Data

`unit-inventory.xlsx` — all 330 units taken from the floor plans in the marketing
package dated 2025-11-17. Three sheets: a summary by unit type, the full unit
list, and project details.

Two discrepancies against the marketing summary are worth knowing about, both
noted on the project sheet:

- The summary counts 138 one-bedroom and 67 three-bedroom units. Counting unit by
  unit off the floor plans gives 137 and 68. The total of 330 agrees, so one unit
  is classified differently somewhere.
- The 3A layout is drawn as a primary bedroom, a second bedroom and a den, but
  the summary counts it as three bedrooms. Advertise it as "2 bed + den" — a
  tenant who arrives expecting a third bedroom has a fair complaint.

The seed data in `server/src/seed.js` follows the floor plans, not the summary.
