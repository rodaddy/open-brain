-- Migration 034: content_occurrences -- the corroboration signal (Issue #390, DREAM-1 Light)
--
-- Spec: docs/dream-design.md, "The load-bearing part: occurrence counting".
--
-- WHY THIS IS THE LOAD-BEARING PIECE. Verbatim from #390:
--
--   The occurrence count light maintains IS the corroboration signal that
--   promotion (#394) and supersession (#396) depend on. Things that actually
--   mattered get said more than once, across sessions. That is evidence the
--   model does not generate -- it just gets measured.
--
-- This is what makes automatic promotion possible WITHOUT trusting a small
-- model's self-assessment, which is already measured as unreliable: 112 of 214
-- candidates in the 2026-07-24 Qwen3.5-4B-4bit run were mislabelled
-- 'preference', including an OAuth redirect URI and a Caddyfile procedure.
-- A count is not an opinion.
--
-- WHY A SEPARATE TABLE, NOT A COLUMN ON ob_raw_turns. 032_raw_turns.sql:119-126
-- deliberately refuses to make content_hash an identity key, and that decision
-- stands:
--
--   keying on content alone would merge 3,495 turns, and the overwhelming
--   majority of exact content repeats are harness control strings
--   ('[Request interrupted by user]' appears 270 times across 51 sessions)
--   [...] collapsing them here would also destroy the reply chain, since each
--   copy has a different parent.
--
-- So turns stay one-row-per-turn and the count lives beside them. ON CONFLICT
-- DO UPDATE on this table cannot damage the reply chain because the chain is
-- not stored here.
--
-- WHAT COUNTS AS CORROBORATION. Repetition inside one session is a person
-- restating themselves; repetition ACROSS sessions is independent evidence.
-- Both are recorded, and they are recorded separately, because only the second
-- is corroboration. session_count is the column promotion should read;
-- occurrence_count alone would let one chatty session manufacture confidence.
--
-- Harness noise is EXCLUDED at the writer via isHarnessNoise()
-- (src/tools/ingest-raw-turn.ts) -- the same predicate the ingest path uses, so
-- the two can never disagree about what noise is. Counting harness strings
-- would make '[Request interrupted by user]' the single best-corroborated
-- "fact" in the system.

CREATE TABLE IF NOT EXISTS content_occurrences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Namespace isolation, as on every other table. Identical content in two
  -- namespaces is two independent observations, never one shared count.
  namespace TEXT NOT NULL,

  -- Digest of the redacted, normalized content. Identity key HERE (unlike on
  -- ob_raw_turns) because collapsing is the entire purpose of this table.
  content_hash TEXT NOT NULL,

  -- Total times this content has been observed. Includes repeats within a
  -- single session.
  occurrence_count INTEGER NOT NULL DEFAULT 1,

  -- Distinct sessions that produced this content. THIS is the corroboration
  -- signal; occurrence_count is not. One session repeating itself ten times is
  -- occurrence_count 10, session_count 1, and must not read as corroborated.
  session_count INTEGER NOT NULL DEFAULT 1,

  -- Bounded sample of contributing sessions, newest-first, capped by the
  -- writer. Enough to audit "which sessions said this?" without turning the
  -- row into an unbounded log.
  session_refs TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

  -- A readable sample of the content. NOT authoritative -- the turns are. This
  -- exists so an operator reading a count knows what was counted without
  -- joining back.
  sample_content TEXT NOT NULL,

  -- Source-time bounds, from the turn's occurred_at. NEVER write time: #396
  -- makes occurred_at a hard constraint for every recency judgment, and a
  -- backfill would otherwise collapse months of history onto the import
  -- moment. first_seen_at is set once and never moved.
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT content_occurrences_counts_positive
    CHECK (occurrence_count > 0 AND session_count > 0),

  -- session_count can never exceed occurrence_count: a session cannot
  -- contribute an observation without producing one. Catches double-increment
  -- bugs that would silently inflate corroboration.
  CONSTRAINT content_occurrences_session_le_occurrence
    CHECK (session_count <= occurrence_count),

  CONSTRAINT content_occurrences_time_order
    CHECK (last_seen_at >= first_seen_at),

  CONSTRAINT content_occurrences_sample_nonempty
    CHECK (btrim(sample_content) <> '')
);

-- The upsert target. Light's write is ON CONFLICT DO UPDATE against this.
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_occurrences_identity
  ON content_occurrences (namespace, content_hash);

-- "What is corroborated in this namespace?" -- promotion's read. Ordered by the
-- signal that actually matters, not by raw repetition.
CREATE INDEX IF NOT EXISTS idx_content_occurrences_corroborated
  ON content_occurrences (namespace, session_count DESC, last_seen_at DESC);

-- Partial index for the multi-session case, which is the only one promotion
-- cares about. Keeps the scan small as single-session rows accumulate -- and
-- they will dominate.
CREATE INDEX IF NOT EXISTS idx_content_occurrences_multi_session
  ON content_occurrences (namespace, last_seen_at DESC)
  WHERE session_count > 1;

COMMENT ON TABLE content_occurrences IS
  'Corroboration signal for promotion (#394) and supersession (#396). Counts how '
  'often content recurs and -- critically -- across how many DISTINCT sessions. '
  'Separate from ob_raw_turns because content_hash is deliberately not an identity '
  'key there (032_raw_turns.sql:119-126). Harness noise excluded at the writer.';

COMMENT ON COLUMN content_occurrences.session_count IS
  'THE corroboration signal. Read this, not occurrence_count: one session '
  'repeating itself is not independent evidence.';

COMMENT ON COLUMN content_occurrences.first_seen_at IS
  'From the turn occurred_at, never write time (#396 hard constraint). Set once.';
