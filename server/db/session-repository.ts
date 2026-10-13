/**
 * Owns every SQL statement the session and lane tools used to execute inline.
 *
 * It exists so the session tier holds no SQL text: `session-lifecycle.ts`,
 * `session-events.ts`, `session-save-load.ts`, `session-wrap-scope.ts`,
 * `lanes.ts`, and `citation-recall.ts` take this port instead of a Pool
 * (issue 1209). Design authority:
 * `_plans/463-server-rewrite-charter.md` reserves raw SQL for server/db
 * repositories, and tools call a repository rather than the driver.
 *
 * Every method takes ONE object argument (D3, issue 1184 comment 17408). The
 * statements, placeholders, parameter order, and the field lists interpolated
 * into them are moved verbatim from the tool files.
 */
import type { QuerySurface } from "./transaction.ts";

/** A lane row as the session tools read it: field list chosen by the caller. */
export type LaneRecord = Record<string, unknown>;

/** One session event as `citation_recall` projects it, with its lane. */
export interface CitationEventRow {
  id: string;
  event_type: string;
  content: string;
  source: string | null;
  transcript_ref: string | null;
  transcript: string | null;
  occurred_at: string | Date | null;
  created_at: string | Date;
  created_by: string;
  lane_id: string;
  session_key: string;
}

/** The narrow lane projection `session_event` reads. */
export interface EventLaneRow {
  id: unknown;
  status: unknown;
}

export interface SessionRepository {
  /** Read the most recent events on a lane, newest first. */
  selectRecentLaneEvents(input: {
    eventFields: string;
    laneId: unknown;
  }): Promise<unknown[]>;

  /** Read the lane a `session_start` names, in the caller's field list. */
  selectLaneBySessionKey(input: {
    fields: string;
    namespace: string;
    sessionKey: string;
  }): Promise<LaneRecord | undefined>;

  /** Create the lane a `session_start` asked for when none existed yet. */
  insertStartLane(input: {
    fields: string;
    values: unknown[];
  }): Promise<LaneRecord | undefined>;

  /** Read lanes matching a prepared `session_context` filter, newest first. */
  selectLanesByFilter(input: {
    fields: string;
    conditions: string[];
    values: unknown[];
  }): Promise<LaneRecord[]>;

  /** Read lane events matching a prepared `session_context` filter. */
  selectLaneEventsByFilter(input: {
    eventFields: string;
    conditions: string[];
    values: unknown[];
  }): Promise<unknown[]>;

  /** Insert the durable `session_wrap` row; empty when it deduplicated away. */
  insertWrapSession(input: {
    values: unknown[];
  }): Promise<Record<string, unknown> | undefined>;

  /** Point the lane's current context at this checkpoint, leaving it active. */
  updateLaneContext(input: { values: unknown[] }): Promise<void>;

  /** Count the events already on a lane. */
  countLaneEvents(input: { laneId: unknown }): Promise<Record<string, unknown>>;

  /** Read the narrow lane projection `session_event` resolves against. */
  selectEventLane(input: {
    namespace: string;
    sessionKey: string;
  }): Promise<EventLaneRow | undefined>;

  /** Create the lane a `session_event` opted into; empty on conflict. */
  insertEventLane(input: { values: unknown[] }): Promise<EventLaneRow | undefined>;

  /** Insert the event row; empty when the idempotency target swallowed it. */
  insertSessionEvent(input: {
    values: unknown[];
  }): Promise<{ id: unknown; created_at: unknown } | undefined>;

  /** Upsert the `session_save` row, keyed on (namespace, session_id). */
  upsertSavedSession(input: { values: unknown[] }): Promise<Record<string, unknown>>;

  /** Read the `session_load` projection under the caller's namespace clause. */
  selectSavedSessions(input: {
    projectClause: string;
    namespaceClause: string;
    values: unknown[];
  }): Promise<Record<string, unknown>[]>;

  /** Run the frozen `lane_upsert` merge statement. */
  upsertLane(input: { values: unknown[] }): Promise<Record<string, unknown>>;

