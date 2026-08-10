-- ============================================================
-- Baydo Pointe — accounting
--
-- Double entry throughout. Every posting writes balanced journal
-- lines, and nothing edits a posted entry: corrections are new
-- entries that reverse. That is what makes a month closable.
--
-- One thing here is not a preference. Under the Alberta RTA a
-- security deposit is the tenant's money held in trust. It is a
-- liability in a separate bank account, never revenue, and it
-- earns interest owed back to the tenant. Booking a deposit as
-- income is the single most common way a small landlord ends up
-- unable to return it.
-- ============================================================

PRAGMA foreign_keys = ON;

-- ---------- Chart of accounts ----------
CREATE TABLE IF NOT EXISTS gl_accounts (
  code        TEXT PRIMARY KEY,             -- 1010, 4010 …
  name_en     TEXT NOT NULL,
  name_zh     TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('asset','liability','equity','revenue','expense')),
  parent_code TEXT REFERENCES gl_accounts(code),
  normal_side TEXT NOT NULL CHECK (normal_side IN ('debit','credit')),
  is_postable INTEGER NOT NULL DEFAULT 1,   -- headers are not postable
  is_trust    INTEGER NOT NULL DEFAULT 0,   -- deposit trust accounts
  is_bank     INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1,
  note        TEXT
);
CREATE INDEX IF NOT EXISTS idx_gl_parent ON gl_accounts(parent_code);

