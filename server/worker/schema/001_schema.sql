--
/* Extensions this schema depends on.

   Declared here rather than only in the merged file, because that file is
   generated and anything only in the generator is a step somebody can skip.

   citext gives case-insensitive email: Bowen@ and bowen@ are one person, and
   without it they are two rows — which then defeats the unique index that
   existed to stop exactly that.

   Note that DROP SCHEMA public CASCADE takes extensions in that schema with
   it, so both have to be recreated after a reset. */
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
 ============================================================
-- Baydo Pointe — PostgreSQL / Supabase
--
-- Converted from the SQLite schema. Text ids (usr_xxx, bd_xxx) are
-- kept so it matches the application as written.
--
-- Safe to re-run.
--
-- ── Four type changes from the SQLite original ──────────────
--
-- Money is NUMERIC(14,2), not REAL.
--   Postgres REAL is float32. Adding 330 rent charges of $1,416.67
--   under it lands $1.69 away from the right answer, and the error
--   is spread across every row rather than sitting in one. The
--   reconciliation rule here is that the balance must agree to the
--   cent, so REAL means the month never closes and nothing shows
--   you why.
--
-- Rates are NUMERIC(10,6).
--   A 4% management fee is 0.04. Two decimal places round it away.
--
-- Booleans are BOOLEAN, not INTEGER 0/1.
--   Left as integers, `WHERE is_active` fails outright: Postgres
--   does not accept an integer where a condition belongs. Better
--   fixed here than found one query at a time.
--
-- Times are TIMESTAMPTZ, dates are DATE, neither is TEXT.
--   SQLite stored ISO strings and relied on everyone writing them
--   the same way. Alberta is UTC-7 half the year and UTC-6 the
--   other half, so a lease starting "on the 1st" has to mean the
--   same moment to everyone reading it. As text, "2026-1-5" and
--   "2026-01-05" are two different values that sort apart.
--
-- ============================================================

CREATE EXTENSION IF NOT EXISTS citext;

BEGIN;

-- ==================== schema.sql ====================
-- ============================================================
-- Baydo Pointe -- SQLite schema
-- Mirrors baydo-erd.mermaid, plus evidence upload, renewals and
-- move-out notice-period validation.
-- Moving to Postgres: swap TEXT ids for uuid, TEXT dates for timestamptz,
-- and replace the IMMEDIATE transaction with SELECT ... FOR UPDATE.
-- ============================================================



-- ---------- Identity and access ----------
CREATE TABLE IF NOT EXISTS roles (
  code TEXT PRIMARY KEY,                    -- admin | property_manager | building_manager
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS permissions (
  code        TEXT PRIMARY KEY,
  description TEXT
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_code       TEXT NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
  permission_code TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_code, permission_code)
);

CREATE TABLE IF NOT EXISTS users (
  id                   TEXT PRIMARY KEY,
  email                CITEXT NOT NULL UNIQUE,
  full_name            TEXT NOT NULL,
  phone                TEXT,
  role_code            TEXT NOT NULL REFERENCES roles(code),
  locale               TEXT NOT NULL DEFAULT 'en',   -- en | zh-Hant
  password_algo        TEXT NOT NULL DEFAULT 'scrypt',
  password_salt        TEXT,
  password_hash        TEXT,
  must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  failed_attempts      INTEGER NOT NULL DEFAULT 0,
  locked_until         TEXT,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  ip         TEXT,
  user_agent TEXT,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Append only. The application exposes no UPDATE or DELETE path, not even for Admin.
CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGSERIAL PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id),
  actor_name    TEXT,
  action        TEXT NOT NULL,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT,
  before_value  TEXT,
  after_value   TEXT,
  ip            TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at DESC);

-- ---------- Property ----------
CREATE TABLE IF NOT EXISTS buildings (
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  address TEXT NOT NULL, storeys INTEGER, unit_count INTEGER
);

