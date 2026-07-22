-- Durable, server-owned maintenance queue. Jobs are intentionally not exposed
-- through MCP: each future handler owns its own authorization and scope rules.
CREATE TABLE IF NOT EXISTS maintenance_jobs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_kind            TEXT NOT NULL CHECK (job_kind ~ '^[a-z][a-z0-9_.-]{0,127}$'),
  job_version         INTEGER NOT NULL CHECK (job_version > 0),
  payload             JSONB NOT NULL DEFAULT '{}'::jsonb
                        CHECK (jsonb_typeof(payload) = 'object'),
  idempotency_key     TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  state               TEXT NOT NULL DEFAULT 'queued'
                        CHECK (state IN ('queued', 'running', 'succeeded', 'dead_letter')),
  run_after           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_token         UUID,
  lease_until         TIMESTAMPTZ,
  attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts        INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 25),
  backoff_base_ms     INTEGER NOT NULL DEFAULT 1000 CHECK (backoff_base_ms > 0),
  backoff_max_ms      INTEGER NOT NULL DEFAULT 300000 CHECK (backoff_max_ms >= backoff_base_ms),
  last_error_category TEXT CHECK (last_error_category IN (
    'syntax_error', 'type_error', 'range_error', 'error', 'non_error',
    'unsupported_job_kind'
  )),
  terminal_at         TIMESTAMPTZ,
  dead_lettered_at    TIMESTAMPTZ,
  namespace           TEXT,
  provenance          JSONB CHECK (provenance IS NULL OR jsonb_typeof(provenance) = 'object'),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT maintenance_jobs_unique_kind_idempotency UNIQUE (job_kind, idempotency_key),
  CONSTRAINT maintenance_jobs_lease_shape CHECK (
    (state = 'running' AND lease_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (state <> 'running' AND lease_token IS NULL AND lease_until IS NULL)
  ),
  CONSTRAINT maintenance_jobs_terminal_shape CHECK (
    (state IN ('succeeded', 'dead_letter') AND terminal_at IS NOT NULL)
    OR (state IN ('queued', 'running') AND terminal_at IS NULL)
  ),
  CONSTRAINT maintenance_jobs_dead_letter_shape CHECK (
    (state = 'dead_letter' AND dead_lettered_at IS NOT NULL)
    OR (state <> 'dead_letter' AND dead_lettered_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_maintenance_jobs_due
  ON maintenance_jobs (run_after, created_at, id)
  WHERE state = 'queued';

CREATE INDEX IF NOT EXISTS idx_maintenance_jobs_expired_lease
  ON maintenance_jobs (lease_until, id)
  WHERE state = 'running';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgname = 'trg_maintenance_jobs_updated_at'
       AND tgrelid = 'maintenance_jobs'::regclass
  ) THEN
    CREATE TRIGGER trg_maintenance_jobs_updated_at
      BEFORE UPDATE ON maintenance_jobs
      FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END;
$$;
