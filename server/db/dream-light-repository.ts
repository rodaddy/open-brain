/**
 * The statements DREAM Light executes (issue 1209).
 *
 * `_plans/463-server-rewrite-charter.md:111` assigns server/db "pool lifecycle,
 * transactions, repositories, append-only migrations", so the SQL Light used to
 * run from server/maintenance lives here instead. Behaviour is unchanged: the
 * statement text and the comments attached to each one moved verbatim.
 *
 * The factory takes a QuerySurface rather than a Pool so the SAME repository is
 * built from `tx` inside the sweep's transaction and from the pool for the
 * read-only queue-depth report.
 */
import type { QuerySurface } from "./transaction.ts";
import type { SweepRow } from "../maintenance/dream-light-occurrences.ts";
import { MAX_SESSION_REFS } from "../maintenance/dream-light.ts";

/** The five scalar sub-selects the queue-depth report reads, as text. */
export interface LightQueueDepthRow {
  unswept: string;
  deferred_missing_timestamp: string;
  undistilled: string;
  occurrence_rows: string;
  corroborated_rows: string;
}

/** What one occurrence upsert returns. */
export interface OccurrenceUpsertRow {
  existed: boolean;
  session_bumped: boolean;
}

/** Every statement DREAM Light needs, one method per statement. */
export interface DreamLightRepository {
  claimUnsweptTurns(input: { batchSize: number }): Promise<SweepRow[]>;
  countDeferredMissingTimestamp(): Promise<number>;
  markSwept(input: { ids: string[] }): Promise<void>;
  readQueueDepth(input: { namespace?: string }): Promise<LightQueueDepthRow[]>;
  upsertOccurrence(input: {
    namespace: string;
    contentHash: string;
    sessionRef: string;
    sampleContent: string;
    occurredAt: Date;
  }): Promise<OccurrenceUpsertRow[]>;
}

export function createDreamLightRepository(db: QuerySurface): DreamLightRepository {
  return {
    async claimUnsweptTurns(input) {
      // FOR UPDATE SKIP LOCKED so two concurrent sweeps take disjoint batches
      // rather than serialising or double-counting. Same primitive the
      // maintenance queue uses to claim jobs (maintenance-queue.ts).
      const claimed = await db.query<SweepRow>(
        `SELECT id, namespace, content, content_hash, session_ref, role, occurred_at
         FROM ob_raw_turns
        WHERE light_swept_at IS NULL
          AND occurred_at IS NOT NULL
        ORDER BY occurred_at ASC
        LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [input.batchSize],
      );
      return claimed.rows;
    },

    async countDeferredMissingTimestamp() {
      const counted = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ob_raw_turns
          WHERE light_swept_at IS NULL AND occurred_at IS NULL`,
      );
      const first = counted.rows[0];
      if (!first) throw new Error("Light deferred-count query returned no row");
      return Number(first.count);
    },

    async markSwept(input) {
      await db.query(
        `UPDATE ob_raw_turns SET light_swept_at = now() WHERE id = ANY($1::uuid[])`,
        [input.ids],
      );
    },

    async readQueueDepth(input) {
      const q = await db.query<LightQueueDepthRow>(
        `SELECT
       (SELECT count(*) FROM ob_raw_turns
         WHERE light_swept_at IS NULL
           AND ($1::text IS NULL OR namespace = $1))::text AS unswept,
       (SELECT count(*) FROM ob_raw_turns
         WHERE light_swept_at IS NULL AND occurred_at IS NULL
           AND ($1::text IS NULL OR namespace = $1))::text AS deferred_missing_timestamp,
       (SELECT count(*) FROM ob_raw_turns
         WHERE distilled_at IS NULL
           AND ($1::text IS NULL OR namespace = $1))::text AS undistilled,
       (SELECT count(*) FROM content_occurrences
         WHERE ($1::text IS NULL OR namespace = $1))::text AS occurrence_rows,
       (SELECT count(*) FROM content_occurrences
         WHERE session_count > 1
           AND ($1::text IS NULL OR namespace = $1))::text AS corroborated_rows`,
        [input.namespace ?? null],
      );
      return q.rows;
    },

    async upsertOccurrence(input) {
      // The upsert. session_count increments ONLY when this session has not
      // already contributed — that condition is what makes the number
      // corroboration rather than repetition. occurred_at drives both
      // timestamps; first_seen_at never moves once set.
      // session_bumped MUST be computed from the PRE-update row
      // (`content_occurrences.session_refs`, the excluded-row alias inside DO
      // UPDATE), never from the returned row. Evaluating `session_refs @> $3`
      // in RETURNING reads the row AFTER the append, so the ref is always
      // present and the flag is always false — measured: the counter reported 0
      // corroborations on a sweep that produced a session_count of 3.
      const upserted = await db.query<OccurrenceUpsertRow>(
        `INSERT INTO content_occurrences (
       namespace, content_hash, occurrence_count, session_count,
       session_refs, sample_content, first_seen_at, last_seen_at, updated_at
     ) VALUES ($1, $2, 1, 1, $3, $4, $5, $5, now())
     ON CONFLICT (namespace, content_hash) DO UPDATE SET
       occurrence_count = content_occurrences.occurrence_count + 1,
       session_count = content_occurrences.session_count
         + CASE WHEN $6 <> '' AND NOT (content_occurrences.session_refs @> $3)
                THEN 1 ELSE 0 END,
       session_refs = CASE
         WHEN $6 <> '' AND NOT (content_occurrences.session_refs @> $3)
         THEN (content_occurrences.session_refs || $3)[1:${MAX_SESSION_REFS}]
         ELSE content_occurrences.session_refs
       END,
       last_seen_at = GREATEST(content_occurrences.last_seen_at, $5),
       first_seen_at = LEAST(content_occurrences.first_seen_at, $5),
       updated_at = now()
     RETURNING (xmax <> 0) AS existed,
               (xmax <> 0
                AND $6 <> ''
                AND NOT (content_occurrences.session_refs @> $3)) AS session_bumped`,
        [
          input.namespace,
          input.contentHash,
          input.sessionRef === "" ? [] : [input.sessionRef],
          input.sampleContent,
          input.occurredAt,
          input.sessionRef,
        ],
      );
      return upserted.rows;
    },
  };
}
