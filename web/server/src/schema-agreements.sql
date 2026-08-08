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

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agreements (
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,        -- lease | parking | storage | pet | ...
  name_en      TEXT NOT NULL,
  name_zh      TEXT NOT NULL,
  description  TEXT,
  required_for TEXT,                        -- JSON: when this one is needed
  sort_order   INTEGER NOT NULL DEFAULT 100,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
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
  effective_from TEXT,
  state         TEXT NOT NULL DEFAULT 'uploaded'
                CHECK (state IN ('uploaded','approved','superseded','withdrawn')),
  -- Approving is what makes a version usable. Recording who did it matters:
  -- "which version did we send, and who said it was the right one" has to
  -- have an answer.
  approved_by   TEXT REFERENCES users(id),
  approved_name TEXT,
  approved_at   TEXT,
  approval_note TEXT,
  withdrawn_reason TEXT,
  uploaded_by   TEXT REFERENCES users(id),
  uploaded_name TEXT,
  uploaded_at   TEXT NOT NULL DEFAULT (datetime('now')),
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
  sent_at       TEXT,
  signed_at     TEXT,
  signed_note   TEXT,
  outbox_id     TEXT REFERENCES outbox(id),
  issued_by     TEXT REFERENCES users(id),
  issued_name   TEXT,
  issued_at     TEXT NOT NULL DEFAULT (datetime('now'))
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
  at         TEXT NOT NULL DEFAULT (datetime('now'))
);
