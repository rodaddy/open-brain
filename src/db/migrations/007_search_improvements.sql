-- Migration 007: Search quality improvements
-- 1. session_id for external tracking (session-wrap UUID linkage)
-- 2. updated_at columns for upsert-merge tracking
-- 3. Rebuild search_vector to include tags in FTS
-- 4. GIN indexes on extracted_metadata for JSONB querying

-- 1. External session_id for session-wrap integration
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS session_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_session_id
  ON sessions (session_id) WHERE session_id IS NOT NULL;

-- 2. updated_at columns for upsert-merge tracking
ALTER TABLE thoughts  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
ALTER TABLE sessions  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- 3. Rebuild search_vector columns to include tags
--    Must drop and recreate: GENERATED ALWAYS expressions cannot be altered in-place.
--    Uses immutable_array_to_string() from migration 005.

-- thoughts: content + tags
ALTER TABLE thoughts DROP COLUMN IF EXISTS search_vector;
ALTER TABLE thoughts ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('english',
    COALESCE(content, '') || ' ' ||
    COALESCE(immutable_array_to_string(tags, ' '), '')
  )) STORED;
CREATE INDEX IF NOT EXISTS idx_thoughts_fts
  ON thoughts USING GIN(search_vector) WHERE archived_at IS NULL;

-- decisions: title + rationale + context + tags
ALTER TABLE decisions DROP COLUMN IF EXISTS search_vector;
ALTER TABLE decisions ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('english',
    COALESCE(title, '') || ' ' ||
    COALESCE(rationale, '') || ' ' ||
    COALESCE(context, '') || ' ' ||
    COALESCE(immutable_array_to_string(tags, ' '), '')
  )) STORED;
CREATE INDEX IF NOT EXISTS idx_decisions_fts
  ON decisions USING GIN(search_vector) WHERE archived_at IS NULL;

-- relationships: person_name + context + tags
ALTER TABLE relationships DROP COLUMN IF EXISTS search_vector;
ALTER TABLE relationships ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('english',
    COALESCE(person_name, '') || ' ' ||
    COALESCE(context, '') || ' ' ||
    COALESCE(immutable_array_to_string(tags, ' '), '')
  )) STORED;
CREATE INDEX IF NOT EXISTS idx_relationships_fts
  ON relationships USING GIN(search_vector) WHERE archived_at IS NULL;

-- projects: name + description + tags
ALTER TABLE projects DROP COLUMN IF EXISTS search_vector;
ALTER TABLE projects ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('english',
    COALESCE(name, '') || ' ' ||
    COALESCE(description, '') || ' ' ||
    COALESCE(immutable_array_to_string(tags, ' '), '')
  )) STORED;
CREATE INDEX IF NOT EXISTS idx_projects_fts
  ON projects USING GIN(search_vector) WHERE archived_at IS NULL;

-- sessions: summary + next_steps + key_decisions + tags
ALTER TABLE sessions DROP COLUMN IF EXISTS search_vector;
ALTER TABLE sessions ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('english',
    COALESCE(summary, '') || ' ' ||
    COALESCE(immutable_array_to_string(next_steps, ' '), '') || ' ' ||
    COALESCE(immutable_array_to_string(key_decisions, ' '), '') || ' ' ||
    COALESCE(immutable_array_to_string(tags, ' '), '')
  )) STORED;
CREATE INDEX IF NOT EXISTS idx_sessions_fts
  ON sessions USING GIN(search_vector) WHERE archived_at IS NULL;

-- 4. GIN indexes on extracted_metadata for JSONB queries
CREATE INDEX IF NOT EXISTS idx_thoughts_extracted_meta
  ON thoughts USING GIN(extracted_metadata jsonb_path_ops)
  WHERE extracted_metadata IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_decisions_extracted_meta
  ON decisions USING GIN(extracted_metadata jsonb_path_ops)
  WHERE extracted_metadata IS NOT NULL;

-- Migration recording handled by the migration runner
