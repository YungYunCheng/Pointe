BEGIN;

/*
 * Vendor invoices and management reports are shared records.  Their files
 * live in R2; Postgres keeps the immutable metadata, hashes and review trail.
 * A replacement file increments the document version and invalidates both
 * current approvals, while the historical review rows remain untouched.
 */
INSERT INTO permissions (code, description) VALUES
  ('accounting.review', 'Review invoice and report documents')
ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('admin', 'accounting.review'),
  ('property_manager', 'accounting.review'),
  ('accounting', 'accounting.review'),
  ('property_manager', 'accounting.reports')
ON CONFLICT DO NOTHING;

ALTER TABLE ap_invoices
  ADD COLUMN IF NOT EXISTS review_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_state IN ('pending','awaiting_other','changes_requested','approved')),
  ADD COLUMN IF NOT EXISTS document_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS accounting_reviewed_by TEXT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS accounting_reviewed_name TEXT,
  ADD COLUMN IF NOT EXISTS accounting_reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pm_reviewed_by TEXT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS pm_reviewed_name TEXT,
  ADD COLUMN IF NOT EXISTS pm_reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS finalised_at TIMESTAMPTZ;

ALTER TABLE monthly_reports
  ADD COLUMN IF NOT EXISTS review_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_state IN ('pending','awaiting_other','changes_requested','approved')),
  ADD COLUMN IF NOT EXISTS document_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS accounting_reviewed_by TEXT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS accounting_reviewed_name TEXT,
  ADD COLUMN IF NOT EXISTS accounting_reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pm_reviewed_by TEXT REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS pm_reviewed_name TEXT,
  ADD COLUMN IF NOT EXISTS pm_reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS finalised_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS accounting_document_files (
  id               TEXT PRIMARY KEY,
  entity_type      TEXT NOT NULL CHECK (entity_type IN ('ap_invoice','monthly_report')),
  entity_id        TEXT NOT NULL,
  document_version INTEGER NOT NULL CHECK (document_version > 0),
  source           TEXT NOT NULL CHECK (source IN ('uploaded','generated')),
  filename         TEXT NOT NULL,
  storage_key      TEXT NOT NULL UNIQUE,
  mime_type        TEXT NOT NULL,
  size_bytes       INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256           TEXT NOT NULL,
  is_current       BOOLEAN NOT NULL DEFAULT TRUE,
  uploaded_by      TEXT NOT NULL REFERENCES users(id),
  uploaded_name    TEXT NOT NULL,
  uploaded_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (entity_type, entity_id, document_version)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounting_document_current
  ON accounting_document_files(entity_type, entity_id) WHERE is_current;
CREATE INDEX IF NOT EXISTS idx_accounting_document_files_entity
  ON accounting_document_files(entity_type, entity_id, document_version DESC);

CREATE TABLE IF NOT EXISTS accounting_document_reviews (
  id               TEXT PRIMARY KEY,
  entity_type      TEXT NOT NULL CHECK (entity_type IN ('ap_invoice','monthly_report')),
  entity_id        TEXT NOT NULL,
  document_version INTEGER NOT NULL CHECK (document_version > 0),
  reviewer_lane    TEXT NOT NULL CHECK (reviewer_lane IN ('accounting','property_manager')),
  decision         TEXT NOT NULL CHECK (decision IN ('approved','changes_requested')),
  note             TEXT,
  reviewed_by      TEXT NOT NULL REFERENCES users(id),
  reviewed_name    TEXT NOT NULL,
  reviewer_role    TEXT NOT NULL,
  reviewed_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_accounting_document_reviews_entity
  ON accounting_document_reviews(entity_type, entity_id, document_version, reviewed_at DESC);

/* Admin remains the super-role even when this migration is applied to an
 * older database whose original seed ran before this permission existed. */
INSERT INTO role_permissions (role_code, permission_code)
SELECT 'admin', code FROM permissions
ON CONFLICT DO NOTHING;

COMMIT;
