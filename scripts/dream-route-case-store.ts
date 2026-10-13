/**
 * The store for LABELLED MATRIX CASES: what a human says the right answer is
 * for one frozen candidate, under one exact wording of the route matrix.
 *
 * Shaped after `scripts/rem-frozen-label-store.ts`: the labels live in a table
 * inside the run schema, keyed by candidate and foreign-keyed to
 * `<schema>.cohort`, created on demand. No memory text is copied here and none
 * is copied into the repo -- a case POINTS at the cohort row, so the frozen
 * snapshot stays the one copy of the words.
 *
 * A case carries the eight answers the matrix asks
 * (`server/domain/dream-route/questions.ts`): the one Choice over
 * destinations, the five per-destination yes/no readings, and the two flags.
 * They are stored together with the matrix fingerprint they were made against,
 * for the same reason the question set is versioned by it: labels must never be
 * read against wording they were not produced under.
 */

import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import { assertDreamRunSchema } from "./rem-ethereal-cohort.ts";
import { DESTINATIONS, type Destination } from "../server/domain/dream-route/types.ts";
import { ynId } from "../server/domain/dream-route/questions.ts";

/** The `dest` answer, plus the "no destination fits" pick. */
export const CASE_DESTINATIONS = [...DESTINATIONS, "none"] as const;
export type CaseDestination = (typeof CASE_DESTINATIONS)[number];

const explicitStringSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, "must not have surrounding whitespace");

const ynShape = Object.fromEntries(
  DESTINATIONS.map((name) => [ynId(name), z.boolean()]),
) as Record<string, z.ZodBoolean>;

/** One labelled case, before it is checked against the cohort. */
export const matrixCaseSchema = z
  .object({
    candidate_id: z.string().uuid(),
    dest: z.enum(CASE_DESTINATIONS),
    ...ynShape,
    restates: z.boolean(),
    drove_decision: z.boolean(),
    note: explicitStringSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const answers = input as unknown as Record<string, boolean>;
    for (const name of DESTINATIONS) {
      const yes = answers[ynId(name)] === true;
      if (input.dest === name && !yes) {
        context.addIssue({
          code: "custom",
          path: [ynId(name)],
          message: `dest ${name} disagrees with its own ${ynId(name)} answer`,
        });
      }
      if (input.dest === "none" && yes) {
        context.addIssue({
          code: "custom",
          path: [ynId(name)],
          message: `dest none disagrees with ${ynId(name)}`,
        });
      }
    }
  });

/** The five per-destination yes/no readings, named as the question set names them. */
export type MatrixCaseAnswers = {
  [Name in Destination as `yn_${Name}`]: boolean;
};

/**
 * One labelled case. The yes/no members are spelled out so a caller gets them
 * checked; the zod schema above derives the same five names from `DESTINATIONS`.
 */
export type MatrixCase = z.infer<typeof matrixCaseSchema> & MatrixCaseAnswers;

const saveMatrixCasesSchema = z
  .object({
    schema: z.string(),
    matrixFingerprint: z.string().regex(/^[0-9a-f]{12}$/),
    labelledBy: explicitStringSchema,
    cases: z.array(matrixCaseSchema).min(1),
  })
  .strict()
  .superRefine((input, context) => {
    const ids = input.cases.map((one) => one.candidate_id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["cases"],
        message: "candidate ids must be unique",
      });
    }
  });

export interface SaveMatrixCasesInput {
  schema: string;
  matrixFingerprint: string;
  labelledBy: string;
  cases: unknown[];
}

/** One stored case, as read back. */
export interface StoredMatrixCase {
  candidate_id: string;
  matrix_fingerprint: string;
  dest: CaseDestination;
  yn_rule: boolean;
  yn_decision: boolean;
  yn_fact: boolean;
  yn_correction: boolean;
  yn_steering: boolean;
  restates: boolean;
  drove_decision: boolean;
  note: string | null;
  labelled_by: string;
  labelled_at: Date;
}

const DEST_CHECK = CASE_DESTINATIONS.map((name) => `'${name}'`).join(",");

/**
 * Creates `<schema>.matrix_case` if it is not already there.
 *
 * @param client - A client already inside the caller's transaction.
 * @param schema - A validated `dream_run_NNN` schema name.
 */
export async function ensureMatrixCaseTable(
  client: PoolClient,
  schema: string,
): Promise<void> {
  assertDreamRunSchema(schema);
  await client.query(`CREATE TABLE IF NOT EXISTS ${schema}.matrix_case (
    candidate_id UUID NOT NULL,
    matrix_fingerprint TEXT NOT NULL,
    dest TEXT NOT NULL CHECK (dest IN (${DEST_CHECK})),
    yn_rule BOOLEAN NOT NULL,
    yn_decision BOOLEAN NOT NULL,
    yn_fact BOOLEAN NOT NULL,
    yn_correction BOOLEAN NOT NULL,
    yn_steering BOOLEAN NOT NULL,
    restates BOOLEAN NOT NULL,
    drove_decision BOOLEAN NOT NULL,
    note TEXT,
    labelled_by TEXT NOT NULL,
    labelled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (candidate_id, matrix_fingerprint),
    FOREIGN KEY (candidate_id) REFERENCES ${schema}.cohort(candidate_id)
  )`);
}

