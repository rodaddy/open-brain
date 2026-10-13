/**
 * The public DREAM routing repository (issue 1525): the unrouted-slice read
 * and the run-history write against a migrated database.
 *
 * REQUIRES `OPENBRAIN_TEST_DATABASE_URL`; `npm run test:isolated` sets it.
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

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

afterAll(async () => {
  await pool.end();
});

const EMBEDDING = `[${Array.from({ length: 768 }, () => "0.1").join(",")}]`;

interface Seed {
  namespace: string;
  embedded?: boolean;
  parentId?: string;
  createdAt?: string;
}

async function seed(input: Seed): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO candidate_memory (id, namespace, candidate_type, content,
       content_hash, source_turn_ids, embedding, parent_id, chunk_index, created_at)
     VALUES ($1, $2, 'fact', 'route repository test', $3, ARRAY[$4::uuid],
       $5::halfvec, $6, $7, COALESCE($8::timestamptz, now()))`,
    [
      id,
      input.namespace,
      `hash-${id}`,
      randomUUID(),
      input.embedded === false ? null : EMBEDDING,
      input.parentId ?? null,
      input.parentId ? 1 : null,
      input.createdAt ?? null,
    ],
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
  note: "route repository test",
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

async function cleanup(
  ids: readonly string[],
  runIds: readonly string[],
): Promise<void> {
  await pool.query(
    `DELETE FROM routing_decisions WHERE candidate_id = ANY($1::uuid[])`,
    [ids],
  );
  await pool.query(`DELETE FROM routing_runs WHERE run_id = ANY($1::uuid[])`, [runIds]);
  await pool.query(`DELETE FROM candidate_memory WHERE id = ANY($1::uuid[])`, [ids]);
}

async function storeRun(
  runId: string,
  decisions: RoutingDecisionRecord[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await writeRoutingRun({ client, runId, run: RUN, decisions });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function writeThenRollBack(
  runId: string,
  decisions: RoutingDecisionRecord[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await writeRoutingRun({ client, runId, run: RUN, decisions });
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
}

async function rowsForRun(
  table: "routing_runs" | "routing_decisions",
  runId: string,
): Promise<number | null> {
  const result = await pool.query(`SELECT 1 FROM ${table} WHERE run_id = $1`, [runId]);
  return result.rowCount;
}

describe("public DREAM routing repository (live Postgres)", () => {
  test("returns an embedded top-level candidate, not a part or an unembedded one", async () => {
    const ns = `route-repo-${randomUUID()}`;
    const ids: string[] = [];
    try {
      const head = await seed({ namespace: ns });
      ids.push(head);
      ids.push(await seed({ namespace: ns, parentId: head }));
      ids.push(await seed({ namespace: ns, embedded: false }));
      const rows = await readUnroutedSlice({ db: pool, namespace: ns, sliceSize: 10 });
      expect(rows.map((r) => r.id)).toEqual([head]);
      expect(rows[0]?.first_said_at).toBeNull();
    } finally {
      await cleanup(ids, []);
    }
  });

  test("a candidate with a stored decision is no longer returned", async () => {
    const ns = `route-repo-${randomUUID()}`;
    const runId = randomUUID();
    const ids: string[] = [];
    try {
      const routed = await seed({ namespace: ns });
      const open = await seed({ namespace: ns });
      ids.push(routed, open);
      await storeRun(runId, [decisionFor(routed, ns)]);
      const rows = await readUnroutedSlice({ db: pool, namespace: ns, sliceSize: 10 });
      expect(rows.map((r) => r.id)).toEqual([open]);
    } finally {
      await cleanup(ids, [runId]);
    }
  });

  test("filters by namespace, and null reads every namespace", async () => {
    const nsA = `route-repo-${randomUUID()}`;
    const nsB = `route-repo-${randomUUID()}`;
    const ids: string[] = [];
    try {
      const a = await seed({ namespace: nsA });
      const b = await seed({ namespace: nsB });
      ids.push(a, b);
      const onlyA = await readUnroutedSlice({
        db: pool,
        namespace: nsA,
        sliceSize: 10,
      });
      expect(onlyA.map((r) => r.id)).toEqual([a]);
      const all = await readUnroutedSlice({
        db: pool,
        namespace: null,
        sliceSize: 100000,
      });
      const allIds = all.map((r) => r.id);
      expect(allIds).toContain(a);
      expect(allIds).toContain(b);
    } finally {
      await cleanup(ids, []);
    }
  });

  test("honours sliceSize and orders by created_at, then id", async () => {
    const ns = `route-repo-${randomUUID()}`;
    const ids: string[] = [];
    try {
      const late = await seed({ namespace: ns, createdAt: "2026-01-03T00:00:00Z" });
      const early = await seed({ namespace: ns, createdAt: "2026-01-01T00:00:00Z" });
      const tieOne = await seed({ namespace: ns, createdAt: "2026-01-02T00:00:00Z" });
      const tieTwo = await seed({ namespace: ns, createdAt: "2026-01-02T00:00:00Z" });
      ids.push(late, early, tieOne, tieTwo);
      const ties = [tieOne, tieTwo].sort();
      const rows = await readUnroutedSlice({ db: pool, namespace: ns, sliceSize: 3 });
      expect(rows.map((r) => r.id)).toEqual([early, ...ties]);
      await expect(
        readUnroutedSlice({ db: pool, namespace: ns, sliceSize: 0 }),
      ).rejects.toThrow(/positive integer/);
    } finally {
      await cleanup(ids, []);
    }
  });

  test("a rolled-back transaction leaves no run or decision rows", async () => {
    const ns = `route-repo-${randomUUID()}`;
    const runId = randomUUID();
    const ids: string[] = [];
    try {
      const candidate = await seed({ namespace: ns });
      ids.push(candidate);
      await writeThenRollBack(runId, [decisionFor(candidate, ns)]);
      expect(await rowsForRun("routing_runs", runId)).toBe(0);
      expect(await rowsForRun("routing_decisions", runId)).toBe(0);
    } finally {
      await cleanup(ids, [runId]);
    }
  });
});
