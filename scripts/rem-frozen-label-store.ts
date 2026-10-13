import type { Pool } from "pg";
import { z } from "zod";

import { remFrozenHumanLabelSchema } from "./rem-frozen-human-label.ts";
import {
  assertDreamRunSchema,
  FROZEN_COHORT_SIZE,
  loadFrozenCohort,
} from "./rem-ethereal-cohort.ts";

const explicitStringSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, "must not have surrounding whitespace");

const submitFrozenHumanLabelsSchema = z
  .object({
    schema: z.string().regex(/^dream_run_[0-9]{3}$/),
    namespace: explicitStringSchema,
    gradedBy: explicitStringSchema,
    expectedSnapshotSha256: z.string().regex(/^[0-9a-f]{64}$/),
    labels: z.array(remFrozenHumanLabelSchema).min(1).max(FROZEN_COHORT_SIZE),
  })
  .strict()
  .superRefine((input, context) => {
    const ids = input.labels.map((label) => label.candidate_id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["labels"],
        message: "candidate ids must be unique",
      });
    }
  });

export interface SubmitFrozenHumanLabelsInput {
  schema: string;
  namespace: string;
  gradedBy: string;
  expectedSnapshotSha256: string;
  labels: unknown[];
}

export async function submitFrozenHumanLabels(
  pool: Pool,
  input: SubmitFrozenHumanLabelsInput,
): Promise<{ savedCount: number }> {
  const parsed = submitFrozenHumanLabelsSchema.parse(input);
  assertDreamRunSchema(parsed.schema);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const frozen = await loadFrozenCohort(client, parsed.schema, parsed.namespace);
    if (frozen.fullSnapshotSha256 !== parsed.expectedSnapshotSha256) {
      throw new Error("frozen full snapshot digest does not match submitted view");
    }
    const candidates = new Map(
      frozen.candidates.map((candidate) => [candidate.id, candidate]),
    );
    for (const label of parsed.labels) {
      if (!candidates.has(label.candidate_id)) {
        throw new Error(
          `candidate ${label.candidate_id} does not belong to the frozen cohort`,
        );
      }
    }

    await client.query(`CREATE TABLE IF NOT EXISTS ${parsed.schema}.human_label (
      run_id TEXT NOT NULL,
      candidate_id UUID NOT NULL,
      namespace TEXT NOT NULL,
      cohort_digest TEXT NOT NULL,
      full_snapshot_sha256 TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      grade TEXT NOT NULL CHECK (grade IN ('promoted','rejected','duplicate','inconclusive')),
      note TEXT,
      graded_by TEXT NOT NULL,
      graded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (run_id, candidate_id),
      FOREIGN KEY (candidate_id) REFERENCES ${parsed.schema}.cohort(candidate_id)
    )`);

    for (const label of parsed.labels) {
      const candidate = candidates.get(label.candidate_id);
      if (!candidate) throw new Error("validated frozen cohort candidate missing");
      await client.query(
        `INSERT INTO ${parsed.schema}.human_label
           (run_id, candidate_id, namespace, cohort_digest,
            full_snapshot_sha256, content_hash, grade, note, graded_by, graded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
         ON CONFLICT (run_id, candidate_id) DO UPDATE SET
           namespace = EXCLUDED.namespace,
           cohort_digest = EXCLUDED.cohort_digest,
           full_snapshot_sha256 = EXCLUDED.full_snapshot_sha256,
           content_hash = EXCLUDED.content_hash,
           grade = EXCLUDED.grade,
           note = EXCLUDED.note,
           graded_by = EXCLUDED.graded_by,
           graded_at = now()`,
        [
          parsed.schema,
          label.candidate_id,
          parsed.namespace,
          frozen.digest,
          frozen.fullSnapshotSha256,
          candidate.content_hash,
          label.grade,
          label.note ?? null,
          parsed.gradedBy,
        ],
      );
    }
    await client.query("COMMIT");
    return { savedCount: parsed.labels.length };
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
