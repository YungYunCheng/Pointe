-- ============================================================
-- Baydo Pointe -- SQLite schema
-- Mirrors baydo-erd.mermaid, plus evidence upload, renewals and
-- move-out notice-period validation.
-- Moving to Postgres: swap TEXT ids for uuid, TEXT dates for timestamptz,
-- and replace the IMMEDIATE transaction with SELECT ... FOR UPDATE.
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

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
  email                TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name            TEXT NOT NULL,
  phone                TEXT,
  role_code            TEXT NOT NULL REFERENCES roles(code),
  locale               TEXT NOT NULL DEFAULT 'en',   -- en | zh-Hant
  password_algo        TEXT NOT NULL DEFAULT 'scrypt',
  password_salt        TEXT NOT NULL,
  password_hash        TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1,
  is_active            INTEGER NOT NULL DEFAULT 1,
  failed_attempts      INTEGER NOT NULL DEFAULT 0,
  locked_until         TEXT,
  last_login_at        TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Append only. The application exposes no UPDATE or DELETE path, not even for Admin.
CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id TEXT REFERENCES users(id),
  actor_name    TEXT,
  action        TEXT NOT NULL,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT,
  before_value  TEXT,
  after_value   TEXT,
  ip            TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
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
  bedrooms INTEGER, area_sqft REAL, balcony_sqft REAL, is_mirrored INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS units (
  id             TEXT PRIMARY KEY,
  building_code  TEXT NOT NULL REFERENCES buildings(code),
  unit_type_code TEXT NOT NULL REFERENCES unit_types(code),
  unit_number    TEXT NOT NULL UNIQUE,
  floor          INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'available'
                 CHECK (status IN ('available','signed','occupied','turnover','offline')),
  available_from TEXT,
  rent_override  REAL,
  notes          TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_units_status ON units(status);

-- ---------- Pricing (versioned: publishing a change never overwrites history) ----------
CREATE TABLE IF NOT EXISTS pricing_profiles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, effective_from TEXT NOT NULL,
  effective_to TEXT, created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS unit_type_rents (
  id TEXT PRIMARY KEY,
  pricing_profile_id TEXT NOT NULL REFERENCES pricing_profiles(id) ON DELETE CASCADE,
  unit_type_code TEXT NOT NULL REFERENCES unit_types(code), base_rent REAL NOT NULL,
  UNIQUE (pricing_profile_id, unit_type_code)
);
CREATE TABLE IF NOT EXISTS fee_settings (
  id TEXT PRIMARY KEY,
  pricing_profile_id TEXT NOT NULL UNIQUE REFERENCES pricing_profiles(id) ON DELETE CASCADE,
  deposit_mode TEXT NOT NULL DEFAULT 'one_month',
  deposit_fixed REAL, cat_deposit REAL, dog_deposit REAL, pet_rent REAL, pet_limit TEXT,
  parking_underground REAL, parking_surface REAL, storage_fee REAL,
  application_fee REAL, utilities_included TEXT
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
  is_surface INTEGER DEFAULT 0, note TEXT
);

CREATE TABLE IF NOT EXISTS parking_allocations (
  id           TEXT PRIMARY KEY,
  pool_code    TEXT NOT NULL REFERENCES parking_pools(code),
  unit_number  TEXT NOT NULL REFERENCES units(unit_number),
  lease_id     TEXT,
  status       TEXT NOT NULL CHECK (status IN ('assigned','waiting','released')),
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),  -- sole ordering key, first come first served
  assigned_at  TEXT,
  released_at  TEXT,
  created_by   TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_parking_queue ON parking_allocations(pool_code, status, requested_at);

-- ---------- Signing lock: first to sign wins ----------
CREATE TABLE IF NOT EXISTS unit_locks (
  unit_number TEXT PRIMARY KEY REFERENCES units(unit_number),
  user_id     TEXT NOT NULL REFERENCES users(id),
  user_name   TEXT NOT NULL,
  acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);

-- ---------- Contacts, leases, renewals ----------
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY, full_name TEXT, email TEXT, phone TEXT,
  locale TEXT DEFAULT 'en', consent_basis TEXT, consent_expires_at TEXT,
  do_not_contact INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leases (
  id               TEXT PRIMARY KEY,
  unit_number      TEXT NOT NULL REFERENCES units(unit_number),
  contact_id       TEXT REFERENCES contacts(id),
  start_date       TEXT NOT NULL,
  end_date         TEXT,
  term_type        TEXT NOT NULL CHECK (term_type IN ('fixed_12','fixed_6','periodic')),
  rent             REAL NOT NULL,
  deposit          REAL NOT NULL,
  occupants        INTEGER,
  status           TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('draft','active','ended','terminated')),
  last_increase_at TEXT,                    -- an increase requires 365 days since this date
  yardi_ref        TEXT,                    -- Yardi is the financial system of record
  created_by       TEXT REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_leases_end ON leases(end_date) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS renewal_tasks (
  id            TEXT PRIMARY KEY,
  lease_id      TEXT NOT NULL REFERENCES leases(id),
  unit_number   TEXT NOT NULL,
  end_date      TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'new'
                CHECK (state IN ('new','drafted','pm_review','sent','accepted','declined','cancelled')),
  decision      TEXT CHECK (decision IN ('renew_fixed','to_periodic','not_renew')),
  current_rent  REAL,
  proposed_rent REAL,
  increase_ok   INTEGER,                    -- passes the 365-day and notice-period rules
  increase_code TEXT,                       -- message code, rendered per user locale
  increase_params TEXT,
  notice_text   TEXT,                       -- AI drafts, PM reviews, then it is sent
  drafted_by    TEXT,
  reviewed_by   TEXT REFERENCES users(id),
  reviewed_at   TEXT,
  sent_at       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_renewal_state ON renewal_tasks(state);

-- ---------- Move-out ----------
CREATE TABLE IF NOT EXISTS moveouts (
  id               TEXT PRIMARY KEY,
  unit_number      TEXT NOT NULL REFERENCES units(unit_number),
  lease_id         TEXT REFERENCES leases(id),
  tenant_name      TEXT, tenant_phone TEXT, tenant_email TEXT,
  notice_date      TEXT NOT NULL,           -- date the tenant gave notice
  moveout_date     TEXT NOT NULL,
  notice_days      INTEGER,                 -- calculated
  notice_required  INTEGER,                 -- required by lease type
  notice_ok        INTEGER,
  state            TEXT NOT NULL DEFAULT 'open'
                   CHECK (state IN ('open','closed','cancelled')),
  vacated_at       TEXT,                    -- confirming this releases parking and the unit
  vacated_by       TEXT REFERENCES users(id),
  deposit_original REAL,
  refund_deadline  TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS moveout_steps (
  id         TEXT PRIMARY KEY,
  moveout_id TEXT NOT NULL REFERENCES moveouts(id) ON DELETE CASCADE,
  step       TEXT NOT NULL,
  payload    TEXT,
  done_by    TEXT REFERENCES users(id),
  done_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (moveout_id, step)
);

CREATE TABLE IF NOT EXISTS deductions (
  id           TEXT PRIMARY KEY,
  moveout_id   TEXT NOT NULL REFERENCES moveouts(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  amount       REAL NOT NULL,
  basis        TEXT,
  state        TEXT NOT NULL DEFAULT 'proposed'
               CHECK (state IN ('proposed','notified','accepted','disputed','withdrawn','upheld')),
  notified_at  TEXT,
  tenant_says  TEXT,
  upheld_basis TEXT,
  resolved_at  TEXT,
  created_by   TEXT REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
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
  taken_at      TEXT,
  uploaded_by   TEXT NOT NULL REFERENCES users(id),
  uploaded_name TEXT,
  uploaded_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_evidence_entity ON evidence(entity_type, entity_id);

-- ---------- Maintenance and notices of entry ----------
CREATE TABLE IF NOT EXISTS maintenance (
  id           TEXT PRIMARY KEY,
  unit_number  TEXT NOT NULL REFERENCES units(unit_number),
  tenant_name  TEXT, tenant_phone TEXT,
  category     TEXT, priority TEXT,
  rush         INTEGER DEFAULT 0,           -- set by the Building Manager only
  rush_by      TEXT, rush_at TEXT,
  description  TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'new'
               CHECK (state IN ('new','scheduled','in_progress','done','cancelled')),
  vendor       TEXT,
  scheduled_at TEXT,
  completed_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS maintenance_notes (
  id        TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES maintenance(id) ON DELETE CASCADE,
  body      TEXT NOT NULL,
  by_user   TEXT REFERENCES users(id),
  by_name   TEXT,
  at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS entry_notices (
  id          TEXT PRIMARY KEY,
  purpose     TEXT NOT NULL CHECK (purpose IN ('showing','maintenance','inspection')),
  ref_type    TEXT NOT NULL,
  ref_id      TEXT NOT NULL,
  unit_number TEXT NOT NULL REFERENCES units(unit_number),
  tenant_name TEXT, tenant_contact TEXT,
  entry_date  TEXT NOT NULL,
  window_from TEXT NOT NULL,
  window_to   TEXT NOT NULL,
  body        TEXT,
  locale      TEXT DEFAULT 'en',
  state       TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','sent','cancelled')),
  lead_hours  REAL,
  drafted_by  TEXT, sent_by TEXT REFERENCES users(id), sent_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- Schedule ----------
CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL CHECK (type IN ('showing','signing','keys','maintenance','followup','review')),
  unit_number  TEXT REFERENCES units(unit_number),
  contact_name TEXT, contact_info TEXT,
  assignee_id  TEXT REFERENCES users(id),
  assignee     TEXT,
  starts_at    TEXT NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 30,
  blocking     INTEGER NOT NULL DEFAULT 1,  -- 0 for vendor visits: they do not occupy staff time
  state        TEXT NOT NULL DEFAULT 'booked'
               CHECK (state IN ('booked','done','cancelled','no_show')),
  outcome      TEXT,
  ref_id       TEXT,
  created_via  TEXT DEFAULT 'staff',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(starts_at) WHERE state = 'booked';

CREATE TABLE IF NOT EXISTS holidays (
  holiday_date TEXT PRIMARY KEY,
  name_en TEXT NOT NULL, name_zh TEXT NOT NULL,
  is_observed INTEGER DEFAULT 1
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
  read_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_aud ON notifications(audience, read_at);

-- ---------- Backups ----------
CREATE TABLE IF NOT EXISTS backups (
  id         TEXT PRIMARY KEY,
  path       TEXT NOT NULL,
  reason     TEXT,
  size_bytes INTEGER,
  by_name    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
