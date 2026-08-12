BEGIN;

CREATE TABLE IF NOT EXISTS ai_feedback_examples (
  id               TEXT PRIMARY KEY,
  task             TEXT NOT NULL,
  source_ref_type  TEXT,
  source_ref_id    TEXT,
  original_input   TEXT NOT NULL,
  ai_draft         TEXT NOT NULL,
  approved_output  TEXT NOT NULL,
  was_edited       BOOLEAN NOT NULL DEFAULT FALSE,
  model            TEXT NOT NULL,
  created_by       TEXT NOT NULL REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at      TIMESTAMPTZ,
  excluded_at      TIMESTAMPTZ,
  exclusion_reason TEXT
);

ALTER TABLE ai_feedback_examples
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS reviewed_by TEXT REFERENCES users(id);

ALTER TABLE ai_feedback_examples
  DROP CONSTRAINT IF EXISTS ai_feedback_examples_review_status_check;
ALTER TABLE ai_feedback_examples
  ADD CONSTRAINT ai_feedback_examples_review_status_check
  CHECK (review_status IN ('pending', 'approved', 'excluded'));

UPDATE ai_feedback_examples
SET review_status = CASE WHEN excluded_at IS NULL THEN 'pending' ELSE 'excluded' END
WHERE review_status IS NULL OR review_status NOT IN ('pending', 'approved', 'excluded');

CREATE INDEX IF NOT EXISTS idx_ai_feedback_review_task
  ON ai_feedback_examples (review_status, task, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_training_rules (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  instruction TEXT NOT NULL,
  task        TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  TEXT NOT NULL REFERENCES users(id),
  updated_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_training_rules_active_task
  ON ai_training_rules (is_active, task, updated_at DESC);

COMMIT;
