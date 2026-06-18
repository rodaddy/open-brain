-- Migration 017: Soft-delete lifecycle for graph entities and links
-- Lets callers correct bad graph nodes/edges without hard-deleting history.

ALTER TABLE ob_entities
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

ALTER TABLE ob_links
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

DROP INDEX IF EXISTS idx_ob_entities_canonical;
DROP INDEX IF EXISTS idx_ob_entities_lookup_unique;
DROP INDEX IF EXISTS idx_ob_links_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ob_entities_canonical
  ON ob_entities (namespace, entity_type, canonical_id)
  WHERE canonical_id IS NOT NULL AND archived_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ob_entities_lookup_unique
  ON ob_entities (namespace, entity_type, lower(name))
  WHERE archived_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ob_links_unique
  ON ob_links (namespace, from_type, from_id, to_type, to_id, relation)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ob_entities_active_lookup
  ON ob_entities (namespace, entity_type, updated_at DESC)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ob_links_active_from
  ON ob_links (namespace, from_type, from_id)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ob_links_active_to
  ON ob_links (namespace, to_type, to_id)
  WHERE archived_at IS NULL;
