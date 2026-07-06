-- Migration 020: namespace-scope session lane content_hash uniqueness
-- First-write lane embedding stores content_hash on ob_session_lanes. Match the
-- durable-table namespace isolation contract so identical lane context in two
-- namespaces cannot collide on a global hash index.

DROP INDEX IF EXISTS idx_session_lanes_content_hash;

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_lanes_content_hash
  ON ob_session_lanes (content_hash, namespace)
  WHERE content_hash IS NOT NULL;
