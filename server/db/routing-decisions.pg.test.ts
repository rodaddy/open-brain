/**
 * Migration 052 creates the public routing history tables (issue 1525, plan
 * item 4): `routing_runs` and `routing_decisions`, copied from the disposable
 * run schemas, with the foreign key, the one-decision-per-candidate-per-run
 * uniqueness, and the four reader indexes.
 *
 * REQUIRES `OPENBRAIN_TEST_DATABASE_URL`; `npm run test:isolated` sets it.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "vitest";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../scripts/test-support/require-test-database.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

afterAll(async () => {
  await pool.end();
});

async function insertRun(runId: string): Promise<void> {
  await pool.query(
    `INSERT INTO routing_runs (run_id, matrix_fingerprint, classifier_version,
       thresholds, backend, served_models, records, requests, input_tokens,
       estimated_usd, actual_usd, ms, note)
     VALUES ($1, 'fp-test', 'v-test', '{}'::jsonb, 'test', ARRAY['m'], 1, 1, 10,
       0, 0, 5, 'routing-decisions test')`,
    [runId],
  );
}

async function insertDecision(runId: string, candidateId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO routing_decisions (run_id, candidate_id, namespace, destination,
       agreement, authority_tier, restates, drove_decision, reasons, raw, served_model)
     VALUES ($1, $2, 'routing-decisions-test', 'thoughts', 'agree', 'observed',
       false, true, '[]'::jsonb, '{}'::jsonb, 'm')
     RETURNING id`,
    [runId, candidateId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("routing_decisions insert returned no row");
  return row.id;
}

async function cleanup(runId: string): Promise<void> {
  await pool.query(`DELETE FROM routing_decisions WHERE run_id = $1`, [runId]);
  await pool.query(`DELETE FROM routing_runs WHERE run_id = $1`, [runId]);
}

async function sqlstateOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

describe("public routing history tables (live Postgres)", () => {
  test("a run row and a decision row for it insert", async () => {
    const runId = randomUUID();
    try {
      await insertRun(runId);
      const id = await insertDecision(runId, randomUUID());
      const back = await pool.query(
        `SELECT run_id FROM routing_decisions WHERE id = $1`,
        [id],
      );
      expect(back.rows).toEqual([{ run_id: runId }]);
    } finally {
      await cleanup(runId);
    }
  });

  test("a decision for a run that does not exist fails with 23503", async () => {
    const runId = randomUUID();
    try {
      expect(await sqlstateOf(insertDecision(runId, randomUUID()))).toBe("23503");
    } finally {
      await cleanup(runId);
    }
  });

  test("a second decision for the same run and candidate fails with 23505", async () => {
    const runId = randomUUID();
    const candidateId = randomUUID();
    try {
      await insertRun(runId);
      await insertDecision(runId, candidateId);
      expect(await sqlstateOf(insertDecision(runId, candidateId))).toBe("23505");
    } finally {
      await cleanup(runId);
    }
  });

  test("pg_indexes lists all four reader indexes", async () => {
    const result = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND tablename IN ('routing_runs', 'routing_decisions')`,
    );
    const names = result.rows.map((r) => r.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        "idx_routing_decisions_candidate",
        "idx_routing_decisions_run",
        "idx_routing_decisions_destination_agreement",
        "idx_routing_runs_matrix_fingerprint",
      ]),
    );
  });
});
