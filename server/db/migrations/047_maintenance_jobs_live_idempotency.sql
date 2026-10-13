-- A FINISHED job must not reserve an idempotency key against NEW work (#747).
--
-- 026 declared `UNIQUE (job_kind, idempotency_key)` across every state. The
-- intent, from the DISTILL-1 design (_plans/issues/382): "Idempotency key is
-- `batch_hash`, so a re-enqueued identical batch is a no-op." That is right
-- while consumption works -- re-running finished work is exactly what a
-- dedupe key should prevent.
--
-- It is wrong once a job finishes WITHOUT consuming. The key then describes
-- pending work, is held forever by a `succeeded` row, and no later job can be
-- inserted under it. There is no reaper: nothing in this repo deletes from
-- maintenance_jobs, so the reservation is permanent.
--
-- Measured on the dogfood database 2026-08-25:
--
--   blocking row : 9c29069d-267c-4e39-a135-ace207e342f6
--   state        : succeeded, 02:19:05, attempts 1
--   key          : memory.distill:25ab14fc2b679646bcbccf7d9c9c2234:s4:t1500
--   live hash    : 25ab14fc2b679646bcbccf7d9c9c2234   (byte-identical)
--   backlog      : 190,206 undistilled turns, climbing
--
-- The hash cannot drift on its own. It covers the FIRST 1500 due turns in
-- (session_ref, occurred_at, id) order; new turns sort to the END and never
-- enter that window. So the key was frozen, the lane could not self-heal, and
-- the sweep re-attempted the same dropped insert every 5 seconds for hours.
--
-- The fix scopes uniqueness to jobs that are still LIVE. A queued or running
-- job still reserves its key, which is the whole point of the constraint:
-- concurrent producers cannot double-enqueue the same batch, and the
-- at-least-once queue stays idempotent. A terminal job (succeeded or
-- dead_letter) releases it, so a batch that recurs can be scheduled again.
--
-- WHAT THIS DELIBERATELY DOES NOT DO. It does not make re-running finished
-- work automatic. A key only recurs when a producer computes it again from
-- live state, which for the distill sweep means the turns are STILL due. Work
-- that actually completed changes its own inputs and therefore its key. The
-- guard against redoing finished work lives in the producer's selection
-- (`distilled_at IS NULL`), not in a permanently-held row -- and relying on
-- the row was what turned one unconsumed batch into a permanent deadlock.
--
-- Class fix, not a distill fix: this deadlock was available to any job kind
-- whose key can recur.

-- Both names are dropped so a partially-applied earlier attempt converges.
ALTER TABLE maintenance_jobs
  DROP CONSTRAINT IF EXISTS maintenance_jobs_unique_kind_idempotency;
DROP INDEX IF EXISTS maintenance_jobs_unique_kind_idempotency;

-- Partial unique index rather than a constraint: a CHECK-style table
-- constraint cannot carry a WHERE clause, and ON CONFLICT infers a partial
-- index only when the statement repeats this exact predicate. src/
-- maintenance-queue.ts spells it identically in its INSERT.
CREATE UNIQUE INDEX IF NOT EXISTS maintenance_jobs_live_idempotency
  ON maintenance_jobs (job_kind, idempotency_key)
  WHERE state IN ('queued', 'running');

-- Terminal rows are no longer covered by a unique index, so the lookup that
-- `enqueue` performs after a dropped insert still needs an access path, and
-- so does any operator asking "what happened to this key". Non-unique by
-- design: many finished jobs may now share one key over time.
CREATE INDEX IF NOT EXISTS maintenance_jobs_kind_idempotency_history
  ON maintenance_jobs (job_kind, idempotency_key, created_at DESC);
