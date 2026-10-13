-- Migration 024: session lane hashes are search metadata, not identity
-- Lane identity is the case-sensitive (namespace, session_key) constraint.
-- contentHash normalizes case, so a unique hash index rejects valid lanes such
-- as dev:rTech-audit and dev:rtech-audit when they share a topic.

DROP INDEX IF EXISTS idx_session_lanes_content_hash;

CREATE INDEX IF NOT EXISTS idx_session_lanes_content_hash
  ON ob_session_lanes (content_hash, namespace)
  WHERE content_hash IS NOT NULL;
