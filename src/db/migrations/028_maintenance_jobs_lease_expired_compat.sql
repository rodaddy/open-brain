-- Migration 028: repair the maintenance_jobs.last_error_category CHECK on
-- databases upgraded across the migration-026 revision that added
-- 'lease_expired'.
--
-- Migration 026 uses CREATE TABLE IF NOT EXISTS. A database that applied an
-- earlier revision of 026 — before 'lease_expired' was added to the inline
-- last_error_category CHECK — keeps its stale constraint: re-running 026 is a
-- no-op on the existing table, so the enum is never widened. The queue's
-- expired-lease dead-letter path then stores 'lease_expired' and the write
-- fails on those upgraded databases while a freshly created database (which
-- got the current 026 body) succeeds.
--
-- This migration re-derives the constraint to the canonical 026 allow-list so
-- upgraded and fresh databases converge. It only widens the accepted set, so
-- every previously stored last_error_category value remains valid — no data is
-- rewritten or lost. It is additive and idempotent: dropping IF EXISTS and
-- re-adding the same named constraint is safe to re-run and safe on a database
-- that already has the current definition.

ALTER TABLE maintenance_jobs
  DROP CONSTRAINT IF EXISTS maintenance_jobs_last_error_category_check;

ALTER TABLE maintenance_jobs
  ADD CONSTRAINT maintenance_jobs_last_error_category_check
  CHECK (last_error_category IN (
    'syntax_error', 'type_error', 'range_error', 'error', 'non_error',
    'unsupported_job_kind', 'lease_expired'
  ));
