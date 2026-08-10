-- ============================================================
-- Baydo Pointe — leads, documents, bookings, key handover
--
-- These were the last things living only in the browser. A lead
-- known to one agent's laptop is not a pipeline, and a document
-- template that exists in one browser cannot be the version
-- everyone signs.
-- ============================================================

PRAGMA foreign_keys = ON;

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
  assigned_to   TEXT REFERENCES users(id),
  assigned_name TEXT,
  next_action_at TEXT,
  do_not_contact INTEGER NOT NULL DEFAULT 0,
  screen_id     TEXT REFERENCES application_screens(id),
  last_contact_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage, last_contact_at);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);

CREATE TABLE IF NOT EXISTS lead_notes (
  id        TEXT PRIMARY KEY,
  lead_id   TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  body      TEXT NOT NULL,
  by_user   TEXT REFERENCES users(id),
  by_name   TEXT,
  at        TEXT NOT NULL DEFAULT (datetime('now'))
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
  approved_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
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
  approved_at  TEXT,
  sent_at      TEXT,
  signed_at    TEXT,
  created_by   TEXT REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
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
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- Public bookings and applications ----------
CREATE TABLE IF NOT EXISTS showing_requests (
  id           TEXT PRIMARY KEY,
  reference    TEXT NOT NULL UNIQUE,
  unit_type    TEXT,
  unit_number  TEXT,
  requested_date TEXT NOT NULL,
  requested_time TEXT NOT NULL,
  name         TEXT NOT NULL,
  email        TEXT,
  phone        TEXT,
  notes        TEXT,
  locale       TEXT DEFAULT 'en',
  lead_id      TEXT REFERENCES leads(id),
  event_id     TEXT REFERENCES events(id),
  state        TEXT NOT NULL DEFAULT 'requested'
               CHECK (state IN ('requested','confirmed','declined','cancelled','completed')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
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
  wants_parking INTEGER DEFAULT 0,
  wants_storage INTEGER DEFAULT 0,
  pets          TEXT,
  service_animal INTEGER DEFAULT 0,
  monthly_total REAL,
  upfront_total REAL,
  fee_ack       INTEGER DEFAULT 0,
  consent       INTEGER DEFAULT 0,
  locale        TEXT DEFAULT 'en',
  lead_id       TEXT REFERENCES leads(id),
  screen_id     TEXT REFERENCES application_screens(id),
  state         TEXT NOT NULL DEFAULT 'new'
                CHECK (state IN ('new','screening','review','approved','declined','withdrawn')),
  decided_by    TEXT REFERENCES users(id),
  decided_at    TEXT,
  decision_note TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
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
  uploaded_at    TEXT NOT NULL DEFAULT (datetime('now'))
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
  scheduled_at TEXT,
  assignee     TEXT,
  items        TEXT,                        -- JSON checklist
  notes        TEXT,
  state        TEXT NOT NULL DEFAULT 'pending'
               CHECK (state IN ('pending','scheduled','done','cancelled')),
  completed_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- Showing outcomes ----------
CREATE TABLE IF NOT EXISTS showing_outcomes (
  event_id   TEXT PRIMARY KEY REFERENCES events(id),
  outcome    TEXT NOT NULL,
  reason     TEXT,
  note       TEXT,
  by_user    TEXT REFERENCES users(id),
  by_name    TEXT,
  at         TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- Tenant portal accounts ----------
-- Separate from staff users on purpose. A tenant is not a member of staff
-- with fewer permissions; mixing them means one mistake in the role check
-- exposes the whole console.
CREATE TABLE IF NOT EXISTS tenant_accounts (
  id            TEXT PRIMARY KEY,
  contact_id    TEXT REFERENCES contacts(id),
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone         TEXT,
  full_name     TEXT NOT NULL,
  unit_number   TEXT REFERENCES units(unit_number),
  lease_id      TEXT REFERENCES leases(id),
  locale        TEXT DEFAULT 'en',
  password_salt TEXT,
  password_hash TEXT,
  password_algo TEXT DEFAULT 'scrypt',
  is_active     INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  last_login_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tenant_sessions (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES tenant_accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tenant_repairs (
  id            TEXT PRIMARY KEY,
  account_id    TEXT REFERENCES tenant_accounts(id),
  unit_number   TEXT NOT NULL,
  what          TEXT NOT NULL,
  where_in_unit TEXT,
  urgent        INTEGER NOT NULL DEFAULT 0,
  ticket_id     TEXT REFERENCES maintenance(id),
  state         TEXT NOT NULL DEFAULT 'new',
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
