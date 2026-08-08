-- ============================================================
-- Baydo Pointe — management remuneration
--
-- The 4% and the wages are both money the property pays to the
-- management side. Kept as separate postings, because they hit
-- different expense accounts and one carries GST while the other
-- may not — but grouped so the total is visible.
--
-- That total is the number an owner asks about, and adding two
-- figures from two screens is how somebody gets it wrong.
--
-- A formula is built from components. Each has its own basis, and
-- the total is their sum after any cap. That way "4% of collected
-- income" and "$30 per unit plus a $500 base" are the same shape,
-- and a change of arrangement is a change of configuration rather
-- than a change of code.
-- ============================================================

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS formula_components (
  id            TEXT PRIMARY KEY,
  formula_id    TEXT NOT NULL REFERENCES fee_formulas(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL DEFAULT 1,
  label         TEXT NOT NULL,

  basis         TEXT NOT NULL CHECK (basis IN
                  ('percent_of_income','per_unit','flat','per_lease','hourly','tiered')),

  rate          REAL,                       -- 0.04
  per_unit_rate REAL,                       -- 30.00
  flat_amount   REAL,                       -- 500.00
  hourly_rate   REAL,
  hours         REAL,

  income_scope  TEXT,                       -- JSON array of GL codes
  income_basis  TEXT DEFAULT 'collected'
                CHECK (income_basis IN ('collected','billed')),
  unit_scope    TEXT DEFAULT 'all'
                CHECK (unit_scope IN ('all','occupied','vacant','leased')),

  -- Banded: [{"upto":50000,"rate":0.05},{"upto":null,"rate":0.03}]. A tier
  -- with no upper bound has to be last, or everything above it is unpriced.
  tiers         TEXT,

  gst_applies   INTEGER NOT NULL DEFAULT 0,
  expense_gl    TEXT REFERENCES gl_accounts(code),
  note          TEXT
);
CREATE INDEX IF NOT EXISTS idx_fcomp ON formula_components(formula_id, seq);

-- Caps live on the formula, not the component: a minimum that applied per
-- component would guarantee the minimum several times over.
CREATE TABLE IF NOT EXISTS formula_caps (
  formula_id  TEXT PRIMARY KEY REFERENCES fee_formulas(id) ON DELETE CASCADE,
  minimum     REAL,
  maximum     REAL,
  -- A cap expressed against income rather than a flat figure, which is how
  -- most agreements word it: "not more than 6% of gross".
  max_percent_of_income REAL,
  note        TEXT
);

-- Grouping, so the total the property pays for management is one number in
-- one place.
CREATE TABLE IF NOT EXISTS remuneration_groups (
  code        TEXT PRIMARY KEY,
  label_en    TEXT NOT NULL,
  label_zh    TEXT NOT NULL,
  description TEXT,
  -- What the arrangement says the fee covers. If wages are inside the
  -- percentage, charging them again is double charging; if they are outside,
  -- the total is the percentage plus the wages. This records which.
  wages_included INTEGER NOT NULL DEFAULT 0,
  agreed_note TEXT,
  updated_by  TEXT REFERENCES users(id),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Which formulas belong to the group.
CREATE TABLE IF NOT EXISTS remuneration_members (
  group_code  TEXT NOT NULL REFERENCES remuneration_groups(code) ON DELETE CASCADE,
  fee_code    TEXT NOT NULL,
  seq         INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (group_code, fee_code)
);
