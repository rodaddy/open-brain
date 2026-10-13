-- Migration 016: Promotion provenance tracking
-- Adds promoted_from JSONB column to all core tables for tracking
-- when entries are promoted from agent namespaces to collab.
-- Schema: {source_namespace, source_id, source_agent, promotion_reason, promoted_at, promoted_by}
-- Transaction managed by migration runner.

ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS promoted_from JSONB;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS promoted_from JSONB;
ALTER TABLE relationships ADD COLUMN IF NOT EXISTS promoted_from JSONB;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS promoted_from JSONB;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS promoted_from JSONB;

CREATE INDEX IF NOT EXISTS idx_thoughts_promoted ON thoughts ((promoted_from IS NOT NULL)) WHERE promoted_from IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_decisions_promoted ON decisions ((promoted_from IS NOT NULL)) WHERE promoted_from IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_relationships_promoted ON relationships ((promoted_from IS NOT NULL)) WHERE promoted_from IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_projects_promoted ON projects ((promoted_from IS NOT NULL)) WHERE promoted_from IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_promoted ON sessions ((promoted_from IS NOT NULL)) WHERE promoted_from IS NOT NULL;
