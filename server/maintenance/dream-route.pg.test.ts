/**
 * The scheduled dream.route handler (issue 1525) against a migrated database,
 * fake backend only: nothing is sent anywhere.
 *
 * REQUIRES `OPENBRAIN_TEST_DATABASE_URL`; `npm run test:isolated` sets it.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "vitest";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../scripts/test-support/require-test-database.ts";
import { isMaintenanceTerminalError, type MaintenanceJob } from "./maintenance-job.ts";
import type { MaintenanceQueueLogger } from "./maintenance-queue-runner.ts";
import { makeDreamRouteHandler } from "./dream-route.ts";
import type { JevFetch } from "../integrations/jev.ts";
import { claimUnrouted, writeRoutingRun } from "../db/dream-route-repository.ts";
import { withTransaction } from "../db/transaction.ts";
import { fakeJevFetch } from "../domain/dream-route/run-core.ts";
import { fakeConfig } from "../domain/dream-route/run-execute.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const namespaces: string[] = [];
const candidateIds: string[] = [];

const EMBEDDING = `[${Array.from({ length: 768 }, () => "0.1").join(",")}]`;
const JOB = {} as MaintenanceJob;

const logger: MaintenanceQueueLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function freshNamespace(): string {
  const namespace = `route-handler-${randomUUID().slice(0, 8)}`;
  namespaces.push(namespace);
  return namespace;
}

async function seed(namespace: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO candidate_memory (id, namespace, candidate_type, content,
         content_hash, source_turn_ids, embedding, unit_kind, operator_text)
       VALUES ($1, $2, 'decision', $3, $4, ARRAY[$5::uuid], $6::halfvec,
         'exchange', $7)`,
      [
        id,
        namespace,
        `route handler test item ${index}: we always branch before editing`,
        `hash-${id}`,
        randomUUID(),
        EMBEDDING,
        `always branch before you edit (${index})`,
      ],
    );
    ids.push(id);
  }
  candidateIds.push(...ids);
  return ids;
}

function handlerFor(namespace: string, maxUsdPerRun = 1) {
  return makeDreamRouteHandler({
    pool,
    logger,
    namespace,
    route: { enabled: true, backend: "fake", sliceSize: 50, minGapMs: 0, maxUsdPerRun },
  });
}

async function decisionRunIds(ids: readonly string[]): Promise<string[]> {
  const result = await pool.query<{ run_id: string }>(
    `SELECT run_id FROM routing_decisions WHERE candidate_id = ANY($1::uuid[])`,
    [ids],
  );
  return result.rows.map((row) => row.run_id);
}

/** Commits one decision for `candidateId` in its own run, as another job would. */
async function writeOtherRun(candidateId: string, namespace: string): Promise<void> {
  await withTransaction({
    pool,
    run: (client) =>
      writeRoutingRun({
        client,
        runId: randomUUID(),
        run: {
          matrixFingerprint: "other-job",
          classifierVersion: "other-job",
          thresholds: {},
          backend: "fake",
          servedModels: [],
          records: 1,
          requests: 0,
          inputTokens: 0,
          estimatedUsd: 0,
          actualUsd: 0,
          ms: 0,
          note: "other-job",
        },
        decisions: [
          {
            candidateId,
            namespace,
            destination: null,
            agreement: "none",
            authorityTier: "observed",
            restates: false,
            droveDecision: false,
            reasons: [],
            raw: {},
            servedModel: null,
          },
        ],
      }),
  });
}

async function hashCount(sql: string, candidateId: string): Promise<number> {
  const result = await pool.query<{ n: string }>(sql, [`hash-${candidateId}`]);
  return Number(result.rows[0]?.n ?? 0);
}

