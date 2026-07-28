-- Migration 033: candidate_memory -- the distiller's output table (Issue #382, DISTILL-1)
--
-- Spec: docs/dream-design.md (precondition 1), docs/dream-ethereal-runs.md.
--
-- Why this table exists: 3,303 raw turns are captured and 0 are distilled,
-- because the distiller has nowhere to write. Measured 2026-07-27 on the local
-- dogfood clone: ob_raw_turns 3,303 rows, every one with distilled_at IS NULL,
-- and no consumer of ob_raw_turns anywhere in src/. Issue #382's top acceptance
-- criterion ("proposals land in candidate_memory") was unsatisfiable --
-- to_regclass('public.candidate_memory') returned NULL.
--
-- THIS SHAPE IS NOT NEW. It is adopted from zz_test_candidate_memory, an
-- undocumented prototype found in the dogfood clone on 2026-07-27 holding 214
-- real candidates distilled by Qwen3.5-4B-4bit on 2026-07-24. That prototype
-- exists ONLY in the database -- no migration, no SQL, no TypeScript anywhere
-- in the repo -- which is why #382 was written as though nothing existed.
-- Adopting the shape deliberately, with a migration this time.
--
-- CANDIDATE, NOT MEMORY -- read before wiring anything to this table:
-- A row here is a PROPOSAL. Nothing in this table is durable memory, is
-- recalled by brain_answer, or has any authority. Promotion out of this table
-- into thoughts/decisions is a separate, deliberate act governed by R3
-- authority tiers (docs/code-brain-design.md section R3): canon overrules
-- decided overrules observed, and a session finding can never outrank canon
-- however recent or repeated. Writing here must never imply promotion.
--
-- CONTENT SAFETY: content arrives already redacted. Rows are derived from
-- ob_raw_turns, whose write path applies redaction BEFORE the row reaches disk
-- (032_raw_turns.sql, redaction_applied). A distiller MUST read redacted turn
-- content and never re-fetch an unredacted source. The 2026-07-24 prototype ran
-- outside that path and persisted a plaintext credential; that is the failure
-- this note exists to prevent repeating.

CREATE TABLE IF NOT EXISTS candidate_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Namespace isolation, applied exactly as on every other table.
  namespace TEXT NOT NULL,

  -- WHAT KIND of claim this is. Deliberately WIDER than GRADUATE_TYPES
  -- (src/tiering.ts:36 = fact | decision | handoff). The distiller's two
  -- largest real outputs were preference (112 of 214) and correction (12), and
  -- NEITHER can graduate today. That mismatch is issue #431 and is a promotion
  -- concern, not a capture concern: refusing to record a correction because
  -- promotion has no path for it would lose the observation entirely.
  candidate_type TEXT NOT NULL,

  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,

  -- Provenance back to the exact turns this was derived from. Non-empty by
  -- constraint: a candidate with no source is not auditable and cannot be
  -- re-derived, which makes it unusable for the ethereal-run comparisons this
  -- table exists to support.
  source_turn_ids UUID[] NOT NULL,

  -- Which maintenance job produced this. Retargeted from the prototype's
  -- zz_test_distill_jobs to the real maintenance_jobs queue, where the
  -- memory.distill job kind will live (#382). ON DELETE SET NULL: losing the
  -- job record must not destroy the candidate.
  distill_job_id UUID REFERENCES maintenance_jobs(id) ON DELETE SET NULL,

  -- The model that produced this candidate. Load-bearing for ethereal runs:
  -- comparing run 46 against run 47 is meaningless without knowing what
  -- generated each. The 2026-07-24 prototype rows are attributable only because
  -- this column existed.
  model TEXT,

  -- R3 authority tier, from the SOURCE of the underlying turns, resolved at
  -- write time -- it is a provenance lookup, not a judgement, which is why it
  -- is model-free Light work. NULL means not yet classified, never "observed":
  -- defaulting an unknown to the weakest tier is a silent downgrade.
  authority_tier TEXT,

  promoted_from JSONB,
  source_refs JSONB NOT NULL DEFAULT '[]'::jsonb,

  embedding halfvec(768),

  -- Review outcome. NULL reviewed_at = not yet judged. All 214 prototype rows
  -- were unreviewed, which is the loop this table exists to close: producing
  -- candidates nobody judges is the same failure as not producing them.
  reviewed_at TIMESTAMPTZ,
  review_action TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT candidate_memory_type_check
    CHECK (candidate_type IN ('decision', 'correction', 'fact', 'preference')),

  CONSTRAINT candidate_memory_review_check
    CHECK (review_action IS NULL OR review_action IN ('promoted', 'rejected', 'duplicate')),

  -- A review_action without a reviewed_at (or the reverse) is a half-written
  -- review, which would make "unreviewed" queries silently wrong.
  CONSTRAINT candidate_memory_review_paired
    CHECK ((reviewed_at IS NULL) = (review_action IS NULL)),

  CONSTRAINT candidate_memory_authority_check
    CHECK (authority_tier IS NULL OR authority_tier IN ('canon', 'decided', 'observed')),

  CONSTRAINT candidate_memory_content_check
    CHECK (btrim(content) <> ''),

  CONSTRAINT candidate_memory_source_turns_check
    CHECK (cardinality(source_turn_ids) > 0)
);

-- Dedupe within a namespace. The distiller is re-runnable by design, so the
-- same turns re-distilled must collapse rather than accumulate. Namespace-
-- scoped because identical content in two namespaces is two separate claims.
CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_memory_dedupe
  ON candidate_memory (namespace, content_hash);

-- The review work queue. Partial: only unreviewed rows are ever scanned here,
-- so the index stays small as reviewed candidates accumulate.
CREATE INDEX IF NOT EXISTS idx_candidate_memory_unreviewed
  ON candidate_memory (namespace, created_at)
  WHERE reviewed_at IS NULL;

-- Ethereal-run comparison: "what did run N produce?" Without this, comparing
-- successive runs is a sequential scan.
CREATE INDEX IF NOT EXISTS idx_candidate_memory_job
  ON candidate_memory (distill_job_id)
  WHERE distill_job_id IS NOT NULL;

-- Reverse provenance: "which candidates came from this turn?" GIN because
-- source_turn_ids is an array and the question is containment.
CREATE INDEX IF NOT EXISTS idx_candidate_memory_source_turns
  ON candidate_memory USING GIN (source_turn_ids);

COMMENT ON TABLE candidate_memory IS
  'Distiller output. PROPOSALS, not durable memory: nothing here is recalled or '
  'has authority until deliberately promoted under R3 authority tiers. Shape '
  'adopted from the undocumented zz_test_candidate_memory prototype (214 rows, '
  '2026-07-24). See docs/dream-design.md and docs/code-brain-design.md.';

COMMENT ON COLUMN candidate_memory.candidate_type IS
  'Wider than GRADUATE_TYPES (src/tiering.ts:36) on purpose -- preference and '
  'correction are the distiller''s largest outputs and cannot graduate today (#431). '
  'Capture the observation; let promotion decide separately.';

COMMENT ON COLUMN candidate_memory.authority_tier IS
  'R3 tier resolved from the source at write time -- provenance lookup, not '
  'judgement. NULL means unclassified, never "observed".';
