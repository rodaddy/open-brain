-- Routing history: the public, append-only record of every DREAM routing run
-- and every per-candidate routing decision (issue 1525, `_plans/1469-dream-route.md`
-- item 4).
--
-- Today `routing_runs` and `routing_decisions` exist only inside the
-- disposable `dream_run_NNN` schemas (`scripts/dream-route-run-store.ts`),
-- which are dropped with the run. The scheduled router job writes its history
-- here instead, and reads it back to skip candidates that already carry a
-- decision. The columns, types, and constraints are copied verbatim from the
-- run store so a run schema and this history stay comparable row for row.
--
-- This migration creates the tables only. Nothing writes them yet; an empty
-- history table is inert.
--
-- APPEND-ONLY BY CONSTRUCTION. There is no updated_at and no archived_at: a
-- run and a decision are facts about a moment. Nothing here grants an UPDATE
-- or DELETE path; a correction is a new run with new rows.
--
-- `would_apply` is deliberately NOT created here. It is a dry-run construct of
-- the disposable run schemas, listing what a run WOULD have applied; the
-- scheduled job applies directly, so the public schema has no use for it.
--
-- Rollback (nothing reads the tables until the scheduled job lands):
--   DROP TABLE IF EXISTS routing_decisions;
--   DROP TABLE IF EXISTS routing_runs;

CREATE TABLE IF NOT EXISTS routing_runs (
    run_id UUID PRIMARY KEY,
    matrix_fingerprint TEXT NOT NULL,
    classifier_version TEXT NOT NULL,
    thresholds JSONB NOT NULL,
    backend TEXT NOT NULL,
    served_models TEXT[] NOT NULL,
    records INTEGER NOT NULL,
    requests INTEGER NOT NULL,
    input_tokens BIGINT NOT NULL,
    estimated_usd NUMERIC NOT NULL,
    actual_usd NUMERIC NOT NULL,
    ms INTEGER NOT NULL,
    note TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS routing_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES routing_runs (run_id),
    candidate_id UUID NOT NULL,
    namespace TEXT NOT NULL,
    destination TEXT,
    agreement TEXT NOT NULL,
    authority_tier TEXT NOT NULL,
    restates BOOLEAN NOT NULL,
    drove_decision BOOLEAN NOT NULL,
    reasons JSONB NOT NULL,
    raw JSONB NOT NULL,
    served_model TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id, candidate_id)
);

-- The scheduled job's skip-already-routed read: "has this candidate a decision?"
CREATE INDEX IF NOT EXISTS idx_routing_decisions_candidate ON routing_decisions (candidate_id);

-- The per-run report: every decision one run made.
CREATE INDEX IF NOT EXISTS idx_routing_decisions_run ON routing_decisions (run_id);

-- The review tallies: decisions grouped by destination and agreement.
CREATE INDEX IF NOT EXISTS idx_routing_decisions_destination_agreement ON routing_decisions (destination, agreement);

-- Comparing matrix versions: runs grouped by the matrix they routed with.
CREATE INDEX IF NOT EXISTS idx_routing_runs_matrix_fingerprint ON routing_runs (matrix_fingerprint);
