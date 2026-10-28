/**
 * Owns the four statements EXCHANGE distillation used to execute from the
 * maintenance tier: the raw-turn window read, the candidate INSERT, the
 * unembedded-candidate read, and the embedding UPDATE.
 *
 * It exists so the maintenance tier holds no SQL text: server/maintenance/
 * distill-exchange-run.ts takes this port instead of running the statements on
 * its own Pool or PoolClient (issue 1209). Design authority:
 * `_plans/463-server-rewrite-charter.md` reserves raw SQL for server/db
 * repositories.
 *
 * The factory takes a QuerySurface, so the same code is built from the pool for
 * the reads outside a transaction and from the transaction client for the
 * sweep's write.
 */
import type { QuerySurface } from "./transaction.ts";
import { toSql } from "pgvector/pg";
import { DISTILL_ORDER_BY, type DistillTurn } from "../domain/distill-window.ts";
import type { PreparedExchangeCandidate } from "../maintenance/distill-exchange.ts";

/** One candidate row awaiting an embedding. */
export interface UnembeddedCandidateRow {
  id: string;
  namespace: string;
  content: string;
}

export interface DistillExchangeRepository {
  /** Live turns in canonical order, at most `maxTurns` of them. */
  readTurnWindow(values: {
    namespace?: string;
    maxTurns: number;
  }): Promise<DistillTurn[]>;

  /**
   * Insert one candidate row, or skip it on the (namespace, content_hash)
   * dedupe. Returns the row's id when it was written, and nothing when the
   * dedupe fired.
   */
  insertCandidate(values: {
    candidate: PreparedExchangeCandidate;
    vector: number[] | null;
    parentId: string | null;
  }): Promise<{ id: string }[]>;

  /** Exchange rows still carrying a NULL embedding, oldest first. */
  readUnembeddedCandidates(values: {
    namespace?: string;
    limit: number;
  }): Promise<UnembeddedCandidateRow[]>;

  /** Fill one row's embedding, if it is still NULL. */
  setCandidateEmbedding(values: {
    id: string;
    namespace: string;
    embedding: number[];
  }): Promise<void>;
}

export function createDistillExchangeRepository(
  db: QuerySurface,
): DistillExchangeRepository {
  return {
    /**
     * WHOLE SESSIONS, NOT A ROW LIMIT. An exchange is defined by where the NEXT
     * operator turn falls, so a cut mid-session would end the last exchange at
     * the page boundary instead of at the operator's next turn -- producing a
     * candidate whose body is arbitrarily truncated by pagination. Reading whole
     * sessions costs a larger read and buys a correct cut, the same trade
     * claimDistillBatch makes for its context window (distill-window.ts:180-190).
     *
     * retention_tier = 'live' excludes archived turns, matching the fragment
     * sweep.
     */
    async readTurnWindow(values) {
      const params: unknown[] = [];
      let nsPredicate = "";
      if (values.namespace !== undefined) {
        params.push(values.namespace);
        nsPredicate = ` AND namespace = $${params.length}`;
      }
      params.push(values.maxTurns);
      const turnLimit = `$${params.length}`;

      const { rows } = await db.query(
        `SELECT id, namespace, session_ref, session_seq, role, content, repo,
            occurred_at, is_human_prompt
       FROM ob_raw_turns
      WHERE retention_tier = 'live'${nsPredicate}
      ORDER BY ${DISTILL_ORDER_BY}
      LIMIT ${turnLimit}`,
        params,
      );

      return rows.map((r) => ({
        id: r.id as string,
        namespace: r.namespace as string,
        session_ref: (r.session_ref as string | null) ?? null,
        session_seq: (r.session_seq as number | null) ?? null,
        role: r.role as string,
        content: r.content as string,
        repo: (r.repo as string | null) ?? null,
        occurred_at: (r.occurred_at as Date | null) ?? null,
        is_human_prompt: Boolean(r.is_human_prompt),
      }));
    },

    /**
     * The INSERT names 041's three new columns alongside the existing ones. It
     * does NOT name review_action, reviewed_at, graded_by, machine_grade, or
     * authority_tier: the first four are the operator's and REM's (037:43-57),
     * and authority_tier stays NULL because 033:94-98 says NULL means
     * unclassified and defaulting an unknown to 'observed' is a silent
     * downgrade.
     */
    async insertCandidate(values) {
      const { candidate } = values;
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO candidate_memory (
       namespace, candidate_type, content, content_hash, source_turn_ids,
       model, embedding, uncertain, uncertainty_reason,
       unit_kind, anchor_turn_id, operator_text, anchor_kind,
       parent_id, chunk_index
     ) VALUES ($1, $2, $3, $4, $5::uuid[], $6, $7, $8, $9, $10, $11::uuid, $12, $13, $14::uuid, $15)
     ON CONFLICT (namespace, content_hash) DO NOTHING
     RETURNING id`,
        [
          candidate.namespace,
          candidate.candidate_type,
          candidate.content,
          candidate.content_hash,
          candidate.source_turn_ids,
          candidate.model,
          values.vector ? toSql(values.vector) : null,
          candidate.uncertain,
          candidate.uncertainty_reason ?? null,
          candidate.unit_kind,
          candidate.anchor_turn_id,
          candidate.operator_text,
          // 043. DO NOTHING on conflict means an existing row keeps whatever
          // anchor_kind it already has, which is correct: the row the operator
          // may have graded must not be silently relabelled underneath him.
          candidate.anchor_kind,
          // 044. Both null for a whole exchange or for the head of a split; both
          // set for a part. chunk_pair enforces they move together.
          values.parentId,
          candidate.chunk_index,
        ],
      );
      return rows;
    },

    async readUnembeddedCandidates(values) {
      const params: unknown[] = [];
      let nsPredicate = "";
      if (values.namespace !== undefined) {
        params.push(values.namespace);
        nsPredicate = ` AND namespace = $${params.length}`;
      }
      params.push(values.limit);

      const { rows } = await db.query<UnembeddedCandidateRow>(
        `SELECT id, namespace, content
       FROM candidate_memory
      WHERE unit_kind = 'exchange' AND embedding IS NULL${nsPredicate}
      ORDER BY created_at
      LIMIT $${params.length}`,
        params,
      );
      return rows;
    },

    // Namespace is carried into the predicate even though the id alone would
    // match: namespace is a security boundary here, and a predicate that relies
    // on the id being trusted is one refactor away from being wrong.
    async setCandidateEmbedding(values) {
      await db.query(
        `UPDATE candidate_memory
          SET embedding = $3
        WHERE id = $1 AND namespace = $2 AND embedding IS NULL`,
        [values.id, values.namespace, toSql(values.embedding)],
      );
    },
  };
}
