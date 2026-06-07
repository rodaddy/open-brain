-- Migration 010: Durable session lanes (Issue #34)
-- Adds a first-class "session lane" concept so agents can attach ongoing work
-- to a stable key and reload current context without semantic search.

CREATE TABLE IF NOT EXISTS ob_session_lanes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_key       TEXT NOT NULL,
  namespace         TEXT NOT NULL DEFAULT 'collab',
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'wrapped', 'archived')),
  agent             TEXT,
  source            TEXT,
  channel_id        TEXT,
  thread_id         TEXT,
  project           TEXT,
  topic             TEXT,
  current_context_md TEXT,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding         halfvec(768),
  content_hash      TEXT,
  embedded_at       TIMESTAMPTZ,
  embedding_model   TEXT,
  created_by        TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at          TIMESTAMPTZ,

  -- Idempotent upsert key: one lane per namespace + session_key
  UNIQUE(namespace, session_key)
);

-- Indexes for common access patterns
CREATE INDEX IF NOT EXISTS idx_session_lanes_status
  ON ob_session_lanes (status) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_session_lanes_namespace
  ON ob_session_lanes (namespace, status);

CREATE INDEX IF NOT EXISTS idx_session_lanes_agent
  ON ob_session_lanes (agent) WHERE agent IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_session_lanes_project
  ON ob_session_lanes (project) WHERE project IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_session_lanes_channel
  ON ob_session_lanes (channel_id) WHERE channel_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_session_lanes_embedding
  ON ob_session_lanes USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 200);

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_lanes_content_hash
  ON ob_session_lanes (content_hash) WHERE content_hash IS NOT NULL;

-- Auto-update updated_at
CREATE TRIGGER trg_session_lanes_updated_at
  BEFORE UPDATE ON ob_session_lanes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
