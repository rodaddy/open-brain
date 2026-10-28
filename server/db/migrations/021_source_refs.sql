-- Structured file/document references for closed-brain source grounding.
-- Kept on each durable memory row so retrieval and answer citations can
-- enforce source scope before evidence leaves the server.

ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS source_refs JSONB DEFAULT '[]'::jsonb;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS source_refs JSONB DEFAULT '[]'::jsonb;
ALTER TABLE relationships ADD COLUMN IF NOT EXISTS source_refs JSONB DEFAULT '[]'::jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS source_refs JSONB DEFAULT '[]'::jsonb;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS source_refs JSONB DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_thoughts_source_refs ON thoughts USING gin (source_refs);
CREATE INDEX IF NOT EXISTS idx_decisions_source_refs ON decisions USING gin (source_refs);
CREATE INDEX IF NOT EXISTS idx_relationships_source_refs ON relationships USING gin (source_refs);
CREATE INDEX IF NOT EXISTS idx_projects_source_refs ON projects USING gin (source_refs);
CREATE INDEX IF NOT EXISTS idx_sessions_source_refs ON sessions USING gin (source_refs);
