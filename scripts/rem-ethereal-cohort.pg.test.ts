import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "./test-support/require-test-database.ts";
import {
  FROZEN_COHORT_SIZE,
  freezeCohort,
  loadFrozenCohort,
} from "./rem-ethereal-cohort.ts";
import { parseRemEtherealArgs, runRemEthereal } from "./rem-ethereal-run.ts";

const graderModuleLoaded = vi.hoisted(() => vi.fn());
vi.mock("../server/maintenance/rem-terra-grader.ts", () => {
  graderModuleLoaded();
  throw new Error("freeze-only imported a grader module");
});

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const namespace = `ethereal-cohort-${process.pid}`;
const foreignNamespace = `${namespace}-foreign`;
const ids = Array.from({ length: FROZEN_COHORT_SIZE }, () => randomUUID());
const foreignId = randomUUID();
const sourceTurn = randomUUID();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
let frozenSchema = "";
let beforeFreezeRows: unknown[] = [];

async function insertCandidate(id: string, ns: string, index: number) {
  const content = `frozen content ${index}`;
  await pool.query(
    `INSERT INTO candidate_memory
       (id, namespace, candidate_type, content, content_hash, source_turn_ids,
        model, unit_kind, uncertain, uncertainty_reason)
     VALUES ($1,$2,'fact',$3,$4,$5::uuid[],'fixture-model','exchange',$6,$7)`,
    [id, ns, content, hash(content), [sourceTurn], index % 2 === 0, `reason-${index}`],
  );
}

beforeAll(async () => {
  for (const [index, id] of ids.entries()) await insertCandidate(id, namespace, index);
  await pool.query(
    "UPDATE candidate_memory SET machine_grade = 'promoted', machine_grade_model = 'advisory-fixture' WHERE id = $1",
    [ids[0]],
  );
  await insertCandidate(foreignId, foreignNamespace, 999);
  beforeFreezeRows = (
    await pool.query(
      "SELECT * FROM candidate_memory WHERE namespace = ANY($1::text[]) ORDER BY id",
      [[namespace, foreignNamespace]],
    )
  ).rows;
  const beforeSchemas = await pool.query<{ nspname: string }>(
    "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'dream\\_run\\_%' ORDER BY nspname",
  );
  await runRemEthereal(
    parseRemEtherealArgs(["--freeze-only", "--namespace", namespace]),
    pool,
  );
  const afterSchemas = await pool.query<{ nspname: string }>(
    "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'dream\\_run\\_%' ORDER BY nspname",
  );
  frozenSchema =
    afterSchemas.rows.find(
      (row) => !beforeSchemas.rows.some((before) => before.nspname === row.nspname),
    )?.nspname ?? "";
  if (!frozenSchema) throw new Error("freeze-only did not create a run schema");
});

afterAll(async () => {
  if (frozenSchema) await pool.query(`DROP SCHEMA IF EXISTS ${frozenSchema} CASCADE`);
  await pool.query("DELETE FROM candidate_memory WHERE namespace = ANY($1::text[])", [
    [namespace, foreignNamespace],
  ]);
  await pool.end();
});

test("refuses an omitted expected namespace before querying", async () => {
  const query = vi.fn();
  const unscopedLoad = loadFrozenCohort as unknown as (
    database: unknown,
    schema: string,
  ) => Promise<unknown>;
  await expect(unscopedLoad({ query }, "dream_run_001")).rejects.toThrow(/namespace/i);
  expect(query).not.toHaveBeenCalled();
});

