-- Migration 010: Explicit entity and link graph for Open Brain adjacency
-- Adds polymorphic entity/link tables without foreign keys so future session lanes
-- can link to existing entries before their schema lands.

CREATE TABLE IF NOT EXISTS ob_entities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type     TEXT NOT NULL,
  name            TEXT NOT NULL,
  canonical_id    TEXT,
  namespace       TEXT NOT NULL DEFAULT 'collab',
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding       halfvec(768),
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (btrim(entity_type) <> ''),
  CHECK (btrim(name) <> ''),
  CHECK (btrim(namespace) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ob_entities_canonical
  ON ob_entities (namespace, entity_type, canonical_id)
  WHERE canonical_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ob_entities_lookup_unique
  ON ob_entities (namespace, entity_type, lower(name));

CREATE INDEX IF NOT EXISTS idx_ob_entities_lookup
  ON ob_entities (namespace, entity_type, name);

CREATE INDEX IF NOT EXISTS idx_ob_entities_embedding ON ob_entities
  USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 200);

CREATE TABLE IF NOT EXISTS ob_links (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_type       TEXT NOT NULL,
  from_id         UUID NOT NULL,
  to_type         TEXT NOT NULL,
  to_id           UUID NOT NULL,
  relation        TEXT NOT NULL,
  weight          DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  namespace       TEXT NOT NULL DEFAULT 'collab',
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (btrim(from_type) <> ''),
  CHECK (btrim(to_type) <> ''),
  CHECK (btrim(namespace) <> ''),
  CHECK (weight >= 0),
  CHECK (from_type <> to_type OR from_id <> to_id),
  CHECK (relation IN (
    'artifact',
    'depends_on',
    'supersedes',
    'caused_by',
    'same_lane',
    'adjacent',
    'mentions',
    'implemented_by',
    'blocked_by',
    'decided_by',
    'relates_to',
    'contradicts',
    'duplicates'
  ))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ob_links_unique
  ON ob_links (namespace, from_type, from_id, to_type, to_id, relation);

CREATE INDEX IF NOT EXISTS idx_ob_links_from
  ON ob_links (namespace, from_type, from_id);

CREATE INDEX IF NOT EXISTS idx_ob_links_to
  ON ob_links (namespace, to_type, to_id);

CREATE INDEX IF NOT EXISTS idx_ob_links_relation
  ON ob_links (namespace, relation);

CREATE TRIGGER trg_ob_entities_updated_at
  BEFORE UPDATE ON ob_entities
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_ob_links_updated_at
  BEFORE UPDATE ON ob_links
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Clean up links when an entity is deleted
CREATE OR REPLACE FUNCTION cleanup_entity_links()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM ob_links
  WHERE (from_type = 'entity' AND from_id = OLD.id)
     OR (to_type = 'entity' AND to_id = OLD.id);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ob_entities_cleanup_links
  AFTER DELETE ON ob_entities
  FOR EACH ROW EXECUTE FUNCTION cleanup_entity_links();
