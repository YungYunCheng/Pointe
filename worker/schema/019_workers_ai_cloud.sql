BEGIN;

-- Every public automation decision is kept in Supabase. This is deliberately
-- separate from the employee audit log: anonymous visitors have no user id,
-- while operations still need to know what was answered, by which provider,
-- and whether a person was asked to confirm it.
CREATE TABLE IF NOT EXISTS ai_chat_runs (
  id               TEXT PRIMARY KEY,
  source           TEXT NOT NULL DEFAULT 'public_chat',
  conversation_key TEXT,
  question         TEXT NOT NULL,
  answer           TEXT,
  language         TEXT NOT NULL DEFAULT 'en',
  provider         TEXT NOT NULL
    CHECK (provider IN ('database', 'workers_ai', 'human')),
  model            TEXT NOT NULL DEFAULT '',
  used_ai          BOOLEAN NOT NULL DEFAULT FALSE,
  needs_human      BOOLEAN NOT NULL DEFAULT FALSE,
  escalation_id    TEXT REFERENCES escalations(id) ON DELETE SET NULL,
  error_code       TEXT,
  input_chars      INTEGER NOT NULL DEFAULT 0,
  output_chars     INTEGER NOT NULL DEFAULT 0,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_chat_runs_created
  ON ai_chat_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_chat_runs_conversation
  ON ai_chat_runs (conversation_key, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_chat_runs_provider
  ON ai_chat_runs (provider, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_chat_runs_handoff
  ON ai_chat_runs (needs_human, created_at DESC) WHERE needs_human;

-- Daily counters make the Admin health page cheap. It never has to scan the
-- full chat history to show whether Workers AI is being used or failing.
CREATE TABLE IF NOT EXISTS ai_usage_daily (
  usage_date    DATE NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL DEFAULT '',
  request_count INTEGER NOT NULL DEFAULT 0,
  error_count   INTEGER NOT NULL DEFAULT 0,
  input_chars   BIGINT NOT NULL DEFAULT 0,
  output_chars  BIGINT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (usage_date, provider, model)
);

ALTER TABLE ai_chat_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_chat_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_usage_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage_daily FORCE ROW LEVEL SECURITY;

COMMIT;
