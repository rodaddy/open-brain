-- Add full-text search columns + GIN indexes for hybrid search (vector + FTS + RRF)
-- tsvector columns are GENERATED ALWAYS -- auto-update on row changes, zero maintenance
--
-- LOCKING WARNING: Each `ALTER TABLE ADD COLUMN ... GENERATED ALWAYS ... STORED` takes an
-- ACCESS EXCLUSIVE lock and rewrites every row to populate the generated column. On tables
-- with significant data this will block all reads and writes for the duration. Options:
--   1. Run during a scheduled low-traffic maintenance window.
--   2. Add the column as plain tsvector (no GENERATED), backfill in batches, then add the
--      GENERATED definition in a follow-up migration once the table is fully populated.
--   3. Use `CREATE INDEX CONCURRENTLY` for the GIN indexes (already IF NOT EXISTS here, but
--      CONCURRENTLY avoids the share lock if you need to add them post-migration online).

-- thoughts: index content
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('english', COALESCE(content, ''))) STORED;
CREATE INDEX IF NOT EXISTS idx_thoughts_fts
  ON thoughts USING GIN(search_vector) WHERE archived_at IS NULL;

-- decisions: index title + rationale + context
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('english',
    COALESCE(title, '') || ' ' || COALESCE(rationale, '') || ' ' || COALESCE(context, '')
  )) STORED;
CREATE INDEX IF NOT EXISTS idx_decisions_fts
  ON decisions USING GIN(search_vector) WHERE archived_at IS NULL;

-- relationships: index person_name + context
ALTER TABLE relationships ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('english',
    COALESCE(person_name, '') || ' ' || COALESCE(context, '')
  )) STORED;
CREATE INDEX IF NOT EXISTS idx_relationships_fts
  ON relationships USING GIN(search_vector) WHERE archived_at IS NULL;

-- projects: index name + description
ALTER TABLE projects ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('english',
    COALESCE(name, '') || ' ' || COALESCE(description, '')
  )) STORED;
CREATE INDEX IF NOT EXISTS idx_projects_fts
  ON projects USING GIN(search_vector) WHERE archived_at IS NULL;

-- sessions: index summary + next_steps + key_decisions
-- array_to_string is STABLE not IMMUTABLE, so GENERATED columns need an IMMUTABLE wrapper
CREATE OR REPLACE FUNCTION immutable_array_to_string(arr text[], sep text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT
AS $$ SELECT array_to_string(arr, sep) $$;

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('english',
    COALESCE(summary, '') || ' ' ||
    COALESCE(immutable_array_to_string(next_steps, ' '), '') || ' ' ||
    COALESCE(immutable_array_to_string(key_decisions, ' '), '')
  )) STORED;
CREATE INDEX IF NOT EXISTS idx_sessions_fts
  ON sessions USING GIN(search_vector) WHERE archived_at IS NULL;
