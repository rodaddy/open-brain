/**
 * Owns the statements the context-pack and conversation-facts tools execute.
 *
 * It exists so those tool files hold no SQL text: each takes this port instead
 * of reaching for a pool (issue 1209). Design authority:
 * `_plans/463-server-rewrite-charter.md:111` gives server/db the repositories,
 * and :117-119 reserves raw SQL for them.
 *
 * The statements, each named by a token that appears in it alone:
 *   1. selectGuidanceRows ..... `candidate_confidence`
 *   2. runSectionQuery ........ the pass-through the section readers share
 *   3. selectLaneEvents ....... `JOIN ob_session_lanes l ON e.lane_id = l.id`
 *   4. lockDuplicateEvent ..... `FOR UPDATE`
 *   5. mergeEventEvidence ..... `additional_evidence`
 *
 * The SQL moved verbatim, placeholders and parameter order unchanged.
 *
 * `runSectionQuery` is the one member that takes SQL from its caller. It is the
 * pass-through `server/tools/context-pack-loaders.ts` built inline, and it stays
 * a pass-through here because a section reader outside this lane's scope
 * (`context-pack-repo-facts.ts`) still owns its own statement text. Moving the
 * `.query(` call without also claiming that statement is deliberate: it keeps
 * the driver call in server/db now, and leaves that reader's SQL for its own
 * lane rather than relocating text this lane did not read.
 */
import type { QuerySurface } from "./transaction.ts";

/** The row shape every section pass-through and the guidance read project. */
export type SectionRow = Record<string, unknown>;

/**
 * What this repository actually needs to run a statement.
 *
 * A `pg.Pool` and a `pg.PoolClient` satisfy it through `QuerySurface`; so does
 * the narrowed `Queryable` the conversation-facts contract already accepts, so
 * a caller inside someone else's transaction can build the port over the client
 * it was handed without widening its own parameter to a driver type.
 */
export type ContextPackQuerySurface =
  | QuerySurface
  | {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: SectionRow[] }>;
    };

