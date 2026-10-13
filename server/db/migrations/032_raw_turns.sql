-- Migration 032: Content-bearing raw turn table (Issue #380, INGEST-1)
--
-- Spec: docs/full-send-derivation-spec.md section 1.
--
-- Why this table exists: distillation and derivation are impossible because
-- their input does not exist. Measured 2026-07-24 on the local dogfood clone, a
-- full working day produced 3 ob_session_events, every one written because the
-- assistant manually chose to run a capture command. mcp_tool_audit_log
-- recorded 445 calls but is content-free by design (declared_parameter_keys,
-- payload_size_bucket, duration_ms; no content column), so it cannot serve as a
-- raw stream. Prompts and responses were persisted nowhere.
--
-- The client is a dumb pipe: it ships raw turns and decides nothing about
-- salience. All judgment (distillation, dedupe, supersession) is server-side,
-- asynchronous, and re-runnable against this table.
--
-- CONTENT SAFETY -- deliberate reversal, read before extending:
-- Unlike mcp_tool_audit_log, this table DOES store real dialogue content. That
-- reversal is the entire point (derivation is impossible without content) and
-- is justified only by its compensating controls:
--   1. Namespace isolation, applied exactly as on every other table.
--   2. Redaction at write, BEFORE the row reaches disk -- redaction is applied
--      by the server write path, never trusted from the client.
--   3. Mandatory retention bounding (INGEST-2 / #381), because unbounded raw
--      dialogue is a disk-exhaustion path.
-- redaction_applied records WHICH rule fired, never the removed value. The
-- standing rule is redact the VALUE, keep the STATEMENT: a turn is never
-- dropped for containing a credential, because "AUTH_TOKEN_X=[REDACTED]" is
-- itself a useful durable fact. Fail-closed was explicitly rejected.

CREATE TABLE IF NOT EXISTS ob_raw_turns (
  -- Surrogate key. Stable handle for foreign keys (distill_job_id and future
  -- derived tables point here); it does NOT enforce uniqueness of a turn --
  -- that is idx_ob_raw_turns_identity below. uuid rather than a serial to match
  -- every other table and keep cross-database merges collision-free.
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Exact isolation boundary, identical in meaning to every other table.
  namespace         TEXT NOT NULL,

  -- TURN IDENTITY. The runtime's own per-turn id (Claude Code's record `uuid`).
  -- Measured 2026-07-25 across 94,564 real turns in 515 transcripts: this value
  -- never covers two different contents, so it is a safe identity key. A
  -- runtime with no native per-turn id (Codex, the Python client) must
  -- synthesize a deterministic one -- hash(session_ref, turn_index,
  -- content_hash) -- because this column is NOT NULL and carries the dedupe.
  turn_uuid         TEXT NOT NULL,

  -- Reply chain. parent_turn_uuid is what makes the conversation a graph rather
  -- than a bag of rows, and it is the only field that survives batching,
  -- retries, and out-of-order spool replay intact. Nullable: the first turn of
  -- a session has no parent.
  parent_turn_uuid  TEXT,

  -- Continuity across a compaction or session boundary. The runtime already
  -- emits this and nothing has been reading it: at a compact the transcript
  -- writes a `compact_boundary` record whose `parentUuid` is NULL (which is why
  -- the chain LOOKS broken) but whose `logicalParentUuid` points at the last
  -- turn before the compact. Measured 2026-07-25: 22 boundaries, 0 unresolved,
  -- and one of them links into a DIFFERENT transcript file -- so the thread
  -- spans sessions, not just compactions within one. One session with fifteen
  -- compacts is already a linked list; this column is the join that walks it.
  -- Same target as parent_turn_uuid (a turn id), different edge type: normal
  -- reply vs. continuity across a context reset.
  logical_parent_turn_uuid TEXT,

  -- Native turn grouping: one human prompt and every record it produced share
  -- one prompt_id. Preferred over counting turn_index, which the client has to
  -- synthesize. Nullable -- it is absent on records that predate a prompt (e.g.
  -- resumed history), which is also why it is NOT part of the identity key.
  prompt_id         TEXT,

  -- Owning lane. Nullable: a turn can arrive before a lane is established, and
  -- losing the turn would defeat full-send. ON DELETE SET NULL keeps the
  -- content (still namespace-bound) rather than cascading a content delete from
  -- lane cleanup.
  lane_id           UUID REFERENCES ob_session_lanes(id) ON DELETE SET NULL,

  -- Opaque client-side session identifier (Claude Code's sessionId). Not a
  -- foreign key: it names a runtime session, not an OB row.
  session_ref       TEXT,

  -- Origin. repo is the meaningful path segment, NOT the last one: measured
  -- 2026-07-25, 22 project directories collide on their final segment ('wt'
  -- alone maps to three distinct worktrees), so a tail-truncated path would
  -- merge unrelated working trees. git_branch is provenance, not identity --
  -- a branch can be renamed or deleted while its turns keep the old value.
  repo              TEXT,
  git_branch        TEXT,

  -- Monotonic position within the sending session. Ordering only; NOT unique,
  -- and not part of the identity key.
  turn_index        INTEGER NOT NULL,

  -- Who produced the turn. 'tool' is first-class and NOT deferred: measured
  -- 2026-07-25, AskUserQuestion answers -- the densest decision content in the
  -- corpus, a question paired with an explicit human choice -- arrive as a
  -- tool_result block and are invisible to any user-text-only reader.
  role              TEXT NOT NULL
                    CHECK (role IN ('user', 'assistant', 'tool')),

  -- Declared human authorship (promptSource == 'typed' AND origin.kind ==
  -- 'human'), not inferred from content shape. This is the honest version of
  -- what a client-side "does this look pasted?" heuristic was guessing at.
  is_human_prompt   BOOLEAN NOT NULL DEFAULT false,

  -- The dialogue itself, redacted at write. Plain text, not JSON: this column
  -- feeds embedding and FTS, and JSON syntax would be lexed as content (braces,
  -- quotes, and key names becoming tokens). Structured payloads belong in
  -- metadata.
  content           TEXT NOT NULL,

  -- Structured, non-lexed provenance and payload (model, effort, token usage,
  -- stop_reason, permission mode, sidechain flag, and the verbatim
  -- AskUserQuestion answers/annotations object). Kept out of content so
  -- retrieval ranks on meaning, not on JSON punctuation.
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Opaque digest of the redacted content. Drift detection and change
  -- comparison only -- deliberately NOT the identity key: measured 2026-07-25,
  -- keying on content alone would merge 3,495 turns, and the overwhelming
  -- majority of exact content repeats are harness control strings
  -- ('[Request interrupted by user]' appears 270 times across 51 sessions).
  -- Those must be filtered at the writer and never ingested at all; collapsing
  -- them here would also destroy the reply chain, since each copy has a
  -- different parent.
  content_hash      TEXT NOT NULL,

  -- Real token counts when the runtime reports them (message.usage), not a
  -- heuristic estimate.
  token_estimate    INTEGER,
  runtime           TEXT,

  -- WHICH redaction rules fired, never the removed values.
  redaction_applied JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Distillation bookkeeping. NULL distilled_at is the sweep work queue.
  distilled_at      TIMESTAMPTZ,
  distill_job_id    UUID,

  created_by        TEXT NOT NULL,

  -- BI-TEMPORAL, borrowed from Graphiti (graphiti_core/edges.py:271-280,
  -- Apache-2.0 -- credit where taken). Four fields, not two: separating
  -- WORLD-time from KNOWLEDGE-time is what makes the believed-a-dead-fact
  -- window measurable. invalid_at is when reality changed; expired_at is when
  -- we found out; the gap between them IS the drift metric.
  --
  -- On raw turns specifically: a turn is an immutable event, so valid_at is
  -- effectively occurred_at and invalid_at/expired_at normally stay NULL. They
  -- are carried here anyway because a turn CAN be retracted -- measured
  -- 2026-07-25, two records written 12:52 were disproved by a retraction at
  -- 12:53, and with only created_at there is no way to express "this was
  -- believed true between these two instants" without deleting it. The fields
  -- earn their keep on the distilled layer; here they make retraction
  -- expressible instead of destructive.
  --
  -- occurred_at is Graphiti's reference_time: when the turn HAPPENED, tied to
  -- the source episode rather than write time. Full-send allows batching and
  -- spool replay, so a turn from 09:00 can land at 14:00; ordering by
  -- created_at would silently scramble the conversation.
  occurred_at       TIMESTAMPTZ,
  valid_at          TIMESTAMPTZ,
  invalid_at        TIMESTAMPTZ,
  expired_at        TIMESTAMPTZ,

  -- Retention tier. NEVER DELETE: 'live' is in recall, 'unused' is out of
  -- recall but still queryable, 'cold' means the CONTENT moved to hard storage
  -- while this row stays as the index. Cold archival is ~6 months, not weeks:
  -- the unused tier must outlive the phenomenon it exists to detect, and a
  -- two-week drift is invisible in a one-week window.
  retention_tier    TEXT NOT NULL DEFAULT 'live'
                    CHECK (retention_tier IN ('live', 'unused', 'cold')),

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- TURN IDENTITY / DEDUPE. An exact duplicate turn must never enter the table.
-- Resuming or forking a session makes the runtime copy prior history into the
-- new transcript: measured 2026-07-25, 961 turns exist verbatim in two
-- transcripts under one id. Keying on the turn's own id (not session_ref +
-- id) is what makes that re-send conflict and be ignored rather than stored
-- twice. Scoped to namespace so two namespaces never collide or resolve across
-- the boundary.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ob_raw_turns_identity
  ON ob_raw_turns (namespace, turn_uuid);

-- The sweep's work queue: undistilled LIVE turns, oldest first, within a
-- namespace. Retired turns are excluded here rather than by the caller, so a
-- sweep cannot accidentally re-distill archived content.
CREATE INDEX IF NOT EXISTS idx_ob_raw_turns_undistilled
  ON ob_raw_turns (namespace, created_at)
  WHERE distilled_at IS NULL AND retention_tier = 'live';

-- Retention drain: find what is eligible to move live -> unused -> cold.
CREATE INDEX IF NOT EXISTS idx_ob_raw_turns_retention
  ON ob_raw_turns (retention_tier, created_at);

-- Drift measurement: turns whose truth was retracted, and how long the wrong
-- belief was held (expired_at - invalid_at).
CREATE INDEX IF NOT EXISTS idx_ob_raw_turns_retracted
  ON ob_raw_turns (namespace, invalid_at)
  WHERE invalid_at IS NOT NULL;

-- Conversation reconstruction in real turn order, and retention scans
-- (INGEST-2 drops distilled turns older than a window).
CREATE INDEX IF NOT EXISTS idx_ob_raw_turns_session
  ON ob_raw_turns (namespace, session_ref, occurred_at);

-- Reply-chain walks: find the children of a turn.
CREATE INDEX IF NOT EXISTS idx_ob_raw_turns_parent
  ON ob_raw_turns (namespace, parent_turn_uuid)
  WHERE parent_turn_uuid IS NOT NULL;

-- Walk the conversation thread across compaction and session boundaries.
-- Measured 2026-07-25: one boundary reported cumulativeDroppedTokens
-- 1,316,157 -- that much context left the window, and all of it is
-- reconstructable through this link.
CREATE INDEX IF NOT EXISTS idx_ob_raw_turns_logical_parent
  ON ob_raw_turns (namespace, logical_parent_turn_uuid)
  WHERE logical_parent_turn_uuid IS NOT NULL;

-- Group every record produced by one human prompt.
CREATE INDEX IF NOT EXISTS idx_ob_raw_turns_prompt
  ON ob_raw_turns (namespace, prompt_id)
  WHERE prompt_id IS NOT NULL;
