/**
 * The DREAM route run against a real Postgres.
 *
 * The cohort is built by calling the REAL freezer (`freezeDreamRouteCohort`)
 * on seeded `public.candidate_memory` rows, rather than hand-inserting the
 * manifest and cohort tables. That choice is deliberate: hand-built fixtures
 * drift from the freezer's actual shape, and a run that only ever reads a
 * fixture proves nothing about reading a real frozen cohort.
 *
 * Every schema this file creates is dropped in `afterAll`, and one case asserts
 * that `public` is untouched by a run.
 */

import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "./test-support/require-test-database.ts";
import { freezeDreamRouteCohort, parseDreamRouteArgs } from "./dream-route-cohort.ts";
import { parseRunArgs, runDreamRoute, type RunDeps } from "./dream-route-run.ts";

const EMBEDDING_DIMENSIONS = 768;
const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const namespace = `dream-route-run-${process.pid}`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const createdSchemas: string[] = [];

/** A tight cluster on one axis, so the freezer's neighbour pass has work. */
function unitVector(axis: number, tilt = 0): string {
  const values = Array.from<number>({ length: EMBEDDING_DIMENSIONS }).fill(0);
  const norm = Math.sqrt(1 + tilt * tilt);
  values[axis % EMBEDDING_DIMENSIONS] = 1 / norm;
  values[(axis + 1) % EMBEDDING_DIMENSIONS] = tilt / norm;
  return `[${values.join(",")}]`;
}

const CONTENTS = [
  "always branch before editing, never commit on main",
  "the operator approved moving every repository to Forge",
  "the service runs two Open Brain workers behind one port",
  "the agent recorded the wrong port and was corrected",
  "prefer the smallest correct change at the owning boundary",
  "the operator decided agreement, not one answer, commits",
];

const TYPES = ["decision", "correction", "fact", "preference"] as const;

function deps(lines: string[]): RunDeps {
  let clock = 1_000;
  return {
    env: {},
    log: (line) => lines.push(line),
    now: () => (clock += 5),
  };
}

async function seed(): Promise<void> {
  for (const [index, content] of CONTENTS.entries()) {
    await pool.query(
      `INSERT INTO candidate_memory
         (id, namespace, candidate_type, content, content_hash, source_turn_ids,
          model, unit_kind, anchor_kind, operator_text, first_said_at, last_said_at,
          embedding)
       VALUES ($1,$2,$3,$4,$5,$6::uuid[],'fixture-model','exchange','typed',$7,
               now() - ($8 || ' days')::interval, now(), $9::halfvec)`,
      [
        randomUUID(),
        namespace,
        TYPES[index % TYPES.length],
        content,
        hash(`${namespace}-${content}`),
        [randomUUID()],
        content,
        String(index + 1),
        // Two pairs share an axis, so the freezer pulls neighbours in.
        unitVector(100 + Math.floor(index / 2) * 50, (index % 2) * 0.2),
      ],
    );
  }
}

async function freeze(): Promise<string> {
  const cohort = await freezeDreamRouteCohort(
    pool,
    parseDreamRouteArgs([
      "--namespace",
      namespace,
      "--fraction",
      "0.5",
      "--neighbours",
      "3",
      "--neighbours-for",
      "all",
      "--max-distance",
      "0.15",
    ]),
  );
  createdSchemas.push(cohort.schema);
  return cohort.schema;
}

async function publicCounts(): Promise<Record<string, number>> {
  const tables = await pool.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`,
  );
  const counts: Record<string, number> = {};
  for (const { relname } of tables.rows) {
    const result = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.${relname}`,
    );
    counts[relname] = Number(result.rows[0]?.n ?? 0);
  }
  return counts;
}

beforeAll(async () => {
  await seed();
});

afterAll(async () => {
  for (const schema of createdSchemas) {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }
  await pool.query("DELETE FROM candidate_memory WHERE namespace = $1", [namespace]);
  await pool.end();
});