-- ---------- Vendors ----------
CREATE TABLE IF NOT EXISTS vendors (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  contact      TEXT,
  email        TEXT,
  phone        TEXT,
  address      TEXT,
  gst_number   TEXT,
  default_gl   TEXT REFERENCES gl_accounts(code),
  payment_terms INTEGER DEFAULT 30,         -- net days
  is_active    INTEGER NOT NULL DEFAULT 1,
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vendor_name ON vendors(name);

-- ---------- Journal ----------
-- A posted entry is immutable. Fixing one means posting a reversal
-- and a replacement, which is what an auditor expects to see.
CREATE TABLE IF NOT EXISTS journal_entries (
  id            TEXT PRIMARY KEY,
  entry_no      INTEGER,
  entry_date    TEXT NOT NULL,
  period        TEXT NOT NULL,              -- YYYY-MM, drives the close
  building_code TEXT REFERENCES buildings(code),
  source        TEXT NOT NULL,              -- rent_run | ap_invoice | ar_receipt | deposit | manual | reversal
  source_id     TEXT,
  memo          TEXT,
  state         TEXT NOT NULL DEFAULT 'posted' CHECK (state IN ('posted','reversed')),
  reverses_id   TEXT REFERENCES journal_entries(id),
  created_by    TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_je_period ON journal_entries(period, building_code);
CREATE INDEX IF NOT EXISTS idx_je_source ON journal_entries(source, source_id);

CREATE TABLE IF NOT EXISTS journal_lines (
  id            TEXT PRIMARY KEY,
  entry_id      TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  line_no       INTEGER NOT NULL,
  gl_code       TEXT NOT NULL REFERENCES gl_accounts(code),
  debit         REAL NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit        REAL NOT NULL DEFAULT 0 CHECK (credit >= 0),
  building_code TEXT REFERENCES buildings(code),
  unit_number   TEXT,
  vendor_id     TEXT REFERENCES vendors(id),
  contact_id    TEXT,
  memo          TEXT,
  CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
);
CREATE INDEX IF NOT EXISTS idx_jl_entry ON journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS idx_jl_gl ON journal_lines(gl_code);
CREATE INDEX IF NOT EXISTS idx_jl_unit ON journal_lines(unit_number);
CREATE INDEX IF NOT EXISTS idx_jl_vendor ON journal_lines(vendor_id);

-- ---------- Recurring charges: what a lease bills each month ----------
CREATE TABLE IF NOT EXISTS charge_schedules (
  id            TEXT PRIMARY KEY,
  lease_id      TEXT REFERENCES leases(id),
  unit_number   TEXT NOT NULL REFERENCES units(unit_number),
  contact_id    TEXT REFERENCES contacts(id),
  kind          TEXT NOT NULL,              -- rent | parking | storage | pet | other
  gl_code       TEXT NOT NULL REFERENCES gl_accounts(code),
  amount        REAL NOT NULL,
  charge_day    INTEGER NOT NULL DEFAULT 1 CHECK (charge_day BETWEEN 1 AND 28),
  due_day       INTEGER NOT NULL DEFAULT 1 CHECK (due_day BETWEEN 1 AND 28),
  start_date    TEXT NOT NULL,
  end_date      TEXT,                       -- follows the lease end
  prorate_first INTEGER NOT NULL DEFAULT 1, -- part month when moving in mid-month
  prorate_last  INTEGER NOT NULL DEFAULT 1,
  is_active     INTEGER NOT NULL DEFAULT 1,
  note          TEXT,
  created_by    TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cs_unit ON charge_schedules(unit_number) WHERE is_active = 1;
CREATE INDEX IF NOT EXISTS idx_cs_day ON charge_schedules(charge_day) WHERE is_active = 1;

-- Charge day is capped at 28 on purpose: a schedule set to the 30th
-- silently skips February, and nobody notices until the year-end.

-- ---------- AR: what tenants owe ----------
CREATE TABLE IF NOT EXISTS ar_charges (
  id            TEXT PRIMARY KEY,
  schedule_id   TEXT REFERENCES charge_schedules(id),
  lease_id      TEXT REFERENCES leases(id),
  unit_number   TEXT NOT NULL REFERENCES units(unit_number),
  contact_id    TEXT REFERENCES contacts(id),
  building_code TEXT REFERENCES buildings(code),
  period        TEXT NOT NULL,              -- YYYY-MM the charge belongs to
  kind          TEXT NOT NULL,
  gl_code       TEXT NOT NULL REFERENCES gl_accounts(code),
  description   TEXT,
  amount        REAL NOT NULL,
  prorated      INTEGER NOT NULL DEFAULT 0,
  prorate_note  TEXT,                       -- how the part month was worked out
  charge_date   TEXT NOT NULL,
  due_date      TEXT NOT NULL,
  entry_id      TEXT REFERENCES journal_entries(id),
  state         TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','paid','partial','written_off','void')),
  paid_amount   REAL NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (schedule_id, period)              -- the same month cannot be billed twice
);
CREATE INDEX IF NOT EXISTS idx_ar_open ON ar_charges(state, due_date);
CREATE INDEX IF NOT EXISTS idx_ar_unit ON ar_charges(unit_number, period);

CREATE TABLE IF NOT EXISTS ar_receipts (
  id            TEXT PRIMARY KEY,
  receipt_no    INTEGER,
  unit_number   TEXT REFERENCES units(unit_number),
  contact_id    TEXT REFERENCES contacts(id),
  building_code TEXT REFERENCES buildings(code),
  received_date TEXT NOT NULL,
  amount        REAL NOT NULL CHECK (amount > 0),
  method        TEXT NOT NULL,              -- etransfer | cheque | preauth | cash | card
  reference     TEXT,
  deposit_to    TEXT NOT NULL REFERENCES gl_accounts(code),
  entry_id      TEXT REFERENCES journal_entries(id),
  bank_txn_id   TEXT,                       -- set when matched to a statement line
  note          TEXT,
  created_by    TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rc_date ON ar_receipts(received_date);
CREATE INDEX IF NOT EXISTS idx_rc_unit ON ar_receipts(unit_number);

-- Applying a receipt to specific charges, so a partial payment is
-- traceable rather than a floating credit.
CREATE TABLE IF NOT EXISTS ar_applications (
  id         TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES ar_receipts(id) ON DELETE CASCADE,
  charge_id  TEXT NOT NULL REFERENCES ar_charges(id),
  amount     REAL NOT NULL CHECK (amount > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_app_charge ON ar_applications(charge_id);

-- ---------- AP: what we owe vendors ----------
CREATE TABLE IF NOT EXISTS ap_invoices (
  id            TEXT PRIMARY KEY,
  vendor_id     TEXT NOT NULL REFERENCES vendors(id),
  invoice_no    TEXT NOT NULL,
  invoice_date  TEXT NOT NULL,
  due_date      TEXT NOT NULL,
  building_code TEXT REFERENCES buildings(code),
  unit_number   TEXT,
  subtotal      REAL NOT NULL,
  gst           REAL NOT NULL DEFAULT 0,
  total         REAL NOT NULL,
  description   TEXT,
  ticket_id     TEXT,                       -- links back to the maintenance ticket
  entry_id      TEXT REFERENCES journal_entries(id),
  state         TEXT NOT NULL DEFAULT 'draft'
                CHECK (state IN ('draft','approved','paid','partial','void')),
  paid_amount   REAL NOT NULL DEFAULT 0,
  approved_by   TEXT REFERENCES users(id),
  approved_at   TEXT,
  created_by    TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (vendor_id, invoice_no)            -- catches the same invoice entered twice
);
CREATE INDEX IF NOT EXISTS idx_ap_state ON ap_invoices(state, due_date);
CREATE INDEX IF NOT EXISTS idx_ap_vendor ON ap_invoices(vendor_id);

CREATE TABLE IF NOT EXISTS ap_invoice_lines (
  id            TEXT PRIMARY KEY,
  invoice_id    TEXT NOT NULL REFERENCES ap_invoices(id) ON DELETE CASCADE,
  line_no       INTEGER NOT NULL,
  gl_code       TEXT NOT NULL REFERENCES gl_accounts(code),
  description   TEXT,
  amount        REAL NOT NULL,
  building_code TEXT REFERENCES buildings(code),
  unit_number   TEXT
);
CREATE INDEX IF NOT EXISTS idx_apl_invoice ON ap_invoice_lines(invoice_id);

CREATE TABLE IF NOT EXISTS ap_payments (
  id           TEXT PRIMARY KEY,
  payment_no   INTEGER,
  vendor_id    TEXT NOT NULL REFERENCES vendors(id),
  payment_date TEXT NOT NULL,
  amount       REAL NOT NULL CHECK (amount > 0),
  method       TEXT NOT NULL,
  reference    TEXT,
  paid_from    TEXT NOT NULL REFERENCES gl_accounts(code),
  entry_id     TEXT REFERENCES journal_entries(id),
  bank_txn_id  TEXT,
  created_by   TEXT REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ap_applications (
  id         TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES ap_payments(id) ON DELETE CASCADE,
  invoice_id TEXT NOT NULL REFERENCES ap_invoices(id),
  amount     REAL NOT NULL CHECK (amount > 0)
);

-- ---------- Deposits held in trust ----------
-- Kept apart from AR because this money is not ours. The balance here
-- must agree with the trust bank account at all times.
CREATE TABLE IF NOT EXISTS deposit_ledger (
  id            TEXT PRIMARY KEY,
  lease_id      TEXT REFERENCES leases(id),
  unit_number   TEXT NOT NULL REFERENCES units(unit_number),
  contact_id    TEXT REFERENCES contacts(id),
  building_code TEXT REFERENCES buildings(code),
  kind          TEXT NOT NULL CHECK (kind IN ('received','interest','deduction','refund')),
  amount        REAL NOT NULL,              -- positive holds, negative releases
  txn_date      TEXT NOT NULL,
  basis         TEXT,                       -- required for a deduction
  moveout_id    TEXT,
  entry_id      TEXT REFERENCES journal_entries(id),
  created_by    TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dep_unit ON deposit_ledger(unit_number);

-- The rate is a setting, not a constant, because it changes.
CREATE TABLE IF NOT EXISTS deposit_interest_rates (
  year      INTEGER PRIMARY KEY,
  rate      REAL NOT NULL,                  -- annual, as a decimal
  source    TEXT,
  set_by    TEXT REFERENCES users(id),
  set_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- Banking and reconciliation ----------
CREATE TABLE IF NOT EXISTS bank_statements (
  id            TEXT PRIMARY KEY,
  gl_code       TEXT NOT NULL REFERENCES gl_accounts(code),
  period        TEXT NOT NULL,
  start_date    TEXT NOT NULL,
  end_date      TEXT NOT NULL,
  opening_balance REAL NOT NULL,
  closing_balance REAL NOT NULL,
  filename      TEXT,
  stored_path   TEXT,
  sha256        TEXT,
  state         TEXT NOT NULL DEFAULT 'uploaded'
                CHECK (state IN ('uploaded','reconciling','reconciled')),
  reconciled_by TEXT REFERENCES users(id),
  reconciled_at TEXT,
  uploaded_by   TEXT REFERENCES users(id),
  uploaded_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (gl_code, period)
);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id           TEXT PRIMARY KEY,
  statement_id TEXT NOT NULL REFERENCES bank_statements(id) ON DELETE CASCADE,
  txn_date     TEXT NOT NULL,
  description  TEXT,
  debit        REAL NOT NULL DEFAULT 0,     -- money out
  credit       REAL NOT NULL DEFAULT 0,     -- money in
  balance      REAL,
  matched_type TEXT,                        -- ar_receipt | ap_payment | journal | none
  matched_id   TEXT,
  matched_by   TEXT REFERENCES users(id),
  matched_at   TEXT,
  note         TEXT
);
CREATE INDEX IF NOT EXISTS idx_bt_statement ON bank_transactions(statement_id);
CREATE INDEX IF NOT EXISTS idx_bt_unmatched ON bank_transactions(statement_id) WHERE matched_id IS NULL;

-- ---------- Period close ----------
-- Once a period is closed nothing may post into it. The AI report is
-- generated from closed figures only, so it can never describe numbers
-- that later change.
CREATE TABLE IF NOT EXISTS accounting_periods (
  period        TEXT PRIMARY KEY,           -- YYYY-MM
  state         TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','reconciled','closed')),
  reconciled_by TEXT REFERENCES users(id),
  reconciled_at TEXT,
  closed_by     TEXT REFERENCES users(id),
  closed_at     TEXT,
  note          TEXT
);

CREATE TABLE IF NOT EXISTS monthly_reports (
  id            TEXT PRIMARY KEY,
  period        TEXT NOT NULL,
  building_code TEXT REFERENCES buildings(code),
  figures       TEXT NOT NULL,              -- the numbers, computed from the ledger
  method        TEXT NOT NULL,              -- how each figure was derived
  narrative     TEXT,                       -- AI written, from figures only
  model         TEXT,
  state         TEXT NOT NULL DEFAULT 'draft'
                CHECK (state IN ('draft','review','final')),
  generated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  approved_by   TEXT REFERENCES users(id),
  approved_at   TEXT,
  UNIQUE (period, building_code)
);

-- ============================================================
-- Amendments
--
-- A posted entry is never edited and never deleted. Amending one
-- reverses the original and posts a replacement, and both stay
-- visible. The document keeps its id, so anything linked to it
-- still resolves, and gains a version.
--
-- This is what lets someone fix a keying error without unpicking
-- payments and re-entering the whole thing, while leaving a trail
-- that shows what was there before.
-- ============================================================

CREATE TABLE IF NOT EXISTS amendments (
  id            TEXT PRIMARY KEY,
  entity_type   TEXT NOT NULL,              -- ap_invoice | ar_receipt | ar_charge | journal | schedule
  entity_id     TEXT NOT NULL,
  version_from  INTEGER NOT NULL,
  version_to    INTEGER NOT NULL,
  before_value  TEXT NOT NULL,              -- snapshot, so the old state is readable
  after_value   TEXT NOT NULL,
  changed       TEXT NOT NULL,              -- the fields that moved, as computed facts
  reason        TEXT,                       -- required: why, in the amender's words
  reversal_id   TEXT REFERENCES journal_entries(id),
  replacement_id TEXT REFERENCES journal_entries(id),
  narrative     TEXT,                       -- AI written, supplementary, never the record
  narrative_model TEXT,
  amended_by    TEXT REFERENCES users(id),
  amended_name  TEXT,
  amended_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_amend_entity ON amendments(entity_type, entity_id, version_to);
CREATE INDEX IF NOT EXISTS idx_amend_time ON amendments(amended_at DESC);


-- ---------- Deposit interest rate proposals ----------
-- Alberta publishes this annually. Getting it wrong means every refund is
-- wrong, and nobody finds out until a tenant leaves. The AI researches and
-- proposes with a source; a person confirms before it can be used.
CREATE TABLE IF NOT EXISTS interest_rate_proposals (
  id           TEXT PRIMARY KEY,
  year         INTEGER NOT NULL,
  rate         REAL NOT NULL,
  source_text  TEXT,                        -- what the AI found, verbatim
  source_url   TEXT,
  confidence   TEXT,                        -- high | low | unverified
  reasoning    TEXT,
  model        TEXT,
  state        TEXT NOT NULL DEFAULT 'proposed'
               CHECK (state IN ('proposed','confirmed','rejected')),
  confirmed_by TEXT REFERENCES users(id),
  confirmed_at TEXT,
  rejected_reason TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_irp_year ON interest_rate_proposals(year, state);

-- ---------- Change log narratives ----------
-- The audit row is the record. This adds a readable sentence beside it, so
-- a month later "what happened here" does not require reading JSON.
CREATE TABLE IF NOT EXISTS audit_narratives (
  audit_id   INTEGER PRIMARY KEY REFERENCES audit_log(id),
  narrative  TEXT NOT NULL,
  model      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
