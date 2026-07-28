-- Migration 043: candidate_memory.anchor_kind -- how the operator authored the head.
--
-- OPERATOR, 2026-07-28, on seeing the recut:
--   "with the exception of maybe AskUserQuestions sections, that's kind of a
--    hybrid and should be treated more like it came from me i think, with that
--    note that it is AUQ"
--
-- THE DEFECT. 041 cuts an exchange at every `is_human_prompt` turn. An
-- AskUserQuestion answer is the operator deciding, but the runtime delivers it
-- as a tool_result, so it is stored `role='tool'`, `is_human_prompt=false` --
-- by those columns alone, indistinguishable from command output.
--
-- Measured on the live corpus 2026-07-28: 6 such turns, all role='tool', all
-- is_human_prompt=false, and after the 041 recut ALL SIX headed nothing. Every
-- one had been swept into the agent body of whatever preceded it. One is the
-- operator's instruction to leave `.claude/` untracked, which was acted on.
--
-- This is the failure ingest already names (tools/ingest-raw-turn.ts:23-25):
-- capture "had never once captured an AskUserQuestion answer -- the densest
-- decision content in the corpus".
--
-- WHY A NEW COLUMN RATHER THAN FIXING is_human_prompt. Rewriting that flag was
-- the obvious shortcut and it is wrong. The column records what the RUNTIME
-- reported; overwriting it would destroy the distinction between "the operator
-- typed this" and "the operator chose this", and it would silently rewrite
-- captured history to make a downstream stage simpler. The raw turn keeps
-- saying what actually arrived; the derived candidate carries the interpretation.
--
-- WHY THE DISTINCTION IS KEPT VISIBLE rather than collapsed to "operator said
-- it". They are not equivalent evidence. A typed sentence is unprompted and
-- unbounded. A menu choice is bounded by options the AGENT wrote, so it is
-- partly the agent's framing -- which matters when these grades become training
-- data about what the operator actually wants. The operator asked for the badge
-- by name: "with that note that it is AUQ".

ALTER TABLE candidate_memory
  ADD COLUMN IF NOT EXISTS anchor_kind TEXT;

ALTER TABLE candidate_memory
  DROP CONSTRAINT IF EXISTS candidate_memory_anchor_kind_check;

ALTER TABLE candidate_memory
  ADD CONSTRAINT candidate_memory_anchor_kind_check
  CHECK (
    anchor_kind IS NULL                    -- fragment rows, which have no anchor
    OR anchor_kind = ANY (ARRAY[
         'typed'::text,            -- operator wrote it unprompted
         'askuserquestion'::text,  -- operator chose from agent-authored options
         'orphan'::text            -- agent turns with no operator head
       ])
  );

COMMENT ON COLUMN candidate_memory.anchor_kind IS
  'How the operator authored the head of this exchange: typed (unprompted), '
  'askuserquestion (chose from options the agent wrote), or orphan (no operator '
  'turn heads it). NULL on unit_kind=''fragment''. Kept distinct from '
  'ob_raw_turns.is_human_prompt, which records what the runtime reported and is '
  'never rewritten -- a menu choice is bounded by the options offered, so it is '
  'weaker evidence of intent than a typed sentence and must stay tellable apart.';

-- Backfill what is already derivable: every existing anchored exchange came
-- from an is_human_prompt turn, because that was 041's only cut rule. The
-- AskUserQuestion heads do not exist yet -- the re-cut creates them.
UPDATE candidate_memory
   SET anchor_kind = 'typed'
 WHERE unit_kind = 'exchange'
   AND anchor_turn_id IS NOT NULL
   AND anchor_kind IS NULL;

UPDATE candidate_memory
   SET anchor_kind = 'orphan'
 WHERE unit_kind = 'exchange'
   AND anchor_turn_id IS NULL
   AND anchor_kind IS NULL;

-- The grading queue reads "operator-anchored, ungraded, uncertain first". Both
-- typed and askuserquestion qualify, so the index covers the pair rather than a
-- single value.
CREATE INDEX IF NOT EXISTS idx_candidate_memory_anchor_kind
  ON candidate_memory (namespace, anchor_kind, created_at)
  WHERE unit_kind = 'exchange' AND reviewed_at IS NULL;