CREATE TABLE IF NOT EXISTS unit_types (
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE,
  bedroom_label_en TEXT NOT NULL, bedroom_label_zh TEXT NOT NULL,
  bedrooms INTEGER, area_sqft NUMERIC(14,2), balcony_sqft NUMERIC(14,2), is_mirrored BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS units (
  id             TEXT PRIMARY KEY,
  building_code  TEXT NOT NULL REFERENCES buildings(code),
  unit_type_code TEXT NOT NULL REFERENCES unit_types(code),
  unit_number    TEXT NOT NULL UNIQUE,
  floor          INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'available'
                 CHECK (status IN ('available','signed','occupied','turnover','offline')),
  available_from DATE,
  rent_override  NUMERIC(14,2),
  notes          TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_units_status ON units(status);

-- ---------- Pricing (versioned: publishing a change never overwrites history) ----------
CREATE TABLE IF NOT EXISTS pricing_profiles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, effective_from DATE NOT NULL,
  effective_to DATE, created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS unit_type_rents (
  id TEXT PRIMARY KEY,
  pricing_profile_id TEXT NOT NULL REFERENCES pricing_profiles(id) ON DELETE CASCADE,
  unit_type_code TEXT NOT NULL REFERENCES unit_types(code), base_rent NUMERIC(14,2) NOT NULL,
  UNIQUE (pricing_profile_id, unit_type_code)
);
CREATE TABLE IF NOT EXISTS fee_settings (
  id TEXT PRIMARY KEY,
  pricing_profile_id TEXT NOT NULL UNIQUE REFERENCES pricing_profiles(id) ON DELETE CASCADE,
  deposit_mode TEXT NOT NULL DEFAULT 'one_month',
  deposit_fixed NUMERIC(14,2), cat_deposit NUMERIC(14,2), dog_deposit NUMERIC(14,2), pet_rent NUMERIC(14,2), pet_limit TEXT,
  parking_underground NUMERIC(14,2), parking_surface NUMERIC(14,2), storage_fee NUMERIC(14,2),
  application_fee NUMERIC(14,2), utilities_included TEXT
);
-- Alberta caps the security deposit at one month's rent and counts pet deposits
-- toward that cap. Enforce in the application layer, never in the browser only.

-- ---------- Parking (concurrency handled by transactions) ----------
CREATE TABLE IF NOT EXISTS parking_pools (
  id TEXT PRIMARY KEY, building_code TEXT REFERENCES buildings(code),
  code TEXT NOT NULL UNIQUE,
  label_en TEXT NOT NULL, label_zh TEXT NOT NULL,
  total_stalls INTEGER NOT NULL CHECK (total_stalls >= 0),
  tandem_stalls INTEGER DEFAULT 0, accessible_stalls INTEGER DEFAULT 0,
  is_surface BOOLEAN DEFAULT FALSE, note TEXT
);

CREATE TABLE IF NOT EXISTS parking_allocations (
  id           TEXT PRIMARY KEY,
  pool_code    TEXT NOT NULL REFERENCES parking_pools(code),
  unit_number  TEXT NOT NULL REFERENCES units(unit_number),
  lease_id     TEXT,
  status       TEXT NOT NULL CHECK (status IN ('assigned','waiting','released')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- sole ordering key, first come first served
  assigned_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  created_by   TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_parking_queue ON parking_allocations(pool_code, status, requested_at);

-- ---------- Signing lock: first to sign wins ----------
CREATE TABLE IF NOT EXISTS unit_locks (
  unit_number TEXT PRIMARY KEY REFERENCES units(unit_number),
  user_id     TEXT NOT NULL REFERENCES users(id),
  user_name   TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL
);

-- ---------- Contacts, leases, renewals ----------
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY, full_name TEXT, email TEXT, phone TEXT,
  locale TEXT DEFAULT 'en', consent_basis TEXT, consent_expires_at TIMESTAMPTZ,
  do_not_contact BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS leases (
  id               TEXT PRIMARY KEY,
  unit_number      TEXT NOT NULL REFERENCES units(unit_number),
  contact_id       TEXT REFERENCES contacts(id),
  start_date DATE NOT NULL,
  end_date DATE,
  term_type        TEXT NOT NULL CHECK (term_type IN ('fixed_12','fixed_6','periodic')),
  rent             NUMERIC(14,2) NOT NULL,
  deposit          NUMERIC(14,2) NOT NULL,
  occupants        INTEGER,
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('draft','active','ended','terminated')),
  last_increase_at DATE,                    -- an increase requires 365 days since this date
  external_ref     TEXT,                    -- optional reference to an outside system
  created_by       TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_leases_end ON leases(end_date) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS renewal_tasks (
  id            TEXT PRIMARY KEY,
  lease_id      TEXT NOT NULL REFERENCES leases(id),
  unit_number   TEXT NOT NULL,
  end_date DATE NOT NULL,
  state         TEXT NOT NULL DEFAULT 'new'
                CHECK (state IN ('new','drafted','pm_review','sent','accepted','declined','cancelled')),
  decision      TEXT CHECK (decision IN ('renew_fixed','to_periodic','not_renew')),
  current_rent  NUMERIC(14,2),
  proposed_rent NUMERIC(14,2),
  increase_ok   INTEGER,                    -- passes the 365-day and notice-period rules
  increase_code TEXT,                       -- message code, rendered per user locale
  increase_params TEXT,
  notice_text   TEXT,                       -- AI drafts, PM reviews, then it is sent
  drafted_by    TEXT,
  reviewed_by   TEXT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_renewal_state ON renewal_tasks(state);

-- ---------- Move-out ----------
CREATE TABLE IF NOT EXISTS moveouts (
  id               TEXT PRIMARY KEY,
  unit_number      TEXT NOT NULL REFERENCES units(unit_number),
  lease_id         TEXT REFERENCES leases(id),
  tenant_name      TEXT, tenant_phone TEXT, tenant_email TEXT,
  notice_date DATE NOT NULL,           -- date the tenant gave notice
  moveout_date DATE NOT NULL,
  notice_days      INTEGER,                 -- calculated
  notice_required  INTEGER,                 -- required by lease type
  notice_ok        INTEGER,
  state            TEXT NOT NULL DEFAULT 'open'
                   CHECK (state IN ('open','closed','cancelled')),
  vacated_at TIMESTAMPTZ,                    -- confirming this releases parking and the unit
  vacated_by       TEXT REFERENCES users(id),
  deposit_original NUMERIC(14,2),
  refund_deadline  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS moveout_steps (
  id         TEXT PRIMARY KEY,
  moveout_id TEXT NOT NULL REFERENCES moveouts(id) ON DELETE CASCADE,
  step       TEXT NOT NULL,
  payload    TEXT,
  done_by    TEXT REFERENCES users(id),
  done_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (moveout_id, step)
);

CREATE TABLE IF NOT EXISTS deductions (
  id           TEXT PRIMARY KEY,
  moveout_id   TEXT NOT NULL REFERENCES moveouts(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  amount       NUMERIC(14,2) NOT NULL,
  basis        TEXT,
  state        TEXT NOT NULL DEFAULT 'proposed'
               CHECK (state IN ('proposed','notified','accepted','disputed','withdrawn','upheld')),
  notified_at TIMESTAMPTZ,
  tenant_says  TEXT,
  upheld_basis TEXT,
  resolved_at TIMESTAMPTZ,
  created_by   TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Files live on disk; metadata and hash live here. No delete path.
CREATE TABLE IF NOT EXISTS evidence (
  id            TEXT PRIMARY KEY,
  entity_type   TEXT NOT NULL,              -- deduction | moveout | maintenance | inspection
  entity_id     TEXT NOT NULL,
  filename      TEXT NOT NULL,
  stored_path   TEXT NOT NULL,
  mime_type     TEXT,
  size_bytes    INTEGER,
  sha256        TEXT NOT NULL,
  caption       TEXT,
  taken_at TIMESTAMPTZ,
  uploaded_by   TEXT NOT NULL REFERENCES users(id),
  uploaded_name TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_evidence_entity ON evidence(entity_type, entity_id);

-- ---------- Maintenance and notices of entry ----------
CREATE TABLE IF NOT EXISTS maintenance (
  id           TEXT PRIMARY KEY,
  unit_number  TEXT NOT NULL REFERENCES units(unit_number),
  tenant_name  TEXT, tenant_phone TEXT,
  category     TEXT, priority TEXT,
  rush BOOLEAN DEFAULT FALSE,           -- set by the Building Manager only
  rush_by      TEXT, rush_at TIMESTAMPTZ,
  description  TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'new'
               CHECK (state IN ('new','scheduled','in_progress','done','cancelled')),
  vendor       TEXT,
  scheduled_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS maintenance_notes (
  id        TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES maintenance(id) ON DELETE CASCADE,
  body      TEXT NOT NULL,
  by_user   TEXT REFERENCES users(id),
  by_name   TEXT,
  at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS entry_notices (
  id          TEXT PRIMARY KEY,
  purpose     TEXT NOT NULL CHECK (purpose IN ('showing','maintenance','inspection')),
  ref_type    TEXT NOT NULL,
  ref_id      TEXT NOT NULL,
  unit_number TEXT NOT NULL REFERENCES units(unit_number),
  tenant_name TEXT, tenant_contact TEXT,
  entry_date DATE NOT NULL,
  window_from DATE NOT NULL,
  window_to DATE NOT NULL,
  body        TEXT,
  locale      TEXT DEFAULT 'en',
  state       TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','sent','cancelled')),
  lead_hours  NUMERIC(14,2),
  drafted_by  TEXT, sent_by TEXT REFERENCES users(id), sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------- Schedule ----------
CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL CHECK (type IN ('showing','signing','keys','maintenance','followup','review')),
  unit_number  TEXT REFERENCES units(unit_number),
  contact_name TEXT, contact_info TEXT,
  assignee_id  TEXT REFERENCES users(id),
  assignee     TEXT,
  starts_at TIMESTAMPTZ NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 30,
  blocking BOOLEAN NOT NULL DEFAULT TRUE,  -- 0 for vendor visits: they do not occupy staff time
  state        TEXT NOT NULL DEFAULT 'booked'
               CHECK (state IN ('booked','done','cancelled','no_show')),
  outcome      TEXT,
  ref_id       TEXT,
  created_via  TEXT DEFAULT 'staff',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(starts_at) WHERE state = 'booked';

CREATE TABLE IF NOT EXISTS holidays (
  holiday_date TEXT PRIMARY KEY,
  name_en TEXT NOT NULL, name_zh TEXT NOT NULL,
  is_observed BOOLEAN DEFAULT TRUE
);

-- ---------- Notifications ----------
-- Stored as a message code plus parameters so the client can render them in
-- whichever language the reader has selected.
CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  audience   TEXT NOT NULL,                 -- role code or user id
  kind       TEXT NOT NULL,
  code       TEXT NOT NULL,
  params     TEXT,
  link       TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notif_aud ON notifications(audience, read_at);

-- ---------- Backups ----------
CREATE TABLE IF NOT EXISTS backups (
  id         TEXT PRIMARY KEY,
  path       TEXT NOT NULL,
  reason     TEXT,
  size_bytes INTEGER,
  by_name    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ==================== schema-accounting.sql ====================
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


-- ---------- Chart of accounts ----------
CREATE TABLE IF NOT EXISTS gl_accounts (
  code        TEXT PRIMARY KEY,             -- 1010, 4010 …
  name_en     TEXT NOT NULL,
  name_zh     TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('asset','liability','equity','revenue','expense')),
  parent_code TEXT REFERENCES gl_accounts(code),
  normal_side TEXT NOT NULL CHECK (normal_side IN ('debit','credit')),
  is_postable BOOLEAN NOT NULL DEFAULT TRUE,   -- headers are not postable
  is_trust BOOLEAN NOT NULL DEFAULT FALSE,   -- deposit trust accounts
  is_bank BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
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
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  note         TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_vendor_name ON vendors(name);

-- ---------- Journal ----------
-- A posted entry is immutable. Fixing one means posting a reversal
-- and a replacement, which is what an auditor expects to see.
CREATE TABLE IF NOT EXISTS journal_entries (
  id            TEXT PRIMARY KEY,
  entry_no      INTEGER,
  entry_date DATE NOT NULL,
  period        TEXT NOT NULL,              -- YYYY-MM, drives the close
  building_code TEXT REFERENCES buildings(code),
  source        TEXT NOT NULL,              -- rent_run | ap_invoice | ar_receipt | deposit | manual | reversal
  source_id     TEXT,
  memo          TEXT,
  state         TEXT NOT NULL DEFAULT 'posted' CHECK (state IN ('posted','reversed')),
  reverses_id   TEXT REFERENCES journal_entries(id),
  created_by    TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_je_period ON journal_entries(period, building_code);
CREATE INDEX IF NOT EXISTS idx_je_source ON journal_entries(source, source_id);

CREATE TABLE IF NOT EXISTS journal_lines (
  id            TEXT PRIMARY KEY,
  entry_id      TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  line_no       INTEGER NOT NULL,
  gl_code       TEXT NOT NULL REFERENCES gl_accounts(code),
  debit         NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit        NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
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
  amount        NUMERIC(14,2) NOT NULL,
  charge_day    INTEGER NOT NULL DEFAULT 1 CHECK (charge_day BETWEEN 1 AND 28),
  due_day       INTEGER NOT NULL DEFAULT 1 CHECK (due_day BETWEEN 1 AND 28),
  start_date DATE NOT NULL,
  end_date DATE,                       -- follows the lease end
  prorate_first BOOLEAN NOT NULL DEFAULT TRUE, -- part month when moving in mid-month
  prorate_last  BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  note          TEXT,
  created_by    TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cs_unit ON charge_schedules(unit_number) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_cs_day ON charge_schedules(charge_day) WHERE is_active = TRUE;

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
  amount        NUMERIC(14,2) NOT NULL,
  prorated BOOLEAN NOT NULL DEFAULT FALSE,
  prorate_note  TEXT,                       -- how the part month was worked out
  charge_date DATE NOT NULL,
  due_date DATE NOT NULL,
  entry_id      TEXT REFERENCES journal_entries(id),
  state         TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','paid','partial','written_off','void')),
  paid_amount   NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
  received_date DATE NOT NULL,
  amount        NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  method        TEXT NOT NULL,              -- etransfer | cheque | preauth | cash | card
  reference     TEXT,
  deposit_to TEXT NOT NULL REFERENCES gl_accounts(code),
  entry_id      TEXT REFERENCES journal_entries(id),
  bank_txn_id   TEXT,                       -- set when matched to a statement line
  note          TEXT,
  created_by    TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_rc_date ON ar_receipts(received_date);
CREATE INDEX IF NOT EXISTS idx_rc_unit ON ar_receipts(unit_number);

-- Applying a receipt to specific charges, so a partial payment is
-- traceable rather than a floating credit.
CREATE TABLE IF NOT EXISTS ar_applications (
  id         TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES ar_receipts(id) ON DELETE CASCADE,
  charge_id  TEXT NOT NULL REFERENCES ar_charges(id),
  amount     NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_app_charge ON ar_applications(charge_id);

-- ---------- AP: what we owe vendors ----------
CREATE TABLE IF NOT EXISTS ap_invoices (
  id            TEXT PRIMARY KEY,
  vendor_id     TEXT NOT NULL REFERENCES vendors(id),
  invoice_no    TEXT NOT NULL,
  invoice_date DATE NOT NULL,
  due_date DATE NOT NULL,
  building_code TEXT REFERENCES buildings(code),
  unit_number   TEXT,
  subtotal      NUMERIC(14,2) NOT NULL,
  gst           NUMERIC(14,2) NOT NULL DEFAULT 0,
  total         NUMERIC(14,2) NOT NULL,
  description   TEXT,
  ticket_id     TEXT,                       -- links back to the maintenance ticket
  entry_id      TEXT REFERENCES journal_entries(id),
  state         TEXT NOT NULL DEFAULT 'draft'
                CHECK (state IN ('draft','approved','paid','partial','void')),
  paid_amount   NUMERIC(14,2) NOT NULL DEFAULT 0,
  approved_by   TEXT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  created_by    TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
  amount        NUMERIC(14,2) NOT NULL,
  building_code TEXT REFERENCES buildings(code),
  unit_number   TEXT
);
CREATE INDEX IF NOT EXISTS idx_apl_invoice ON ap_invoice_lines(invoice_id);

CREATE TABLE IF NOT EXISTS ap_payments (
  id           TEXT PRIMARY KEY,
  payment_no   INTEGER,
  vendor_id    TEXT NOT NULL REFERENCES vendors(id),
  payment_date DATE NOT NULL,
  amount       NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  method       TEXT NOT NULL,
  reference    TEXT,
  paid_from TEXT NOT NULL REFERENCES gl_accounts(code),
  entry_id     TEXT REFERENCES journal_entries(id),
  bank_txn_id  TEXT,
  created_by   TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ap_applications (
  id         TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES ap_payments(id) ON DELETE CASCADE,
  invoice_id TEXT NOT NULL REFERENCES ap_invoices(id),
  amount     NUMERIC(14,2) NOT NULL CHECK (amount > 0)
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
  amount        NUMERIC(14,2) NOT NULL,              -- positive holds, negative releases
  txn_date DATE NOT NULL,
  basis         TEXT,                       -- required for a deduction
  moveout_id    TEXT,
  entry_id      TEXT REFERENCES journal_entries(id),
  created_by    TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_dep_unit ON deposit_ledger(unit_number);

-- The rate is a setting, not a constant, because it changes.
CREATE TABLE IF NOT EXISTS deposit_interest_rates (
  year      INTEGER PRIMARY KEY,
  rate NUMERIC(10,6) NOT NULL,                  -- annual, as a decimal
  source    TEXT,
  set_by    TEXT REFERENCES users(id),
  set_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------- Banking and reconciliation ----------
CREATE TABLE IF NOT EXISTS bank_statements (
  id            TEXT PRIMARY KEY,
  gl_code       TEXT NOT NULL REFERENCES gl_accounts(code),
  period        TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  opening_balance NUMERIC(14,2) NOT NULL,
  closing_balance NUMERIC(14,2) NOT NULL,
  filename      TEXT,
  stored_path   TEXT,
  sha256        TEXT,
  state         TEXT NOT NULL DEFAULT 'uploaded'
                CHECK (state IN ('uploaded','reconciling','reconciled')),
  reconciled_by TEXT REFERENCES users(id),
  reconciled_at TIMESTAMPTZ,
  uploaded_by   TEXT REFERENCES users(id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (gl_code, period)
);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id           TEXT PRIMARY KEY,
  statement_id TEXT NOT NULL REFERENCES bank_statements(id) ON DELETE CASCADE,
  txn_date DATE NOT NULL,
  description  TEXT,
  debit        NUMERIC(14,2) NOT NULL DEFAULT 0,     -- money out
  credit       NUMERIC(14,2) NOT NULL DEFAULT 0,     -- money in
  balance      NUMERIC(14,2),
  matched_type TEXT,                        -- ar_receipt | ap_payment | journal | none
  matched_id   TEXT,
  matched_by   TEXT REFERENCES users(id),
  matched_at TIMESTAMPTZ,
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
  reconciled_at TIMESTAMPTZ,
  closed_by     TEXT REFERENCES users(id),
  closed_at TIMESTAMPTZ,
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
  generated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_by   TEXT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
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
  amended_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
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
  rate NUMERIC(10,6) NOT NULL,
  source_text  TEXT,                        -- what the AI found, verbatim
  source_url   TEXT,
  confidence   TEXT,                        -- high | low | unverified
  reasoning    TEXT,
  model        TEXT,
  state        TEXT NOT NULL DEFAULT 'proposed'
               CHECK (state IN ('proposed','confirmed','rejected')),
  confirmed_by TEXT REFERENCES users(id),
  confirmed_at TIMESTAMPTZ,
  rejected_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_irp_year ON interest_rate_proposals(year, state);

-- ---------- Change log narratives ----------
-- The audit row is the record. This adds a readable sentence beside it, so
-- a month later "what happened here" does not require reading JSON.
CREATE TABLE IF NOT EXISTS audit_narratives (
  audit_id   BIGINT PRIMARY KEY REFERENCES audit_log(id),
  narrative  TEXT NOT NULL,
  model      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ==================== schema-ops.sql ====================
-- ============================================================
-- Baydo Pointe — notifications, screening, entry windows,
-- password policy, log export
-- ============================================================


-- ---------- Outbox ----------
-- Every message to a tenant or a member of staff queues here first.
-- Sending directly from the code that caused it means a provider outage
-- loses the message and nobody knows which ones went missing.
CREATE TABLE IF NOT EXISTS outbox (
  id            TEXT PRIMARY KEY,
  channel       TEXT NOT NULL CHECK (channel IN ('email','sms','both')),
  to_email      TEXT,
  to_phone      TEXT,
  to_name       TEXT,
  locale        TEXT NOT NULL DEFAULT 'en',
  kind          TEXT NOT NULL,              -- showing_confirm | entry_notice | reset | ...
  subject       TEXT,
  body          TEXT NOT NULL,
  ref_type      TEXT,
  ref_id        TEXT,
  required_by   TEXT,                       -- when it must have gone out by
  state         TEXT NOT NULL DEFAULT 'queued'
                CHECK (state IN ('queued','sent','failed','cancelled')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  sent_at TIMESTAMPTZ,
  provider_id   TEXT,
  created_by    TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_outbox_state ON outbox(state, created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_ref ON outbox(ref_type, ref_id);

-- A recipient can decline a channel. Marketing consent is separate: a
-- transactional notice such as a notice of entry is not marketing and does
-- not depend on it.
CREATE TABLE IF NOT EXISTS contact_preferences (
  contact_key   TEXT PRIMARY KEY,           -- email or phone
  allow_email BOOLEAN NOT NULL DEFAULT TRUE,
  allow_sms BOOLEAN NOT NULL DEFAULT TRUE,
  allow_marketing BOOLEAN NOT NULL DEFAULT FALSE,
  locale        TEXT DEFAULT 'en',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------- Confirmations ----------
-- A step that needs the other side to agree. Nothing proceeds on the
-- assumption that a message was read.
CREATE TABLE IF NOT EXISTS confirmations (
  id           TEXT PRIMARY KEY,
  token        TEXT NOT NULL UNIQUE,
  ref_type     TEXT NOT NULL,               -- showing | entry | signing | keys
  ref_id       TEXT NOT NULL,
  to_email     TEXT,
  to_phone     TEXT,
  question     TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'sent'
               CHECK (state IN ('sent','confirmed','declined','expired')),
  response_note TEXT,
  expires_at TIMESTAMPTZ,
  responded_at TIMESTAMPTZ,
  outbox_id    TEXT REFERENCES outbox(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_conf_ref ON confirmations(ref_type, ref_id);

-- ---------- Entry windows ----------
-- When a tenant will and will not accept access. Recording a refusal is
-- as important as recording availability: entering during a window the
-- tenant has excluded is what turns a repair into a complaint.
CREATE TABLE IF NOT EXISTS entry_windows (
  id           TEXT PRIMARY KEY,
  unit_number  TEXT NOT NULL REFERENCES units(unit_number),
  kind         TEXT NOT NULL CHECK (kind IN ('available','blocked')),
  weekday      INTEGER,                     -- 0-6, null when it is a one-off date
  specific_date DATE,
  from_time TIMESTAMPTZ NOT NULL,
  to_time TIMESTAMPTZ NOT NULL,
  reason       TEXT,
  set_by       TEXT,                        -- tenant | staff
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ew_unit ON entry_windows(unit_number);

-- ---------- Screening ----------
-- Applications matched against existing people. An exact email or phone
-- match is a hard stop. A resemblance is not: two people with the same
-- common surname are two people, and refusing one of them automatically
-- would fall unevenly across communities.
CREATE TABLE IF NOT EXISTS application_screens (
  id            TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  email         TEXT,
  phone         TEXT,
  full_name     TEXT,
  result        TEXT NOT NULL CHECK (result IN ('clear','duplicate','review')),
  matched_type  TEXT,                       -- email | phone | similarity
  matched_id    TEXT,
  similarity NUMERIC(10,6),
  detail        TEXT,
  decided_by    TEXT REFERENCES users(id),
  decision      TEXT CHECK (decision IN ('allow','reject')),
  decision_note TEXT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_screen_result ON application_screens(result);
CREATE INDEX IF NOT EXISTS idx_screen_email ON application_screens(email);

-- ---------- Password policy ----------
CREATE TABLE IF NOT EXISTS password_history (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hash       TEXT NOT NULL,
  salt       TEXT NOT NULL,
  algo       TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pwhist_user ON password_history(user_id, changed_at DESC);

-- ---------- Log exports ----------
-- Who took a copy of the audit log, covering what, and when. An export is
-- itself an event worth recording.
CREATE TABLE IF NOT EXISTS log_exports (
  id          TEXT PRIMARY KEY,
  from_date DATE,
  to_date DATE,
  query       TEXT,
  format      TEXT NOT NULL,
  row_count   INTEGER,
  sha256      TEXT,
  exported_by TEXT REFERENCES users(id),
  exported_name TEXT,
  exported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ==================== schema-crm.sql ====================
-- ============================================================
-- Baydo Pointe — leads, documents, bookings, key handover
--
-- These were the last things living only in the browser. A lead
-- known to one agent's laptop is not a pipeline, and a document
-- template that exists in one browser cannot be the version
-- everyone signs.
-- ============================================================


-- ---------- Leads ----------
CREATE TABLE IF NOT EXISTS leads (
  id            TEXT PRIMARY KEY,
  contact_id    TEXT REFERENCES contacts(id),
  name          TEXT NOT NULL,
  email         TEXT,
  phone         TEXT,
  source        TEXT,
  stage         TEXT NOT NULL DEFAULT 'new'
                CHECK (stage IN ('new','contacted','booked','viewed','applied','leased','lost')),
  lost_reason   TEXT,
  beds          TEXT,
  move_in       TEXT,
  units         TEXT,                       -- JSON array of unit numbers
  assigned_to TEXT REFERENCES users(id),
  assigned_name TEXT,
  next_action_at TIMESTAMPTZ,
  do_not_contact BOOLEAN DEFAULT FALSE,
  screen_id     TEXT REFERENCES application_screens(id),
  last_contact_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage, last_contact_at);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);

CREATE TABLE IF NOT EXISTS lead_notes (
  id        TEXT PRIMARY KEY,
  lead_id   TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  body      TEXT NOT NULL,
  by_user   TEXT REFERENCES users(id),
  by_name   TEXT,
  at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_leadnotes ON lead_notes(lead_id, at DESC);

-- ---------- Documents ----------
CREATE TABLE IF NOT EXISTS document_templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'missing'
              CHECK (status IN ('missing','draft','approved','retired')),
  version     TEXT,
  body        TEXT,
  filename    TEXT,
  note        TEXT,
  -- Only an approved version can generate a document. Putting an unreviewed
  -- lease in front of a tenant costs far more than the time it saves.
  approved_by TEXT REFERENCES users(id),
  approved_name TEXT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS template_fields (
  id          TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES document_templates(id) ON DELETE CASCADE,
  field_key   TEXT NOT NULL,
  label       TEXT,
  source      TEXT NOT NULL DEFAULT 'staff' CHECK (source IN ('backend','tenant','staff')),
  field_type  TEXT DEFAULT 'text',
  note        TEXT,
  UNIQUE (template_id, field_key)
);

CREATE TABLE IF NOT EXISTS document_instances (
  id           TEXT PRIMARY KEY,
  template_id  TEXT NOT NULL REFERENCES document_templates(id),
  unit_number  TEXT,
  contact_id   TEXT REFERENCES contacts(id),
  tenant_name  TEXT,
  tenant_email TEXT,
  tenant_phone TEXT,
  values_json  TEXT,
  state        TEXT NOT NULL DEFAULT 'new'
               CHECK (state IN ('new','review','approved','sent','signed','rejected')),
  approved_by  TEXT REFERENCES users(id),
  approved_name TEXT,
  approved_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  signed_at TIMESTAMPTZ,
  created_by   TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_docinst_state ON document_instances(state, created_at DESC);

-- Converted renderings, kept beside the source rather than replacing it.
CREATE TABLE IF NOT EXISTS document_renditions (
  id          TEXT PRIMARY KEY,
  template_id TEXT REFERENCES document_templates(id) ON DELETE CASCADE,
  instance_id TEXT REFERENCES document_instances(id) ON DELETE CASCADE,
  target_role TEXT NOT NULL,
  format      TEXT NOT NULL,
  body        TEXT NOT NULL,
  model       TEXT,
  created_by  TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------- Public bookings and applications ----------
CREATE TABLE IF NOT EXISTS showing_requests (
  id           TEXT PRIMARY KEY,
  reference    TEXT NOT NULL UNIQUE,
  unit_type    TEXT,
  unit_number  TEXT,
  requested_date DATE NOT NULL,
  requested_time TIMESTAMPTZ NOT NULL,
  name         TEXT NOT NULL,
  email        TEXT,
  phone        TEXT,
  notes        TEXT,
  locale       TEXT DEFAULT 'en',
  lead_id      TEXT REFERENCES leads(id),
  event_id     TEXT REFERENCES events(id),
  state        TEXT NOT NULL DEFAULT 'requested'
               CHECK (state IN ('requested','confirmed','declined','cancelled','completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS applications (
  id            TEXT PRIMARY KEY,
  reference     TEXT NOT NULL UNIQUE,
  unit_type     TEXT,
  unit_number   TEXT,
  move_in       TEXT,
  term          TEXT,
  tenants       TEXT,                       -- JSON array of names
  occupants     INTEGER,
  email         TEXT,
  phone         TEXT,
  wants_parking BOOLEAN DEFAULT FALSE,
  wants_storage BOOLEAN DEFAULT FALSE,
  pets          TEXT,
  service_animal BOOLEAN DEFAULT FALSE,
  monthly_total NUMERIC(14,2),
  upfront_total NUMERIC(14,2),
  fee_ack BOOLEAN DEFAULT FALSE,
  consent BOOLEAN DEFAULT FALSE,
  locale        TEXT DEFAULT 'en',
  lead_id       TEXT REFERENCES leads(id),
  screen_id     TEXT REFERENCES application_screens(id),
  state         TEXT NOT NULL DEFAULT 'new'
                CHECK (state IN ('new','screening','review','approved','declined','withdrawn')),
  decided_by    TEXT REFERENCES users(id),
  decided_at TIMESTAMPTZ,
  decision_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_app_state ON applications(state, created_at DESC);

CREATE TABLE IF NOT EXISTS application_documents (
  id             TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  filename       TEXT NOT NULL,
  stored_path    TEXT NOT NULL,
  mime_type      TEXT,
  size_bytes     INTEGER,
  sha256         TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------- Key handover ----------
CREATE TABLE IF NOT EXISTS key_handovers (
  id           TEXT PRIMARY KEY,
  unit_number  TEXT NOT NULL REFERENCES units(unit_number),
  lease_id     TEXT REFERENCES leases(id),
  tenant_name  TEXT,
  tenant_email TEXT,
  tenant_phone TEXT,
  lease_start  TEXT,
  scheduled_at TIMESTAMPTZ,
  assignee     TEXT,
  items        TEXT,                        -- JSON checklist
  notes        TEXT,
  state        TEXT NOT NULL DEFAULT 'pending'
               CHECK (state IN ('pending','scheduled','done','cancelled')),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------- Showing outcomes ----------
CREATE TABLE IF NOT EXISTS showing_outcomes (
  event_id   TEXT PRIMARY KEY REFERENCES events(id),
  outcome    TEXT NOT NULL,
  reason     TEXT,
  note       TEXT,
  by_user    TEXT REFERENCES users(id),
  by_name    TEXT,
  at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------- Tenant portal accounts ----------
-- Separate from staff users on purpose. A tenant is not a member of staff
-- with fewer permissions; mixing them means one mistake in the role check
-- exposes the whole console.
CREATE TABLE IF NOT EXISTS tenant_accounts (
  id            TEXT PRIMARY KEY,
  contact_id    TEXT REFERENCES contacts(id),
  email         CITEXT NOT NULL UNIQUE,
  phone         TEXT,
  full_name     TEXT NOT NULL,
  unit_number   TEXT REFERENCES units(unit_number),
  lease_id      TEXT REFERENCES leases(id),
  locale        TEXT DEFAULT 'en',
  password_salt TEXT,
  password_hash TEXT,
  password_algo TEXT DEFAULT 'scrypt',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tenant_sessions (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES tenant_accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tenant_repairs (
  id            TEXT PRIMARY KEY,
  account_id    TEXT REFERENCES tenant_accounts(id),
  unit_number   TEXT NOT NULL,
  what          TEXT NOT NULL,
  where_in_unit TEXT,
  urgent BOOLEAN NOT NULL DEFAULT FALSE,
  ticket_id     TEXT REFERENCES maintenance(id),
  state         TEXT NOT NULL DEFAULT 'new',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ==================== schema-agreements.sql ====================
-- ============================================================
-- Baydo Pointe — agreement library
--
-- The system does not produce an agreement. Admin uploads the file
-- a lawyer approved, and that file is what goes to the tenant,
-- byte for byte. Nothing merges, reflows or regenerates it.
--
-- What the system does is keep track: which version is current,
-- who approved it, which one went to which tenant and when. That
-- is the question that actually gets asked in a dispute, and it is
-- one a generated document cannot answer.
-- ============================================================


CREATE TABLE IF NOT EXISTS agreements (
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,        -- lease | parking | storage | pet | ...
  name_en      TEXT NOT NULL,
  name_zh      TEXT NOT NULL,
  description  TEXT,
  required_for TEXT,                        -- JSON: when this one is needed
  sort_order   INTEGER NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Each upload is a version. Nothing is ever replaced in place: the file that
-- somebody signed in March has to still be retrievable in March's form.
CREATE TABLE IF NOT EXISTS agreement_versions (
  id            TEXT PRIMARY KEY,
  agreement_id  TEXT NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
  version_label TEXT NOT NULL,              -- "2026-08 counsel version"
  filename      TEXT NOT NULL,
  stored_path   TEXT NOT NULL,
  mime_type     TEXT,
  size_bytes    INTEGER,
  sha256        TEXT NOT NULL,
  page_count    INTEGER,
  effective_from DATE,
  state         TEXT NOT NULL DEFAULT 'uploaded'
                CHECK (state IN ('uploaded','approved','superseded','withdrawn')),
  -- Approving is what makes a version usable. Recording who did it matters:
  -- "which version did we send, and who said it was the right one" has to
  -- have an answer.
  approved_by   TEXT REFERENCES users(id),
  approved_name TEXT,
  approved_at TIMESTAMPTZ,
  approval_note TEXT,
  withdrawn_reason TEXT,
  uploaded_by   TEXT REFERENCES users(id),
  uploaded_name TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (agreement_id, version_label)
);
CREATE INDEX IF NOT EXISTS idx_av_agreement ON agreement_versions(agreement_id, state);

-- Issuing records that a specific version went to a specific tenant. The file
-- is unchanged; this is the pairing, which is the part worth keeping.
CREATE TABLE IF NOT EXISTS agreement_issues (
  id            TEXT PRIMARY KEY,
  version_id    TEXT NOT NULL REFERENCES agreement_versions(id),
  agreement_id  TEXT NOT NULL REFERENCES agreements(id),
  unit_number   TEXT REFERENCES units(unit_number),
  contact_id    TEXT REFERENCES contacts(id),
  tenant_name   TEXT NOT NULL,
  tenant_email  TEXT,
  tenant_phone  TEXT,
  lease_id      TEXT REFERENCES leases(id),
  -- Collected alongside, never merged in. The tenant fills the document; this
  -- is what we told them the figures were, captured at the moment of issue so
  -- a later price change cannot rewrite history.
  particulars   TEXT,
  state         TEXT NOT NULL DEFAULT 'prepared'
                CHECK (state IN ('prepared','sent','signed','declined','cancelled')),
  sent_at TIMESTAMPTZ,
  signed_at TIMESTAMPTZ,
  signed_note   TEXT,
  outbox_id     TEXT REFERENCES outbox(id),
  issued_by     TEXT REFERENCES users(id),
  issued_name   TEXT,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ai_unit ON agreement_issues(unit_number, state);
CREATE INDEX IF NOT EXISTS idx_ai_state ON agreement_issues(state, issued_at DESC);

-- Downloads of an approved agreement, because the library is the source of
-- what gets signed and taking a copy is worth a line.
CREATE TABLE IF NOT EXISTS agreement_downloads (
  id         TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES agreement_versions(id),
  by_user    TEXT REFERENCES users(id),
  by_name    TEXT,
  purpose    TEXT,
  at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ==================== schema-ops2.sql ====================
-- ============================================================
-- Baydo Pointe — per-user permissions, purchase orders,
-- receipts, escalation, retention
-- ============================================================


-- ---------- Per-user permission grants ----------
-- The role is the baseline. This layers on top, so Admin can give one person
-- one extra thing without inventing a fifth role for them.
CREATE TABLE IF NOT EXISTS user_permissions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission  TEXT NOT NULL REFERENCES permissions(code),
  effect      TEXT NOT NULL CHECK (effect IN ('grant','revoke')),
  reason      TEXT,
  granted_by  TEXT REFERENCES users(id),
  granted_name TEXT,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ,
  UNIQUE (user_id, permission)
);
CREATE INDEX IF NOT EXISTS idx_uperm_user ON user_permissions(user_id);

-- ---------- Purchase orders ----------
-- A PO is a commitment, not a liability. It does not touch the ledger.
-- It becomes a bill when the work is done and the amount is confirmed —
-- and the amount usually changes, which is the whole reason for the two
-- steps rather than one.
CREATE TABLE IF NOT EXISTS purchase_orders (
  id            TEXT PRIMARY KEY,
  po_number     TEXT NOT NULL UNIQUE,
  ticket_id     TEXT REFERENCES maintenance(id),
  vendor_id     TEXT REFERENCES vendors(id),
  vendor_name   TEXT,
  unit_number   TEXT,
  building_code TEXT REFERENCES buildings(code),
  description   TEXT NOT NULL,
  scope         TEXT,                       -- what the vendor is being asked to do
  gl_code       TEXT REFERENCES gl_accounts(code),
  estimated     NUMERIC(14,2) NOT NULL,
  scheduled_at TIMESTAMPTZ,
  drafted_by_ai BOOLEAN NOT NULL DEFAULT FALSE,
  ai_model      TEXT,
  state         TEXT NOT NULL DEFAULT 'draft'
                CHECK (state IN ('draft','issued','work_done','billed','cancelled')),
  -- The actual, entered by whoever was on site. Blank until the work is done.
  actual_amount NUMERIC(14,2),
  variance_note TEXT,                       -- required when actual differs from estimate
  confirmed_by  TEXT REFERENCES users(id),
  confirmed_name TEXT,
  confirmed_at TIMESTAMPTZ,
  bill_id       TEXT REFERENCES ap_invoices(id),
  cancelled_reason TEXT,
  created_by    TEXT REFERENCES users(id),
  created_name  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_po_state ON purchase_orders(state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_po_ticket ON purchase_orders(ticket_id);

CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id          TEXT PRIMARY KEY,
  po_id       TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  line_no     INTEGER NOT NULL,
  description TEXT NOT NULL,
  gl_code     TEXT REFERENCES gl_accounts(code),
  quantity NUMERIC(10,6) DEFAULT 1,
  unit_price  NUMERIC(14,2),
  estimated   NUMERIC(14,2) NOT NULL,
  actual      NUMERIC(14,2)
);
CREATE INDEX IF NOT EXISTS idx_pol_po ON purchase_order_lines(po_id);

-- ---------- Receipts to tenants ----------
-- Issued by Accounting after the money is confirmed, never on the promise of
-- money. A receipt for a payment that later bounces is worse than no receipt.
CREATE TABLE IF NOT EXISTS payment_receipts (
  id            TEXT PRIMARY KEY,
  receipt_number TEXT NOT NULL UNIQUE,
  ar_receipt_id TEXT NOT NULL REFERENCES ar_receipts(id),
  unit_number   TEXT,
  tenant_name   TEXT,
  tenant_email  TEXT,
  tenant_phone  TEXT,
  amount        NUMERIC(14,2) NOT NULL,
  received_date DATE NOT NULL,
  method        TEXT,
  applied_to    TEXT,                      -- JSON: which charges it settled
  balance_after NUMERIC(14,2),
  locale        TEXT DEFAULT 'en',
  outbox_id     TEXT REFERENCES outbox(id),
  state         TEXT NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending','sent','failed')),
  confirmed_by  TEXT REFERENCES users(id),
  confirmed_name TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_prcpt_state ON payment_receipts(state);

-- ---------- Escalation ----------
-- Handing a message to a person is not the same as a person seeing it. This
-- turns an escalation into an email with a reply link and a clock, so a
-- tenant is not waiting on somebody happening to open a console.
CREATE TABLE IF NOT EXISTS escalations (
  id            TEXT PRIMARY KEY,
  message_id    TEXT,
  source        TEXT NOT NULL,              -- inbox | tenant_chat | portal
  rule_id       TEXT,                       -- R-101 … the reason it was intercepted
  topic         TEXT,
  tenant_name   TEXT,
  tenant_email  TEXT,
  tenant_phone  TEXT,
  unit_number   TEXT,
  locale        TEXT DEFAULT 'en',
  -- Content is not copied for the protected-ground rules. The person opens
  -- the thread to read it; the escalation record holds the rule id only.
  body_included BOOLEAN NOT NULL DEFAULT TRUE,
  body          TEXT,
  assigned_role TEXT NOT NULL DEFAULT 'property_manager',
  assigned_to TEXT REFERENCES users(id),
  outbox_id     TEXT REFERENCES outbox(id),
  reply_token   TEXT UNIQUE,
  state         TEXT NOT NULL DEFAULT 'open'
                CHECK (state IN ('open','claimed','answered','closed')),
  claimed_by    TEXT REFERENCES users(id),
  claimed_name  TEXT,
  claimed_at TIMESTAMPTZ,
  answered_at TIMESTAMPTZ,
  answer_body   TEXT,
  due_by        TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_esc_state ON escalations(state, due_by);

-- ---------- Key handover gate ----------
-- Keys cannot be booked until the lease is signed and the Property Manager
-- has confirmed it. Handing over keys against an unsigned lease gives away
-- possession with nothing to enforce.
CREATE TABLE IF NOT EXISTS key_release_approvals (
  id           TEXT PRIMARY KEY,
  unit_number  TEXT NOT NULL REFERENCES units(unit_number),
  lease_id     TEXT REFERENCES leases(id),
  issue_id     TEXT REFERENCES agreement_issues(id),
  tenant_name  TEXT,
  deposit_received BOOLEAN NOT NULL DEFAULT FALSE,
  first_rent_received BOOLEAN NOT NULL DEFAULT FALSE,
  lease_signed BOOLEAN NOT NULL DEFAULT FALSE,
  approved_by  TEXT REFERENCES users(id),
  approved_name TEXT,
  approved_at TIMESTAMPTZ,
  note         TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (unit_number, lease_id)
);

-- ---------- Shadow mode ----------
-- The AI runs the whole way through and nothing is sent. Two to four weeks
-- of this before going live is how you find out the error rate instead of
-- guessing it — and the errors that matter are the ones nobody would have
-- caught by reading a few samples.
CREATE TABLE IF NOT EXISTS shadow_runs (
  id            TEXT PRIMARY KEY,
  message_id    TEXT,
  source        TEXT,
  intent        TEXT,
  confidence NUMERIC(10,6),
  level         TEXT,                       -- what it would have done
  rule_id       TEXT,
  draft         TEXT,
  facts_used    TEXT,
  would_send BOOLEAN NOT NULL DEFAULT FALSE,
  -- Filled by a person afterwards. Without this the run is a pile of drafts
  -- nobody scored, which measures nothing.
  reviewed_by   TEXT REFERENCES users(id),
  reviewed_name TEXT,
  verdict       TEXT CHECK (verdict IN ('correct','wrong_intent','wrong_content','should_not_send','missed_stop')),
  reviewer_note TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_shadow_verdict ON shadow_runs(verdict, created_at DESC);

-- ---------- Turnover ----------
-- Between a tenant leaving and the unit being back on the market is pure
-- vacancy loss, and it is the number nobody measures because no single
-- person owns it.
CREATE TABLE IF NOT EXISTS turnovers (
  id             TEXT PRIMARY KEY,
  unit_number    TEXT NOT NULL REFERENCES units(unit_number),
  moveout_id     TEXT REFERENCES moveouts(id),
  vacated_at TIMESTAMPTZ NOT NULL,
  inspected_at TIMESTAMPTZ,
  work_started_at TIMESTAMPTZ,
  work_done_at TIMESTAMPTZ,
  listed_at TIMESTAMPTZ,
  leased_at TIMESTAMPTZ,
  occupied_at TIMESTAMPTZ,
  daily_rent     NUMERIC(14,2),
  cost_total     NUMERIC(14,2) DEFAULT 0,
  state          TEXT NOT NULL DEFAULT 'vacant'
                 CHECK (state IN ('vacant','inspecting','working','listed','leased','occupied')),
  note           TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_turnover_state ON turnovers(state, vacated_at);

CREATE TABLE IF NOT EXISTS turnover_tasks (
  id          TEXT PRIMARY KEY,
  turnover_id TEXT NOT NULL REFERENCES turnovers(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  ticket_id   TEXT REFERENCES maintenance(id),
  po_id       TEXT REFERENCES purchase_orders(id),
  done BOOLEAN NOT NULL DEFAULT FALSE,
  done_at TIMESTAMPTZ,
  done_by     TEXT
);

-- ---------- Pricing signals ----------
-- A unit shown twelve times without an application is telling you something.
CREATE TABLE IF NOT EXISTS pricing_signals (
  id            TEXT PRIMARY KEY,
  unit_type     TEXT NOT NULL,
  period        TEXT NOT NULL,
  showings      INTEGER NOT NULL DEFAULT 0,
  applications  INTEGER NOT NULL DEFAULT 0,
  not_interested INTEGER NOT NULL DEFAULT 0,
  price_reason  INTEGER NOT NULL DEFAULT 0, -- said no because of price
  avg_days_vacant NUMERIC(10,6),
  current_rent  NUMERIC(14,2),
  computed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (unit_type, period)
);

-- ---------- GST ----------
CREATE TABLE IF NOT EXISTS gst_returns (
  id            TEXT PRIMARY KEY,
  period_from DATE NOT NULL,
  period_to DATE NOT NULL,
  collected     NUMERIC(14,2) NOT NULL DEFAULT 0,    -- 2300, GST charged out
  input_credits NUMERIC(14,2) NOT NULL DEFAULT 0,    -- 1210, GST paid on purchases
  net           NUMERIC(14,2) NOT NULL DEFAULT 0,
  state         TEXT NOT NULL DEFAULT 'draft'
                CHECK (state IN ('draft','filed','paid')),
  filed_at TIMESTAMPTZ,
  filed_by      TEXT REFERENCES users(id),
  confirmation  TEXT,
  entry_id      TEXT REFERENCES journal_entries(id),
  note          TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (period_from, period_to)
);

-- ---------- Fixed assets ----------
CREATE TABLE IF NOT EXISTS fixed_assets (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  building_code  TEXT REFERENCES buildings(code),
  asset_class    TEXT,                      -- CCA class, e.g. 1 for buildings
  cost           NUMERIC(14,2) NOT NULL,
  in_service_on DATE NOT NULL,
  useful_life_years NUMERIC(10,6),
  method         TEXT NOT NULL DEFAULT 'straight_line'
                 CHECK (method IN ('straight_line','declining_balance')),
  rate NUMERIC(10,6),                      -- for declining balance
  salvage        NUMERIC(14,2) DEFAULT 0,
  asset_gl       TEXT DEFAULT '1500',
  accum_gl       TEXT DEFAULT '1510',
  expense_gl     TEXT DEFAULT '5200',
  disposed_on DATE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS depreciation_runs (
  id         TEXT PRIMARY KEY,
  asset_id   TEXT NOT NULL REFERENCES fixed_assets(id),
  period     TEXT NOT NULL,
  amount     NUMERIC(14,2) NOT NULL,
  entry_id   TEXT REFERENCES journal_entries(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (asset_id, period)
);

-- ---------- Owner statements ----------
CREATE TABLE IF NOT EXISTS owner_statements (
  id            TEXT PRIMARY KEY,
  period        TEXT NOT NULL,
  building_code TEXT REFERENCES buildings(code),
  figures       TEXT NOT NULL,
  method        TEXT NOT NULL,
  distribution  NUMERIC(14,2) DEFAULT 0,
  state         TEXT NOT NULL DEFAULT 'draft'
                CHECK (state IN ('draft','final','sent')),
  entry_id      TEXT REFERENCES journal_entries(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (period, building_code)
);

-- ==================== schema-signing.sql ====================
-- ============================================================
-- Baydo Pointe — electronic signature
--
-- What makes an electronic signature hold up is not the drawn mark.
-- It is the trail: who signed, when, from where, what they were
-- shown, and proof the document did not change afterwards.
--
-- So the source file is hashed before it goes out, the signed file
-- is hashed after, and every event in between is recorded with a
-- timestamp and an address. The certificate of completion carries
-- all of it, and travels with the document.
--
-- Alberta's Electronic Transactions Act requires the parties to
-- have consented to sign electronically. That consent is a recorded
-- event here, not an assumption.
-- ============================================================


CREATE TABLE IF NOT EXISTS signature_requests (
  id              TEXT PRIMARY KEY,
  reference       TEXT NOT NULL UNIQUE,
  issue_id        TEXT REFERENCES agreement_issues(id),
  version_id      TEXT NOT NULL REFERENCES agreement_versions(id),
  agreement_id    TEXT NOT NULL REFERENCES agreements(id),
  unit_number     TEXT,
  lease_id        TEXT REFERENCES leases(id),

  -- The document as it left. Everything afterwards is measured against this.
  source_sha256   TEXT NOT NULL,
  source_filename TEXT NOT NULL,
  source_key      TEXT NOT NULL,

  -- The document as it came back, with the marks overlaid. The source is
  -- never modified: a signed copy is a new file.
  signed_key      TEXT,
  signed_sha256   TEXT,
  certificate_key TEXT,

  particulars     TEXT,                     -- what the tenant was told, captured at issue
  locale          TEXT DEFAULT 'en',
  message         TEXT,
  expires_at TIMESTAMPTZ,
  state           TEXT NOT NULL DEFAULT 'draft'
                  CHECK (state IN ('draft','sent','viewed','signed','completed','declined','expired','voided')),
  declined_reason TEXT,
  voided_reason   TEXT,
  completed_at TIMESTAMPTZ,
  created_by      TEXT REFERENCES users(id),
  created_name    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sigreq_state ON signature_requests(state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sigreq_unit ON signature_requests(unit_number);

-- Everyone who has to sign. Order matters when the landlord signs after the
-- tenant, which is the usual arrangement.
CREATE TABLE IF NOT EXISTS signature_parties (
  id            TEXT PRIMARY KEY,
  request_id    TEXT NOT NULL REFERENCES signature_requests(id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('tenant','landlord','witness','guarantor')),
  full_name     TEXT NOT NULL,
  email         TEXT,
  phone         TEXT,
  sign_order    INTEGER NOT NULL DEFAULT 1,
  access_token  TEXT UNIQUE,
  -- A second factor for anything the party has to prove. Not always needed —
  -- for a tenant who applied through the site the email link is the identity.
  access_code   TEXT,
  consented_at TIMESTAMPTZ,                       -- ETA requires consent to sign electronically
  viewed_at TIMESTAMPTZ,
  signed_at TIMESTAMPTZ,
  declined_at TIMESTAMPTZ,
  decline_reason TEXT,
  signature_image TEXT,                     -- data URL of the drawn or typed mark
  signature_kind  TEXT CHECK (signature_kind IN ('drawn','typed','uploaded')),
  ip_address    TEXT,
  user_agent    TEXT,
  outbox_id     TEXT REFERENCES outbox(id),
  reminded_at TIMESTAMPTZ,
  reminder_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sigparty_req ON signature_parties(request_id, sign_order);

-- Where each mark goes on the page. Positions are in PDF points from the
-- bottom-left, which is how the PDF itself measures.
CREATE TABLE IF NOT EXISTS signature_fields (
  id          TEXT PRIMARY KEY,
  request_id  TEXT NOT NULL REFERENCES signature_requests(id) ON DELETE CASCADE,
  party_id    TEXT NOT NULL REFERENCES signature_parties(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('signature','initials','date','text','checkbox')),
  label       TEXT,
  page        INTEGER NOT NULL,
  x           NUMERIC(14,2) NOT NULL,
  y           NUMERIC(14,2) NOT NULL,
  width       NUMERIC(14,2) NOT NULL DEFAULT 180,
  height      NUMERIC(14,2) NOT NULL DEFAULT 44,
  required BOOLEAN NOT NULL DEFAULT TRUE,
  value       TEXT,
  filled_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sigfield_req ON signature_fields(request_id, page);

-- Every event, in order. This is the part that matters in a dispute: not that
-- somebody signed, but that the trail shows what they saw and when.
CREATE TABLE IF NOT EXISTS signature_events (
  id          TEXT PRIMARY KEY,
  request_id  TEXT NOT NULL REFERENCES signature_requests(id) ON DELETE CASCADE,
  party_id    TEXT REFERENCES signature_parties(id),
  event       TEXT NOT NULL,                -- created | sent | opened | consented | signed | ...
  detail      TEXT,
  ip_address  TEXT,
  user_agent  TEXT,
  sha256      TEXT,                         -- document hash at this moment, where relevant
  actor_name  TEXT,
  at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sigevent_req ON signature_events(request_id, at);

-- ==================== schema-fees.sql ====================
-- ============================================================
-- Baydo Pointe — management fees, payroll, distributions
--
-- Formulas are versioned by effective date, not overwritten. Change
-- the rate in June and May still calculates at the old one — a rate
-- that applies retroactively rewrites months somebody has already
-- been paid on.
-- ============================================================


CREATE TABLE IF NOT EXISTS fee_formulas (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL,              -- management_fee | bm_payroll
  label_en      TEXT NOT NULL,
  label_zh      TEXT NOT NULL,

  -- How it is worked out. Kept as parts rather than an expression, because a
  -- formula somebody can type is a formula somebody can typo into a number
  -- nobody notices.
  basis         TEXT NOT NULL,              -- percent_of_income | per_unit | flat
  rate NUMERIC(10,6),                       -- 0.04 for 4%
  per_unit_rate NUMERIC(14,2),                       -- 30.00
  flat_amount   NUMERIC(14,2),

  -- Which income counts. This is the part that causes arguments with owners,
  -- so it is explicit rather than assumed.
  income_scope  TEXT,                       -- JSON array of GL codes
  income_basis  TEXT DEFAULT 'collected'
                CHECK (income_basis IN ('collected','billed')),
  unit_scope    TEXT DEFAULT 'all'
                CHECK (unit_scope IN ('all','occupied','leased')),

  gst_applies BOOLEAN NOT NULL DEFAULT TRUE,
  gst_rate NUMERIC(10,6) NOT NULL DEFAULT 0.05,

  expense_gl    TEXT REFERENCES gl_accounts(code),
  gst_gl        TEXT REFERENCES gl_accounts(code),
  payable_gl    TEXT REFERENCES gl_accounts(code),

  building_code TEXT REFERENCES buildings(code),   -- null = the whole property
  effective_from DATE NOT NULL,
  effective_to DATE,
  note          TEXT,
  created_by    TEXT REFERENCES users(id),
  created_name  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
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

  base_amount   NUMERIC(14,2) NOT NULL,              -- the income, or the unit count
  base_detail   TEXT,                       -- what went into it, line by line
  rate_used NUMERIC(10,6),
  subtotal      NUMERIC(14,2) NOT NULL,
  gst           NUMERIC(14,2) NOT NULL DEFAULT 0,
  total         NUMERIC(14,2) NOT NULL,
  method        TEXT NOT NULL,              -- how it was worked out, in words

  entry_id      TEXT REFERENCES journal_entries(id),
  state         TEXT NOT NULL DEFAULT 'draft'
                CHECK (state IN ('draft','approved','posted','paid','void')),
  approved_by   TEXT REFERENCES users(id),
  approved_name TEXT,
  approved_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  void_reason   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
  rate_per_unit NUMERIC(14,2),
  gross         NUMERIC(14,2) NOT NULL,

  -- Employee only. A contractor invoices and remits their own.
  cpp_employee  NUMERIC(14,2) DEFAULT 0,
  ei_employee   NUMERIC(14,2) DEFAULT 0,
  tax_withheld  NUMERIC(14,2) DEFAULT 0,
  cpp_employer  NUMERIC(14,2) DEFAULT 0,
  ei_employer   NUMERIC(14,2) DEFAULT 0,

  -- Contractor only, and only if they are registered.
  gst           NUMERIC(14,2) DEFAULT 0,

  net_pay       NUMERIC(14,2) NOT NULL,
  employer_cost NUMERIC(14,2) NOT NULL,
  method        TEXT NOT NULL,
  entry_id      TEXT REFERENCES journal_entries(id),
  state         TEXT NOT NULL DEFAULT 'draft'
                CHECK (state IN ('draft','approved','posted','paid','void')),
  approved_by   TEXT REFERENCES users(id),
  approved_name TEXT,
  approved_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (period, person_name)
);

-- Distributions to the owner. Cash going out, not an expense: it reduces
-- equity rather than profit, and treating it as an expense understates the
-- income the property actually made.
CREATE TABLE IF NOT EXISTS owner_distributions (
  id            TEXT PRIMARY KEY,
  period        TEXT NOT NULL,
  building_code TEXT REFERENCES buildings(code),
  amount        NUMERIC(14,2) NOT NULL,
  cash_available NUMERIC(14,2),
  reserve_held  NUMERIC(14,2) DEFAULT 0,
  method        TEXT NOT NULL,
  statement_id  TEXT REFERENCES owner_statements(id),
  entry_id      TEXT REFERENCES journal_entries(id),
  paid_from TEXT DEFAULT '1010' REFERENCES gl_accounts(code),
  state         TEXT NOT NULL DEFAULT 'draft'
                CHECK (state IN ('draft','approved','paid','void')),
  approved_by   TEXT REFERENCES users(id),
  approved_name TEXT,
  approved_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  reference     TEXT,
  note          TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_dist_period ON owner_distributions(period);

-- ==================== schema-remuneration.sql ====================
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


CREATE TABLE IF NOT EXISTS formula_components (
  id            TEXT PRIMARY KEY,
  formula_id    TEXT NOT NULL REFERENCES fee_formulas(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL DEFAULT 1,
  label         TEXT NOT NULL,

  basis         TEXT NOT NULL CHECK (basis IN
                  ('percent_of_income','per_unit','flat','per_lease','hourly','tiered')),

  rate NUMERIC(10,6),                       -- 0.04
  per_unit_rate NUMERIC(14,2),                       -- 30.00
  flat_amount   NUMERIC(14,2),                       -- 500.00
  hourly_rate   NUMERIC(14,2),
  hours NUMERIC(10,6),

  income_scope  TEXT,                       -- JSON array of GL codes
  income_basis  TEXT DEFAULT 'collected'
                CHECK (income_basis IN ('collected','billed')),
  unit_scope    TEXT DEFAULT 'all'
                CHECK (unit_scope IN ('all','occupied','vacant','leased')),

  -- Banded: [{"upto":50000,"rate":0.05},{"upto":null,"rate":0.03}]. A tier
  -- with no upper bound has to be last, or everything above it is unpriced.
  tiers         TEXT,

  gst_applies BOOLEAN NOT NULL DEFAULT FALSE,
  expense_gl    TEXT REFERENCES gl_accounts(code),
  note          TEXT
);
CREATE INDEX IF NOT EXISTS idx_fcomp ON formula_components(formula_id, seq);

-- Caps live on the formula, not the component: a minimum that applied per
-- component would guarantee the minimum several times over.
CREATE TABLE IF NOT EXISTS formula_caps (
  formula_id  TEXT PRIMARY KEY REFERENCES fee_formulas(id) ON DELETE CASCADE,
  minimum     NUMERIC(14,2),
  maximum     NUMERIC(14,2),
  -- A cap expressed against income rather than a flat figure, which is how
  -- most agreements word it: "not more than 6% of gross".
  max_percent_of_income NUMERIC(10,6),
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
  wages_included BOOLEAN NOT NULL DEFAULT FALSE,
  agreed_note TEXT,
  updated_by  TEXT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Which formulas belong to the group.
CREATE TABLE IF NOT EXISTS remuneration_members (
  group_code  TEXT NOT NULL REFERENCES remuneration_groups(code) ON DELETE CASCADE,
  fee_code    TEXT NOT NULL,
  seq         INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (group_code, fee_code)
);

-- ==================== schema-proposals.sql ====================
-- ============================================================
-- Baydo Pointe — AI proposals
--
-- Nothing the AI produces applies itself. Every task that would
-- change something writes a proposal here, and a person confirms
-- it before anything happens.
--
-- One table rather than a flag on each feature, because the useful
-- question is "what is waiting on me" and that has to be answerable
-- in one place. A confirmation queue spread across six screens is a
-- confirmation queue nobody works through.
--
-- Some proposals need two people. Sending an arrears sequence needs
-- the Property Manager who knows the tenant and the Admin who owns
-- the consequences; either alone is somebody deciding on their own
-- what the other would have questioned.
-- ============================================================


CREATE TABLE IF NOT EXISTS ai_proposals (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  summary       TEXT,

  -- What the AI produced, and what it was given. Both are kept: a
  -- proposal that cannot show its inputs cannot be checked, only trusted.
  payload       TEXT NOT NULL,
  inputs        TEXT,
  method        TEXT,
  model         TEXT,
  confidence    TEXT CHECK (confidence IN ('high','medium','low','unverified')),

  -- Where it came from and what it would touch.
  ref_type      TEXT,
  ref_id        TEXT,
  building_code TEXT REFERENCES buildings(code),
  unit_number   TEXT,
  amount        NUMERIC(14,2),

  -- Who has to say yes. Two names here means two people, not either.
  required_roles TEXT NOT NULL,
  -- Anything that reaches a tenant or moves money is flagged, so the
  -- queue can be read by consequence rather than by date.
  reaches_tenant BOOLEAN NOT NULL DEFAULT FALSE,
  moves_money BOOLEAN NOT NULL DEFAULT FALSE,

  state         TEXT NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending','confirmed','applied','rejected','expired','superseded')),
  applied_at TIMESTAMPTZ,
  applied_note  TEXT,
  rejected_by   TEXT REFERENCES users(id),
  rejected_name TEXT,
  rejected_reason TEXT,
  rejected_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,

  created_by    TEXT REFERENCES users(id),
  created_name  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_prop_state ON ai_proposals(state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prop_kind ON ai_proposals(kind, state);

-- One row per person who confirmed. Edits are recorded here too: somebody
-- who changed the amount before confirming has not confirmed the AI's
-- figure, and the difference between those two is worth keeping.
CREATE TABLE IF NOT EXISTS proposal_confirmations (
  id           TEXT PRIMARY KEY,
  proposal_id  TEXT NOT NULL REFERENCES ai_proposals(id) ON DELETE CASCADE,
  role_code    TEXT NOT NULL,
  user_id      TEXT REFERENCES users(id),
  user_name    TEXT,
  edited BOOLEAN NOT NULL DEFAULT FALSE,
  edited_payload TEXT,
  note         TEXT,
  at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (proposal_id, role_code)
);

-- Vendor quotes, so they can be compared. Uploaded rather than typed:
-- what the vendor sent is the thing that matters if the work is disputed.
CREATE TABLE IF NOT EXISTS vendor_quotes (
  id            TEXT PRIMARY KEY,
  ticket_id     TEXT REFERENCES maintenance(id),
  po_id         TEXT REFERENCES purchase_orders(id),
  vendor_id     TEXT REFERENCES vendors(id),
  vendor_name   TEXT NOT NULL,
  amount        NUMERIC(14,2),
  received_on DATE,
  valid_until   TEXT,
  lead_time_days INTEGER,
  scope         TEXT,
  exclusions    TEXT,
  filename      TEXT,
  stored_key    TEXT,
  sha256        TEXT,
  notes         TEXT,
  uploaded_by   TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_quote_ticket ON vendor_quotes(ticket_id);

-- Read-only queries the AI wrote. The SQL is kept and shown: a query
-- nobody can see is an answer nobody can check.
CREATE TABLE IF NOT EXISTS query_log (
  id          TEXT PRIMARY KEY,
  question    TEXT NOT NULL,
  sql_text    TEXT NOT NULL,
  row_count   INTEGER,
  result_json TEXT,
  ms          INTEGER,
  error       TEXT,
  confirmed_by TEXT REFERENCES users(id),
  confirmed_name TEXT,
  asked_by    TEXT REFERENCES users(id),
  asked_name  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Extracted from an uploaded lease. Populates a draft; the file stays
-- the authority.
CREATE TABLE IF NOT EXISTS lease_abstracts (
  id            TEXT PRIMARY KEY,
  issue_id      TEXT REFERENCES agreement_issues(id),
  version_id    TEXT REFERENCES agreement_versions(id),
  unit_number   TEXT,
  fields        TEXT NOT NULL,              -- JSON, each field with its own confidence
  source_sha256 TEXT,
  state         TEXT NOT NULL DEFAULT 'draft'
                CHECK (state IN ('draft','confirmed','rejected')),
  confirmed_by  TEXT REFERENCES users(id),
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ==================== schema-arrears.sql ====================
-- ============================================================
-- Baydo Pointe — arrears history and the evidence behind it
--
-- Every demand for rent is recorded here, not only queued as a
-- message. Those are different things: a message queue answers
-- "did we send it", and an application to end a tenancy needs
-- "what was owed, what was demanded, when, and how it reached
-- them".
--
-- Alberta's rules on service and notice periods are specific, and
-- an application usually fails on service or on the notice itself
-- rather than on the debt. So this holds the record; the notice
-- form is uploaded and approved like any other agreement, because
-- a notice with the wrong wording fails whatever the arrears show.
-- ============================================================


CREATE TABLE IF NOT EXISTS arrears_files (
  id            TEXT PRIMARY KEY,
  unit_number   TEXT NOT NULL REFERENCES units(unit_number),
  lease_id      TEXT REFERENCES leases(id),
  contact_id    TEXT REFERENCES contacts(id),
  tenant_name   TEXT NOT NULL,

  opened_on DATE NOT NULL,
  opening_owed  NUMERIC(14,2) NOT NULL,
  current_owed  NUMERIC(14,2) NOT NULL,
  peak_owed     NUMERIC(14,2),

  state         TEXT NOT NULL DEFAULT 'open'
                CHECK (state IN ('open','arrangement','cleared','notice_served','ended','written_off')),
  -- A payment arrangement changes what a later application can rely on:
  -- a tenant keeping to an agreed schedule is not in the same position as
  -- one who has not answered.
  arrangement_note TEXT,
  arrangement_from DATE,
  cleared_on DATE,
  closed_reason TEXT,
  created_by    TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (unit_number, opened_on)
);
CREATE INDEX IF NOT EXISTS idx_arrears_state ON arrears_files(state, current_owed DESC);

-- One row per demand. This is the spine of an application: what was owed at
-- that moment, what was asked for, and how it was delivered.
CREATE TABLE IF NOT EXISTS arrears_steps (
  id            TEXT PRIMARY KEY,
  file_id       TEXT NOT NULL REFERENCES arrears_files(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  step          TEXT NOT NULL,              -- reminder | request | direct | notice | filing
  owed_at_time  NUMERIC(14,2) NOT NULL,
  charges_cited TEXT,                       -- JSON: which charges made up the figure
  subject       TEXT,
  body          TEXT NOT NULL,

  -- Service. Alberta has rules about what counts and when it is deemed
  -- received, and an application fails on this more often than on the debt.
  method        TEXT NOT NULL CHECK (method IN
                  ('email','sms','post','personal','posted_on_door','courier')),
  served_on DATE NOT NULL,
  deemed_served_on DATE,
  served_by     TEXT,
  witness       TEXT,
  delivery_state TEXT NOT NULL DEFAULT 'queued'
                CHECK (delivery_state IN ('queued','sent','delivered','bounced','unknown')),
  provider_id   TEXT,
  outbox_id     TEXT REFERENCES outbox(id),

  -- Photographs of a notice on a door, a courier receipt, a delivery report.
  evidence_key  TEXT,
  evidence_sha256 TEXT,

  tenant_response TEXT,
  responded_at TIMESTAMPTZ,
  drafted_by_ai BOOLEAN NOT NULL DEFAULT FALSE,
  approved_by   TEXT REFERENCES users(id),
  approved_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_astep_file ON arrears_steps(file_id, seq);

-- Payments received while the file is open, so the running figure in the
-- history is the figure that was true on the day of each demand.
CREATE TABLE IF NOT EXISTS arrears_payments (
  id          TEXT PRIMARY KEY,
  file_id     TEXT NOT NULL REFERENCES arrears_files(id) ON DELETE CASCADE,
  receipt_id  TEXT REFERENCES ar_receipts(id),
  amount      NUMERIC(14,2) NOT NULL,
  received_on DATE NOT NULL,
  owed_after  NUMERIC(14,2) NOT NULL,
  note        TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Exports of the file, because handing a bundle to a lawyer or filing it is
-- itself an event, and the hash says which version was handed over.
CREATE TABLE IF NOT EXISTS arrears_exports (
  id          TEXT PRIMARY KEY,
  file_id     TEXT NOT NULL REFERENCES arrears_files(id),
  purpose     TEXT,                         -- rtdrs | lawyer | internal | tenant
  step_count  INTEGER,
  owed_at_export NUMERIC(14,2),
  sha256      TEXT,
  exported_by TEXT REFERENCES users(id),
  exported_name TEXT,
  exported_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ==================== db.js compatibility columns ====================
ALTER TABLE ap_invoices ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ar_receipts ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ar_charges ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_expires_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS normalised_email TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS normalised_phone TEXT;



-- The per-unit parking limit lives on the pool, not in the request. With 222
-- stalls for 330 units this is the rule that decides who goes without, and a
-- limit the caller supplies is not a limit.
ALTER TABLE parking_pools ADD COLUMN IF NOT EXISTS max_per_unit INTEGER NOT NULL DEFAULT 1;

-- ============================================================
-- Guards
--
-- These catch the mistakes that are silent otherwise. A negative
-- charge is a typo, not a credit — a credit is its own entry — and
-- left alone it quietly reduces what the ledger says is owed.
-- ============================================================

DO $$
BEGIN
  -- Charges and receipts are positive. A refund or a write-off is a
  -- separate entry with its own reason, not a negative charge.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ar_charges_amount_positive') THEN
    ALTER TABLE ar_charges ADD CONSTRAINT ar_charges_amount_positive
      CHECK (amount >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ar_charges_paid_not_over') THEN
    ALTER TABLE ar_charges ADD CONSTRAINT ar_charges_paid_not_over
      CHECK (paid_amount >= 0 AND paid_amount <= amount + 0.005);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ar_receipts_amount_positive') THEN
    ALTER TABLE ar_receipts ADD CONSTRAINT ar_receipts_amount_positive
      CHECK (amount > 0);
  END IF;

  -- A journal line is a debit or a credit, never both and never neither.
  -- Both would double the entry; neither is a line that does nothing but
  -- still counts towards the balance check.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'journal_lines_one_side') THEN
    ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_one_side
      CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0));
  END IF;

  -- A vendor invoice cannot be paid more than it is for.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ap_invoices_paid_not_over') THEN
    ALTER TABLE ap_invoices ADD CONSTRAINT ap_invoices_paid_not_over
      CHECK (paid_amount >= 0 AND paid_amount <= total + 0.005);
  END IF;

  -- The charge day is capped at 28. A schedule set to the 30th silently
  -- skips February, and nobody notices until the year-end numbers are wrong.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'charge_schedules_day_range') THEN
    ALTER TABLE charge_schedules ADD CONSTRAINT charge_schedules_day_range
      CHECK (charge_day BETWEEN 1 AND 28);
  END IF;
END $$;

-- The rent run must be safe to repeat. A retry after a failure should add
-- nothing rather than bill 330 tenants twice, and a unique index is the only
-- version of that promise the database itself enforces.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ar_charges_schedule_period
  ON ar_charges (schedule_id, period) WHERE schedule_id IS NOT NULL;

-- The same vendor invoice entered twice is the most common AP error and the
-- hardest to spot afterwards.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ap_invoices_vendor_number
  ON ap_invoices (vendor_id, invoice_no);

-- One live agreement version at a time. Two would mean two tenants signing
-- different leases in the same week without anybody noticing.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agreement_versions_one_live
  ON agreement_versions (agreement_id) WHERE state = 'approved';

-- One open arrears file per unit. A second would split the demand history
-- across two records, and the history is the whole point of the file.
CREATE UNIQUE INDEX IF NOT EXISTS idx_arrears_one_open
  ON arrears_files (unit_number)
  WHERE state IN ('open', 'arrangement', 'notice_served');


-- ============================================================
-- The two rules the ledger cannot be wrong about
--
-- Both are already checked in the application. They are here as
-- well because the database is the only place that runs on every
-- path: a script, a migration, somebody in the SQL editor at
-- eleven at night, a route ported next month by whoever inherits
-- this.
--
-- An unbalanced entry does not announce itself. It sits there and
-- the trial balance is out by an amount nobody can trace to a
-- transaction, and by the time anybody looks the entry is one of
-- forty thousand.
-- ============================================================

CREATE OR REPLACE FUNCTION check_entry_balanced() RETURNS TRIGGER AS $$
DECLARE
  total_debit  NUMERIC(14,2);
  total_credit NUMERIC(14,2);
  entry_state  TEXT;
BEGIN
  SELECT state INTO entry_state FROM journal_entries
  WHERE id = COALESCE(NEW.entry_id, OLD.entry_id);

  -- A draft is allowed to be unbalanced while somebody is building it.
  -- Posting is the moment it has to be right.
  IF entry_state IS DISTINCT FROM 'posted' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
  INTO total_debit, total_credit
  FROM journal_lines WHERE entry_id = COALESCE(NEW.entry_id, OLD.entry_id);

  IF total_debit <> total_credit THEN
    RAISE EXCEPTION
      'Entry % does not balance: debits %, credits %, difference %',
      COALESCE(NEW.entry_id, OLD.entry_id), total_debit, total_credit,
      total_debit - total_credit;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_entry_balanced ON journal_lines;
CREATE CONSTRAINT TRIGGER trg_entry_balanced
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  -- Deferred to the end of the transaction. Checking after each line would
  -- fail on the first one, since an entry is only balanced once every line
  -- is in.
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_entry_balanced();


-- A closed period does not take new entries.
--
-- Reopening one to fix something is how a set of books stops matching the
-- statements that were already issued from it. The correction goes in the
-- current period as a reversal and a replacement, both visible.

CREATE OR REPLACE FUNCTION check_period_open() RETURNS TRIGGER AS $$
DECLARE
  period_state TEXT;
BEGIN
  IF NEW.state <> 'posted' THEN
    RETURN NEW;
  END IF;

  SELECT state INTO period_state FROM accounting_periods
  WHERE period = NEW.period;

  IF period_state = 'closed' THEN
    RAISE EXCEPTION
      'Period % is closed. Post the correction to the current period as a reversal and a replacement.',
      NEW.period;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_period_open ON journal_entries;
CREATE TRIGGER trg_period_open
  BEFORE INSERT OR UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION check_period_open();


-- The security deposit trust account must equal the deposit liability.
--
-- Not enforced as a constraint, because a deposit arriving and the liability
-- being recorded are two lines of one entry and there is a moment between
-- them. This is a view, so the dashboard check has one definition rather than
-- one per screen.
--
-- Getting this wrong is the way small landlords fail: deposits treated as
-- income make a good year, and then there is nothing to return at move-out.

CREATE OR REPLACE VIEW trust_reconciliation AS
SELECT
  COALESCE((SELECT SUM(jl.debit) - SUM(jl.credit)
            FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
            WHERE jl.gl_code = '1020' AND je.state = 'posted'), 0) AS trust_bank,
  COALESCE((SELECT SUM(jl.credit) - SUM(jl.debit)
            FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
            WHERE jl.gl_code IN ('2100','2110') AND je.state = 'posted'), 0)
    AS deposit_liability,
  COALESCE((SELECT SUM(jl.debit) - SUM(jl.credit)
            FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
            WHERE jl.gl_code = '1020' AND je.state = 'posted'), 0)
  - COALESCE((SELECT SUM(jl.credit) - SUM(jl.debit)
              FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
              WHERE jl.gl_code IN ('2100','2110') AND je.state = 'posted'), 0)
    AS difference;

COMMIT;


-- ============================================================
-- SAFE BASE SEED DATA
-- No staff passwords are inserted here.
-- ============================================================

BEGIN;
INSERT INTO roles (code, name) VALUES
  ('admin', 'Admin'),
  ('property_manager', 'Property Manager'),
  ('building_manager', 'Building Manager'),
  ('accounting', 'Accounting')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO permissions (code, description) VALUES
  ('settings.pricing.edit', 'Edit pricing and fee settings'),
  ('settings.parking.quota', 'Edit parking stall quotas'),
  ('templates.manage', 'Upload and approve document templates'),
  ('users.manage', 'Manage accounts and roles'),
  ('audit.view', 'View the audit log'),
  ('backup.restore', 'Create backups and restore'),
  ('process.delete', 'Delete or roll back workflows'),
  ('units.view', 'View units, vacancy and resulting rent'),
  ('parking.view', 'View parking quotas and waitlist'),
  ('parking.allocate', 'Allocate and promote parking stalls'),
  ('schedule.view', 'View schedule and task lists'),
  ('leads.view', 'Browse leads'),
  ('notifications.view', 'View notifications'),
  ('evidence.upload', 'Upload evidence files'),
  ('units.status.edit', 'Change unit status'),
  ('leads.manage', 'Own leads and showing schedule'),
  ('showings.manage', 'Book and confirm showings'),
  ('maintenance.manage', 'Maintenance tickets'),
  ('entrynotice.manage', 'Notices of entry'),
  ('keys.manage', 'Key handover'),
  ('schedule.leasing', 'Book signings, renewals and follow-ups'),
  ('schedule.showings', 'Book viewings and key handovers'),
  ('keys.release', 'Confirm a lease is signed so keys can be booked'),
  ('po.create', 'Raise a purchase order'),
  ('po.confirm', 'Confirm the actual amount after the work'),
  ('po.bill', 'Turn a confirmed order into a bill'),
  ('escalation.answer', 'Answer a message the AI passed to a person'),
  ('accounting.view', 'View ledgers, invoices and reports'),
  ('accounting.post', 'Post journal entries, charges and receipts'),
  ('accounting.ap', 'Vendor invoices and payments'),
  ('accounting.ar', 'Rent charges and receipts'),
  ('accounting.bank', 'Upload statements and reconcile'),
  ('accounting.close', 'Reconcile and close a period'),
  ('accounting.coa', 'Edit the chart of accounts'),
  ('accounting.reports', 'Generate and approve monthly reports'),
  ('inbox.manage', 'AI inbox'),
  ('lease.sign', 'Signing and unit locks'),
  ('documents.approve', 'Approve and release documents'),
  ('moveout.process', 'Move-out workflow'),
  ('renewals.decide', 'Renewal decisions')
ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('admin', 'settings.pricing.edit'),
  ('admin', 'settings.parking.quota'),
  ('admin', 'templates.manage'),
  ('admin', 'users.manage'),
  ('admin', 'audit.view'),
  ('admin', 'backup.restore'),
  ('admin', 'process.delete'),
  ('admin', 'units.view'),
  ('admin', 'parking.view'),
  ('admin', 'parking.allocate'),
  ('admin', 'schedule.view'),
  ('admin', 'leads.view'),
  ('admin', 'notifications.view'),
  ('admin', 'evidence.upload'),
  ('admin', 'units.status.edit'),
  ('admin', 'leads.manage'),
  ('admin', 'showings.manage'),
  ('admin', 'maintenance.manage'),
  ('admin', 'entrynotice.manage'),
  ('admin', 'keys.manage'),
  ('admin', 'schedule.leasing'),
  ('admin', 'schedule.showings'),
  ('admin', 'keys.release'),
  ('admin', 'po.create'),
  ('admin', 'po.confirm'),
  ('admin', 'po.bill'),
  ('admin', 'escalation.answer'),
  ('admin', 'accounting.view'),
  ('admin', 'accounting.post'),
  ('admin', 'accounting.ap'),
  ('admin', 'accounting.ar'),
  ('admin', 'accounting.bank'),
  ('admin', 'accounting.close'),
  ('admin', 'accounting.coa'),
  ('admin', 'accounting.reports'),
  ('admin', 'inbox.manage'),
  ('admin', 'lease.sign'),
  ('admin', 'documents.approve'),
  ('admin', 'moveout.process'),
  ('admin', 'renewals.decide'),
  ('property_manager', 'units.view'),
  ('property_manager', 'parking.view'),
  ('property_manager', 'parking.allocate'),
  ('property_manager', 'schedule.view'),
  ('property_manager', 'leads.view'),
  ('property_manager', 'notifications.view'),
  ('property_manager', 'evidence.upload'),
  ('property_manager', 'units.status.edit'),
  ('property_manager', 'inbox.manage'),
  ('property_manager', 'lease.sign'),
  ('property_manager', 'documents.approve'),
  ('property_manager', 'moveout.process'),
  ('property_manager', 'renewals.decide'),
  ('property_manager', 'schedule.leasing'),
  ('property_manager', 'keys.release'),
  ('property_manager', 'escalation.answer'),
  ('property_manager', 'accounting.view'),
  ('property_manager', 'po.bill'),
  ('building_manager', 'units.view'),
  ('building_manager', 'parking.view'),
  ('building_manager', 'parking.allocate'),
  ('building_manager', 'schedule.view'),
  ('building_manager', 'leads.view'),
  ('building_manager', 'notifications.view'),
  ('building_manager', 'evidence.upload'),
  ('building_manager', 'units.status.edit'),
  ('building_manager', 'leads.manage'),
  ('building_manager', 'showings.manage'),
  ('building_manager', 'maintenance.manage'),
  ('building_manager', 'entrynotice.manage'),
  ('building_manager', 'keys.manage'),
  ('building_manager', 'schedule.showings'),
  ('building_manager', 'po.create'),
  ('building_manager', 'po.confirm'),
  ('accounting', 'units.view'),
  ('accounting', 'parking.view'),
  ('accounting', 'schedule.view'),
  ('accounting', 'notifications.view'),
  ('accounting', 'evidence.upload'),
  ('accounting', 'accounting.view'),
  ('accounting', 'accounting.post'),
  ('accounting', 'accounting.ap'),
  ('accounting', 'accounting.ar'),
  ('accounting', 'accounting.bank'),
  ('accounting', 'accounting.close'),
  ('accounting', 'accounting.coa'),
  ('accounting', 'accounting.reports'),
  ('accounting', 'po.bill')
ON CONFLICT DO NOTHING;

INSERT INTO buildings (id, code, name, address, storeys, unit_count) VALUES
  ('bd_370', '370', 'Baydo Pointe 370', '370 Clareview Station Drive NW, Edmonton, AB', 6, 118),
  ('bd_374', '374', 'Baydo Pointe 374', '374 Clareview Station Drive NW, Edmonton, AB', 6, 94),
  ('bd_378', '378', 'Baydo Pointe 378', '378 Clareview Station Drive NW, Edmonton, AB', 6, 118)
ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name,address=EXCLUDED.address,storeys=EXCLUDED.storeys,unit_count=EXCLUDED.unit_count;

INSERT INTO unit_types (id, code, bedroom_label_en, bedroom_label_zh, bedrooms, area_sqft, balcony_sqft, is_mirrored) VALUES
  ('ut_1c', '1C', '1 bed', '1房', 1, 462.8, 71, FALSE),
  ('ut_1a', '1A', '1 bed', '1房', 1, 484.4, 71, FALSE),
  ('ut_1a_m', '1A (M)', '1 bed', '1房', 1, 484.4, 71, TRUE),
  ('ut_1b', '1B', '1 bed + den', '1房+書房', 1, 602.8, 71, FALSE),
  ('ut_3a', '3A', '2 bed + den', '2房+書房', 3, 731.9, 71, FALSE),
  ('ut_3a_m', '3A (M)', '2 bed + den', '2房+書房', 3, 731.9, 71, TRUE),
  ('ut_2a', '2A', '2 bed 2 bath', '2房2衛', 2, 742.7, 71, FALSE),
  ('ut_2a_m', '2A (M)', '2 bed 2 bath', '2房2衛', 2, 742.7, 71, TRUE)
ON CONFLICT (code) DO UPDATE SET bedroom_label_en=EXCLUDED.bedroom_label_en,bedroom_label_zh=EXCLUDED.bedroom_label_zh,bedrooms=EXCLUDED.bedrooms,area_sqft=EXCLUDED.area_sqft,balcony_sqft=EXCLUDED.balcony_sqft,is_mirrored=EXCLUDED.is_mirrored;

INSERT INTO parking_pools (id, code, building_code, label_en, label_zh, total_stalls, tandem_stalls, accessible_stalls, is_surface, note) VALUES
  ('pp_u370', 'u370', '370', 'Underground / Building 370', '地下 · 370棟', 52, 0, 0, FALSE, NULL),
  ('pp_u374', 'u374', '374', 'Underground / Building 374', '地下 · 374棟', 62, 16, 0, FALSE, 'Drawing labelling to be confirmed with the developer'),
  ('pp_u378', 'u378', '378', 'Underground / Building 378', '地下 · 378棟', 52, 0, 0, FALSE, NULL),
  ('pp_surface', 'surface', NULL, 'Surface / shared', '地面 · 全案共用', 56, 0, 6, TRUE, NULL)
ON CONFLICT (code) DO UPDATE SET building_code=EXCLUDED.building_code,label_en=EXCLUDED.label_en,label_zh=EXCLUDED.label_zh,total_stalls=EXCLUDED.total_stalls,tandem_stalls=EXCLUDED.tandem_stalls,accessible_stalls=EXCLUDED.accessible_stalls,is_surface=EXCLUDED.is_surface,note=EXCLUDED.note;

INSERT INTO holidays (holiday_date, name_en, name_zh, is_observed) VALUES
  ('2026-09-07', 'Labour Day', '勞動節', TRUE),
  ('2026-10-12', 'Thanksgiving', '感恩節', TRUE),
  ('2026-11-11', 'Remembrance Day', '國殤日', TRUE),
  ('2026-12-25', 'Christmas Day', '聖誕節', TRUE),
  ('2027-01-01', 'New Year''s Day', '元旦', TRUE),
  ('2026-08-03', 'Heritage Day (optional in Alberta)', 'Heritage Day（Alberta 選擇性假日）', FALSE)
ON CONFLICT (holiday_date) DO UPDATE SET name_en=EXCLUDED.name_en,name_zh=EXCLUDED.name_zh,is_observed=EXCLUDED.is_observed;

INSERT INTO units (id, building_code, unit_type_code, unit_number, floor) VALUES
  ('un_370_101', '370', '1B', '370-101', 1),
  ('un_370_102', '370', '1A', '370-102', 1),
  ('un_370_103', '370', '1A (M)', '370-103', 1),
  ('un_370_104', '370', '2A (M)', '370-104', 1),
  ('un_370_105', '370', '2A', '370-105', 1),
  ('un_370_106', '370', '1A (M)', '370-106', 1),
  ('un_370_107', '370', '1A', '370-107', 1),
  ('un_370_108', '370', '2A (M)', '370-108', 1),
  ('un_370_109', '370', '3A (M)', '370-109', 1),
  ('un_370_110', '370', '3A', '370-110', 1),
  ('un_370_111', '370', '2A', '370-111', 1),
  ('un_370_112', '370', '1A (M)', '370-112', 1),
  ('un_370_113', '370', '1A', '370-113', 1),
  ('un_370_114', '370', '2A (M)', '370-114', 1),
  ('un_370_115', '370', '2A', '370-115', 1),
  ('un_370_116', '370', '1A (M)', '370-116', 1),
  ('un_370_117', '370', '1A', '370-117', 1),
  ('un_370_118', '370', '2A (M)', '370-118', 1),
  ('un_370_201', '370', '1C', '370-201', 2),
  ('un_370_202', '370', '1A', '370-202', 2),
  ('un_370_203', '370', '1A (M)', '370-203', 2),
  ('un_370_204', '370', '2A (M)', '370-204', 2),
  ('un_370_205', '370', '2A', '370-205', 2),
  ('un_370_206', '370', '1A (M)', '370-206', 2),
  ('un_370_207', '370', '1A', '370-207', 2),
  ('un_370_208', '370', '2A (M)', '370-208', 2),
  ('un_370_209', '370', '3A (M)', '370-209', 2),
  ('un_370_210', '370', '3A', '370-210', 2),
  ('un_370_211', '370', '2A', '370-211', 2),
  ('un_370_212', '370', '1A (M)', '370-212', 2),
  ('un_370_213', '370', '1A', '370-213', 2),
  ('un_370_214', '370', '2A (M)', '370-214', 2),
  ('un_370_215', '370', '2A', '370-215', 2),
  ('un_370_216', '370', '1A (M)', '370-216', 2),
  ('un_370_217', '370', '1A', '370-217', 2),
  ('un_370_218', '370', '2A (M)', '370-218', 2),
  ('un_370_219', '370', '3A (M)', '370-219', 2),
  ('un_370_220', '370', '3A', '370-220', 2),
  ('un_370_301', '370', '1C', '370-301', 3),
  ('un_370_302', '370', '1A', '370-302', 3),
  ('un_370_303', '370', '1A (M)', '370-303', 3),
  ('un_370_304', '370', '2A (M)', '370-304', 3),
  ('un_370_305', '370', '2A', '370-305', 3),
  ('un_370_306', '370', '1A (M)', '370-306', 3),
  ('un_370_307', '370', '1A', '370-307', 3),
  ('un_370_308', '370', '2A (M)', '370-308', 3),
  ('un_370_309', '370', '3A (M)', '370-309', 3),
  ('un_370_310', '370', '3A', '370-310', 3),
  ('un_370_311', '370', '2A', '370-311', 3),
  ('un_370_312', '370', '1A (M)', '370-312', 3),
  ('un_370_313', '370', '1A', '370-313', 3),
  ('un_370_314', '370', '2A (M)', '370-314', 3),
  ('un_370_315', '370', '2A', '370-315', 3),
  ('un_370_316', '370', '1A (M)', '370-316', 3),
  ('un_370_317', '370', '1A', '370-317', 3),
  ('un_370_318', '370', '2A (M)', '370-318', 3),
  ('un_370_319', '370', '3A (M)', '370-319', 3),
  ('un_370_320', '370', '3A', '370-320', 3),
  ('un_370_401', '370', '1C', '370-401', 4),
  ('un_370_402', '370', '1A', '370-402', 4),
  ('un_370_403', '370', '1A (M)', '370-403', 4),
  ('un_370_404', '370', '2A (M)', '370-404', 4),
  ('un_370_405', '370', '2A', '370-405', 4),
  ('un_370_406', '370', '1A (M)', '370-406', 4),
  ('un_370_407', '370', '1A', '370-407', 4),
  ('un_370_408', '370', '2A (M)', '370-408', 4),
  ('un_370_409', '370', '3A (M)', '370-409', 4),
  ('un_370_410', '370', '3A', '370-410', 4),
  ('un_370_411', '370', '2A', '370-411', 4),
  ('un_370_412', '370', '1A (M)', '370-412', 4),
  ('un_370_413', '370', '1A', '370-413', 4),
  ('un_370_414', '370', '2A (M)', '370-414', 4),
  ('un_370_415', '370', '2A', '370-415', 4),
  ('un_370_416', '370', '1A (M)', '370-416', 4),
  ('un_370_417', '370', '1A', '370-417', 4),
  ('un_370_418', '370', '2A (M)', '370-418', 4),
  ('un_370_419', '370', '3A (M)', '370-419', 4),
  ('un_370_420', '370', '3A', '370-420', 4),
  ('un_370_501', '370', '1C', '370-501', 5),
  ('un_370_502', '370', '1A', '370-502', 5),
  ('un_370_503', '370', '1A (M)', '370-503', 5),
  ('un_370_504', '370', '2A (M)', '370-504', 5),
  ('un_370_505', '370', '2A', '370-505', 5),
  ('un_370_506', '370', '1A (M)', '370-506', 5),
  ('un_370_507', '370', '1A', '370-507', 5),
  ('un_370_508', '370', '2A (M)', '370-508', 5),
  ('un_370_509', '370', '3A (M)', '370-509', 5),
  ('un_370_510', '370', '3A', '370-510', 5),
  ('un_370_511', '370', '2A', '370-511', 5),
  ('un_370_512', '370', '1A (M)', '370-512', 5),
  ('un_370_513', '370', '1A', '370-513', 5),
  ('un_370_514', '370', '2A (M)', '370-514', 5),
  ('un_370_515', '370', '2A', '370-515', 5),
  ('un_370_516', '370', '1A (M)', '370-516', 5),
  ('un_370_517', '370', '1A', '370-517', 5),
  ('un_370_518', '370', '2A (M)', '370-518', 5),
  ('un_370_519', '370', '3A (M)', '370-519', 5),
  ('un_370_520', '370', '3A', '370-520', 5),
  ('un_370_601', '370', '1C', '370-601', 6),
  ('un_370_602', '370', '1A', '370-602', 6),
  ('un_370_603', '370', '1A (M)', '370-603', 6),
  ('un_370_604', '370', '2A (M)', '370-604', 6),
  ('un_370_605', '370', '2A', '370-605', 6),
  ('un_370_606', '370', '1A (M)', '370-606', 6),
  ('un_370_607', '370', '1A', '370-607', 6),
  ('un_370_608', '370', '2A (M)', '370-608', 6),
  ('un_370_609', '370', '3A (M)', '370-609', 6),
  ('un_370_610', '370', '3A', '370-610', 6),
  ('un_370_611', '370', '2A', '370-611', 6),
  ('un_370_612', '370', '1A (M)', '370-612', 6),
  ('un_370_613', '370', '1A', '370-613', 6),
  ('un_370_614', '370', '2A (M)', '370-614', 6),
  ('un_370_615', '370', '2A', '370-615', 6),
  ('un_370_616', '370', '1A (M)', '370-616', 6),
  ('un_370_617', '370', '1A', '370-617', 6),
  ('un_370_618', '370', '2A (M)', '370-618', 6),
  ('un_370_619', '370', '3A (M)', '370-619', 6),
  ('un_370_620', '370', '3A', '370-620', 6),
  ('un_374_101', '374', '1A (M)', '374-101', 1),
  ('un_374_102', '374', '1A', '374-102', 1),
  ('un_374_103', '374', '2A', '374-103', 1),
  ('un_374_104', '374', '2A (M)', '374-104', 1),
  ('un_374_105', '374', '3A (M)', '374-105', 1),
  ('un_374_106', '374', '3A', '374-106', 1),
  ('un_374_107', '374', '2A', '374-107', 1),
  ('un_374_108', '374', '2A (M)', '374-108', 1),
  ('un_374_109', '374', '1A (M)', '374-109', 1),
  ('un_374_110', '374', '1A', '374-110', 1),
  ('un_374_111', '374', '2A (M)', '374-111', 1),
  ('un_374_112', '374', '3A (M)', '374-112', 1),
  ('un_374_113', '374', '3A', '374-113', 1),
  ('un_374_114', '374', '2A', '374-114', 1),
  ('un_374_201', '374', '1C', '374-201', 2),
  ('un_374_202', '374', '1A (M)', '374-202', 2),
  ('un_374_203', '374', '1A', '374-203', 2),
  ('un_374_204', '374', '2A', '374-204', 2),
  ('un_374_205', '374', '2A (M)', '374-205', 2),
  ('un_374_206', '374', '3A (M)', '374-206', 2),
  ('un_374_207', '374', '3A', '374-207', 2),
  ('un_374_208', '374', '2A', '374-208', 2),
  ('un_374_209', '374', '2A (M)', '374-209', 2),
  ('un_374_210', '374', '1A (M)', '374-210', 2),
  ('un_374_211', '374', '1A', '374-211', 2),
  ('un_374_212', '374', '2A (M)', '374-212', 2),
  ('un_374_213', '374', '2A (M)', '374-213', 2),
  ('un_374_214', '374', '3A (M)', '374-214', 2),
  ('un_374_215', '374', '3A', '374-215', 2),
  ('un_374_216', '374', '2A', '374-216', 2),
  ('un_374_301', '374', '1C', '374-301', 3),
  ('un_374_302', '374', '1A (M)', '374-302', 3),
  ('un_374_303', '374', '1A', '374-303', 3),
  ('un_374_304', '374', '2A', '374-304', 3),
  ('un_374_305', '374', '2A (M)', '374-305', 3),
  ('un_374_306', '374', '3A (M)', '374-306', 3),
  ('un_374_307', '374', '3A', '374-307', 3),
  ('un_374_308', '374', '2A', '374-308', 3),
  ('un_374_309', '374', '2A (M)', '374-309', 3),
  ('un_374_310', '374', '1A (M)', '374-310', 3),
  ('un_374_311', '374', '1A', '374-311', 3),
  ('un_374_312', '374', '2A (M)', '374-312', 3),
  ('un_374_313', '374', '2A (M)', '374-313', 3),
  ('un_374_314', '374', '3A (M)', '374-314', 3),
  ('un_374_315', '374', '3A', '374-315', 3),
  ('un_374_316', '374', '2A', '374-316', 3),
  ('un_374_401', '374', '1C', '374-401', 4),
  ('un_374_402', '374', '1A (M)', '374-402', 4),
  ('un_374_403', '374', '1A', '374-403', 4),
  ('un_374_404', '374', '2A', '374-404', 4),
  ('un_374_405', '374', '2A (M)', '374-405', 4),
  ('un_374_406', '374', '3A (M)', '374-406', 4),
  ('un_374_407', '374', '3A', '374-407', 4),
  ('un_374_408', '374', '2A', '374-408', 4),
  ('un_374_409', '374', '2A (M)', '374-409', 4),
  ('un_374_410', '374', '1A (M)', '374-410', 4),
  ('un_374_411', '374', '1A', '374-411', 4),
  ('un_374_412', '374', '2A (M)', '374-412', 4),
  ('un_374_413', '374', '2A (M)', '374-413', 4),
  ('un_374_414', '374', '3A (M)', '374-414', 4),
  ('un_374_415', '374', '3A', '374-415', 4),
  ('un_374_416', '374', '2A', '374-416', 4),
  ('un_374_501', '374', '1C', '374-501', 5),
  ('un_374_502', '374', '1A (M)', '374-502', 5),
  ('un_374_503', '374', '1A', '374-503', 5),
  ('un_374_504', '374', '2A', '374-504', 5),
  ('un_374_505', '374', '2A (M)', '374-505', 5),
  ('un_374_506', '374', '3A (M)', '374-506', 5),
  ('un_374_507', '374', '3A', '374-507', 5),
  ('un_374_508', '374', '2A', '374-508', 5),
  ('un_374_509', '374', '2A (M)', '374-509', 5),
  ('un_374_510', '374', '1A (M)', '374-510', 5),
  ('un_374_511', '374', '1A', '374-511', 5),
  ('un_374_512', '374', '2A (M)', '374-512', 5),
  ('un_374_513', '374', '2A (M)', '374-513', 5),
  ('un_374_514', '374', '3A (M)', '374-514', 5),
  ('un_374_515', '374', '3A', '374-515', 5),
  ('un_374_516', '374', '2A', '374-516', 5),
  ('un_374_601', '374', '1C', '374-601', 6),
  ('un_374_602', '374', '1A (M)', '374-602', 6),
  ('un_374_603', '374', '1A', '374-603', 6),
  ('un_374_604', '374', '2A', '374-604', 6),
  ('un_374_605', '374', '2A (M)', '374-605', 6),
  ('un_374_606', '374', '3A (M)', '374-606', 6),
  ('un_374_607', '374', '3A', '374-607', 6),
  ('un_374_608', '374', '2A', '374-608', 6),
  ('un_374_609', '374', '2A (M)', '374-609', 6),
  ('un_374_610', '374', '1A (M)', '374-610', 6),
  ('un_374_611', '374', '1A', '374-611', 6),
  ('un_374_612', '374', '2A (M)', '374-612', 6),
  ('un_374_613', '374', '2A (M)', '374-613', 6),
  ('un_374_614', '374', '3A (M)', '374-614', 6),
  ('un_374_615', '374', '3A', '374-615', 6),
  ('un_374_616', '374', '2A', '374-616', 6),
  ('un_378_101', '378', '1B', '378-101', 1),
  ('un_378_102', '378', '1A', '378-102', 1),
  ('un_378_103', '378', '1A (M)', '378-103', 1),
  ('un_378_104', '378', '2A (M)', '378-104', 1),
  ('un_378_105', '378', '2A', '378-105', 1),
  ('un_378_106', '378', '1A (M)', '378-106', 1),
  ('un_378_107', '378', '1A', '378-107', 1),
  ('un_378_108', '378', '2A (M)', '378-108', 1),
  ('un_378_109', '378', '3A (M)', '378-109', 1),
  ('un_378_110', '378', '3A', '378-110', 1),
  ('un_378_111', '378', '2A', '378-111', 1),
  ('un_378_112', '378', '1A (M)', '378-112', 1),
  ('un_378_113', '378', '1A', '378-113', 1),
  ('un_378_114', '378', '2A (M)', '378-114', 1),
  ('un_378_115', '378', '2A', '378-115', 1),
  ('un_378_116', '378', '1A (M)', '378-116', 1),
  ('un_378_117', '378', '1A', '378-117', 1),
  ('un_378_118', '378', '2A (M)', '378-118', 1),
  ('un_378_201', '378', '1C', '378-201', 2),
  ('un_378_202', '378', '1A', '378-202', 2),
  ('un_378_203', '378', '1A (M)', '378-203', 2),
  ('un_378_204', '378', '2A (M)', '378-204', 2),
  ('un_378_205', '378', '2A', '378-205', 2),
  ('un_378_206', '378', '1A (M)', '378-206', 2),
  ('un_378_207', '378', '1A', '378-207', 2),
  ('un_378_208', '378', '2A (M)', '378-208', 2),
  ('un_378_209', '378', '3A (M)', '378-209', 2),
  ('un_378_210', '378', '3A', '378-210', 2),
  ('un_378_211', '378', '2A', '378-211', 2),
  ('un_378_212', '378', '1A (M)', '378-212', 2),
  ('un_378_213', '378', '1A', '378-213', 2),
  ('un_378_214', '378', '2A (M)', '378-214', 2),
  ('un_378_215', '378', '2A', '378-215', 2),
  ('un_378_216', '378', '1A (M)', '378-216', 2),
  ('un_378_217', '378', '1A', '378-217', 2),
  ('un_378_218', '378', '2A (M)', '378-218', 2),
  ('un_378_219', '378', '3A (M)', '378-219', 2),
  ('un_378_220', '378', '3A', '378-220', 2),
  ('un_378_301', '378', '1C', '378-301', 3),
  ('un_378_302', '378', '1A', '378-302', 3),
  ('un_378_303', '378', '1A (M)', '378-303', 3),
  ('un_378_304', '378', '2A (M)', '378-304', 3),
  ('un_378_305', '378', '2A', '378-305', 3),
  ('un_378_306', '378', '1A (M)', '378-306', 3),
  ('un_378_307', '378', '1A', '378-307', 3),
  ('un_378_308', '378', '2A (M)', '378-308', 3),
  ('un_378_309', '378', '3A (M)', '378-309', 3),
  ('un_378_310', '378', '3A', '378-310', 3),
  ('un_378_311', '378', '2A', '378-311', 3),
  ('un_378_312', '378', '1A (M)', '378-312', 3),
  ('un_378_313', '378', '1A', '378-313', 3),
  ('un_378_314', '378', '2A (M)', '378-314', 3),
  ('un_378_315', '378', '2A', '378-315', 3),
  ('un_378_316', '378', '1A (M)', '378-316', 3),
  ('un_378_317', '378', '1A', '378-317', 3),
  ('un_378_318', '378', '2A (M)', '378-318', 3),
  ('un_378_319', '378', '3A (M)', '378-319', 3),
  ('un_378_320', '378', '3A', '378-320', 3),
  ('un_378_401', '378', '1C', '378-401', 4),
  ('un_378_402', '378', '1A', '378-402', 4),
  ('un_378_403', '378', '1A (M)', '378-403', 4),
  ('un_378_404', '378', '2A (M)', '378-404', 4),
  ('un_378_405', '378', '2A', '378-405', 4),
  ('un_378_406', '378', '1A (M)', '378-406', 4),
  ('un_378_407', '378', '1A', '378-407', 4),
  ('un_378_408', '378', '2A (M)', '378-408', 4),
  ('un_378_409', '378', '3A (M)', '378-409', 4),
  ('un_378_410', '378', '3A', '378-410', 4),
  ('un_378_411', '378', '2A', '378-411', 4),
  ('un_378_412', '378', '1A (M)', '378-412', 4),
  ('un_378_413', '378', '1A', '378-413', 4),
  ('un_378_414', '378', '2A (M)', '378-414', 4),
  ('un_378_415', '378', '2A', '378-415', 4),
  ('un_378_416', '378', '1A (M)', '378-416', 4),
  ('un_378_417', '378', '1A', '378-417', 4),
  ('un_378_418', '378', '2A (M)', '378-418', 4),
  ('un_378_419', '378', '3A (M)', '378-419', 4),
  ('un_378_420', '378', '3A', '378-420', 4),
  ('un_378_501', '378', '1C', '378-501', 5),
  ('un_378_502', '378', '1A', '378-502', 5),
  ('un_378_503', '378', '1A (M)', '378-503', 5),
  ('un_378_504', '378', '2A (M)', '378-504', 5),
  ('un_378_505', '378', '2A', '378-505', 5),
  ('un_378_506', '378', '1A (M)', '378-506', 5),
  ('un_378_507', '378', '1A', '378-507', 5),
  ('un_378_508', '378', '2A (M)', '378-508', 5),
  ('un_378_509', '378', '3A (M)', '378-509', 5),
  ('un_378_510', '378', '3A', '378-510', 5),
  ('un_378_511', '378', '2A', '378-511', 5),
  ('un_378_512', '378', '1A (M)', '378-512', 5),
  ('un_378_513', '378', '1A', '378-513', 5),
  ('un_378_514', '378', '2A (M)', '378-514', 5),
  ('un_378_515', '378', '2A', '378-515', 5),
  ('un_378_516', '378', '1A (M)', '378-516', 5),
  ('un_378_517', '378', '1A', '378-517', 5),
  ('un_378_518', '378', '2A (M)', '378-518', 5),
  ('un_378_519', '378', '3A (M)', '378-519', 5),
  ('un_378_520', '378', '3A', '378-520', 5),
  ('un_378_601', '378', '1C', '378-601', 6),
  ('un_378_602', '378', '1A', '378-602', 6),
  ('un_378_603', '378', '1A (M)', '378-603', 6),
  ('un_378_604', '378', '2A (M)', '378-604', 6),
  ('un_378_605', '378', '2A', '378-605', 6),
  ('un_378_606', '378', '1A (M)', '378-606', 6),
  ('un_378_607', '378', '1A', '378-607', 6),
  ('un_378_608', '378', '2A (M)', '378-608', 6),
  ('un_378_609', '378', '3A (M)', '378-609', 6),
  ('un_378_610', '378', '3A', '378-610', 6),
  ('un_378_611', '378', '2A', '378-611', 6),
  ('un_378_612', '378', '1A (M)', '378-612', 6),
  ('un_378_613', '378', '1A', '378-613', 6),
  ('un_378_614', '378', '2A (M)', '378-614', 6),
  ('un_378_615', '378', '2A', '378-615', 6),
  ('un_378_616', '378', '1A (M)', '378-616', 6),
  ('un_378_617', '378', '1A', '378-617', 6),
  ('un_378_618', '378', '2A (M)', '378-618', 6),
  ('un_378_619', '378', '3A (M)', '378-619', 6),
  ('un_378_620', '378', '3A', '378-620', 6)
ON CONFLICT (unit_number) DO NOTHING;

INSERT INTO gl_accounts (code, name_en, name_zh, type, parent_code, normal_side, is_postable, is_trust, is_bank) VALUES
  ('1000', 'Assets', '資產', 'asset', NULL, 'debit', FALSE, FALSE, FALSE),
  ('1010', 'Operating bank account', '營運銀行帳戶', 'asset', '1000', 'debit', TRUE, FALSE, TRUE),
  ('1020', 'Trust account — security deposits', '信託帳戶 — 保證金', 'asset', '1000', 'debit', TRUE, TRUE, TRUE),
  ('1100', 'Accounts receivable — tenants', '應收帳款 — 租客', 'asset', '1000', 'debit', TRUE, FALSE, FALSE),
  ('1110', 'Allowance for doubtful accounts', '備抵呆帳', 'asset', '1000', 'credit', TRUE, FALSE, FALSE),
  ('1200', 'Prepaid expenses', '預付費用', 'asset', '1000', 'debit', TRUE, FALSE, FALSE),
  ('1210', 'GST receivable', '應收 GST', 'asset', '1000', 'debit', TRUE, FALSE, FALSE),
  ('1500', 'Buildings', '建築物', 'asset', '1000', 'debit', TRUE, FALSE, FALSE),
  ('1510', 'Accumulated depreciation', '累計折舊', 'asset', '1000', 'credit', TRUE, FALSE, FALSE),
  ('2000', 'Liabilities', '負債', 'liability', NULL, 'credit', FALSE, FALSE, FALSE),
  ('2010', 'Accounts payable — vendors', '應付帳款 — 廠商', 'liability', '2000', 'credit', TRUE, FALSE, FALSE),
  ('2100', 'Security deposits held', '代收保證金', 'liability', '2000', 'credit', TRUE, TRUE, FALSE),
  ('2110', 'Deposit interest payable', '應付保證金利息', 'liability', '2000', 'credit', TRUE, TRUE, FALSE),
  ('2200', 'Prepaid rent', '預收租金', 'liability', '2000', 'credit', TRUE, FALSE, FALSE),
  ('2300', 'GST payable', '應付 GST', 'liability', '2000', 'credit', TRUE, FALSE, FALSE),
  ('2400', 'Accrued liabilities', '應計負債', 'liability', '2000', 'credit', TRUE, FALSE, FALSE),
  ('2410', 'Payroll deductions payable', '應付薪資扣繳', 'liability', '2000', 'credit', TRUE, FALSE, FALSE),
  ('2420', 'Management fee payable', '應付管理費', 'liability', '2000', 'credit', TRUE, FALSE, FALSE),
  ('3000', 'Equity', '權益', 'equity', NULL, 'credit', FALSE, FALSE, FALSE),
  ('3010', 'Owner capital', '業主資本', 'equity', '3000', 'credit', TRUE, FALSE, FALSE),
  ('3020', 'Owner draws', '業主提取', 'equity', '3000', 'debit', TRUE, FALSE, FALSE),
  ('3900', 'Retained earnings', '保留盈餘', 'equity', '3000', 'credit', TRUE, FALSE, FALSE),
  ('4000', 'Revenue', '收入', 'revenue', NULL, 'credit', FALSE, FALSE, FALSE),
  ('4010', 'Rental income', '租金收入', 'revenue', '4000', 'credit', TRUE, FALSE, FALSE),
  ('4020', 'Parking income', '車位收入', 'revenue', '4000', 'credit', TRUE, FALSE, FALSE),
  ('4030', 'Storage income', '儲藏室收入', 'revenue', '4000', 'credit', TRUE, FALSE, FALSE),
  ('4040', 'Pet rent', '寵物月費收入', 'revenue', '4000', 'credit', TRUE, FALSE, FALSE),
  ('4050', 'Application fees', '申請費收入', 'revenue', '4000', 'credit', TRUE, FALSE, FALSE),
  ('4060', 'Late fees', '逾期費收入', 'revenue', '4000', 'credit', TRUE, FALSE, FALSE),
  ('4070', 'Damage recovery', '損壞賠償收入', 'revenue', '4000', 'credit', TRUE, FALSE, FALSE),
  ('4080', 'Laundry and vending', '洗衣與販賣機收入', 'revenue', '4000', 'credit', TRUE, FALSE, FALSE),
  ('4090', 'Other income', '其他收入', 'revenue', '4000', 'credit', TRUE, FALSE, FALSE),
  ('5000', 'Operating expenses', '營運費用', 'expense', NULL, 'debit', FALSE, FALSE, FALSE),
  ('5010', 'Repairs and maintenance', '維修保養', 'expense', '5000', 'debit', TRUE, FALSE, FALSE),
  ('5020', 'Utilities — electricity', '水電 — 電費', 'expense', '5000', 'debit', TRUE, FALSE, FALSE),
  ('5021', 'Utilities — gas and heat', '水電 — 瓦斯與暖氣', 'expense', '5000', 'debit', TRUE, FALSE, FALSE),
  ('5022', 'Utilities — water and sewer', '水電 — 水費與污水', 'expense', '5000', 'debit', TRUE, FALSE, FALSE),
  ('5030', 'Property management', '物業管理費', 'expense', '5000', 'debit', TRUE, FALSE, FALSE),
  ('5040', 'Insurance', '保險', 'expense', '5000', 'debit', TRUE, FALSE, FALSE),
  ('5050', 'Property taxes', '房產稅', 'expense', '5000', 'debit', TRUE, FALSE, FALSE),
  ('5060', 'Cleaning and turnover', '清潔與整備', 'expense', '5000', 'debit', TRUE, FALSE, FALSE),
  ('5070', 'Landscaping and snow removal', '景觀與剷雪', 'expense', '5000', 'debit', TRUE, FALSE, FALSE),
  ('5080', 'Advertising and leasing', '廣告與招租', 'expense', '5000', 'debit', TRUE, FALSE, FALSE),
  ('5090', 'Professional fees', '專業服務費', 'expense', '5000', 'debit', TRUE, FALSE, FALSE),
  ('5100', 'Deposit interest expense', '保證金利息費用', 'expense', '5000', 'debit', TRUE, FALSE, FALSE),
  ('5110', 'Bad debt', '呆帳', 'expense', '5000', 'debit', TRUE, FALSE, FALSE),
  ('5120', 'Bank charges', '銀行手續費', 'expense', '5000', 'debit', TRUE, FALSE, FALSE),
  ('5130', 'Security and access', '保全與門禁', 'expense', '5000', 'debit', TRUE, FALSE, FALSE),
  ('5140', 'Elevator maintenance', '電梯保養', 'expense', '5000', 'debit', TRUE, FALSE, FALSE),
  ('5150', 'Waste removal', '廢棄物清運', 'expense', '5000', 'debit', TRUE, FALSE, FALSE),
  ('5160', 'Pest control', '蟲害防治', 'expense', '5000', 'debit', TRUE, FALSE, FALSE),
  ('5170', 'Building manager wages', '管理員薪資', 'expense', '5000', 'debit', TRUE, FALSE, FALSE),
  ('5175', 'Employer contributions', '雇主提撥', 'expense', '5000', 'debit', TRUE, FALSE, FALSE),
  ('5200', 'Depreciation', '折舊費用', 'expense', '5000', 'debit', TRUE, FALSE, FALSE),
  ('5900', 'Other operating expenses', '其他營運費用', 'expense', '5000', 'debit', TRUE, FALSE, FALSE)
ON CONFLICT (code) DO UPDATE SET name_en=EXCLUDED.name_en,name_zh=EXCLUDED.name_zh,type=EXCLUDED.type,parent_code=EXCLUDED.parent_code,normal_side=EXCLUDED.normal_side,is_postable=EXCLUDED.is_postable,is_trust=EXCLUDED.is_trust,is_bank=EXCLUDED.is_bank;

UPDATE gl_accounts SET note='Tenant money held in trust under the Alberta RTA. Never revenue. Must agree with 1020 at all times.' WHERE code='2100';
UPDATE gl_accounts SET note='Separate bank account. Operating expenses must never be paid from here.' WHERE code='1020';

INSERT INTO deposit_interest_rates (year, rate, source) VALUES (2026, 0.0, 'Placeholder. Set the published rate before accruing.') ON CONFLICT (year) DO NOTHING;

INSERT INTO fee_formulas (id, code, label_en, label_zh, basis, rate, per_unit_rate, income_scope, income_basis, unit_scope, gst_applies, gst_rate, expense_gl, gst_gl, payable_gl, effective_from, note) VALUES
  ('ff_management_fee','management_fee','Property management fee','物業管理費','percent_of_income',0.04,NULL,'["4010","4020","4030","4040","4080"]','collected','all',TRUE,0.05,'5030','1210','2420','2026-01-01','4% of rent, parking, storage, pet rent and laundry actually collected, plus GST. Excludes late fees and damage recovery.'),
  ('ff_bm_payroll', 'bm_payroll', 'Building manager', '管理員薪資', 'per_unit', NULL, 30.0, '[]', 'collected', 'all', FALSE, 0.05, '5170', NULL, '2410', '2026-01-01', '$30 per unit per month across all 330 units. Confirm employment/contractor treatment before posting.')
ON CONFLICT (id) DO NOTHING;

INSERT INTO formula_components (id, formula_id, seq, label, basis, rate, per_unit_rate, income_scope, income_basis, unit_scope, gst_applies, expense_gl, note)
SELECT 'fcp_management_fee', id, 1, 'Management fee', 'percent_of_income', 0.04, NULL, '["4010","4020","4030","4040","4080"]', 'collected', 'all', TRUE, '5030', '4% of rent, parking, storage, pet rent and laundry collected.' FROM fee_formulas WHERE id='ff_management_fee'
ON CONFLICT DO NOTHING;

INSERT INTO formula_components (id, formula_id, seq, label, basis, rate, per_unit_rate, income_scope, income_basis, unit_scope, gst_applies, expense_gl, note)
SELECT 'fcp_bm_payroll', id, 1, 'Building manager', 'per_unit', NULL, 30.0, '[]', 'collected', 'all', FALSE, '5170', '$30 per unit across all units.' FROM fee_formulas WHERE id='ff_bm_payroll'
ON CONFLICT DO NOTHING;

INSERT INTO remuneration_groups (code, label_en, label_zh, description, wages_included, agreed_note) VALUES ('management', 'Paid to management', '支付予管理方', 'The management fee and the wages of anyone the management side employs on this property.', FALSE, 'Confirm this against the signed management agreement before the first month is posted.')
ON CONFLICT (code) DO NOTHING;
INSERT INTO remuneration_members (group_code, fee_code, seq) VALUES
('management','management_fee',1),('management','bm_payroll',2)
ON CONFLICT DO NOTHING;

INSERT INTO agreements (id, code, name_en, name_zh, description, required_for, sort_order) VALUES
  ('ag_lease', 'lease', 'Residential Tenancy Agreement', '住宅租約', 'The main lease. Nothing downstream can complete without an approved version of this.', '["always"]', 10),
  ('ag_parking', 'parking', 'Parking Agreement', '車位使用協議', 'Kept separate from the lease so a stall can be given up or reassigned without reopening the tenancy.', '["parking"]', 20),
  ('ag_storage', 'storage', 'Storage Locker Agreement', '儲藏室協議', NULL, '["storage"]', 30),
  ('ag_pet', 'pet', 'Pet Addendum', '寵物附約', 'Service animals are not pets. This does not apply to them and must not be sent to a tenant who has one.', '["pets"]', 40),
  ('ag_inspection_in', 'inspection_in', 'Move-in Inspection Report', '入住檢查報告', 'Required in Alberta, completed at move-in. Without it a deposit dispute is very hard to defend.', '["always"]', 50),
  ('ag_inspection_out', 'inspection_out', 'Move-out Inspection Report', '遷出檢查報告', 'Required in Alberta, completed at move-out.', '["moveout"]', 60),
  ('ag_deposit_receipt', 'deposit_receipt', 'Security Deposit Receipt', '保證金收據', 'The deposit is held in trust; the receipt states where.', '["always"]', 70),
  ('ag_keys', 'keys', 'Key and Fob Acknowledgement', '鑰匙與門禁卡簽收單', NULL, '["always"]', 80),
  ('ag_renewal', 'renewal', 'Renewal Notice', '續約通知', NULL, '["renewal"]', 90),
  ('ag_termination', 'termination', 'Notice of Termination', '終止通知', 'Notice periods come from the RTA. Have this one checked carefully before it is used.', '["termination"]', 100),
  ('ag_notice_nonpayment', 'notice_nonpayment', '14-Day Notice — Non-payment of Rent', '欠租十四日通知', 'A prescribed form with its own wording and notice period. Nothing generates this: an application for non-payment fails on the notice or on service far more often than on the debt. Upload the version your lawyer approved.', '["arrears"]', 105),
  ('ag_emergency_contact', 'emergency_contact', 'Emergency Contact Form', '緊急聯絡資料表', NULL, '["always"]', 110)
ON CONFLICT (code) DO UPDATE SET name_en=EXCLUDED.name_en,name_zh=EXCLUDED.name_zh,description=EXCLUDED.description,required_for=EXCLUDED.required_for,sort_order=EXCLUDED.sort_order;

COMMIT;
