-- Migration 009: Agent attribution + access log index restoration
-- Adds accessed_by column to entry_access_log for per-agent analytics.
-- Re-adds indexes on entry_access_log that were prematurely dropped in migration 008.

-- 1. Add accessed_by column for agent attribution
ALTER TABLE entry_access_log ADD COLUMN IF NOT EXISTS accessed_by TEXT;

-- 2. Re-add indexes dropped in migration 008
CREATE INDEX IF NOT EXISTS idx_access_log_entry ON entry_access_log(entry_id);
CREATE INDEX IF NOT EXISTS idx_access_log_time ON entry_access_log(accessed_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_log_agent ON entry_access_log(accessed_by);

-- 3. Composite index for agent-specific analytics
CREATE INDEX IF NOT EXISTS idx_access_log_entry_agent ON entry_access_log(entry_id, accessed_by);
