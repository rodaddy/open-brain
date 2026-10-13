/**
 * Owns the two statements DISTILL's transactional write used to execute from
 * the maintenance tier: the candidate insert and the consumed-turn stamp.
 *
 * It exists so the maintenance tier holds no SQL text: server/maintenance/
 * distill-persist.ts takes this port instead of running the statements on a
 * PoolClient it was handed (issue 1209). Design authority:
 * `_plans/463-server-rewrite-charter.md` reserves raw SQL for server/db
 * repositories.
 */
import { toSql } from "pgvector/pg";
import type { QuerySurface } from "./transaction.ts";

/** The id of a candidate row the insert actually created. */
export interface InsertedCandidateRow {
  id?: unknown;
}

export interface DistillPersistRepository {
  /**
   * Insert one prepared candidate, returning the rows it created -- empty when
   * the (namespace, content_hash) dedupe fired.
   *
   * NOTE the columns that are ABSENT and must stay absent: review_action,
   * reviewed_at, graded_by, machine_grade. 037:43-57 -- a machine writing
   * review_action sets reviewed_at by constraint and silently removes the item
   * from the operator's queue. authority_tier is also left NULL: 033:70-73 says
   * NULL means unclassified and must never be defaulted to 'observed', because
   * defaulting an unknown to the weakest tier is a silent downgrade. Resolving it
   * is a provenance lookup for a later stage.
   */
  insertCandidate(values: {
    namespace: string;
    candidateType: string;
    content: string;
    contentHash: string;
    sourceTurnIds: readonly string[];
    distillJobId: string | null;
    model: string | null;
    embedding: number[] | null;
    uncertain: boolean;
    uncertaintyReason: string | null;
  }): Promise<InsertedCandidateRow[]>;

  /** Stamp the consumed turns as distilled, returning how many rows changed. */
  stampConsumedTurns(values: {
    consumedTurnIds: readonly string[];
    distillJobId: string | null;
  }): Promise<number>;
}

export function createDistillPersistRepository(
  db: QuerySurface,
): DistillPersistRepository {
  return {
    async insertCandidate(values) {
      const { rows } = await db.query<InsertedCandidateRow>(
        `INSERT INTO candidate_memory (
         namespace, candidate_type, content, content_hash, source_turn_ids,
         distill_job_id, model, embedding, uncertain, uncertainty_reason
       ) VALUES ($1, $2, $3, $4, $5::uuid[], $6, $7, $8, $9, $10)
       ON CONFLICT (namespace, content_hash) DO NOTHING
       RETURNING id`,
        [
          values.namespace,
          values.candidateType,
          values.content,
          values.contentHash,
          values.sourceTurnIds,
          values.distillJobId,
          values.model,
          values.embedding ? toSql(values.embedding) : null,
          values.uncertain,
          values.uncertaintyReason,
        ],
      );
      return rows;
    },

    async stampConsumedTurns(values) {
      const stamped = await db.query(
        `UPDATE ob_raw_turns
        SET distilled_at = now(),
            distill_job_id = COALESCE($2::uuid, distill_job_id)
      WHERE id = ANY($1::uuid[])
        AND distilled_at IS NULL`,
        [values.consumedTurnIds, values.distillJobId],
      );
      return stamped.rowCount ?? 0;
    },
  };
}