async function assertInCohort(
  client: PoolClient,
  schema: string,
  ids: readonly string[],
): Promise<void> {
  const present = await client.query<{ candidate_id: string }>(
    `SELECT candidate_id FROM ${schema}.cohort WHERE candidate_id = ANY ($1::uuid[])`,
    [ids],
  );
  const known = new Set(present.rows.map((row) => row.candidate_id));
  for (const id of ids) {
    if (!known.has(id)) {
      throw new Error(`candidate ${id} does not belong to the cohort in ${schema}`);
    }
  }
}

function caseValues(
  one: z.infer<typeof matrixCaseSchema>,
  fingerprint: string,
  labelledBy: string,
): unknown[] {
  const answers = one as unknown as Record<string, boolean>;
  return [
    one.candidate_id,
    fingerprint,
    one.dest,
    ...DESTINATIONS.map((name: Destination) => answers[ynId(name)]),
    one.restates,
    one.drove_decision,
    one.note ?? null,
    labelledBy,
  ];
}

/**
 * Saves labelled cases, replacing any case already stored for the same
 * candidate under the same matrix fingerprint.
 *
 * Every case is validated before a client is taken: a `dest` must agree with
 * its own yes/no answer, and `none` requires all five to be false. The whole
 * batch runs in ONE transaction, so a foreign candidate leaves nothing behind.
 *
 * @param pool - A pool for the test or target database. Never the dogfood one.
 * @param input - The run schema, the matrix fingerprint, the labeller, the cases.
 * @returns How many cases were written.
 */
export async function saveMatrixCases(
  pool: Pool,
  input: SaveMatrixCasesInput,
): Promise<{ savedCount: number }> {
  const parsed = saveMatrixCasesSchema.parse(input);
  assertDreamRunSchema(parsed.schema);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assertInCohort(
      client,
      parsed.schema,
      parsed.cases.map((one) => one.candidate_id),
    );
    await ensureMatrixCaseTable(client, parsed.schema);
    for (const one of parsed.cases) {
      await client.query(
        `INSERT INTO ${parsed.schema}.matrix_case
           (candidate_id, matrix_fingerprint, dest, yn_rule, yn_decision, yn_fact,
            yn_correction, yn_steering, restates, drove_decision, note,
            labelled_by, labelled_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
         ON CONFLICT (candidate_id, matrix_fingerprint) DO UPDATE SET
           dest = EXCLUDED.dest,
           yn_rule = EXCLUDED.yn_rule,
           yn_decision = EXCLUDED.yn_decision,
           yn_fact = EXCLUDED.yn_fact,
           yn_correction = EXCLUDED.yn_correction,
           yn_steering = EXCLUDED.yn_steering,
           restates = EXCLUDED.restates,
           drove_decision = EXCLUDED.drove_decision,
           note = EXCLUDED.note,
           labelled_by = EXCLUDED.labelled_by,
           labelled_at = now()`,
        caseValues(one, parsed.matrixFingerprint, parsed.labelledBy),
      );
    }
    await client.query("COMMIT");
    return { savedCount: parsed.cases.length };
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Reads back every stored case for one matrix fingerprint, in candidate order.
 *
 * Returns an empty list when the table has not been created yet, so a caller
 * can ask before anything has been labelled.
 *
 * @param pool - A pool for the test or target database.
 * @param schema - A `dream_run_NNN` schema name.
 * @param matrixFingerprint - The fingerprint the labels were made against.
 * @returns The stored cases, ordered by candidate id.
 */
export async function readMatrixCases(
  pool: Pool,
  schema: string,
  matrixFingerprint: string,
): Promise<StoredMatrixCase[]> {
  assertDreamRunSchema(schema);
  const exists = await pool.query<{ table_name: string | null }>(
    "SELECT to_regclass($1) AS table_name",
    [`${schema}.matrix_case`],
  );
  if (!exists.rows[0]?.table_name) return [];
  const result = await pool.query<StoredMatrixCase>(
    `SELECT candidate_id, matrix_fingerprint, dest, yn_rule, yn_decision, yn_fact,
            yn_correction, yn_steering, restates, drove_decision, note,
            labelled_by, labelled_at
       FROM ${schema}.matrix_case
      WHERE matrix_fingerprint = $1
      ORDER BY candidate_id`,
    [matrixFingerprint],
  );
  return result.rows;
}
