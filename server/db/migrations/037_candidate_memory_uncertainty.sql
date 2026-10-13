-- Migration 037: let everything through, and record how sure we were.
--
-- THE DECISION (operator, 2026-07-28). Nothing gets pre-filtered on a guess.
-- Every candidate passes Light and REM into Deep, and the machine records its
-- own uncertainty instead of acting on it. We find out what is actually good by
-- GRADING it, not by tuning thresholds before a single item has been graded.
--
-- WHY. A filter tuned before there is graded data is tuned on nothing. Worse,
-- it destroys the very evidence needed to tune it: a candidate suppressed at
-- ingest cannot be graded, so the error it represents is never measurable and
-- never corrected. gbrain reached a working automated promoter by grading the
-- whole corpus first -- a big annoying slog -- not by guessing well up front.
--
-- The measured case for distrusting machine self-assessment here: 112 of 214
-- candidates were mislabelled `preference` in the 2026-07-24 run
-- (docs/dream-design.md:238). A model that is wrong about the label 52% of the
-- time must not also be the thing deciding what never gets seen.
--
-- This is the same asymmetry that removed the length floor from Light: the
-- tier system is the precision filter, applied later, reversibly, with months
-- of usage evidence behind it. Content that never entered has no usage history
-- to be judged by and no path back.
--
-- WHAT THIS ADDS
--
--   uncertain          -- boolean, NOT NULL, default false. Did the producer
--                         doubt this? A flag, not a score: a calibrated
--                         confidence number from an uncalibrated model is
--                         false precision, and there is no graded data yet to
--                         calibrate against. Promote it to a scale later if
--                         grading shows a flag is too coarse.
--   uncertainty_reason -- free text, nullable. WHY it was doubted, which is
--                         what makes a flag actionable during review.
--   'inconclusive'     -- added to review_action. The operator must be able to
--                         say "I cannot tell" without that collapsing into
--                         rejected. Treating "unsure" as "no" is exactly the
--                         silent data loss this migration exists to stop.
--   graded_by          -- who reviewed it. Training data needs provenance:
--                         human grades and machine grades cannot be pooled.
--   machine_grade      -- REM's GUESS, in its own column. See below.
--   machine_grade_model
--
-- THE MACHINE GRADE MUST NOT LIVE IN review_action. REM may attempt a grade --
-- that guess is useful, because comparing it to the operator's grade is how we
-- eventually learn whether the machine can be trusted with this at all. But it
-- cannot be written to review_action, for a reason that is structural rather
-- than stylistic:
--
--   reviewed_at IS NULL is the operator's queue. Anything that sets
--   review_action also sets reviewed_at (candidate_memory_review_paired), so a
--   machine writing there silently removes the item from human review. The
--   model would be grading its own training data and marking it done.
--
-- Two separate columns keep the ground truth clean. machine_grade is a
-- prediction; review_action is the label. Their disagreement rate IS the
-- measurement of whether REM has learned anything, and that number only exists
-- if the two were never allowed to contaminate each other.
--
-- WHAT THIS DOES NOT DO. It does not change what is promoted, and it does not
-- let any machine judgement suppress an item. reviewed_at IS NULL remains the
-- operator's queue (idx_candidate_memory_unreviewed); `uncertain` and
-- `machine_grade` are advisory only -- they sort the queue so doubtful items
-- surface first, never filter it.

ALTER TABLE candidate_memory
  ADD COLUMN IF NOT EXISTS uncertain BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS uncertainty_reason TEXT,
  ADD COLUMN IF NOT EXISTS graded_by TEXT,
  ADD COLUMN IF NOT EXISTS machine_grade TEXT,
  ADD COLUMN IF NOT EXISTS machine_grade_model TEXT;

COMMENT ON COLUMN candidate_memory.uncertain IS
  'Did the producer doubt this candidate? ADVISORY ONLY -- it sorts the review '
  'queue so doubtful items surface first, and must never gate what enters. A '
  'flag rather than a score because there is no graded data to calibrate a '
  'score against, and false precision is worse than none.';

COMMENT ON COLUMN candidate_memory.uncertainty_reason IS
  'Why this was doubted (ambiguous referent, no clear decision, conflicting '
  'statements, ...). What makes the flag actionable to a human reviewer.';

COMMENT ON COLUMN candidate_memory.graded_by IS
  'Who set review_action. This column is the HUMAN label -- the ground truth a '
  'future automated promoter is measured against. A model writes '
  'machine_grade, never this.';

COMMENT ON COLUMN candidate_memory.machine_grade IS
  'REM''s guess at the grade, kept strictly separate from review_action. '
  'Writing a machine guess into review_action would set reviewed_at and drop '
  'the item out of the human queue -- the model grading its own training data '
  'and marking it done. Agreement between this and review_action is how we '
  'find out whether the machine can be trusted, and that number only exists '
  'while the two stay independent.';

COMMENT ON COLUMN candidate_memory.machine_grade_model IS
  'Which model produced machine_grade. Grades from different models are not '
  'comparable, and a model swap must not look like the machine improving.';

-- 'inconclusive' joins the review vocabulary. Rebuild the constraint rather
-- than add a second one, so there is exactly one place that defines the set.
ALTER TABLE candidate_memory
  DROP CONSTRAINT IF EXISTS candidate_memory_review_check;

ALTER TABLE candidate_memory
  ADD CONSTRAINT candidate_memory_review_check
  CHECK (
    review_action IS NULL
    OR review_action = ANY (ARRAY[
         'promoted'::text,      -- graded good, goes up the chain
         'rejected'::text,      -- graded bad
         'duplicate'::text,     -- already known
         'inconclusive'::text   -- cannot tell yet; NOT a rejection
       ])
  );

-- machine_grade draws from the same vocabulary as review_action so the two are
-- directly comparable -- a disagreement rate is only meaningful if both sides
-- speak the same language.
ALTER TABLE candidate_memory
  ADD CONSTRAINT candidate_memory_machine_grade_check
  CHECK (
    machine_grade IS NULL
    OR machine_grade = ANY (ARRAY[
         'promoted'::text,
         'rejected'::text,
         'duplicate'::text,
         'inconclusive'::text
       ])
  );

-- A grade with no model attached cannot be interpreted later, and an
-- attribution with no grade is noise. Keep them paired, the same way
-- review_action and reviewed_at are.
ALTER TABLE candidate_memory
  ADD CONSTRAINT candidate_memory_machine_grade_paired
  CHECK ((machine_grade IS NULL) = (machine_grade_model IS NULL));

-- The doubtful-first review queue. Same predicate as
-- idx_candidate_memory_unreviewed so it stays small, ordered so a reviewer
-- meets the items where their judgement is worth the most.
CREATE INDEX IF NOT EXISTS idx_candidate_memory_uncertain_first
  ON candidate_memory (namespace, uncertain DESC, created_at)
  WHERE reviewed_at IS NULL;

-- Inconclusive items are a work queue in their own right: the operator asked to
-- be able to come back and grade them later, so they need to be findable
-- without scanning every reviewed row.
CREATE INDEX IF NOT EXISTS idx_candidate_memory_inconclusive
  ON candidate_memory (namespace, reviewed_at)
  WHERE review_action = 'inconclusive';