  /** Read lanes matching a prepared `lane_load` predicate, newest first. */
  selectLanesByPredicate(input: {
    fields: string;
    conditions: string[];
    values: unknown[];
  }): Promise<Record<string, unknown>[]>;

  /**
   * Fill in the exact-scope coordinates of a lane from a `session_wrap` that
   * supplies all of them. One-way fill: each COALESCE only populates a NULL.
   */
  establishWrapScope(input: {
    wrapLaneColumns: string;
    values: unknown[];
  }): Promise<LaneRecord | undefined>;

  /**
   * Fill in the exact-scope coordinates of an EXISTING lane from a
   * `session_start` that supplies all of them (#646).
   */
  establishStartScope(input: {
    returningFields: string;
    values: unknown[];
  }): Promise<LaneRecord | undefined>;

  /** Read the wrap lane projection a `session_wrap` names. */
  selectWrapLane(input: {
    wrapLaneColumns: string;
    namespace: string;
    sessionKey: string;
  }): Promise<LaneRecord | undefined>;

  /**
   * Fetch the cited event under lane-derived namespace scope.
   *
   * The lane join IS the isolation predicate: `l.namespace = $1` is what stops
   * an event UUID from another lane resolving here.
   */
  selectCitedEvent(input: {
    namespace: string;
    eventId: string;
  }): Promise<CitationEventRow | undefined>;

  /** Read the exchanges one side of a cited event, within its transcript. */
  selectCitationNeighbors(input: {
    laneId: string;
    transcriptRef: string | null;
    eventId: string;
    limitPlusOne: number;
    side: "before" | "after";
  }): Promise<CitationEventRow[]>;
}

/** The frozen `lane_upsert` merge; a merge, never a replace (#162). */
const LANE_UPSERT_SQL = `INSERT INTO ob_session_lanes
           (session_key, namespace, status, agent, source, channel_id, thread_id,
            project, topic, current_context_md, metadata, embedding, content_hash,
            embedded_at, embedding_model, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16)
         ON CONFLICT (namespace, session_key)
         DO UPDATE SET status = COALESCE(EXCLUDED.status, ob_session_lanes.status),
           agent = COALESCE(EXCLUDED.agent, ob_session_lanes.agent),
           source = COALESCE(EXCLUDED.source, ob_session_lanes.source),
           channel_id = COALESCE(EXCLUDED.channel_id, ob_session_lanes.channel_id),
           thread_id = COALESCE(EXCLUDED.thread_id, ob_session_lanes.thread_id),
           project = COALESCE(EXCLUDED.project, ob_session_lanes.project),
           topic = COALESCE(EXCLUDED.topic, ob_session_lanes.topic),
           current_context_md = COALESCE(EXCLUDED.current_context_md, ob_session_lanes.current_context_md),
           metadata = ob_session_lanes.metadata || EXCLUDED.metadata,
           embedding = COALESCE(EXCLUDED.embedding, ob_session_lanes.embedding),
           content_hash = COALESCE(EXCLUDED.content_hash, ob_session_lanes.content_hash),
           embedded_at = COALESCE(EXCLUDED.embedded_at, ob_session_lanes.embedded_at),
           embedding_model = COALESCE(EXCLUDED.embedding_model, ob_session_lanes.embedding_model)
         RETURNING id, (xmax = 0) AS is_new, status, updated_at`;

/** The statements the session lifecycle and event tools execute. */
function sessionStatements(
  db: QuerySurface,
): Pick<
  SessionRepository,
  | "selectRecentLaneEvents"
  | "selectLaneBySessionKey"
  | "insertStartLane"
  | "selectLanesByFilter"
  | "selectLaneEventsByFilter"
  | "insertWrapSession"
  | "updateLaneContext"
  | "countLaneEvents"