async function runCount(): Promise<number> {
  const result = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM routing_runs`,
  );
  return Number(result.rows[0]?.n ?? 0);
}

afterAll(async () => {
  const runIds = [...new Set(await decisionRunIds(candidateIds))];
  await pool.query("DELETE FROM tier_moves WHERE routing_run_id = ANY($1::uuid[])", [
    runIds,
  ]);
  await pool.query(
    `DELETE FROM ob_session_events WHERE lane_id IN
       (SELECT id FROM ob_session_lanes WHERE namespace = ANY($1::text[]))`,
    [namespaces],
  );
  await pool.query("DELETE FROM ob_session_lanes WHERE namespace = ANY($1::text[])", [
    namespaces,
  ]);
  await pool.query("DELETE FROM thoughts WHERE namespace = ANY($1::text[])", [
    namespaces,
  ]);
  await pool.query(
    "DELETE FROM routing_decisions WHERE candidate_id = ANY($1::uuid[])",
    [candidateIds],
  );
  await pool.query("DELETE FROM routing_runs WHERE run_id = ANY($1::uuid[])", [runIds]);
  await pool.query("DELETE FROM candidate_memory WHERE id = ANY($1::uuid[])", [
    candidateIds,
  ]);
  await pool.end();
});

describe("dream.route handler (live Postgres)", () => {
  const routedNamespace = freshNamespace();
  let routedIds: string[] = [];

  test("routes every unrouted candidate in one run", async () => {
    routedIds = await seed(routedNamespace, 3);
    await handlerFor(routedNamespace)(JOB);
    const runIds = await decisionRunIds(routedIds);
    expect(runIds).toHaveLength(3);
    expect(new Set(runIds).size).toBe(1);
    const run = await pool.query<{ records: number; note: string; backend: string }>(
      `SELECT records, note, backend FROM routing_runs WHERE run_id = $1`,
      [runIds[0]],
    );
    expect(run.rows).toEqual([{ records: 3, note: "scheduled", backend: "fake" }]);
  });

  test("a second run routes nothing", async () => {
    const before = await runCount();
    await handlerFor(routedNamespace)(JOB);
    expect(await runCount()).toBe(before);
    expect(await decisionRunIds(routedIds)).toHaveLength(3);
  });

  test("a projected spend over the run maximum is terminal and writes nothing", async () => {
    const namespace = freshNamespace();
    const ids = await seed(namespace, 3);
    const before = await runCount();
    const error: unknown = await handlerFor(
      namespace,
      0.000000001,
    )(JOB).catch((caught: unknown) => caught);
    expect(isMaintenanceTerminalError(error)).toBe(true);
    expect(String(error)).toMatch(
      /dream\.route projected \$.* over max .*nothing sent/,
    );
    expect(await runCount()).toBe(before);
    expect(await decisionRunIds(ids)).toHaveLength(0);
  });

  test("an empty slice writes nothing", async () => {
    const before = await runCount();
    await handlerFor(freshNamespace())(JOB);
    expect(await runCount()).toBe(before);
  });

  test("claimUnrouted keeps only the candidates with no decision", async () => {
    const namespace = freshNamespace();
    const ids = await seed(namespace, 3);
    await writeOtherRun(ids[0] ?? "", namespace);
    const kept = await withTransaction({
      pool,
      run: (client) => claimUnrouted({ client, candidateIds: ids }),
    });
    expect([...kept].sort()).toEqual(ids.slice(1).sort());
  });

  test("a candidate another job routed mid-run is not applied twice", async () => {
    const namespace = freshNamespace();
    const ids = await seed(namespace, 3);
    const racedId = ids[0] ?? "";
    const inner = fakeJevFetch();
    let calls = 0;
    const fetchFn: JevFetch = async (...args) => {
      calls += 1;
      if (calls === 1) await writeOtherRun(racedId, namespace);
      return inner(...args);
    };
    await makeDreamRouteHandler({
      pool,
      logger,
      namespace,
      route: {
        enabled: true,
        backend: "jev",
        sliceSize: 50,
        minGapMs: 0,
        maxUsdPerRun: 1,
      },
      jev: { config: fakeConfig(), fetchFn },
    })(JOB);
    expect(calls).toBeGreaterThan(0);
    expect(await decisionRunIds([racedId])).toHaveLength(1);
    expect(
      await hashCount(
        `SELECT count(*) AS n FROM thoughts WHERE content_hash = $1`,
        racedId,
      ),
    ).toBe(0);
    expect(
      await hashCount(
        `SELECT count(*) AS n FROM tier_moves AS m JOIN thoughts AS t
            ON m.entry_id::text = t.id::text WHERE t.content_hash = $1`,
        racedId,
      ),
    ).toBe(0);
    const others = await decisionRunIds(ids.slice(1));
    expect(others).toHaveLength(2);
    expect(new Set(others).size).toBe(1);
    const run = await pool.query<{ records: number }>(
      `SELECT records FROM routing_runs WHERE run_id = $1`,
      [others[0]],
    );
    expect(run.rows).toEqual([{ records: 2 }]);
  });
});
