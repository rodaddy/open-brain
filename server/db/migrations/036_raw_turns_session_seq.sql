-- Migration 036: ob_raw_turns.session_seq -- a turn_index the server owns.
--
-- THE BUG. 032_raw_turns.sql:91 declares turn_index as "monotonic position
-- within the sending session". It is not. Measured 2026-07-28 across the whole
-- dogfood corpus: every session, regardless of size, carries turn_index 0..7
-- and nothing else. A 994-row session has 8 distinct values. A 163-row session
-- has 8. Within one session, index 0 spans 2026-07-27 00:23 to 2026-07-28
-- 01:05 -- a full day at the "first" position.
--
-- The counter is per HOOK INVOCATION, not per session. Each capture ships its
-- turns numbered from zero, so the column reports position-within-batch and the
-- per-session ordering the schema promises was never written. Row counts by
-- index decay 65/55/55/55/51/51/49/45 -- the shape of variable-size batches,
-- not of a conversation.
--
-- WHY THE SERVER MUST OWN IT. 032_raw_turns.sql:68 already names the hazard:
-- turn_index is "something the client has to synthesize". A client cannot
-- synthesize a session-global sequence correctly -- it sees one batch, may
-- retry, may resume, and several runtimes write the same session. Every client
-- would have to reimplement it and agree. The server sees the whole session, so
-- the invariant belongs here. This is the same reasoning that put distillation
-- server-side in the full-send design: the client is a dumb pipe.
--
-- WHY A NEW COLUMN INSTEAD OF FIXING turn_index IN PLACE. turn_index is
-- NOT NULL and client-supplied on every insert. Redefining its meaning would
-- silently change what existing readers get, and there is no way to tell a
-- correct client value from a broken one after the fact. session_seq is
-- unambiguous: server-assigned or NULL, never a guess. turn_index stays as the
-- client's own record of what it thought it sent, which is worth keeping when
-- diagnosing a client.
--
-- ORDERING SOURCE. (session_ref, occurred_at) is a perfect total order on the
-- live corpus: 3,638 turns, 3,638 distinct (session_ref, occurred_at) pairs,
-- zero collisions and zero ties. So the sequence is recoverable exactly, and
-- the backfill below is not an approximation. id breaks any future tie
-- deterministically.
--
-- NOT A REPLACEMENT FOR parent_turn_uuid. The reply chain is the graph;
-- session_seq is a line. Both are needed -- 24% of parent links currently
-- dangle (881 of 3,626), so the linear order is the only intact ordering signal
-- the corpus has today. That dangling-parent defect is separate and is NOT
-- addressed here.

ALTER TABLE ob_raw_turns
  ADD COLUMN IF NOT EXISTS session_seq INTEGER;

COMMENT ON COLUMN ob_raw_turns.session_seq IS
  'Server-assigned monotonic position within session_ref, ordered by '
  'occurred_at then id. This is the ordering key -- turn_index is the '
  'client-supplied value and is per-batch, not per-session (measured '
  '2026-07-28: every session carries only 0..7). NULL means not yet '
  'assigned; never infer order from turn_index.';

-- Backfill from the verified total order. Idempotent: recomputes every row
-- from scratch, so re-running after new inserts is safe and correct.
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

-- Reads are always "this session, in order" or "the next N after position X".
-- A plain btree on (session_ref, session_seq) serves both, and the partial
-- predicate keeps orphaned turns (no session_ref, which the schema allows) out
-- of an index that can never serve them.
CREATE INDEX IF NOT EXISTS idx_ob_raw_turns_session_seq
  ON ob_raw_turns (session_ref, session_seq)
  WHERE session_ref IS NOT NULL;
