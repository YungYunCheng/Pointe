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

CREATE INDEX IF NOT EXISTS idx_ai_feedback_task_created
  ON ai_feedback_examples (task, created_at DESC);

COMMIT;
