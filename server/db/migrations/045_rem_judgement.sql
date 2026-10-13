-- 045 — REM's judgement: the 0-10 score and what the grader saw.
--
-- WHY A SCORE COLUMN WHEN machine_grade ALREADY EXISTS.
--
-- They are different axes and collapsing them loses the one that has ordering.
-- `machine_grade` is deliberately the four-value review vocabulary
-- (037:116-123) so it is directly comparable to `review_action` — a
-- disagreement rate is only meaningful if both sides speak the same language.
-- Four unordered buckets cannot rank 1,827 items, and ranking is the whole
-- point: the operator works a queue top-down, and Deep inherits whatever order
-- REM established. Operator, 2026-07-29: "make sure that there's a 0 to 10
-- grading scale so that I can we can actually put some proper logic around the
-- REM stuff which will give proper logic to the deep sleep".
--
-- So: machine_grade keeps its job (comparable to the human label), and
-- machine_score carries the ordering. Neither replaces the other, and
-- machine_score is advisory in exactly the way 037:62 already establishes —
-- it sorts the queue, it never filters it. Under the 2026-07-28 "let everything
-- pass" decision the queue predicate is `reviewed_at IS NULL` and nothing else.
--
-- WHY THE REST OF REM'S OUTPUT LIVES IN JSONB.
--
-- The round-three prompt returns a quote, a label, a one-line synopsis of what
-- the agent did, and an agent_behavior read. Those are the grader's working
-- notes: useful for rendering the review page and for writing canned replies
-- against, but not things anything queries by. A column each would be four
-- migrations' worth of surface for data with no predicate on it, and the
-- prompt is expected to change — round three is itself the third iteration.
-- JSONB absorbs a prompt change without a migration; a column does not.
--
-- The two fields that DO get columns are the two with real query shapes:
-- machine_score (ORDER BY) and machine_graded_at (freshness / re-grade).
--
-- WHY agent_behavior IS NOT ADDED HERE. 042 already put agent_behavior on
-- candidate_grade — the OPERATOR's read of the agent. REM's guess about the
-- same thing is a different claim by a different author, and 037's central
-- rule is that the machine's guess never shares a column with the human's
-- label. It rides in the judgement JSONB, where it is clearly the model's.

ALTER TABLE candidate_memory
  ADD COLUMN IF NOT EXISTS machine_score INTEGER,
  ADD COLUMN IF NOT EXISTS machine_graded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS machine_judgement JSONB;

COMMENT ON COLUMN candidate_memory.machine_score IS
  'REM''s 0-10 value estimate. ADVISORY: it orders the review queue and never '
  'filters it. Separate from machine_grade, which stays in review_action''s '
  'four-value vocabulary so the two remain directly comparable (037).';

COMMENT ON COLUMN candidate_memory.machine_graded_at IS
  'When REM last wrote a judgement. Distinguishes never-graded from graded-'
  'and-scored-zero, which a NULL check on machine_score alone cannot.';

COMMENT ON COLUMN candidate_memory.machine_judgement IS
  'REM''s working notes: {quote, label, synopsis, agent_behavior, '
  'canned_replies}. Rendered on the review page and read when composing canned '
  'replies. JSONB because the prompt is expected to keep changing and none of '
  'these fields carry a query predicate.';

-- 0-10 inclusive, matching the prompt's anchored scale. A grader returning 11
-- is a bug, and the database should refuse it rather than let it skew an
-- ORDER BY that the operator then works top-down.
ALTER TABLE candidate_memory
  DROP CONSTRAINT IF EXISTS candidate_memory_machine_score_range;
ALTER TABLE candidate_memory
  ADD CONSTRAINT candidate_memory_machine_score_range
  CHECK (machine_score IS NULL OR (machine_score >= 0 AND machine_score <= 10));

-- The half-written form is the one that reads as "no data" instead of "broken":
-- a score with no timestamp cannot be aged out or re-graded, and a judgement
-- with no score cannot be ordered. 044 added the same shape of pairing CHECK
-- for exactly this reason — a declared-but-unpopulated column typechecks,
-- satisfies every constraint, and returns an empty result set that looks like
-- an answer.
ALTER TABLE candidate_memory
  DROP CONSTRAINT IF EXISTS candidate_memory_machine_score_paired;
ALTER TABLE candidate_memory
  ADD CONSTRAINT candidate_memory_machine_score_paired
  CHECK ((machine_score IS NULL) = (machine_graded_at IS NULL));

-- The review queue's ordering index. Partial on the queue predicate
-- (`reviewed_at IS NULL`) because that is the only population ever sorted this
-- way, and DESC NULLS LAST so ungraded items sink below graded ones rather
-- than heading the queue on a NULL.
CREATE INDEX IF NOT EXISTS idx_candidate_memory_machine_score
  ON candidate_memory (namespace, machine_score DESC NULLS LAST, created_at)
  WHERE reviewed_at IS NULL AND parent_id IS NULL;