> {
  return {
    async selectRecentLaneEvents({ eventFields, laneId }) {
      const events = await db.query(
        `SELECT ${eventFields} FROM ob_session_events
            WHERE lane_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [laneId],
      );
      return events.rows;
    },

    async selectLaneBySessionKey({ fields, namespace, sessionKey }) {
      const existing = await db.query(
        `SELECT ${fields} FROM ob_session_lanes
          WHERE namespace = $1 AND session_key = $2`,
        [namespace, sessionKey],
      );
      return existing.rows[0];
    },

    async insertStartLane({ fields, values }) {
      const inserted = await db.query(
        `INSERT INTO ob_session_lanes
           (session_key, namespace, status, agent, source, project, channel_id,
            thread_id, topic, metadata, created_by)
         VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
         RETURNING ${fields}`,
        values,
      );
      return inserted.rows[0];
    },

    async selectLanesByFilter({ fields, conditions, values }) {
      const lanes = await db.query(
        `SELECT ${fields} FROM ob_session_lanes
          WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC`,
        values,
      );
      return lanes.rows;
    },

    async selectLaneEventsByFilter({ eventFields, conditions, values }) {
      const events = await db.query(
        `SELECT ${eventFields} FROM ob_session_events
            WHERE ${conditions.join(" AND ")}
            ORDER BY created_at DESC LIMIT $2`,
        values,
      );
      return events.rows;
    },

    async insertWrapSession({ values }) {
      const sessions = await db.query(
        `INSERT INTO sessions
           (summary, key_decisions, next_steps, project, namespace, embedding,
            content_hash, embedded_at, embedding_model, created_by, source_refs)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
         ON CONFLICT (content_hash, namespace) WHERE content_hash IS NOT NULL DO NOTHING
         RETURNING id, created_at, source_refs`,
        values,
      );
      return sessions.rows[0];
    },

    async updateLaneContext({ values }) {
      await db.query(
        `UPDATE ob_session_lanes
            SET current_context_md = $2, embedding = $3, content_hash = $4,
                embedded_at = $5, embedding_model = $6
          WHERE id = $1 AND namespace = $7 AND session_key = $8`,
        values,
      );
    },

    async countLaneEvents({ laneId }) {
      const events = await db.query(
        "SELECT count(*)::int AS cnt FROM ob_session_events WHERE lane_id = $1",
        [laneId],
      );
      return events.rows[0];
    },
  };
}

/** The statements the `session_event` tool executes. */
function eventStatements(
  db: QuerySurface,
): Pick<
  SessionRepository,
  "selectEventLane" | "insertEventLane" | "insertSessionEvent"
> {
  return {
    async selectEventLane({ namespace, sessionKey }) {
      const lanes = await db.query(
        `SELECT id, status FROM ob_session_lanes
          WHERE namespace = $1 AND session_key = $2`,
        [namespace, sessionKey],
      );
      return lanes.rows[0];
    },

    async insertEventLane({ values }) {
      const created = await db.query(
        `INSERT INTO ob_session_lanes
             (session_key, namespace, status, agent, source, channel_id, thread_id,
              project, topic, metadata, created_by)
           VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
           ON CONFLICT (namespace, session_key) DO NOTHING
           RETURNING id, status`,
        values,
      );
      return created.rows[0];
    },

    async insertSessionEvent({ values }) {
      const events = await db.query(
        `INSERT INTO ob_session_events
           (lane_id, event_type, content, source, artifact_path, transcript_ref,
            transcript, occurred_at, importance, metadata, embedding, content_hash,
            embedded_at, embedding_model, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15)
         ON CONFLICT (lane_id, content_hash) WHERE content_hash IS NOT NULL DO NOTHING
         RETURNING id, created_at`,
        values,
      );
      return events.rows[0];
    },
  };
}

/** The statements the session save/load and lane tools execute. */
function savedSessionStatements(
  db: QuerySurface,
): Pick<
  SessionRepository,
  "upsertSavedSession" | "selectSavedSessions" | "upsertLane" | "selectLanesByPredicate"
> {
  return {
    async upsertSavedSession({ values }) {
      const rows = await db.query(
        `INSERT INTO sessions
       (session_id, project, summary, tags, blockers, next_steps, key_decisions,
        created_by, namespace, embedding, content_hash, embedded_at, embedding_model)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (namespace, session_id) WHERE session_id IS NOT NULL
     DO UPDATE SET summary = EXCLUDED.summary, tags = EXCLUDED.tags,
       blockers = EXCLUDED.blockers, next_steps = EXCLUDED.next_steps,
       key_decisions = EXCLUDED.key_decisions, embedding = EXCLUDED.embedding,
       content_hash = EXCLUDED.content_hash, embedded_at = EXCLUDED.embedded_at,
       embedding_model = EXCLUDED.embedding_model, updated_at = NOW()
     RETURNING id, (xmax = 0) AS is_new`,
        values,
      );
      return rows.rows[0];
    },

    async selectSavedSessions({ projectClause, namespaceClause, values }) {
      const rows = await db.query(
        `SELECT id, project, summary, tags, blockers, next_steps, key_decisions,
            created_by, created_at
       FROM sessions
      WHERE archived_at IS NULL${projectClause}${namespaceClause}
      ORDER BY created_at DESC`,
        values,
      );
      return rows.rows;
    },

    async upsertLane({ values }) {
      const rows = await db.query(LANE_UPSERT_SQL, values);
      return rows.rows[0];
    },

    async selectLanesByPredicate({ fields, conditions, values }) {
      const rows = await db.query(
        `SELECT ${fields} FROM ob_session_lanes
          WHERE ${conditions.join(" AND ")}
          ORDER BY updated_at DESC`,
        values,
      );
      return rows.rows;
    },
  };
}

/** The exact-scope statements `session_start` and `session_wrap` share. */
function scopeStatements(
  db: QuerySurface,
): Pick<
  SessionRepository,
  "establishWrapScope" | "establishStartScope" | "selectWrapLane"
> {
  return {
    async establishWrapScope({ wrapLaneColumns, values }) {
      const { rows } = await db.query(
        `UPDATE ob_session_lanes
        SET agent = COALESCE(agent, $4),
            source = COALESCE(source, $5),
            metadata = CASE
              WHEN metadata->>'server_id' IS NOT NULL THEN metadata
              ELSE jsonb_set(COALESCE(metadata, '{}'::jsonb), '{server_id}', to_jsonb($6::text), true)
            END,
            channel_id = COALESCE(channel_id, $7),
            thread_id = CASE
              WHEN $8::text IS NOT NULL AND thread_id IS NULL THEN $8
              ELSE thread_id
            END
      WHERE id = $1
        AND namespace = $2
        AND session_key = $3
        AND (agent IS NULL OR agent = $4)
        AND (source IS NULL OR source = $5)
        AND (metadata->>'server_id' IS NULL OR metadata->>'server_id' = $6)
        AND (channel_id IS NULL OR channel_id = $7)
        AND (
          ($8::text IS NULL AND thread_id IS NULL)
          OR (
            $8::text IS NOT NULL
            AND (
              thread_id = $8
              OR (
                thread_id IS NULL
                AND NOT (
                  agent IS NOT NULL
                  AND source IS NOT NULL
                  AND metadata->>'server_id' IS NOT NULL
                  AND channel_id IS NOT NULL
                )
              )
            )
          )
        )
    RETURNING ${wrapLaneColumns}`,
        values,
      );
      return rows[0] as LaneRecord | undefined;
    },

    async establishStartScope({ returningFields, values }) {
      const { rows } = await db.query(
        `UPDATE ob_session_lanes
        SET agent = COALESCE(agent, $3),
            source = COALESCE(source, $4),
            metadata = CASE
              WHEN metadata->>'server_id' IS NOT NULL THEN metadata
              ELSE jsonb_set(COALESCE(metadata, '{}'::jsonb), '{server_id}', to_jsonb($5::text), true)
            END,
            channel_id = COALESCE(channel_id, $6),
            thread_id = CASE
              WHEN $7::text IS NOT NULL AND thread_id IS NULL THEN $7
              ELSE thread_id
            END
      WHERE namespace = $1
        AND session_key = $2
        AND (agent IS NULL OR agent = $3)
        AND (source IS NULL OR source = $4)
        AND (metadata->>'server_id' IS NULL OR metadata->>'server_id' = $5)
        AND (channel_id IS NULL OR channel_id = $6)
        AND ($7::text IS NULL OR thread_id IS NULL OR thread_id = $7)
    RETURNING ${returningFields}`,
        values,
      );
      return rows[0] as LaneRecord | undefined;
    },

    async selectWrapLane({ wrapLaneColumns, namespace, sessionKey }) {
      const { rows } = await db.query(
        `SELECT ${wrapLaneColumns}
       FROM ob_session_lanes
      WHERE namespace = $1 AND session_key = $2`,
        [namespace, sessionKey],
      );
      return rows[0] as LaneRecord | undefined;
    },
  };
}

const TARGET_EVENT_COLUMNS = `e.id, e.event_type, e.content, e.source, e.transcript_ref,
  e.transcript, e.occurred_at, e.created_at, e.created_by`;
const CANDIDATE_EVENT_COLUMNS = `candidate.id, candidate.event_type, candidate.content,
  candidate.source, candidate.transcript_ref, candidate.transcript,
  candidate.occurred_at, candidate.created_at, candidate.created_by`;

const CITATION_ASCENDING =
  "COALESCE(candidate.occurred_at, candidate.created_at), candidate.created_at, candidate.id";
const CITATION_DESCENDING =
  "COALESCE(candidate.occurred_at, candidate.created_at) DESC, " +
  "candidate.created_at DESC, candidate.id DESC";
// Ordering by the row tuple rather than the timestamp alone keeps
// same-instant events in one stable order, so `before` and `after`
// cannot both claim the same neighbor.
const CITATION_CONTEXT_SOURCE = `FROM ob_session_events candidate
             JOIN ob_session_events target ON target.id = $3::uuid
            WHERE candidate.lane_id = $1
              AND candidate.transcript_ref = $2
              AND candidate.transcript IS NOT NULL`;

/** The `citation_recall` statements: the cited event and its neighbors. */
function citationStatements(
  db: QuerySurface,
): Pick<SessionRepository, "selectCitedEvent" | "selectCitationNeighbors"> {
  return {
    async selectCitedEvent({ namespace, eventId }) {
      const { rows } = await db.query(
        `SELECT ${TARGET_EVENT_COLUMNS}, e.lane_id, l.session_key
             FROM ob_session_events e
             JOIN ob_session_lanes l ON l.id = e.lane_id
            WHERE l.namespace = $1 AND e.id = $2`,
        [namespace, eventId],
      );
      return rows[0] as CitationEventRow | undefined;
    },

    async selectCitationNeighbors({
      laneId,
      transcriptRef,
      eventId,
      limitPlusOne,
      side,
    }) {
      const values = [laneId, transcriptRef, eventId, limitPlusOne];
      const comparison = side === "before" ? "<" : ">";
      const ordering =
        side === "before" ? CITATION_DESCENDING : `${CITATION_ASCENDING} ASC`;
      const { rows } = await db.query(
        `SELECT ${CANDIDATE_EVENT_COLUMNS}
             ${CITATION_CONTEXT_SOURCE}
              AND (${CITATION_ASCENDING}) ${comparison} (
                COALESCE(target.occurred_at, target.created_at), target.created_at, target.id
              )
            ORDER BY ${ordering}
            LIMIT $4`,
        values,
      );
      return rows as CitationEventRow[];
    },
  };
}

export function createSessionRepository(db: QuerySurface): SessionRepository {
  return {
    ...sessionStatements(db),
    ...eventStatements(db),
    ...savedSessionStatements(db),
    ...scopeStatements(db),
    ...citationStatements(db),
  };
}
