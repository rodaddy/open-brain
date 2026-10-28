import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Pool } from "pg";

import { requireTestDatabaseUrl } from "./test-support/require-test-database.ts";
import {
  readMatrixCases,
  saveMatrixCases,
  type MatrixCase,
} from "./dream-route-case-store.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const schema = "dream_run_911";
const fingerprint = "0123456789ab";
const namespace = `dream-route-case-store-${process.pid}`;
const first = randomUUID();
const second = randomUUID();

function planted(candidateId: string, overrides: Partial<MatrixCase> = {}): MatrixCase {
  return {
    candidate_id: candidateId,
    dest: "decision",
    yn_rule: false,
    yn_decision: true,
    yn_fact: false,
    yn_correction: false,
    yn_steering: false,
    restates: false,
    drove_decision: true,
    ...overrides,
  };
}

function save(
  labelledBy: string,
  cases: MatrixCase[],
): Promise<{ savedCount: number }> {
  return saveMatrixCases(pool, {
    schema,
    matrixFingerprint: fingerprint,
    labelledBy,
    cases,
  });
}

beforeAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`CREATE TABLE ${schema}.cohort (
    ordinal INTEGER PRIMARY KEY CHECK (ordinal > 0),
    candidate_id UUID NOT NULL UNIQUE, namespace TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('draw', 'neighbour', 'labelled')),
    neighbour_of UUID,
    CHECK ((source = 'neighbour') = (neighbour_of IS NOT NULL)),
    snapshot JSONB NOT NULL)`);
  for (const [index, id] of [first, second].entries()) {
    await pool.query(
      `INSERT INTO ${schema}.cohort
         (ordinal, candidate_id, namespace, content_hash, source, neighbour_of, snapshot)
       VALUES ($1,$2,$3,$4,'draw',NULL,'{}'::jsonb)`,
      [index + 1, id, namespace, `hash-${index}`],
    );
  }
});

afterAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.end();
});

async function expectRoundTrip(): Promise<void> {
  await expect(
    save("dana", [
      planted(first, { note: "operator said it plainly" }),
      planted(second, {
        dest: "none",
        yn_decision: false,
        drove_decision: false,
        restates: true,
      }),
    ]),
  ).resolves.toEqual({ savedCount: 2 });

  const stored = await readMatrixCases(pool, schema, fingerprint);
  expect(stored).toHaveLength(2);
  const saved = stored.find((one) => one.candidate_id === first);
  expect(saved).toMatchObject({
    matrix_fingerprint: fingerprint,
    dest: "decision",
    yn_decision: true,
    yn_rule: false,
    restates: false,
    drove_decision: true,
    note: "operator said it plainly",
    labelled_by: "dana",
  });
  expect(saved?.labelled_at).toBeInstanceOf(Date);
  expect(await readMatrixCases(pool, schema, "ffffffffffff")).toEqual([]);
}

async function expectUpdateInPlace(): Promise<void> {
  await expect(
    save("dana-corrected", [
      planted(first, {
        dest: "rule",
        yn_rule: true,
        yn_decision: false,
        drove_decision: false,
        note: "standing rule, not one decision",
      }),
    ]),
  ).resolves.toEqual({ savedCount: 1 });

  const stored = await readMatrixCases(pool, schema, fingerprint);
  expect(stored).toHaveLength(2);
  expect(stored.find((one) => one.candidate_id === first)).toMatchObject({
    dest: "rule",
    yn_rule: true,
    yn_decision: false,
    note: "standing rule, not one decision",
    labelled_by: "dana-corrected",
  });
}

async function expectUnknownCandidateRefused(): Promise<void> {
  await expect(
    save("dana", [
      planted(second, { dest: "fact", yn_decision: false, yn_fact: true }),
    ]),
  ).resolves.toEqual({ savedCount: 1 });
  await expect(save("dana", [planted(randomUUID())])).rejects.toThrow(
    /does not belong to the cohort/i,
  );

  const stored = await readMatrixCases(pool, schema, fingerprint);
  expect(stored.map((one) => one.candidate_id).sort()).toEqual([first, second].sort());
  expect(stored.find((one) => one.candidate_id === second)?.dest).toBe("fact");
}

async function expectInconsistentRefused(): Promise<void> {
  await expect(save("dana", [planted(first, { dest: "fact" })])).rejects.toThrow(
    /disagrees/i,
  );
  await expect(save("dana", [planted(first, { dest: "none" })])).rejects.toThrow(
    /disagrees/i,
  );
}

async function expectInvalidSchemaRefused(): Promise<void> {
  await expect(
    saveMatrixCases(pool, {
      schema: "public; drop table cohort",
      matrixFingerprint: fingerprint,
      labelledBy: "dana",
      cases: [planted(first)],
    }),
  ).rejects.toThrow(/invalid dream run schema/i);
  await expect(readMatrixCases(pool, "dream_runs", fingerprint)).rejects.toThrow(
    /invalid dream run schema/i,
  );
}

describe("dream route matrix case store (live Postgres)", () => {
  test("saves cases and reads them back against their fingerprint", expectRoundTrip);
  test("re-saving one candidate updates it in place", expectUpdateInPlace);
  test("refuses a candidate outside the cohort", expectUnknownCandidateRefused);
  test("refuses a dest that disagrees with its own answers", expectInconsistentRefused);
  test("refuses an invalid schema name", expectInvalidSchemaRefused);
});