/** Run one statement over either accepted surface. */
async function runStatement(
  db: ContextPackQuerySurface,
  sql: string,
  params?: unknown[],
): Promise<{ rows: SectionRow[] }> {
  const result = await (
    db.query as (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>
  )(sql, params);
  return { rows: result.rows as SectionRow[] };
}

export interface ContextPackRepository {
  /**
   * Every lifecycle event for one namespace and candidate type, newest first.
   * Ordering is `created_at DESC, id DESC` so supersession reconciliation
   * downstream sees the most recent decision for a scope key first.
   */
  selectGuidanceRows(input: {
    namespace: string;
    candidateType: string;
  }): Promise<{ rows: SectionRow[] }>;

  /** Run one caller-supplied section statement. See the module header. */
  runSectionQuery(input: {
    sql: string;
    params?: unknown[];
  }): Promise<{ rows: SectionRow[] }>;

  /**
   * One lane's events, newest last, joined to their lane so each row carries
   * the lane's own namespace and agent -- the lane is what the namespace
   * predicate binds to, because events hold no namespace of their own.
   */
  selectLaneEvents(input: {
    namespace: string;
    sessionKey: string;
    scanLimit: number;
  }): Promise<{ rows: SectionRow[] }>;

  /**
   * The stored row conflicting on `(lane_id, content_hash)`, locked
   * `FOR UPDATE` because the caller's merge is a read-modify-write.
   */
  lockDuplicateEvent(input: {
    laneId: string;
    eventContentHash: string;
  }): Promise<{ rows: SectionRow[] }>;

  /** Replace one event's `metadata.additional_evidence` array. */
  mergeEventEvidence(input: { eventId: string; evidenceJson: string }): Promise<void>;

  /**
   * The lane matching all seven scope coordinates exactly, for conversation-fact
   * ingestion. `thread_id` uses IS NOT DISTINCT FROM so a null thread matches
   * ONLY unthreaded lanes.
   */
  selectScopedLane(input: {
    namespace: string;
    sessionKey: string;
    agent: string;
    platform: string;
    serverId: string;
    channelId: string;
    threadId: string | null | undefined;
  }): Promise<{ rows: SectionRow[] }>;

  /**
   * Insert one distilled unit, or return no row when the lane already holds
   * this content hash (`ON CONFLICT ... DO NOTHING`).
   */
  insertConversationFactEvent(input: {
    values: unknown[];
  }): Promise<{ rows: SectionRow[] }>;

  /**
   * The context-pack lane row for an exact seven-coordinate scope, with the
   * checkpoint (`current_context_md`) the pack renders.
   */
  selectContextPackLane(input: {
    scopeParams: unknown[];
  }): Promise<{ rows: SectionRow[] }>;

  /**
   * Every event in one lane, newest-first, re-binding all seven coordinates on
   * the join so a lane_id alone can never widen scope.
   */
  selectContextPackLaneEvents(input: {
    laneId: unknown;
    scopeParams: unknown[];
  }): Promise<{ rows: SectionRow[] }>;
}

/**
 * Bind by LANE namespace — the isolation boundary for session events. The
 * candidate_type discriminator is an explicit typed metadata field, not a
 * content match. promote/relegate/discard are all pulled so supersession is
 * reconciled deterministically in-process.
 */
const GUIDANCE_ROWS_SQL = `SELECT e.id,
              e.content,
              e.created_at,
              e.metadata->>'memory_lifecycle_action' AS memory_lifecycle_action,
              e.metadata->>'candidate_type' AS candidate_type,
              e.metadata->>'candidate_reason' AS candidate_reason,
              (e.metadata->>'candidate_confidence')::float8 AS candidate_confidence,
              e.metadata->'candidate_scope' AS candidate_scope
         FROM ob_session_events e
         JOIN ob_session_lanes l ON l.id = e.lane_id
        WHERE l.namespace = $1
          AND e.metadata->>'candidate_type' = $2
          AND e.metadata->>'memory_lifecycle_action' IN ('promote', 'relegate', 'discard')
        ORDER BY e.created_at DESC, e.id DESC`;

const LANE_EVENTS_SQL = `SELECT e.id, e.lane_id, l.namespace, l.agent, l.session_key,
            e.event_type, e.content, e.importance, e.content_hash,
            e.created_at, e.metadata
       FROM ob_session_events e
       JOIN ob_session_lanes l ON e.lane_id = l.id
      WHERE l.namespace = $1 AND l.session_key = $2
      ORDER BY e.created_at ASC, e.id ASC
      LIMIT $3`;

const LOCK_DUPLICATE_EVENT_SQL = `SELECT id, event_type, metadata FROM ob_session_events
      WHERE lane_id = $1 AND content_hash = $2
      FOR UPDATE`;

const MERGE_EVENT_EVIDENCE_SQL = `UPDATE ob_session_events
        SET metadata = jsonb_set(
              COALESCE(metadata, '{}'::jsonb),
              '{additional_evidence}',
              $2::jsonb,
              true
            )
      WHERE id = $1`;

const SCOPED_LANE_SQL = `SELECT id, status FROM ob_session_lanes
      WHERE namespace = $1
        AND session_key = $2
        AND agent = $3
        AND source = $4
        AND metadata->>'server_id' = $5
        AND channel_id = $6
        AND thread_id IS NOT DISTINCT FROM $7::text`;

const INSERT_CONVERSATION_FACT_EVENT_SQL = `INSERT INTO ob_session_events
       (lane_id, event_type, content, source, importance, metadata,
        embedding, content_hash, embedded_at, embedding_model, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)
     ON CONFLICT (lane_id, content_hash) WHERE content_hash IS NOT NULL
       DO NOTHING
     RETURNING id`;

const CONTEXT_PACK_LANE_SQL = `SELECT id, session_key, status, agent, source, channel_id, thread_id,
              project, topic, current_context_md, updated_at
         FROM ob_session_lanes
        WHERE namespace = $1
          AND session_key = $2
          AND agent = $3
          AND source = $4
          AND metadata->>'server_id' = $5
          AND channel_id = $6
          AND thread_id IS NOT DISTINCT FROM $7::text`;

// Every event in the lane, newest-first. No row ceiling: the caller asked for
// this lane's durable context, and a partial answer that reports itself as
// complete is the silent-zero failure `docs/GOTCHAS.md` names. The join
// re-binds all seven coordinates so a lane_id alone can never widen scope.
const CONTEXT_PACK_LANE_EVENTS_SQL = `SELECT e.id, e.event_type, e.content, e.source, e.importance,
              e.artifact_path, e.transcript_ref, e.occurred_at, e.created_at
         FROM ob_session_events e
         JOIN ob_session_lanes l ON l.id = e.lane_id
        WHERE e.lane_id = $1
          AND l.namespace = $2
          AND l.session_key = $3
          AND l.agent = $4
          AND l.source = $5
          AND l.metadata->>'server_id' = $6
          AND l.channel_id = $7
          AND l.thread_id IS NOT DISTINCT FROM $8::text
        ORDER BY e.created_at DESC, e.id DESC`;

/**
 * Build the port over any query surface -- a pool outside a transaction, or a
 * checked-out client inside one.
 */
export function createContextPackRepository(
  db: ContextPackQuerySurface,
): ContextPackRepository {
  return {
    async selectGuidanceRows(input) {
      return await runStatement(db, GUIDANCE_ROWS_SQL, [
        input.namespace,
        input.candidateType,
      ]);
    },

    async runSectionQuery(input) {
      return await runStatement(db, input.sql, input.params);
    },

    async selectLaneEvents(input) {
      return await runStatement(db, LANE_EVENTS_SQL, [
        input.namespace,
        input.sessionKey,
        input.scanLimit,
      ]);
    },

    async lockDuplicateEvent(input) {
      return await runStatement(db, LOCK_DUPLICATE_EVENT_SQL, [
        input.laneId,
        input.eventContentHash,
      ]);
    },

    async mergeEventEvidence(input) {
      await runStatement(db, MERGE_EVENT_EVIDENCE_SQL, [
        input.eventId,
        input.evidenceJson,
      ]);
    },

    async selectScopedLane(input) {
      return await runStatement(db, SCOPED_LANE_SQL, [
        input.namespace,
        input.sessionKey,
        input.agent,
        input.platform,
        input.serverId,
        input.channelId,
        input.threadId,
      ]);
    },

    async insertConversationFactEvent(input) {
      return await runStatement(db, INSERT_CONVERSATION_FACT_EVENT_SQL, input.values);
    },

    async selectContextPackLane(input) {
      return await runStatement(db, CONTEXT_PACK_LANE_SQL, input.scopeParams);
    },

    async selectContextPackLaneEvents(input) {
      return await runStatement(db, CONTEXT_PACK_LANE_EVENTS_SQL, [
        input.laneId,
        ...input.scopeParams,
      ]);
    },
  };
}
