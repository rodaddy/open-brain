-- Migration 042: WHY the operator graded it, and WHETHER THE AGENT DID WELL.
--
-- Two additive columns on candidate_grade. Both exist because one grade value
-- was measurably carrying more than one question.
--
--
-- 1. reason_code -- the WHY, as a code instead of prose.
--
-- The only real evidence available is the operator's own 8 notes, the entire
-- graded corpus as of 2026-07-28:
--
--   "this by itself isn't, but the surronding messages will make for useful
--    info in whole"
--   "combined with surrounding messages???"
--   "circular but has a point and states facts"
--   "show's logic"
--   "logic to fix an issue"
--
-- Five notes, three ideas: the unit is too small to judge alone (2 of 5), it
-- shows reasoning (2 of 5), it states a fact (1 of 5). The same handful of
-- reasons, retyped by hand each time, with a typo and a different phrasing every
-- time. Across 1,104 items that is both slow and unqueryable: "how many did he
-- reject as too fragmentary" becomes a grep over free text where "this by itself
-- isn't" and "combined with surrounding messages???" mean the same thing and
-- share not one word.
--
-- So the reason is stored as a CODE. A code is training data -- GROUP BY
-- reason_code answers "which extraction defect does the operator hit most" as a
-- count, which is precisely the question the re-cut in 041 was guessing at. The
-- note column stays exactly as it was and keeps the operator's own words; the
-- code is an ADDITIONAL, coarser channel beside it, never a replacement. NULL is
-- the normal case for a free-text-only grade, and no default is set: a code the
-- operator did not choose would be fabricated evidence in the one table meant to
-- be ground truth.
--
-- NOT A FOREIGN KEY TO A LOOKUP TABLE, and not a CHECK constraint. The
-- vocabulary lives in src/grading-reasons.ts and is validated server-side before
-- the INSERT. A CHECK here would mean a migration every time a reason is added,
-- removed, or reworded during the exploratory phase this whole grading exercise
-- is; worse, a code retired from the UI would have to stay in the constraint
-- forever anyway to keep the rows that already carry it readable. Text plus
-- server-side validation keeps history readable when the vocabulary moves.
--
--
-- 2. agent_behavior -- the SECOND AXIS, and the reason this migration exists at
--    all rather than being a note-formatting change.
--
-- OPERATOR, verbatim, 2026-07-28:
--   "if I say my interaction is a yes, the surrounding agent calls should almost
--    always auto go in"
--   "then the decision is are they there a good interaction and things to keep
--    doing, or i'm pissed and the agent did the wrong thing and don't do that"
--
-- That is NOT the same question as `action`. `action` asks "is this worth
-- remembering". This asks "did the agent behave well". They come apart in both
-- directions, and both directions are real:
--
--   - Excellent agent behavior, worthless memory. The agent answers a throwaway
--     question perfectly. Nothing durable was decided, so the memory is rejected
--     -- while the behavior is exactly what should keep happening.
--   - Valuable memory, bad agent behavior. The agent does the wrong thing, the
--     operator corrects it, and the correction is the most valuable thing in the
--     exchange. Promote the memory; the behavior is what must NOT be repeated.
--
-- Folding both into one grade destroys both signals: a `rejected` row can no
-- longer be read as either "bad memory" or "bad agent", and a `promoted` row
-- cannot distinguish "the agent nailed it" from "the agent blew it and that is
-- why this is worth keeping." Since the whole point of collecting grades is to
-- have separable training signal later, collapsing two axes into one column at
-- collection time is unrecoverable -- no downstream query can un-mix them.
--
-- NULLABLE, and that asymmetry is deliberate. Grading the memory is the job;
-- rating the behavior is optional colour. A NOT NULL with a 'neutral' default
-- would silently manufacture 1,104 explicit "the agent was fine" judgements the
-- operator never made, which is worse than having no behavior data at all --
-- fabricated agreement is indistinguishable from real agreement in the counts.
-- NULL means "not rated", 'neutral' means "rated, and it was unremarkable", and
-- those are different facts.
--
-- CHECKED, unlike reason_code, because this vocabulary is a closed three-way
-- judgement that will not churn. good/bad/neutral is the whole space of the
-- question the operator asked; there is no fourth answer to add later, so the
-- constraint costs nothing and stops a typo'd 'Good' from forming a fourth
-- silent bucket that no query filters on.
--
--
-- PURELY ADDITIVE. Both columns are nullable with no default, so the 8 existing
-- grades (one batch, 2026-07-28) keep their exact meaning: NULL reason_code and
-- NULL agent_behavior read as "graded before these axes existed", which is the
-- truth. Nothing is rewritten, nothing is backfilled -- inventing a reason_code
-- for a note the operator typed in prose would be the model authoring the
-- operator's judgement, the same failure 037 keeps machine_grade apart for.

ALTER TABLE candidate_grade
  -- Which canned reason the operator chose. NULL when the grade carried only
  -- free text (or nothing). Deliberately unconstrained TEXT -- see the header:
  -- the vocabulary is server-side in src/grading-reasons.ts so it can move
  -- without a migration, and so retired codes stay readable in old rows.
  ADD COLUMN IF NOT EXISTS reason_code TEXT,

  -- Was the AGENT's conduct in this exchange worth repeating? Independent of
  -- `action`, which judges the memory. NULL = not rated (the default state),
  -- 'neutral' = rated and unremarkable. Those are different, so no default.
  ADD COLUMN IF NOT EXISTS agent_behavior TEXT;

ALTER TABLE candidate_grade
  DROP CONSTRAINT IF EXISTS candidate_grade_agent_behavior_check;

ALTER TABLE candidate_grade
  ADD CONSTRAINT candidate_grade_agent_behavior_check
  CHECK (agent_behavior IS NULL OR agent_behavior IN ('good', 'bad', 'neutral'));

COMMENT ON COLUMN candidate_grade.reason_code IS
  'Which canned reason the operator picked, as a code rather than prose, so '
  '"why does he reject things" is a GROUP BY instead of a grep over free text. '
  'NULL when the grade was free-text-only. The vocabulary lives in '
  'src/grading-reasons.ts and is validated server-side -- not CHECKed here, so '
  'it can change without a migration and retired codes stay readable.';

COMMENT ON COLUMN candidate_grade.agent_behavior IS
  'Whether the AGENT behaved well in this exchange -- a SECOND AXIS, independent '
  'of `action`. Operator, 2026-07-28: "are they there a good interaction and '
  'things to keep doing, or i''m pissed and the agent did the wrong thing". A '
  'useless memory can come from excellent behavior and a valuable memory from '
  'the agent screwing up, so mixing them into one grade destroys both signals. '
  'NULL means not rated; ''neutral'' means rated and unremarkable.';

-- "Which reasons does he actually use, and for which action?" The counts this
-- column exists to make cheap. Partial so it stays small: most grades will carry
-- no code, and a code-less row answers nothing this index is asked.
CREATE INDEX IF NOT EXISTS idx_candidate_grade_reason
  ON candidate_grade (namespace, reason_code, action)
  WHERE reason_code IS NOT NULL;

-- "How often was the agent good, bad, or unremarkable?" Same argument, same
-- shape -- and partial for the same reason, since rating behavior is optional.
CREATE INDEX IF NOT EXISTS idx_candidate_grade_behavior
  ON candidate_grade (namespace, agent_behavior)
  WHERE agent_behavior IS NOT NULL;