test("a fake run writes one decision and one verdict per cohort row", async () => {
  const schema = await freeze();
  const lines: string[] = [];
  const summary = await runDreamRoute(
    pool,
    parseRunArgs(["--schema", schema, "--note", "first pass"]),
    deps(lines),
  );

  const cohortCount = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${schema}.cohort`,
  );
  const rows = Number(cohortCount.rows[0]?.n ?? 0);
  expect(rows).toBeGreaterThan(0);

  const runs = await pool.query<{ run_id: string; records: number; note: string }>(
    `SELECT run_id, records, note FROM ${schema}.routing_runs`,
  );
  expect(runs.rows).toHaveLength(1);
  expect(runs.rows[0]?.run_id).toBe(summary.runId);
  expect(runs.rows[0]?.records).toBe(rows);
  expect(runs.rows[0]?.note).toBe("first pass");

  const decisions = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${schema}.routing_decisions WHERE run_id = $1`,
    [summary.runId],
  );
  const verdicts = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${schema}.would_apply WHERE run_id = $1`,
    [summary.runId],
  );
  expect(Number(decisions.rows[0]?.n)).toBe(rows);
  expect(Number(verdicts.rows[0]?.n)).toBe(rows);

  // The fake backend is the only model that answered.
  const served = await pool.query<{ served_models: string[] }>(
    `SELECT served_models FROM ${schema}.routing_runs WHERE run_id = $1`,
    [summary.runId],
  );
  expect(served.rows[0]?.served_models).toEqual(["local-fake"]);
  expect(summary.actualUsd).toBeGreaterThan(0);
});

test("the three named indexes exist", async () => {
  const schema = await freeze();
  await runDreamRoute(pool, parseRunArgs(["--schema", schema]), deps([]));
  const indexes = await pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = $1 ORDER BY indexname`,
    [schema],
  );
  const names = indexes.rows.map((row) => row.indexname);
  expect(names).toContain("routing_decisions_candidate_idx");
  expect(names).toContain("routing_decisions_run_idx");
  expect(names).toContain("routing_decisions_destination_agreement_idx");
  expect(names).toContain("would_apply_action_idx");
});

test("a second run refuses and writes nothing; --rerun adds one and changes none", async () => {
  const schema = await freeze();
  const first = await runDreamRoute(pool, parseRunArgs(["--schema", schema]), deps([]));

  const before = await pool.query(
    `SELECT * FROM ${schema}.routing_decisions ORDER BY candidate_id`,
  );
  const verdictsBefore = await pool.query(
    `SELECT * FROM ${schema}.would_apply ORDER BY candidate_id`,
  );

  await expect(
    runDreamRoute(pool, parseRunArgs(["--schema", schema]), deps([])),
  ).rejects.toThrow(new RegExp(`already holds run ${first.runId}`));

  const afterRefusal = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${schema}.routing_runs`,
  );
  expect(Number(afterRefusal.rows[0]?.n)).toBe(1);

  const second = await runDreamRoute(
    pool,
    parseRunArgs(["--schema", schema, "--rerun"]),
    deps([]),
  );
  expect(second.runId).not.toBe(first.runId);

  const runs = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${schema}.routing_runs`,
  );
  expect(Number(runs.rows[0]?.n)).toBe(2);

  // The first run's rows are exactly as they were.
  const after = await pool.query(
    `SELECT * FROM ${schema}.routing_decisions WHERE run_id = $1 ORDER BY candidate_id`,
    [first.runId],
  );
  const verdictsAfter = await pool.query(
    `SELECT * FROM ${schema}.would_apply WHERE run_id = $1 ORDER BY candidate_id`,
    [first.runId],
  );
  expect(after.rows).toEqual(before.rows.filter((row) => row.run_id === first.runId));
  expect(verdictsAfter.rows).toEqual(
    verdictsBefore.rows.filter((row) => row.run_id === first.runId),
  );
});

test("a failing request yields no-signal rows and the run still completes", async () => {
  const schema = await freeze();
  const lines: string[] = [];
  const broken: RunDeps = deps(lines);
  const failing = async () => {
    throw new Error("connection reset by peer");
  };
  // The fake backend's fetch is replaced by one that always rejects, which is
  // what a dead endpoint looks like from inside a lane.
  const summary = await runDreamRoute(
    pool,
    { ...parseRunArgs(["--schema", schema]), backend: "fake" },
    { ...broken, env: {} },
    failing,
  );

  const reasons = await pool.query<{ reason: string; action: string }>(
    `SELECT reason, action FROM ${schema}.would_apply WHERE run_id = $1`,
    [summary.runId],
  );
  expect(reasons.rows.length).toBeGreaterThan(0);
  expect(reasons.rows.every((row) => row.action === "none")).toBe(true);

  const decisions = await pool.query<{ reasons: string[] }>(
    `SELECT reasons FROM ${schema}.routing_decisions WHERE run_id = $1`,
    [summary.runId],
  );
  expect(decisions.rows.length).toBeGreaterThan(0);
  for (const row of decisions.rows) {
    expect(row.reasons[0]).toMatch(/^no signal: request failed/);
  }
  expect(summary.noSignal).toBe(decisions.rows.length);
});

test("nothing in public changes", async () => {
  const before = await publicCounts();
  const schema = await freeze();
  await runDreamRoute(pool, parseRunArgs(["--schema", schema]), deps([]));
  expect(await publicCounts()).toEqual(before);
});

test("an empty cohort is refused with a clear message", async () => {
  const emptyNamespace = `${namespace}-empty`;
  const cohort = await freezeDreamRouteCohort(
    pool,
    parseDreamRouteArgs(["--namespace", emptyNamespace, "--neighbours", "0"]),
  );
  createdSchemas.push(cohort.schema);
  await expect(
    runDreamRoute(pool, parseRunArgs(["--schema", cohort.schema]), deps([])),
  ).rejects.toThrow(/is empty: there is nothing to route/);
});
