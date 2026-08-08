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

PRAGMA foreign_keys = ON;

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
  expires_at      TEXT,
  state           TEXT NOT NULL DEFAULT 'draft'
                  CHECK (state IN ('draft','sent','viewed','signed','completed','declined','expired','voided')),
  declined_reason TEXT,
  voided_reason   TEXT,
  completed_at    TEXT,
  created_by      TEXT REFERENCES users(id),
  created_name    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
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
  consented_at  TEXT,                       -- ETA requires consent to sign electronically
  viewed_at     TEXT,
  signed_at     TEXT,
  declined_at   TEXT,
  decline_reason TEXT,
  signature_image TEXT,                     -- data URL of the drawn or typed mark
  signature_kind  TEXT CHECK (signature_kind IN ('drawn','typed','uploaded')),
  ip_address    TEXT,
  user_agent    TEXT,
  outbox_id     TEXT REFERENCES outbox(id),
  reminded_at   TEXT,
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
  x           REAL NOT NULL,
  y           REAL NOT NULL,
  width       REAL NOT NULL DEFAULT 180,
  height      REAL NOT NULL DEFAULT 44,
  required    INTEGER NOT NULL DEFAULT 1,
  value       TEXT,
  filled_at   TEXT
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
  at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sigevent_req ON signature_events(request_id, at);
