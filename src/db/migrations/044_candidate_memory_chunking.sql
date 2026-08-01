-- Migration 044: an over-length exchange SPLITS across rows; it is never cut.
--
-- THE DEFECT THIS FIXES, measured on the live dogfood clone 2026-07-28:
--
--   exchanges | carrying '[N further turn(s) omitted for length]'
--        963  |  154
--
-- 154 exchanges dropped 1,579 turns between them. src/distill-exchange.ts:517
-- counts the loss into the text and moves on, so the row is honest about being
-- incomplete -- and the turns are still gone from the graded corpus.
--
-- WHY A BIGGER MAX_CANDIDATE_CHARS IS NOT THE FIX. That was tried first, and the
-- operator rejected it (2026-07-28): "so let it call the provider that is the
-- fucking point and the reason it exists. It's there so if something's too big
-- it can split it up over multiple entries properly. That's the whole reason why
-- I set it up that way." Raising a cap moves the cliff; it does not remove it,
-- and 032's embedding guard (src/embedding.ts:265) still refuses anything over
-- 32,000 chars by returning null WITHOUT calling the provider -- which writes a
-- candidate with no embedding, invisible to dedupe and to semantic search. A cap
-- high enough to stop truncating is a cap high enough to start silently
-- un-embedding.
--
-- #192 settled the shape and rejected the alternative in advance: decompose into
-- "smaller, independently-retrievable entries with [[links]] back to the
-- original... instead of bolting on a retrieval-time compression mode." #247
-- owns the implementation. src/decomposition.ts + src/chunking.ts are that
-- mechanism, already written, already tested. This migration gives
-- candidate_memory the two columns it needs to be a target for it.
--
-- THE LESSON FROM 011_chunking.sql, WHICH THIS DELIBERATELY DOES NOT REPEAT.
-- That migration declared thoughts.parent_id as a real FK with a real partial
-- index -- and src/tools/decompose-entry.ts bound a literal `null` to it while
-- populating chunk_index correctly beside it. Every chunk recorded that it was
-- Nth of something and never recorded of what. Lineage lived only in the
-- promoted_from JSON, which is not joinable, so no read path could reassemble a
-- decomposed entry and none was ever written. The unit test asserted the column
-- was null, encoding the defect as the contract, and idx_thoughts_parent_id
-- indexed zero rows while reporting healthy. A declared relation that is never
-- populated is worse than a missing one: it typechecks, satisfies every
-- constraint, and returns an empty result set that reads as "no chunks" rather
-- than "broken link". Fixed 2026-07-28. Whatever writes these two columns must
-- be proven by a test that FAILS when the parent link is null.

ALTER TABLE candidate_memory
  -- The first part of a split exchange. NULL means "this row is whole, or it is
  -- itself the first part" -- the same convention 011_chunking.sql uses for
  -- thoughts, so a reader that understands one understands the other.
  --
  -- ON DELETE CASCADE: the parts of one exchange are one interaction. Deleting
  -- the head without its tail would leave orphan fragments that render as
  -- mid-conversation text with no operator turn above them -- the exact defect
  -- 041 exists to fix, reintroduced by a dangling reference.
  ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES candidate_memory(id) ON DELETE CASCADE,

  -- Position within the split, 0-based. NULL for an unsplit row so "was this
  -- ever split?" is answerable without joining: chunk_index IS NULL means no.
  ADD COLUMN IF NOT EXISTS chunk_index INTEGER;

-- A part cannot be its own parent. Cheap to state, and a self-reference would
-- make the reassembly query below recurse forever.
ALTER TABLE candidate_memory
  DROP CONSTRAINT IF EXISTS candidate_memory_parent_not_self;

ALTER TABLE candidate_memory
  ADD CONSTRAINT candidate_memory_parent_not_self
  CHECK (parent_id IS NULL OR parent_id <> id);

-- The two columns travel together. A row with a parent and no position cannot be
-- ordered within its exchange; a row with a position and no parent is the
-- 011_chunking defect verbatim -- knowing it is Nth of something without
-- recording of what. Only the head is allowed both-null, and it is identified by
-- being the row other parts point AT.
ALTER TABLE candidate_memory
  DROP CONSTRAINT IF EXISTS candidate_memory_chunk_pair;

ALTER TABLE candidate_memory
  ADD CONSTRAINT candidate_memory_chunk_pair
  CHECK ((parent_id IS NULL) = (chunk_index IS NULL));

-- Reassembly: "give me every part of this exchange, in order."
--
-- This is the query the whole migration exists to make possible, and the reason
-- the columns are relational rather than another JSON blob. Column order matches
-- it exactly so the planner can walk the index for the sort instead of sorting
-- after the fetch.
CREATE INDEX IF NOT EXISTS idx_candidate_memory_parts
  ON candidate_memory (parent_id, chunk_index)
  WHERE parent_id IS NOT NULL;

-- THE QUEUE MUST NOT SHOW PARTS AS SEPARATE ITEMS.
--
-- 041:43-44 fixed the unit: "the judgement being collected is about an
-- INTERACTION -- operator ask, then what the agent did about it -- and one grade
-- should carry the whole thing." A 4-part exchange appearing as 4 rows in the
-- review queue would undo exactly that, asking for four grades on one
-- conversation and making the disagreement metric meaningless.
--
-- So the queue index excludes parts. The head carries the grade; the parts carry
-- the content, and are read by following parent_id. Partial on `parent_id IS
-- NULL` in addition to 041's `reviewed_at IS NULL`, mirroring
-- idx_candidate_memory_exchange_first's key order so it can serve the same sort.
CREATE INDEX IF NOT EXISTS idx_candidate_memory_queue_heads
  ON candidate_memory (
    namespace,
    (unit_kind <> 'exchange'),
    (anchor_turn_id IS NULL),
    uncertain DESC,
    created_at,
    id
  )
  WHERE reviewed_at IS NULL AND parent_id IS NULL;

COMMENT ON COLUMN candidate_memory.parent_id IS
  'The head row of a split exchange. NULL for an unsplit row or for the head '
  'itself. Populated by the exchange extractor when one exchange exceeds the '
  'candidate size bound -- an over-length exchange splits across rows and is '
  'never truncated. Must actually be written: see 011_chunking.sql, where the '
  'equivalent column was declared and then bound to null for months.';

COMMENT ON COLUMN candidate_memory.chunk_index IS
  '0-based position within a split exchange, NULL when the row is not a part. '
  'Ordering key for reassembly via idx_candidate_memory_parts.';
