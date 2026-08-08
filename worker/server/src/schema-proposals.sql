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

PRAGMA foreign_keys = ON;

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
  amount        REAL,

  -- Who has to say yes. Two names here means two people, not either.
  required_roles TEXT NOT NULL,
  -- Anything that reaches a tenant or moves money is flagged, so the
  -- queue can be read by consequence rather than by date.
  reaches_tenant INTEGER NOT NULL DEFAULT 0,
  moves_money    INTEGER NOT NULL DEFAULT 0,

  state         TEXT NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending','confirmed','applied','rejected','expired','superseded')),
  applied_at    TEXT,
  applied_note  TEXT,
  rejected_by   TEXT REFERENCES users(id),
  rejected_name TEXT,
  rejected_reason TEXT,
  rejected_at   TEXT,
  expires_at    TEXT,

  created_by    TEXT REFERENCES users(id),
  created_name  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
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
  edited       INTEGER NOT NULL DEFAULT 0,
  edited_payload TEXT,
  note         TEXT,
  at           TEXT NOT NULL DEFAULT (datetime('now')),
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
  amount        REAL,
  received_on   TEXT,
  valid_until   TEXT,
  lead_time_days INTEGER,
  scope         TEXT,
  exclusions    TEXT,
  filename      TEXT,
  stored_key    TEXT,
  sha256        TEXT,
  notes         TEXT,
  uploaded_by   TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
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
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
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
  confirmed_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
