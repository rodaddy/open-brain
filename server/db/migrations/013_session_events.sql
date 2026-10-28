-- Migration 013: Session event journal (Issues #35 + #36)
-- Append-only event stream for session lanes. Each event captures a discrete
-- fact, decision, blocker, action, etc. within a lane's lifecycle.

CREATE TABLE IF NOT EXISTS ob_session_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lane_id         UUID NOT NULL REFERENCES ob_session_lanes(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,
  content         TEXT NOT NULL,
  source          TEXT,
  artifact_path   TEXT,
  importance      TEXT NOT NULL DEFAULT 'warm',
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding       halfvec(768),
  content_hash    TEXT,
  embedded_at     TIMESTAMPTZ,
  embedding_model TEXT,
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (btrim(content) <> ''),
  CHECK (event_type IN (
    'fact', 'decision', 'blocker', 'action',
    'artifact', 'receipt', 'question', 'correction', 'handoff'
  )),
  CHECK (importance IN ('hot', 'warm', 'cold'))
);

CREATE INDEX IF NOT EXISTS idx_session_events_lane
  ON ob_session_events (lane_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_session_events_type
  ON ob_session_events (lane_id, event_type);

CREATE INDEX IF NOT EXISTS idx_session_events_importance
  ON ob_session_events (lane_id, importance)
  WHERE importance = 'hot';

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_events_content_hash
  ON ob_session_events (lane_id, content_hash)
  WHERE content_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_session_events_embedding
  ON ob_session_events USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 200);
