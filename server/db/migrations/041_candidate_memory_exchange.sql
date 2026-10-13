-- Migration 041: the extraction unit is an EXCHANGE, headed by the operator.
--
-- THE DEFECT THIS FIXES, measured on the live dogfood clone 2026-07-28 by
-- joining candidate_memory to the turn its source_turn_ids[1] names:
--
--   candidate_type | from operator turn | from agent turn
--   decision       |        166         |       0
--   correction     |         90         |     235
--   fact           |          0         |     612
--   preference     |          1         |       0
--
-- 612 of 1,104 candidates are agent `fact` rows and NOT ONE of them traces to an
-- operator turn. The operator's 272 turns produced 167 candidates between them.
-- The distiller anchored on the wrong speaker.
--
-- WHY THAT IS A GRADING DEFECT AND NOT A TUNING KNOB. The operator hit it live
-- on the review page. The graded sentence was the AGENT's "Drizzle isn't a
-- dependency and there's no config -- planned, not in progress", while the
-- operator's own turn -- "I can't decide whether the DreamEngine curation logic
-- should move to TypeScript now or wait until after drizzle..." -- sat in the
-- context panel, ungraded. Grading the agent's middle sentence asks the operator
-- to judge a fragment of his own conversation: the claim is real, but it is not
-- the unit anyone decided anything in, so a grade on it says nothing about
-- whether the exchange was worth keeping.
--
-- The cause is structural, in src/distiller.ts + src/distill-window.ts: one
-- candidate per SPEECH TURN, and 3,615 of 3,887 turns are the agent's. A
-- per-turn unit therefore cannot help but be dominated by the agent, whatever
-- the classification rules say. No amount of retuning CORRECTION_RE or
-- RESULT_RE changes the ratio, because the ratio is the corpus shape.
--
-- THE OPERATOR'S INSTRUCTION, verbatim and authoritative (2026-07-28):
--   "my part of the conversation should be the first thing, anything below that
--    can be agent response and maybe tool calls to get there"
--   "if I say my interaction is a yes, the surrounding agent calls should almost
--    always auto go in"
--   "then the decision is are they there a good interaction and things to keep
--    doing, or i'm pissed and the agent did the wrong thing and don't do that"
--   "for now they all go into at least the REM session. with light sleeps adding
--    things like categories, counts, direct metadata, the REM doing a first
--    pass, then that is why i grade"
--
-- So the judgement being collected is about an INTERACTION -- operator ask, then
-- what the agent did about it -- and one grade should carry the whole thing.
-- That makes the unit the exchange, and the anchor the operator's turn.
--
-- WHAT AN EXCHANGE IS: one operator turn (is_human_prompt = true), plus every
-- turn following it in the same session_ref in order, up to but excluding the
-- next operator turn. Measured over the live corpus with exactly that cut: 272
-- operator-anchored exchanges and 17 orphan units, mean 13.4 turns, max 208.
--
-- THIS MIGRATION IS PURELY ADDITIVE. Nothing is dropped, and the existing 1,104
-- rows are not deleted -- the operator has already graded 8 of them in one
-- batch, and those grades are real data about the rule-based extractor. They are
-- backfilled to unit_kind='fragment' so the two populations stay distinguishable
-- and every existing grade keeps meaning exactly what it meant when it was made.
-- Comparing fragment grades against exchange grades is the measurement that says
-- whether re-cutting the unit actually helped.

ALTER TABLE candidate_memory
  -- Which SHAPE of unit produced this row. 'fragment' is the per-speech-turn
  -- unit the original distiller cut; 'exchange' is the operator-anchored one.
  -- NOT NULL with a 'fragment' default so the backfill below is the whole
  -- migration for existing rows and no row is ever left unclassified -- an
  -- unclassified unit_kind would silently mix the two populations back
  -- together, which is the one thing this column exists to prevent.
  ADD COLUMN IF NOT EXISTS unit_kind TEXT NOT NULL DEFAULT 'fragment',

  -- The operator turn that HEADS this exchange. NULL is meaningful and is not
  -- "unknown": it means no operator turn heads this unit -- either a fragment
  -- (which has no head at all) or an orphan exchange, the agent turns that
  -- appear before the first operator turn of a session. Measured 2026-07-28: 10
  -- of 32 sessions open with agent turns, and 7 sessions contain no operator
  -- turn whatsoever. Those 17 units are captured rather than dropped, per the
  -- governing "let everything pass" decision (037), and rank below anchored
  -- ones because nobody asked for them.
  ADD COLUMN IF NOT EXISTS anchor_turn_id UUID REFERENCES ob_raw_turns(id) ON DELETE SET NULL,

  -- The operator's verbatim words, stored SEPARATELY from content.
  --
  -- Denormalized on purpose, against the usual instinct. The review page must be
  -- able to LEAD with the operator's own sentence, and the alternative is
  -- re-deriving it at read time from source_turn_ids -- which means a join back
  -- to ob_raw_turns plus re-applying whatever rendering the distiller used, on
  -- every page load, in code that would inevitably drift from the extractor's.
  -- Worse, it would break the moment a source turn is archived out of the live
  -- tier, leaving a candidate whose head cannot be reconstructed. This column is
  -- a copy of already-redacted text (032 redacts before the row reaches disk),
  -- so it carries no new content-safety surface.
  ADD COLUMN IF NOT EXISTS operator_text TEXT;

