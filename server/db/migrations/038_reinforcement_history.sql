-- Migration 038: candidate_reinforcement -- the history table IS the reinforcement.
--
-- Spec: docs/dream-design.md:580-650 ("Design: the history table IS the
-- reinforcement", #398, runs in REM). This migration implements that section
-- literally; the column list below is the table in dream-design.md:588-603.
--
-- THE THING THIS REPLACES. An earlier draft of #398 proposed adding +0.2 to a
-- candidate's confidence per duplicate. dream-design.md:559-578 rejects that,
-- and the reason is worth restating here because it is the whole shape of this
-- table: confidence answers "is this claim true?", reinforcement answers "how
-- well established is it?". One number cannot hold both, and arithmetic that
-- turns a 0.7 into a 0.9 because something was repeated is silently changing a
-- truth estimate using an evidence signal.
--
-- So a near-duplicate does NOT survive as its own candidate row, and it does
-- NOT modify the original. It writes one row here. Counting these rows is how
-- reinforcement is measured. Nothing is added to anything.
--
-- WHY THIS IS SAFE TO DO AUTONOMOUSLY, when almost nothing else in DREAM is:
-- the merge is reversible. dream-design.md:706-708 -- "if the threshold proves
-- too loose and distinct facts were merged, the history holds the hashes and
-- refs, the merge can be undone. Without it, a bad merge is permanent." That
-- reversibility is the licence. The dup's content is discarded (the text is the
-- redundant part) but its hash, its turns, and its time are all kept, which is
-- everything needed to re-extract it.
--
-- NOTHING IS COUNTED ONTO THE CANDIDATE ROW. dream-design.md:686 is explicit:
-- "Reinforcement count must never be denormalized onto the candidate row or
-- cached." The indexes below are what make that affordable -- (candidate_id,
-- dup_occurred_at DESC) yields the count, the first, and the last from one
-- index-only scan, so the number is recomputed every time and is therefore
-- never stale. A cached count is the staleness class of bug this whole epic
-- exists to remove.
--
-- TIME COMES FROM THE TURN, NEVER FROM now(). dup_occurred_at is the duplicate
-- turn's occurred_at. #396 makes that a hard constraint: a backfill keyed on
-- write time would collapse months of history onto the import moment, and the
-- SPAN between first-said and last-said is itself the evidence that defends an
-- old well-supported claim against a bare new one (dream-design.md:619-629).
-- created_at is separate and is the merge time -- the two answer different
-- questions and must not be conflated.

CREATE TABLE IF NOT EXISTS candidate_reinforcement (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Namespace isolation, as on every other table. Also what makes the
  -- reverse-lookup index below answerable without a join.
  namespace TEXT NOT NULL,

  -- What was reinforced. CASCADE because a reinforcement row has no meaning
  -- without its candidate: it is not an independent observation, it is an
  -- annotation on one. (Contrast candidate_memory.distill_job_id, which is SET
  -- NULL because losing the job must not destroy the candidate.)
  candidate_id UUID NOT NULL
    REFERENCES candidate_memory(id) ON DELETE CASCADE,

  -- Which restatement was absorbed. The hash, not the text: the text is the
  -- redundant part, and keeping it would make this table as large as the thing
  -- it is compressing. The hash is enough to find the turns again.
  dup_content_hash TEXT NOT NULL,

  -- When the duplicate was SAID -- the source turn's occurred_at. Never the
  -- merge time; see the module note.
  dup_occurred_at TIMESTAMPTZ NOT NULL,

  -- Which turns said it. Non-empty by constraint for the same reason
  -- candidate_memory.source_turn_ids is: a reinforcement with no source cannot
  -- be audited and cannot be undone, which defeats the reversibility that
  -- licenses the merge in the first place.
  dup_source_turn_ids UUID[] NOT NULL,

  -- How close the match was, as cosine DISTANCE (0 = identical), matching what
  -- pgvector's <=> returns so no conversion happens between the query and the
  -- row. Recorded per-row rather than assumed from a constant because the
  -- threshold is expected to move, and a fitted threshold can only be audited
  -- against the distances that were actually accepted (dream-design.md:712).
  similarity REAL,

  -- Which extractor produced the duplicate. Grades and merges from different
  -- models are not comparable, and a model swap must not look like the corpus
  -- changing.
  model TEXT,

  -- When the merge happened. Distinct from dup_occurred_at on purpose.
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT candidate_reinforcement_source_turns_check
    CHECK (cardinality(dup_source_turn_ids) > 0),

  -- Cosine distance is bounded [0, 2]. A value outside that is a unit error
  -- (similarity written where distance was meant), which would silently invert
  -- every later audit of the threshold.
  CONSTRAINT candidate_reinforcement_similarity_range
    CHECK (similarity IS NULL OR (similarity >= 0 AND similarity <= 2))
);

-- Primary access path: count and span the reinforcements for one candidate.
-- Covering (candidate_id, dup_occurred_at) so count, first, and last all come
-- from the index without touching the heap -- this is what makes recomputing
-- the count every time cheaper than caching it.
CREATE INDEX IF NOT EXISTS idx_candidate_reinforcement_candidate
  ON candidate_reinforcement (candidate_id, dup_occurred_at DESC);

-- Idempotency, and it is correctness rather than speed: reprocessing a batch
-- after a retry must not inflate reinforcement. ON CONFLICT DO NOTHING against
-- this index is the guard, not application logic -- the same pattern raw turns
-- already use for (namespace, session_ref, content_hash).
CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_reinforcement_dedupe
  ON candidate_reinforcement (candidate_id, dup_content_hash);

-- Reverse lookup: "which candidate absorbed this hash?" -- the unmerge and
-- audit path, and the reason a bad threshold is recoverable.
CREATE INDEX IF NOT EXISTS idx_candidate_reinforcement_hash
  ON candidate_reinforcement (namespace, dup_content_hash);

COMMENT ON TABLE candidate_reinforcement IS
  'One row per absorbed near-duplicate (#398). COUNTING THESE ROWS IS THE '
  'REINFORCEMENT MEASURE -- nothing is added to any confidence number, and the '
  'count must never be denormalized onto candidate_memory '
  '(docs/dream-design.md:686). Holds hash + turns + time so a bad merge can be '
  'undone; the duplicate text itself is discarded as the redundant part.';

COMMENT ON COLUMN candidate_reinforcement.dup_occurred_at IS
  'When the duplicate was SAID (source turn occurred_at), never the merge time. '
  '#396 hard constraint: the span between first-said and last-said is the '
  'evidence that defends an old claim against a bare new one.';

COMMENT ON COLUMN candidate_reinforcement.similarity IS
  'Cosine DISTANCE (0 = identical), as returned by pgvector <=>. Stored per row '
  'so a future fitted threshold can be audited against the distances actually '
  'accepted, rather than assumed from whatever the constant was that day.';
