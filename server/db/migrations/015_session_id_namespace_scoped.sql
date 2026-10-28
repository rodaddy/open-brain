-- Migration 015: Namespace-scoped session_id uniqueness
-- Makes session_id unique per namespace instead of globally unique.
-- Prevents cross-namespace collisions when agents use the same session_id.
-- Transaction managed by migration runner.

DROP INDEX IF EXISTS idx_sessions_session_id;
CREATE UNIQUE INDEX idx_sessions_session_id ON sessions (namespace, session_id)
  WHERE session_id IS NOT NULL;
