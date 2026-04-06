-- Migration: Cognitive Tiering (OB Dreaming)
-- Adds tier system, consolidation tracking, access log, and discard staging
-- Issue: https://github.com/rodaddy/open-brain/issues/12

BEGIN;

-- 1. Add tier column to all searchable tables
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS tier TEXT DEFAULT 'warm' CHECK (tier IN ('hot','warm','cold'));
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS tier TEXT DEFAULT 'warm' CHECK (tier IN ('hot','warm','cold'));
ALTER TABLE relationships ADD COLUMN IF NOT EXISTS tier TEXT DEFAULT 'warm' CHECK (tier IN ('hot','warm','cold'));
ALTER TABLE projects ADD COLUMN IF NOT EXISTS tier TEXT DEFAULT 'warm' CHECK (tier IN ('hot','warm','cold'));
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS tier TEXT DEFAULT 'warm' CHECK (tier IN ('hot','warm','cold'));

-- 2. Add consolidation tracking columns
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS consolidated_into UUID REFERENCES thoughts(id);
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS consolidated_from UUID[];
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS consolidated_into UUID REFERENCES decisions(id);
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS consolidated_from UUID[];
ALTER TABLE relationships ADD COLUMN IF NOT EXISTS consolidated_into UUID REFERENCES relationships(id);
ALTER TABLE relationships ADD COLUMN IF NOT EXISTS consolidated_from UUID[];
ALTER TABLE projects ADD COLUMN IF NOT EXISTS consolidated_into UUID REFERENCES projects(id);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS consolidated_from UUID[];
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS consolidated_into UUID REFERENCES sessions(id);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS consolidated_from UUID[];

-- 3. Indexes for tier-based queries
CREATE INDEX IF NOT EXISTS idx_thoughts_tier ON thoughts(tier) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_decisions_tier ON decisions(tier) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_relationships_tier ON relationships(tier) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_projects_tier ON projects(tier) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_tier ON sessions(tier) WHERE archived_at IS NULL;

-- 4. Access tracking log table
CREATE TABLE IF NOT EXISTS entry_access_log (
    id BIGSERIAL PRIMARY KEY,
    entry_id UUID NOT NULL,
    source_table TEXT NOT NULL CHECK (source_table IN ('thoughts','decisions','relationships','projects','sessions')),
    accessed_at TIMESTAMPTZ DEFAULT now(),
    query_text TEXT,
    context TEXT DEFAULT 'search' CHECK (context IN ('search','session_load','direct'))
);
CREATE INDEX IF NOT EXISTS idx_access_log_entry ON entry_access_log(entry_id, accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_log_time ON entry_access_log(accessed_at);
CREATE INDEX IF NOT EXISTS idx_access_log_source ON entry_access_log(source_table, entry_id);

-- 5. Discard staging table
CREATE TABLE IF NOT EXISTS discarded_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    original_id UUID NOT NULL,
    source_table TEXT NOT NULL CHECK (source_table IN ('thoughts','decisions','relationships','projects','sessions')),
    original_content TEXT NOT NULL,
    tags TEXT[],
    namespace TEXT,
    tier_at_discard TEXT,
    access_summary JSONB,
    discarded_at TIMESTAMPTZ DEFAULT now(),
    reason TEXT CHECK (reason IN ('decay','consolidated','manual')),
    expires_at TIMESTAMPTZ,
    consolidated_into UUID
);
CREATE INDEX IF NOT EXISTS idx_discarded_expires ON discarded_entries(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_discarded_original ON discarded_entries(original_id);

-- 6. Record this migration
INSERT INTO _migrations (name, applied_at) 
VALUES ('006_cognitive_tiering', now())
ON CONFLICT DO NOTHING;

COMMIT;
