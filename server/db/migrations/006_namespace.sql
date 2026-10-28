-- Migration 006: Per-user namespace support
-- Adds namespace column to all tables for user-level data isolation.
-- Rows are either in a personal namespace (user's clientId) or 'collab' (shared).

ALTER TABLE thoughts      ADD COLUMN IF NOT EXISTS namespace TEXT NOT NULL DEFAULT 'collab';
ALTER TABLE decisions     ADD COLUMN IF NOT EXISTS namespace TEXT NOT NULL DEFAULT 'collab';
ALTER TABLE relationships ADD COLUMN IF NOT EXISTS namespace TEXT NOT NULL DEFAULT 'collab';
ALTER TABLE projects      ADD COLUMN IF NOT EXISTS namespace TEXT NOT NULL DEFAULT 'collab';
ALTER TABLE sessions      ADD COLUMN IF NOT EXISTS namespace TEXT NOT NULL DEFAULT 'collab';

-- Partial indexes for namespace-scoped queries (active rows only)
CREATE INDEX IF NOT EXISTS idx_thoughts_namespace      ON thoughts      (namespace) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_decisions_namespace      ON decisions     (namespace) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_relationships_namespace  ON relationships (namespace) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_projects_namespace       ON projects      (namespace) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_namespace       ON sessions      (namespace) WHERE archived_at IS NULL;
