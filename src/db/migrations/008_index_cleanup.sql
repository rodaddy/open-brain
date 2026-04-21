-- 008: Drop unused indexes and install pg_stat_statements
-- Audit on 2026-04-20 found 14 unused non-PK indexes.
-- Dropping the ones with measurable write overhead or storage cost.

-- entry_access_log: write-only table, all 3 non-PK indexes have 0 scans
DROP INDEX IF EXISTS idx_access_log_entry;
DROP INDEX IF EXISTS idx_access_log_source;
DROP INDEX IF EXISTS idx_access_log_time;

-- extracted_metadata GIN indexes: feature not yet queried (0 scans each)
DROP INDEX IF EXISTS idx_decisions_extracted_meta;
DROP INDEX IF EXISTS idx_thoughts_extracted_meta;

-- pg_stat_statements: essential for query performance monitoring
-- NOTE: requires shared_preload_libraries = 'pg_stat_statements' in postgresql.conf
-- and a server restart. The CREATE EXTENSION will fail if not preloaded.
-- Run manually: ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements';
-- Then restart PostgreSQL and re-run this migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') THEN
    BEGIN
      CREATE EXTENSION pg_stat_statements;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'pg_stat_statements not available -- add to shared_preload_libraries and restart PostgreSQL';
    END;
  END IF;
END $$;
