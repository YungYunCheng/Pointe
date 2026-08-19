-- QuickBooks-style accounting workspace on top of Pointe's property ledger.
-- Run after 020_pm_monthly_reports.sql.

CREATE TABLE IF NOT EXISTS accounting_bank_rules (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  priority      INTEGER NOT NULL DEFAULT 100,
  conditions    JSONB NOT NULL DEFAULT '{}'::jsonb,
  actions       JSONB NOT NULL DEFAULT '{}'::jsonb,
  auto_confirm  BOOLEAN NOT NULL DEFAULT FALSE,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_by    TEXT REFERENCES users(id),
  updated_by    TEXT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_accounting_bank_rules_active
  ON accounting_bank_rules(is_active, priority, created_at);

-- Workflow state stays separate from the immutable accounting source rows.
CREATE TABLE IF NOT EXISTS accounting_transaction_reviews (
  source_type     TEXT NOT NULL CHECK (source_type IN
    ('bank_transaction','ap_invoice','ar_receipt','journal_entry')),
  source_id       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'review' CHECK (status IN
    ('review','matched','posted','excluded')),
  matched_type    TEXT,
  matched_id      TEXT,
  suggested_type  TEXT,
  suggested_id    TEXT,
  suggested_gl    TEXT REFERENCES gl_accounts(code),
  confidence      NUMERIC(5,4),
  rule_id         TEXT REFERENCES accounting_bank_rules(id) ON DELETE SET NULL,
  note            TEXT,
  reviewed_by     TEXT REFERENCES users(id),
  reviewed_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_accounting_reviews_queue
  ON accounting_transaction_reviews(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS accounting_captures (
  id              TEXT PRIMARY KEY,
  document_type   TEXT NOT NULL DEFAULT 'receipt' CHECK (document_type IN
    ('receipt','vendor_invoice','bank_document','other')),
  filename        TEXT NOT NULL,
  storage_key     TEXT NOT NULL UNIQUE,
  mime_type       TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'processing' CHECK (status IN
    ('processing','ready','needs_review','converted','failed')),
  extracted       JSONB NOT NULL DEFAULT '{}'::jsonb,
  extraction_note TEXT,
  linked_type     TEXT,
  linked_id       TEXT,
  uploaded_by     TEXT REFERENCES users(id),
  uploaded_name   TEXT,
  reviewed_by     TEXT REFERENCES users(id),
  reviewed_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_accounting_captures_status
  ON accounting_captures(status, created_at DESC);

-- Central replacement for the old browser-only Accounting tool datasets.
-- Each dataset is versionable/auditable in Supabase and shared by all staff.
CREATE TABLE IF NOT EXISTS accounting_workspace_state (
  dataset       TEXT PRIMARY KEY,
  value         JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_by    TEXT REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
