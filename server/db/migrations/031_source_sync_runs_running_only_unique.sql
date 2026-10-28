-- Migration 031: converge ob_source_sync_runs onto the RUNNING-only uniqueness
-- for databases upgraded across the migration-030 revision (Issue #338).
--
-- Migration 030 uses CREATE TABLE IF NOT EXISTS. An earlier revision of 030
-- declared uniqueness as an inline table constraint —
--   UNIQUE (source_id, observation_hash)
-- which Postgres materializes as the PERMANENT unique constraint
--   ob_source_sync_runs_source_id_observation_hash_key
-- covering runs in EVERY status. A database that applied that earlier revision
-- keeps that permanent constraint: re-running the corrected 030 is a no-op on
-- the existing table (IF NOT EXISTS), so it never drops the old constraint and
-- its own CREATE UNIQUE INDEX IF NOT EXISTS for the partial running-only index
-- may never have run (the earlier revision did not define it).
--
-- The corrected 030 makes uniqueness PARTIAL on status = 'running': a completed
-- run is terminal history and must not block a fresh running run for the same
-- observation (the A -> B -> A revert case). On an upgraded database the leftover
-- permanent constraint still enforces uniqueness across completed rows, so
-- re-planning a repeated observation — or reverting to an earlier one — collides
-- with a completed history row and the sync fails.
--
-- This migration converges upgraded and fresh databases:
--   1. Drop the legacy permanent unique constraint by its exact generated name
--      (IF EXISTS, so it is a no-op on a fresh database that never had it).
--   2. Ensure the running-only partial unique index exists (IF NOT EXISTS, so it
--      is a no-op on a fresh database where the corrected 030 already created it).
--
-- The partial index definition is byte-identical to the one in the corrected
-- 030, so both paths land on exactly the same schema. Nothing here rewrites or
-- loses data, and the migration is safe to re-run.

-- 1. Remove the legacy always-on unique constraint that the earlier 030's inline
--    UNIQUE (source_id, observation_hash) generated. Targets the exact known
--    constraint name; no dynamic discovery.
ALTER TABLE ob_source_sync_runs
  DROP CONSTRAINT IF EXISTS ob_source_sync_runs_source_id_observation_hash_key;

-- 2. Ensure the RUNNING-only partial unique index exists. Only 'running' runs are
--    resumable identity; a 'completed' run is terminal history and must not block
--    a fresh run for the same observation. Identical to the corrected 030 body, so
--    this is a no-op on a fresh database.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ob_source_sync_runs_running_obs
  ON ob_source_sync_runs (source_id, observation_hash)
  WHERE status = 'running';
