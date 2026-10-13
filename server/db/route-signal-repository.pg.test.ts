/**
 * The route producer's database facts (issue 1525) against a migrated database.
 *
 * REQUIRES `OPENBRAIN_TEST_DATABASE_URL`; `npm run test:isolated` sets it.
 * Terminal times are seeded far in the future so another suite's jobs cannot
 * be the maximum; every row this suite writes is deleted by id.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "vitest";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../../scripts/test-support/require-test-database.ts";
import {
  readUnroutedSlice,
  writeRoutingRun,
  type RoutingDecisionRecord,
  type RoutingRunRecord,
} from "./dream-route-repository.ts";
import { createRouteSignalRepository } from "./route-signal-repository.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const repository = createRouteSignalRepository(pool);
const jobIds: string[] = [];

afterAll(async () => {
  await pool.query(`DELETE FROM maintenance_jobs WHERE id = ANY($1::uuid[])`, [jobIds]);
  await pool.end();
});

const EMBEDDING = `[${Array.from({ length: 768 }, () => "0.1").join(",")}]`;

async function seedJob(state: "queued" | "dead_letter", terminalAt: string | null) {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO maintenance_jobs (job_kind, job_version, payload, idempotency_key,
       state, terminal_at, dead_lettered_at)
     VALUES ('dream.route', 1, '{}'::jsonb, $1, $2, $3::timestamptz,
       CASE WHEN $2 = 'dead_letter' THEN $3::timestamptz END)
     RETURNING id`,
    [`route-signal-test:${randomUUID()}`, state, terminalAt],
  );
  const id = result.rows[0]?.id;
  if (id) jobIds.push(id);
}

async function seedCandidate(namespace: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO candidate_memory (id, namespace, candidate_type, content,
       content_hash, source_turn_ids, embedding)
     VALUES ($1, $2, 'fact', 'route signal test', $3, ARRAY[$4::uuid], $5::halfvec)`,
    [id, namespace, `hash-${id}`, randomUUID(), EMBEDDING],
  );
  return id;
}

const RUN: RoutingRunRecord = {
  matrixFingerprint: "fp-test",
  classifierVersion: "v-test",
  thresholds: { pickAt: 0.5 },
  backend: "test",
  servedModels: ["m"],
  records: 1,
  requests: 1,
  inputTokens: 10,
  estimatedUsd: 0,
  actualUsd: 0,
  ms: 5,
  note: "route signal test",
};

function decisionFor(candidateId: string, namespace: string): RoutingDecisionRecord {
  return {
    candidateId,
    namespace,
    destination: "fact",
    agreement: "high",
    authorityTier: "observed",
    restates: false,
    droveDecision: false,
    reasons: ["test"],
    raw: { pick: "fact" },
    servedModel: "m",
  };
}

async function routeAll(runId: string, ns: string): Promise<void> {
  const open = await readUnroutedSlice({
    db: pool,
    namespace: ns,
    sliceSize: 100000,
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await writeRoutingRun({
      client,
      runId,
      run: RUN,
      decisions: open.map((c) => decisionFor(c.id, c.namespace)),
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

describe("route signal facts (live Postgres)", () => {
  test("a dead-lettered dream.route job counts as the last terminal time", async () => {
    await seedJob("dead_letter", "2990-01-01T00:00:00Z");
    const facts = await repository.readFacts();
    expect(facts.last_route_terminal_at?.toISOString()).toBe(
      "2990-01-01T00:00:00.000Z",
    );
  });

  test("a queued dream.route job does not count", async () => {
    await seedJob("dead_letter", "2990-01-01T00:00:00Z");
    await seedJob("queued", null);
    const facts = await repository.readFacts();
    expect(facts.last_route_terminal_at?.toISOString()).toBe(
      "2990-01-01T00:00:00.000Z",
    );
  });

  test("has_unrouted flips to false once every candidate has a decision", async () => {
    const ns = `route-signal-${randomUUID()}`;
    const ids = [await seedCandidate(ns), await seedCandidate(ns)];
    const runId = randomUUID();
    const scoped = createRouteSignalRepository(pool, { namespace: ns });
    try {
      expect((await scoped.readFacts()).has_unrouted).toBe(true);
      await routeAll(runId, ns);
      expect((await scoped.readFacts()).has_unrouted).toBe(false);
    } finally {
      await pool.query(`DELETE FROM routing_decisions WHERE run_id = $1`, [runId]);
      await pool.query(`DELETE FROM routing_runs WHERE run_id = $1`, [runId]);
      await pool.query(`DELETE FROM candidate_memory WHERE id = ANY($1::uuid[])`, [
        ids,
      ]);
    }
  });
});
