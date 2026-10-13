-- Tier moves: the append-only history of every tier change (#1469, State 4,
-- `_plans/1469-dream-route.md` item 5).
--
-- Today a tier is a single mutable column. `tiering-repository.ts:195`
-- (`setTier`), `tier-mutations.ts:246` (`bulk_set_tier`), and
-- `dream-rem-repository.ts:92` (`warmProjectCluster`) each UPDATE it in place,
-- so the previous value is gone the moment it changes and nothing records WHY
-- it changed. The DREAM router is about to become a fourth writer, and a
-- router whose moves cannot be read back afterwards cannot be evaluated.
--
-- This migration creates the table only. Wiring the four writers is a
-- separate change: an empty history table is inert, a half-wired one is a
-- history that lies by omission.
--
-- APPEND-ONLY BY CONSTRUCTION. There is no updated_at and no archived_at,
-- because a move is a fact about a moment and a fact about a moment does not
-- change. Nothing here grants an UPDATE or DELETE path; a correction is a new
-- row, exactly as the rest of this schema treats history.
--
-- Rollback (nothing reads the table until the writers land):
--   DROP TABLE IF EXISTS tier_moves;

CREATE TABLE IF NOT EXISTS tier_moves (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The entry that moved. No foreign key: the entry lives in one of several
  -- resource tables (thoughts, decisions, relationships, projects, sessions),
  -- which is precisely what `source_table` names, and Postgres cannot point
  -- one column at five parents. The three existing writers already address an
  -- entry the same way -- a UUID `id` plus the table name they interpolate --
  -- so this pair is the shape that is already in use, not a new one.
  entry_id        UUID NOT NULL,
  source_table    TEXT NOT NULL,

  -- Tiers are TEXT with the ('hot','warm','cold') CHECK on the resource
  -- tables (006_cognitive_tiering.sql:6-10). This table deliberately does NOT
  -- repeat that CHECK: history records what happened, including a value a
  -- later migration retires, and a CHECK here would make old rows
  -- unrestorable after such a change. `from_tier` is nullable because a
  -- writer may not have read the prior value.
  from_tier       TEXT,
  to_tier         TEXT NOT NULL,

  -- Why the move happened -- the free-text reason code the writer supplies
  -- (for example the router, a stale scan, a warm pass). Indexed, so it is
  -- the column a reader groups by when asking which mechanism is moving
  -- things.
  cause           TEXT NOT NULL,

  -- The DREAM routing run this move belongs to, when a routing run caused it.
  -- Nullable, and no foreign key: the three existing writers move tiers with
  -- no routing run at all, and `routing_decisions` (plan item 4) is not in
  -- the schema yet.
  routing_run_id  UUID,

  moved_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "What happened to this entry, newest first" -- the per-entry timeline.
CREATE INDEX IF NOT EXISTS idx_tier_moves_entry_moved_at
  ON tier_moves (entry_id, moved_at DESC);

-- "What moved in this window" -- the fleet-wide timeline, and the access path
-- for any retention or reporting sweep.
CREATE INDEX IF NOT EXISTS idx_tier_moves_moved_at
  ON tier_moves (moved_at DESC);

-- "Which mechanism is moving things" -- the evaluation question the router
-- exists to answer.
CREATE INDEX IF NOT EXISTS idx_tier_moves_cause
  ON tier_moves (cause);
