-- Curation columns: archived_at, access_count, last_accessed_at, usefulness_score
-- Partial indexes for active-only queries, sessions updated_at + trigger

-- Thoughts
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS access_count INTEGER DEFAULT 0;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS usefulness_score FLOAT;
CREATE INDEX IF NOT EXISTS idx_thoughts_active ON thoughts (created_at DESC) WHERE archived_at IS NULL;

-- Decisions
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS access_count INTEGER DEFAULT 0;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS usefulness_score FLOAT;
CREATE INDEX IF NOT EXISTS idx_decisions_active ON decisions (created_at DESC) WHERE archived_at IS NULL;

-- Relationships
ALTER TABLE relationships ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE relationships ADD COLUMN IF NOT EXISTS access_count INTEGER DEFAULT 0;
ALTER TABLE relationships ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;
ALTER TABLE relationships ADD COLUMN IF NOT EXISTS usefulness_score FLOAT;
CREATE INDEX IF NOT EXISTS idx_relationships_active ON relationships (created_at DESC) WHERE archived_at IS NULL;

-- Projects
ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS access_count INTEGER DEFAULT 0;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS usefulness_score FLOAT;
CREATE INDEX IF NOT EXISTS idx_projects_active ON projects (created_at DESC) WHERE archived_at IS NULL;

-- Sessions
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS access_count INTEGER DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS usefulness_score FLOAT;
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions (created_at DESC) WHERE archived_at IS NULL;

-- Sessions is missing updated_at (see 001_init.sql -- no updated_at or trigger for sessions)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

DO $$ BEGIN
  CREATE TRIGGER trg_sessions_updated_at BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION update_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
