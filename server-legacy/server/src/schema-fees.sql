-- ============================================================
-- Baydo Pointe — management fees, payroll, distributions
--
-- Formulas are versioned by effective date, not overwritten. Change
-- the rate in June and May still calculates at the old one — a rate
-- that applies retroactively rewrites months somebody has already
-- been paid on.
-- ============================================================

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS fee_formulas (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL,              -- management_fee | bm_payroll
  label_en      TEXT NOT NULL,
  label_zh      TEXT NOT NULL,

  -- How it is worked out. Kept as parts rather than an expression, because a
  -- formula somebody can type is a formula somebody can typo into a number
  -- nobody notices.
  basis         TEXT NOT NULL,              -- percent_of_income | per_unit | flat
  rate          REAL,                       -- 0.04 for 4%
  per_unit_rate REAL,                       -- 30.00
  flat_amount   REAL,

  -- Which income counts. This is the part that causes arguments with owners,
  -- so it is explicit rather than assumed.
  income_scope  TEXT,                       -- JSON array of GL codes
  income_basis  TEXT DEFAULT 'collected'
                CHECK (income_basis IN ('collected','billed')),
  unit_scope    TEXT DEFAULT 'all'
                CHECK (unit_scope IN ('all','occupied','leased')),

  gst_applies   INTEGER NOT NULL DEFAULT 1,
  gst_rate      REAL NOT NULL DEFAULT 0.05,

  expense_gl    TEXT REFERENCES gl_accounts(code),
  gst_gl        TEXT REFERENCES gl_accounts(code),
  payable_gl    TEXT REFERENCES gl_accounts(code),

  building_code TEXT REFERENCES buildings(code),   -- null = the whole property
  effective_from TEXT NOT NULL,
  effective_to  TEXT,
  note          TEXT,
  created_by    TEXT REFERENCES users(id),
  created_name  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fee_code ON fee_formulas(code, effective_from DESC);

-- Each month's calculation, with the inputs kept. "Why was August $412.80"
-- has to have an answer without recalculating it from a formula that may
-- since have changed.
CREATE TABLE IF NOT EXISTS fee_calculations (
  id            TEXT PRIMARY KEY,
  formula_id    TEXT NOT NULL REFERENCES fee_formulas(id),
  code          TEXT NOT NULL,
  period        TEXT NOT NULL,
  building_code TEXT REFERENCES buildings(code),

  base_amount   REAL NOT NULL,              -- the income, or the unit count
  base_detail   TEXT,                       -- what went into it, line by line
  rate_used     REAL,
  subtotal      REAL NOT NULL,
  gst           REAL NOT NULL DEFAULT 0,
  total         REAL NOT NULL,
  method        TEXT NOT NULL,              -- how it was worked out, in words

  entry_id      TEXT REFERENCES journal_entries(id),
  state         TEXT NOT NULL DEFAULT 'draft'
                CHECK (state IN ('draft','approved','posted','paid','void')),
  approved_by   TEXT REFERENCES users(id),
  approved_name TEXT,
  approved_at   TEXT,
  paid_at       TEXT,
  void_reason   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (code, period, building_code)
);
CREATE INDEX IF NOT EXISTS idx_feecalc_period ON fee_calculations(period, code);

-- Payroll, kept apart from a plain expense because employment carries
-- withholding obligations that a contractor invoice does not.
CREATE TABLE IF NOT EXISTS payroll_runs (
  id            TEXT PRIMARY KEY,
  period        TEXT NOT NULL,
  person_name   TEXT NOT NULL,
  person_id     TEXT REFERENCES users(id),
  engagement    TEXT NOT NULL DEFAULT 'contractor'
                CHECK (engagement IN ('employee','contractor')),
  unit_count    INTEGER,
  rate_per_unit REAL,
  gross         REAL NOT NULL,

  -- Employee only. A contractor invoices and remits their own.
  cpp_employee  REAL DEFAULT 0,
  ei_employee   REAL DEFAULT 0,
  tax_withheld  REAL DEFAULT 0,
  cpp_employer  REAL DEFAULT 0,
  ei_employer   REAL DEFAULT 0,

  -- Contractor only, and only if they are registered.
  gst           REAL DEFAULT 0,

  net_pay       REAL NOT NULL,
  employer_cost REAL NOT NULL,
  method        TEXT NOT NULL,
  entry_id      TEXT REFERENCES journal_entries(id),
  state         TEXT NOT NULL DEFAULT 'draft'
                CHECK (state IN ('draft','approved','posted','paid','void')),
  approved_by   TEXT REFERENCES users(id),
  approved_name TEXT,
  approved_at   TEXT,
  paid_at       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (period, person_name)
);

-- Distributions to the owner. Cash going out, not an expense: it reduces
-- equity rather than profit, and treating it as an expense understates the
-- income the property actually made.
CREATE TABLE IF NOT EXISTS owner_distributions (
  id            TEXT PRIMARY KEY,
  period        TEXT NOT NULL,
  building_code TEXT REFERENCES buildings(code),
  amount        REAL NOT NULL,
  cash_available REAL,
  reserve_held  REAL DEFAULT 0,
  method        TEXT NOT NULL,
  statement_id  TEXT REFERENCES owner_statements(id),
  entry_id      TEXT REFERENCES journal_entries(id),
  paid_from     TEXT DEFAULT '1010' REFERENCES gl_accounts(code),
  state         TEXT NOT NULL DEFAULT 'draft'
                CHECK (state IN ('draft','approved','paid','void')),
  approved_by   TEXT REFERENCES users(id),
  approved_name TEXT,
  approved_at   TEXT,
  paid_at       TEXT,
  reference     TEXT,
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dist_period ON owner_distributions(period);