-- One vocabulary, enforced in one place. A typo'd unit_kind would quietly create
-- a third population that no query filters on and no index serves.
ALTER TABLE candidate_memory
  DROP CONSTRAINT IF EXISTS candidate_memory_unit_kind_check;

ALTER TABLE candidate_memory
  ADD CONSTRAINT candidate_memory_unit_kind_check
  CHECK (unit_kind IN ('exchange', 'fragment'));

-- A fragment never has an anchor: it is one speech turn, with no head/body
-- structure to anchor. Constraining it stops the exchange writer's columns from
-- being half-applied to a fragment row, which would make the queue ordering
-- below rank a fragment as though an operator had asked for it.
ALTER TABLE candidate_memory
  DROP CONSTRAINT IF EXISTS candidate_memory_fragment_no_anchor;

ALTER TABLE candidate_memory
  ADD CONSTRAINT candidate_memory_fragment_no_anchor
  CHECK (unit_kind <> 'fragment' OR anchor_turn_id IS NULL);

-- An anchored exchange MUST carry the operator's words. The anchor is the
-- operator turn, so a row claiming one while holding no operator_text has lost
-- exactly the thing the re-cut exists to preserve, and would render on the page
-- as an agent fragment again -- the defect, reintroduced silently.
ALTER TABLE candidate_memory
  DROP CONSTRAINT IF EXISTS candidate_memory_anchor_has_text;

ALTER TABLE candidate_memory
  ADD CONSTRAINT candidate_memory_anchor_has_text
  CHECK (anchor_turn_id IS NULL OR btrim(coalesce(operator_text, '')) <> '');

-- Backfill: everything that already exists is a fragment. Explicit rather than
-- relying on the column default alone, because the default only applies to rows
-- the ALTER rewrote -- being explicit makes the intent auditable and makes the
-- statement safe to re-run.
UPDATE candidate_memory
   SET unit_kind = 'fragment'
 WHERE unit_kind IS NULL OR unit_kind <> 'exchange';

-- THE QUEUE INDEX: "operator-anchored, ungraded, newest first."
--
-- Column order mirrors the ORDER BY in fetchQueue (src/candidate-review.ts)
-- exactly, because an index whose order differs from the query's is an index the
-- planner will not use for the sort. Partial on `reviewed_at IS NULL` for the
-- same reason idx_candidate_memory_unreviewed is (033:140-144): the queue only
-- ever scans ungraded rows, so the index stays small as grades accumulate.
--
-- THE LEADING KEY IS THE EXPRESSION `(unit_kind <> 'exchange')`, NOT
-- `unit_kind DESC`. Writing it as a plain column sort was tried first and was
-- wrong in the wrong direction: 'f' sorts AFTER 'e', so DESC put fragments at
-- the top -- verified against the live clone, where the first page came back as
-- five fragments with no operator_text at all, which is the exact defect this
-- migration exists to fix, reintroduced by a collation assumption. A boolean
-- expression states the intent ("exchange first") and cannot be silently
-- inverted by the alphabet or by adding a third unit_kind later.
--
-- `(anchor_turn_id IS NULL)` is the second key so orphan exchanges rank below
-- anchored ones -- still gradeable, just not ahead of what the operator asked
-- for. Both are expression keys, so this stays a straight b-tree the planner
-- can walk for the sort.
CREATE INDEX IF NOT EXISTS idx_candidate_memory_exchange_first
  ON candidate_memory (
    namespace,
    (unit_kind <> 'exchange'),
    (anchor_turn_id IS NULL),
    uncertain DESC,
    created_at,
    id
  )
  WHERE reviewed_at IS NULL;

-- Reverse lookup: "which exchange did this operator turn head?" The provenance
-- question that source_turn_ids' GIN index answers for body turns, answered for
-- the head specifically -- and it is the head that identifies the exchange.
CREATE INDEX IF NOT EXISTS idx_candidate_memory_anchor
  ON candidate_memory (anchor_turn_id)
  WHERE anchor_turn_id IS NOT NULL;

COMMENT ON COLUMN candidate_memory.unit_kind IS
  'Which shape of extraction unit produced this row. ''exchange'' is the '
  'operator-anchored unit (one operator turn plus the agent turns answering it); '
  '''fragment'' is the original per-speech-turn unit. Kept distinguishable so the '
  '8 grades already made against fragments stay meaningful and the two '
  'populations can be compared rather than silently merged.';

COMMENT ON COLUMN candidate_memory.anchor_turn_id IS
  'The operator turn heading this exchange. NULL means no operator turn heads '
  'the unit -- a fragment, or an orphan exchange (agent turns before the first '
  'operator turn of a session). Captured, never dropped, but ranked below '
  'anchored units because nobody asked for them.';

COMMENT ON COLUMN candidate_memory.operator_text IS
  'The operator''s verbatim words, denormalized so the review page can lead with '
  'them without re-deriving from source_turn_ids on every load. Already redacted '
  'at source (032), so it adds no content-safety surface.';
