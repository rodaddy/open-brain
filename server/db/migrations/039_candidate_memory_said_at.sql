-- Migration 039: candidate_memory said-at timestamps, and the session_seq gap.
--
-- TWO CHANGES, both about time. Neither adds a judgement column; both fix a
-- place where write time was standing in for source time, which #396 names as a
-- hard constraint (docs/dream-design.md:421-425, :522-527).
--
-- ============================================================================
-- 1. first_said_at / last_said_at on candidate_memory
-- ============================================================================
--
-- WHY created_at IS NOT ENOUGH. candidate_memory.created_at is when the
-- DISTILLER RAN. On this corpus that is one afternoon: all 1,104 candidates
-- produced 2026-07-28 from turns spanning 2026-07-25 to 2026-07-28. Ranking or
-- superseding on created_at would therefore treat a three-day-old decision and
-- a minute-old one as simultaneous -- exactly the backfill collapse 036 and
-- #396 both warn about, arriving through a different column.
--
-- WHAT THEY MEAN. dream-design.md:605-629, verbatim on the merge behaviour:
--
--     | confidence          | unchanged                                    |
--     | last-said timestamp | advance to the duplicate `occurred_at`       |
--     | first-said timestamp| unchanged                                    |
--
-- first_said_at is set once from the earliest source turn and NEVER moves.
-- last_said_at advances when a near-duplicate is absorbed (#398). The SPAN
-- between them is the support signal: "held for three months across twenty
-- restatements" is what defends an old claim against a bare new one, and
-- overwriting first_said_at would erase it.
--
-- WHY NOT DERIVE THEM FROM source_turn_ids EVERY TIME. first_said_at could be
-- computed by joining back to ob_raw_turns, but last_said_at could not: after a
-- merge, the duplicate's turns are in candidate_reinforcement, not in
-- source_turn_ids (dream-design.md:616-618 -- "source_refs: do not append,
-- refs go to the history table"). So last_said_at is genuinely new state. They
-- are added as a pair because a first with no last invites exactly the
-- created_at substitution this migration exists to remove.
--
-- THIS IS NOT A DENORMALIZED COUNT. dream-design.md:686 forbids caching the
-- reinforcement COUNT on the candidate row, and that prohibition still holds --
-- nothing here stores a count. A timestamp is different in kind: it is a
-- maximum over immutable source facts, monotonic, and it cannot silently
-- disagree with the history the way a count can, because a later merge only
-- ever moves it forward.
--
-- NULLABLE, DELIBERATELY. The 1,104 candidates already in this table were
-- written before these columns existed; the backfill below fills them from
-- their own source turns. A candidate whose source turns were later purged
-- keeps NULL rather than acquiring a fabricated time.

ALTER TABLE candidate_memory
  ADD COLUMN IF NOT EXISTS first_said_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_said_at TIMESTAMPTZ;

-- last_said_at can only move forward from first_said_at. A merge that moved it
-- backwards would mean a "duplicate" older than the original was absorbed as
-- the newer statement, which inverts the recency signal #396 reads.
ALTER TABLE candidate_memory
  DROP CONSTRAINT IF EXISTS candidate_memory_said_order;

ALTER TABLE candidate_memory
  ADD CONSTRAINT candidate_memory_said_order
  CHECK (
    first_said_at IS NULL
    OR last_said_at IS NULL
    OR last_said_at >= first_said_at
  );

-- Backfill from the source turns. Idempotent (recomputes from scratch, only
-- writes where the value differs) and correct on re-run after new inserts.
-- Only the MIN is used for both: before any merge has happened, a candidate has
-- been said exactly once, over the span of its own source turns.
WITH src AS (
  SELECT c.id,
         min(t.occurred_at) AS first_at,
         max(t.occurred_at) AS last_at
    FROM candidate_memory c
    JOIN ob_raw_turns t ON t.id = ANY (c.source_turn_ids)
   GROUP BY c.id
)
UPDATE candidate_memory c
   SET first_said_at = src.first_at,
       last_said_at  = GREATEST(COALESCE(c.last_said_at, src.last_at), src.last_at)
  FROM src
 WHERE c.id = src.id
   AND (c.first_said_at IS DISTINCT FROM src.first_at
        OR c.last_said_at IS NULL
        OR c.last_said_at < src.last_at);

-- Recency ranking reads last-said (dream-design.md:630). Without this the
-- review page's "newest first" ordering is a sequential scan over the whole
-- table, and the temptation becomes to order by created_at instead -- which is
-- the bug this migration removes.
CREATE INDEX IF NOT EXISTS idx_candidate_memory_last_said
  ON candidate_memory (namespace, last_said_at DESC);

COMMENT ON COLUMN candidate_memory.first_said_at IS
  'Earliest source-turn occurred_at. Set once, NEVER moved -- the span to '
  'last_said_at is the support signal #396 reads, and overwriting this erases '
  'it. Not created_at: that is when the distiller ran, which on a backfill is '
  'one afternoon for months of history.';

COMMENT ON COLUMN candidate_memory.last_said_at IS
  'Latest occurred_at across the source turns AND every absorbed near-duplicate '
  '(#398). Advances on merge; this is what recency ranking reads. Genuinely new '
  'state, not derivable from source_turn_ids, because a merged duplicate''s '
  'turns live in candidate_reinforcement rather than being appended here.';

-- ============================================================================
-- 2. Re-run the 036 session_seq backfill
-- ============================================================================
--
-- THE GAP, filed by the distiller build and re-measured here. 036 assigns
-- session_seq with a ONE-SHOT backfill. Nothing on the insert path
-- (src/tools/ingest-raw-turn.ts) assigns it, so every turn ingested after 036
-- ran carries NULL -- 59 of 3,795 when the distiller measured it on 2026-07-28,
-- and the number grows monotonically with every capture.
--
-- WHY A RE-RUN AND NOT A TRIGGER. A trigger is the real fix and it belongs on
-- the ingest path, which is a shared read-only file in this build's ownership
-- split -- so proposing one here would be inventing a write-path change under a
-- migration number. What this migration can do honestly is make the backfill
-- RE-RUNNABLE and run it once more, which is exactly what 036 already
-- documented itself as being ("Idempotent: recomputes every row from scratch,
-- so re-running after new inserts is safe and correct", 036:55-56). That
-- converts a permanent gap into a maintenance-visible one.
--
-- NOTHING DEPENDS ON THIS BEING COMPLETE. The distiller orders by
-- (session_ref, occurred_at, id) -- the expression 036:57-63 computes
-- session_seq FROM -- and re-measured it as a perfect total order (3,795 turns,
-- 3,795 distinct pairs, zero ties). So the NULL rows were distilled in the
-- right order regardless. This closes the reporting gap, it does not unblock
-- anything.

WITH ordered AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY session_ref
           ORDER BY occurred_at, id
         ) - 1 AS seq
  FROM ob_raw_turns
  WHERE session_ref IS NOT NULL
)
UPDATE ob_raw_turns t
   SET session_seq = o.seq
  FROM ordered o
 WHERE t.id = o.id
   AND t.session_seq IS DISTINCT FROM o.seq;