test("freezes exactly 50 eligible candidates in deterministic namespace-scoped order without a grader", async () => {
  const frozen = await loadFrozenCohort(pool, frozenSchema, namespace);

  expect(frozen.candidates).toHaveLength(FROZEN_COHORT_SIZE);
  expect(new Set(frozen.candidates.map((candidate) => candidate.id)).size).toBe(50);
  expect(
    frozen.candidates.every((candidate) => candidate.namespace === namespace),
  ).toBe(true);
  expect(frozen.candidates.map((candidate) => candidate.id)).not.toContain(foreignId);
  expect(frozen.candidates.map((candidate) => candidate.id)).toContain(ids[0]);
  const expected = [...ids].sort((left, right) => {
    const byHash = hashMd5(left).localeCompare(hashMd5(right));
    return byHash || left.localeCompare(right);
  });
  expect(frozen.candidates.map((candidate) => candidate.id)).toEqual(expected);
  expect(frozen.digest).toMatch(/^[0-9a-f]{64}$/);
  expect(frozen.fullSnapshotSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(graderModuleLoaded).not.toHaveBeenCalled();
  const afterFreezeRows = (
    await pool.query(
      "SELECT * FROM candidate_memory WHERE namespace = ANY($1::text[]) ORDER BY id",
      [[namespace, foreignNamespace]],
    )
  ).rows;
  expect(afterFreezeRows).toEqual(beforeFreezeRows);
});

test("replays full snapshots unchanged after source rows mutate and become reviewed", async () => {
  const original = await loadFrozenCohort(pool, frozenSchema, namespace);
  await pool.query(
    `UPDATE candidate_memory
        SET content = 'mutated after freeze', content_hash = $1,
            reviewed_at = now(), review_action = 'rejected',
            uncertain = false, uncertainty_reason = NULL, model = 'mutated-model'
      WHERE id = $2`,
    [hash("mutated after freeze"), ids[0]],
  );
  const replay = await loadFrozenCohort(pool, frozenSchema, namespace);
  expect(replay.candidates).toEqual(original.candidates);
  expect(replay.digest).toBe(original.digest);
  expect(replay.fullSnapshotSha256).toBe(original.fullSnapshotSha256);
});

test("fails closed on namespace, snapshot, count, and digest tampering", async () => {
  await expect(loadFrozenCohort(pool, frozenSchema, foreignNamespace)).rejects.toThrow(
    /namespace/i,
  );

  await pool.query("BEGIN");
  try {
    await pool.query(
      `UPDATE ${frozenSchema}.cohort SET snapshot = snapshot || '{"content":"tampered"}'::jsonb WHERE ordinal = 1`,
    );
    await expect(loadFrozenCohort(pool, frozenSchema, namespace)).rejects.toThrow(
      /snapshot/i,
    );
  } finally {
    await pool.query("ROLLBACK");
  }

  await pool.query("BEGIN");
  try {
    await pool.query(`DELETE FROM ${frozenSchema}.cohort WHERE ordinal = 50`);
    await expect(loadFrozenCohort(pool, frozenSchema, namespace)).rejects.toThrow(
      /exactly 50/i,
    );
  } finally {
    await pool.query("ROLLBACK");
  }

  await pool.query("BEGIN");
  try {
    await pool.query(`UPDATE ${frozenSchema}.manifest SET cohort_digest = $1`, [
      "0".repeat(64),
    ]);
    await expect(loadFrozenCohort(pool, frozenSchema, namespace)).rejects.toThrow(
      /digest/i,
    );
  } finally {
    await pool.query("ROLLBACK");
  }
});

test("validates frozen CLI modes before any effects", () => {
  expect(() => parseRemEtherealArgs(["--freeze-only"])).toThrow(/namespace/i);
  expect(() => parseRemEtherealArgs(["--replay", "dream_run_001"])).toThrow(
    /namespace/i,
  );
  expect(() =>
    parseRemEtherealArgs(["--freeze-only", "--list", "--namespace", namespace]),
  ).toThrow(/mutually exclusive/i);
  expect(() =>
    parseRemEtherealArgs(["--freeze-only", "--namespace", namespace, "--limit", "50"]),
  ).toThrow(/limit/i);
  expect(() =>
    parseRemEtherealArgs([
      "--replay",
      "dream_run_001",
      "--namespace",
      namespace,
      "--limit",
      "50",
    ]),
  ).toThrow(/limit/i);
  expect(() => parseRemEtherealArgs(["--namespace", namespace])).toThrow(/namespace/i);
  expect(() => parseRemEtherealArgs(["--list", "--namespace", namespace])).toThrow(
    /namespace/i,
  );
  expect(() =>
    parseRemEtherealArgs(["--drop", "dream_run_001", "--namespace", namespace]),
  ).toThrow(/namespace/i);
  expect(parseRemEtherealArgs(["--limit", "7"]).mode).toBe("run");
  expect(parseRemEtherealArgs(["--limit", "7"])).toMatchObject({
    model: "gpt-5.6-terra",
    effort: "low",
  });
  expect(
    parseRemEtherealArgs([
      "--replay",
      "dream_run_001",
      "--namespace",
      namespace,
      "--model",
      "gpt-5.6-luna",
      "--effort",
      "max",
    ]),
  ).toMatchObject({ model: "gpt-5.6-luna", effort: "max" });
  expect(() =>
    parseRemEtherealArgs([
      "--replay",
      "dream_run_001",
      "--namespace",
      namespace,
      "--model",
      "gpt-5.6-luna",
    ]),
  ).toThrow(/model.*effort.*together/i);
  expect(() =>
    parseRemEtherealArgs([
      "--replay",
      "dream_run_001",
      "--namespace",
      namespace,
      "--model",
      "gpt-5.6-luna",
      "--effort",
      "low",
    ]),
  ).toThrow(/supported.*pair/i);
});

test("refuses atomically when fewer than 50 eligible rows exist", async () => {
  const sparseNamespace = `${namespace}-sparse`;
  await insertCandidate(randomUUID(), sparseNamespace, 2000);
  const before = await pool.query<{ nspname: string }>(
    "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'dream\\_run\\_%' ORDER BY nspname",
  );
  await expect(freezeCohort(pool, sparseNamespace)).rejects.toThrow(/exactly 50/i);
  const after = await pool.query<{ nspname: string }>(
    "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'dream\\_run\\_%' ORDER BY nspname",
  );
  expect(after.rows).toEqual(before.rows);
  await pool.query("DELETE FROM candidate_memory WHERE namespace = $1", [
    sparseNamespace,
  ]);
});

function hashMd5(value: string): string {
  return createHash("md5").update(value).digest("hex");
}
