-- Migration 040: candidate_grade -- the operator's judgement, in its own table.
--
-- OPERATOR DECISION, 2026-07-28: "i think we leave the output into its own
-- table for now and figure that out when i'm done." Grading is a data-collection
-- exercise whose downstream use is not yet decided, so the grades land somewhere
-- of their own and NOTHING about how they feed back is committed to yet.
--
-- WHY A TABLE INSTEAD OF COLUMNS ON candidate_memory.
--
-- 1. The note had nowhere honest to live. Before this, an operator note was
--    written into candidate_memory.uncertainty_reason (candidate-review.ts:672
--    documents the compromise), which is the DISTILLER's statement about why IT
--    doubted the row. Overwriting it destroys the machine's reason and files the
--    human's words under a machine-owned meaning. Same argument that keeps
--    machine_grade and review_action apart in 037: two authors, two columns.
--
-- 2. Grading is an EVENT, not a property. One row per act of judgement means a
--    regrade is a new row rather than an overwrite, so changing your mind is
--    recorded rather than erased. That history is the interesting part -- which
--    items got revisited, and what the first answer was -- and a column on
--    candidate_memory cannot express it without losing the original.
--
-- 3. It keeps candidate_memory clean while the shape is still unknown. Nothing
--    here forecloses later copying a resolved grade back onto the candidate.
--
-- RELATIONSHIP TO candidate_memory.review_action. That column still exists and
-- still drives the ungraded queue (reviewed_at IS NULL). This table is the
-- record of what the operator actually did and said; the columns remain the
-- fast queue predicate. The writer keeps them consistent in one transaction.
--
-- STILL NEVER MACHINE-WRITABLE. graded_by is the human. REM writes
-- candidate_memory.machine_grade and never touches this table -- a machine
-- grading here would be the model authoring its own training labels.

CREATE TABLE IF NOT EXISTS candidate_grade (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Namespace is carried rather than joined, so every read can be scoped
  -- without a join to candidate_memory. Namespace isolation is a security
  -- boundary here, and a predicate that depends on a join is one refactor away
  -- from being dropped.
  namespace     TEXT NOT NULL,

  candidate_id  UUID NOT NULL
    REFERENCES candidate_memory(id) ON DELETE CASCADE,

  -- Same vocabulary as candidate_memory.review_action and machine_grade, so
  -- human and machine judgements stay directly comparable. 'inconclusive' is
  -- first-class: "I cannot tell" must not collapse into "no".
  action        TEXT NOT NULL
    CHECK (action IN ('promoted', 'rejected', 'duplicate', 'inconclusive')),

  -- The operator's own words. Free text, nullable, and NOT to be confused with
  -- candidate_memory.uncertainty_reason, which belongs to the distiller.
  note          TEXT,

  graded_by     TEXT NOT NULL,

  -- Which batch this arrived in. The page holds grades locally until the
  -- operator sends, so one Send is one batch id -- enough to reconstruct what
  -- was submitted together, and to spot a batch entered in one careless sweep.
  batch_id      UUID,

  -- Superseded by a later grade on the same candidate. Set by the writer, never
  -- deleted: a changed mind is evidence, and the first answer is part of it.
  superseded_at TIMESTAMPTZ,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE candidate_grade IS
  'One row per act of operator judgement. Append-only: a regrade inserts a new '
  'row and marks the previous one superseded, so changing your mind is recorded '
  'rather than erased. Never written by a model -- REM writes '
  'candidate_memory.machine_grade instead.';

COMMENT ON COLUMN candidate_grade.note IS
  'The operator''s own words. Distinct from candidate_memory.uncertainty_reason, '
  'which is the distiller''s statement about its own doubt. Two authors, two '
  'columns -- the same separation 037 makes between machine_grade and '
  'review_action.';

COMMENT ON COLUMN candidate_grade.batch_id IS
  'Groups grades submitted in one Send. The page batches locally, so this is '
  'what reconstructs a submission after the fact.';

-- The live grade for a candidate: exactly one un-superseded row. A partial
-- unique index enforces it, which is cheaper and harder to bypass than doing it
-- in application code.
CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_grade_current
  ON candidate_grade (candidate_id)
  WHERE superseded_at IS NULL;

-- "What have I graded, most recent first" -- the review-history read.
CREATE INDEX IF NOT EXISTS idx_candidate_grade_recent
  ON candidate_grade (namespace, created_at DESC);

-- Undo pulls back the last batch, so a batch has to be findable as a unit.
CREATE INDEX IF NOT EXISTS idx_candidate_grade_batch
  ON candidate_grade (batch_id)
  WHERE batch_id IS NOT NULL;
