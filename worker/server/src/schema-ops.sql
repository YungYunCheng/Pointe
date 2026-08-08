-- ============================================================
-- Baydo Pointe — notifications, screening, entry windows,
-- password policy, log export
-- ============================================================

PRAGMA foreign_keys = ON;

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
  sent_at       TEXT,
  provider_id   TEXT,
  created_by    TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_outbox_state ON outbox(state, created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_ref ON outbox(ref_type, ref_id);

-- A recipient can decline a channel. Marketing consent is separate: a
-- transactional notice such as a notice of entry is not marketing and does
-- not depend on it.
CREATE TABLE IF NOT EXISTS contact_preferences (
  contact_key   TEXT PRIMARY KEY,           -- email or phone
  allow_email   INTEGER NOT NULL DEFAULT 1,
  allow_sms     INTEGER NOT NULL DEFAULT 1,
  allow_marketing INTEGER NOT NULL DEFAULT 0,
  locale        TEXT DEFAULT 'en',
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
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
  expires_at   TEXT,
  responded_at TEXT,
  outbox_id    TEXT REFERENCES outbox(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
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
  specific_date TEXT,
  from_time    TEXT NOT NULL,
  to_time      TEXT NOT NULL,
  reason       TEXT,
  set_by       TEXT,                        -- tenant | staff
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
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
  similarity    REAL,
  detail        TEXT,
  decided_by    TEXT REFERENCES users(id),
  decision      TEXT CHECK (decision IN ('allow','reject')),
  decision_note TEXT,
  decided_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
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
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pwhist_user ON password_history(user_id, changed_at DESC);

-- ---------- Log exports ----------
-- Who took a copy of the audit log, covering what, and when. An export is
-- itself an event worth recording.
CREATE TABLE IF NOT EXISTS log_exports (
  id          TEXT PRIMARY KEY,
  from_date   TEXT,
  to_date     TEXT,
  query       TEXT,
  format      TEXT NOT NULL,
  row_count   INTEGER,
  sha256      TEXT,
  exported_by TEXT REFERENCES users(id),
  exported_name TEXT,
  exported_at TEXT NOT NULL DEFAULT (datetime('now'))
);
