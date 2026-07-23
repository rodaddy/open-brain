-- Migration 029: widen the maintenance_jobs.last_error_category CHECK to accept
-- the queue-owned 'terminal' category (#346).
--
-- Background mirrors migration 028. A handler can now declare a failure
-- non-retryable by throwing the queue-owned MaintenanceTerminalError; the queue
-- dead-letters that job on the failing attempt and records the content-free
-- category 'terminal', distinct from 'error' (unclassified retryable) and
-- 'lease_expired' (expired lease past its attempt budget) so dead-letter
-- analysis can tell a policy-driven immediate dead-letter apart.
--
-- Migration 026 (CREATE TABLE IF NOT EXISTS) and 028 (drop/re-add the named
-- constraint) both already carry 'terminal' in their current bodies, so a fresh
-- database converges through them. A database that already applied 026 and 028
-- before 'terminal' was introduced keeps its stale constraint: neither 026 nor
-- 028 re-runs once recorded in _migrations, so the enum is never widened and the
-- terminal dead-letter write would fail. This migration re-derives the named
-- constraint to the canonical allow-list so upgraded and fresh databases
-- converge.
--
-- It only widens the accepted set, so every previously stored
-- last_error_category value remains valid — no data is rewritten or lost. It is
-- additive and idempotent: dropping IF EXISTS and re-adding the same named
-- constraint is safe to re-run and safe on a database that already has the
-- current definition.

ALTER TABLE maintenance_jobs
  DROP CONSTRAINT IF EXISTS maintenance_jobs_last_error_category_check;

ALTER TABLE maintenance_jobs
  ADD CONSTRAINT maintenance_jobs_last_error_category_check
  CHECK (last_error_category IN (
    'syntax_error', 'type_error', 'range_error', 'error', 'non_error',
    'unsupported_job_kind', 'lease_expired', 'terminal'
  ));
