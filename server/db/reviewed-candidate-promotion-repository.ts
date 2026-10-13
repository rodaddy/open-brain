/**
 * SQL port for the explicit reviewed-candidate promotion path.
 *
 * Candidate rows are proposals. This repository only exposes candidates whose
 * server-maintained review_action is the human label `promoted`, and the
 * durable write is an idempotent thought insert in the same namespace. REM's
 * machine_grade is intentionally not part of the promotion predicate.
 */
import type { QuerySurface } from "./transaction.ts";

export interface HumanPromotedCandidateRow {
  readonly id: string;
  readonly namespace: string;
  readonly candidate_type: string;
  readonly content: string;
  readonly content_hash: string;
  readonly source_turn_ids: string[];
  readonly distill_job_id: string | null;
  readonly model: string | null;
  readonly authority_tier: string | null;
  readonly embedding: string | null;
  readonly reviewed_at: Date | string | null;
  readonly review_action: "promoted";
  readonly graded_by: string | null;
}

export interface ExistingThoughtRow {
  readonly id: string;
  readonly archived_at: Date | string | null;
}

export interface InsertedThoughtRow {
  readonly id: string;
}

export interface ReviewedCandidatePromotionRepository {
  /** Read and lock one candidate only when the human review action is promoted. */
  findHumanPromotedCandidate(input: {
    candidateId: string;
    namespace: string;
  }): Promise<HumanPromotedCandidateRow | null>;

  /** Find a live or archived thought that already owns this namespace/hash. */
  findThoughtByHash(input: {
    contentHash: string;
    namespace: string;
  }): Promise<ExistingThoughtRow | null>;

  /** Insert the candidate as a thought, returning null for a hash duplicate. */
  insertThought(input: {
    content: string;
    tags: readonly string[];
    createdBy: string;
    namespace: string;
    embedding: string | null;
    contentHash: string;
    sourceRefs: string;
    promotedFrom: string;
    /** Defaults to 'dream-reviewed-candidate'. */
    source?: string;
    /** Absent means the column default, 'warm'. */
    tier?: string;
  }): Promise<InsertedThoughtRow | null>;
}

export function createReviewedCandidatePromotionRepository(
  db: QuerySurface,
): ReviewedCandidatePromotionRepository {
  return {
    async findHumanPromotedCandidate({ candidateId, namespace }) {
      const { rows } = await db.query<HumanPromotedCandidateRow>(
        `SELECT c.id,
                c.namespace,
                c.candidate_type,
                c.content,
                c.content_hash,
                c.source_turn_ids,
                c.distill_job_id,
                c.model,
                c.authority_tier,
                c.embedding::text AS embedding,
                c.reviewed_at,
                c.review_action,
                c.graded_by
           FROM candidate_memory c
          WHERE c.id = $1
            AND c.namespace = $2
            AND c.review_action = 'promoted'
            AND c.reviewed_at IS NOT NULL
            AND c.graded_by IS NOT NULL
            AND btrim(c.graded_by) <> ''
          FOR UPDATE`,
        [candidateId, namespace],
      );
      return rows[0] ?? null;
    },

    async findThoughtByHash({ contentHash, namespace }) {
      const { rows } = await db.query<ExistingThoughtRow>(
        `SELECT id, archived_at
           FROM thoughts
          WHERE content_hash = $1 AND namespace = $2
          ORDER BY archived_at IS NULL DESC, created_at DESC, id DESC
          LIMIT 1`,
        [contentHash, namespace],
      );
      return rows[0] ?? null;
    },

    async insertThought({
      content,
      tags,
      createdBy,
      namespace,
      embedding,
      contentHash,
      sourceRefs,
      promotedFrom,
      source = "dream-reviewed-candidate",
      tier,
    }) {
      const { rows } = await db.query<InsertedThoughtRow>(
        `INSERT INTO thoughts
           (content, tags, source, created_by, namespace, embedding, content_hash,
            embedded_at, embedding_model, source_refs, promoted_from, tier)
         VALUES ($1, $2, $10, $3, $4, $5, $6,
                 NULL, NULL, $7::jsonb, $8::jsonb, COALESCE($9::text, 'warm'))
         ON CONFLICT (content_hash, namespace) WHERE content_hash IS NOT NULL
         DO NOTHING
         RETURNING id`,
        [
          content,
          [...tags],
          createdBy,
          namespace,
          embedding,
          contentHash,
          sourceRefs,
          promotedFrom,
          tier ?? null,
          source,
        ],
      );
      return rows[0] ?? null;
    },
  };
}
