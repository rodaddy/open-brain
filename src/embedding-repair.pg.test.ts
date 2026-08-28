/**
 * Live-Postgres tests for #345 stale-embedding repair: the scope-and-drift
 * half. These tests prove cross-namespace isolation on SELECT and on the
 * guarded UPDATE, that a missing embedding is repaired within scope, that a
 * batch pass is idempotent, and that source drift is detected then cleared.
 * The writer-parity suites live in src/embedding-repair-formula.pg.test.ts.
 *
 * The suite demands the test database through requireTestDatabaseUrl(): absent
 * the variable it throws rather than skipping, so a database-less run fails
 * loudly instead of reporting a green suite that exercised nothing.
 *
 * The embedding PROVIDER is stubbed with a deterministic in-process vector so
 * the test never depends on a live endpoint; everything else -- the SELECTs,
 * the guarded UPDATEs, and namespace binding -- runs against real Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../scripts/test-support/require-test-database.ts";
import { runMigrations } from "./db/migrate.ts";
import { contentHash } from "./embedding.ts";
import { selectStale, repairOne, repairStaleBatch } from "./embedding-repair.ts";
import {
  CREATED_BY,
  NS_A,
  NS_B,
  cleanup,
  embeddingIsNull,
  expectDefined,
  seedMissingEntity,
  seedMissingThought,
  stubEmbed,
} from "./embedding-repair-test-helpers.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

beforeAll(async () => {
  const pgvector = await import("pgvector/pg");
  pool.on("connect", (client) => {
    pgvector.registerTypes(client).catch(() => {});
  });
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  await runMigrations(pool);
});

beforeEach(() => cleanup(pool));

afterAll(async () => {
  await cleanup(pool);
  await pool.end();
});

async function selectStaleScopesToNamespace(): Promise<void> {
  await seedMissingThought(pool, NS_A, "a1");
  await seedMissingThought(pool, NS_B, "b1");

  const aOnly = await selectStale(pool, "thoughts", {
    reasons: ["missing"],
    scope: { namespaces: [NS_A] },
  });
  const ids = aOnly.map((c) => c.id);
  const aRow = await pool.query(
    "SELECT id FROM thoughts WHERE namespace = $1 AND created_by = $2",
    [NS_A, CREATED_BY],
  );
  const bRow = await pool.query(
    "SELECT id FROM thoughts WHERE namespace = $1 AND created_by = $2",
    [NS_B, CREATED_BY],
  );
  expect(ids).toContain(aRow.rows[0].id);
  expect(ids).not.toContain(bRow.rows[0].id);
}

async function repairOneCannotEscapeScope(): Promise<void> {
  const bId = await seedMissingThought(pool, NS_B, "b-secret");
  // Build a candidate for the ns-B row but repair it under an ns-A scope.
  const bCandidate = {
    table: "thoughts",
    id: bId,
    reasons: ["missing" as const],
    row: { id: bId, content: "b-secret", tags: [], namespace: NS_B },
  };
  const res = await repairOne(pool, bCandidate, stubEmbed, {
    scope: { namespaces: [NS_A] }, // WRONG namespace on purpose
  });
  // The namespace predicate on the UPDATE filters it out -> zero rows matched.
  expect(res.status).toBe("skipped_source_changed");
  expect(res.updated).toBe(false);
  // Proof: the ns-B row is still unembedded (never written cross-namespace).
  expect(await embeddingIsNull(pool, "thoughts", bId)).toBe(true);
}

async function repairOneRepairsMissingInScope(): Promise<void> {
  const aId = await seedMissingThought(pool, NS_A, "repair me");
  const [cand] = await selectStale(pool, "thoughts", {
    reasons: ["missing"],
    scope: { namespaces: [NS_A] },
  });
  const candidate = expectDefined(cand, "stale candidate");
  expect(candidate.id).toBe(aId);
  const res = await repairOne(pool, candidate, stubEmbed, {
    scope: { namespaces: [NS_A] },
  });
  expect(res.status).toBe("repaired");
  expect(await embeddingIsNull(pool, "thoughts", aId)).toBe(false);

  // Content-hash + model were written -> the row is no longer "missing" and
  // no longer model/source drifted, so a re-scan finds nothing.
  const again = await selectStale(pool, "thoughts", {
    reasons: ["missing", "model_drift", "source_drift"],
    scope: { namespaces: [NS_A] },
  });
  expect(again.find((c) => c.id === aId)).toBeUndefined();
}

async function repairStaleBatchReplayIsNoOp(): Promise<void> {
  for (let i = 0; i < 5; i++) await seedMissingThought(pool, NS_A, `batch-${i}`);
  await seedMissingThought(pool, NS_B, "other-ns"); // must never be touched

  const first = await repairStaleBatch(pool, "thoughts", stubEmbed, {
    scope: { namespaces: [NS_A] },
    reasons: ["missing"],
    limit: 3, // bounded: only 3 of the 5 this pass
  });
  expect(first.selected).toBe(3);
  expect(first.repaired).toBe(3);

  const second = await repairStaleBatch(pool, "thoughts", stubEmbed, {
    scope: { namespaces: [NS_A] },
    reasons: ["missing"],
    limit: 3,
  });
  // Two still-missing remain; the 3 already repaired are not re-selected.
  expect(second.selected).toBe(2);
  expect(second.repaired).toBe(2);

  // Third pass: nothing left stale in ns-A -> a true no-op.
  const third = await repairStaleBatch(pool, "thoughts", stubEmbed, {
    scope: { namespaces: [NS_A] },
    reasons: ["missing"],
  });
  expect(third.selected).toBe(0);
  expect(third.repaired).toBe(0);

  // ns-B row was never in scope and stays unembedded.
  const bRow = await pool.query(
    "SELECT embedding IS NULL AS n FROM thoughts WHERE namespace = $1 AND created_by = $2",
    [NS_B, CREATED_BY],
  );
  expect(bRow.rows[0].n).toBe(true);
}

async function entitiesRepairWritesEmbeddingOnly(): Promise<void> {
  const enId = await seedMissingEntity(pool, NS_A, "Ada");
  const [cand] = await selectStale(pool, "ob_entities", {
    reasons: ["missing"],
    scope: { namespaces: [NS_A] },
  });
  const candidate = expectDefined(cand, "stale candidate");
  expect(candidate.id).toBe(enId);
  const res = await repairOne(pool, candidate, stubEmbed, {
    scope: { namespaces: [NS_A] },
  });
  expect(res.status).toBe("repaired");
  expect(await embeddingIsNull(pool, "ob_entities", enId)).toBe(false);

  // Replaying finds nothing (embedding now present) -> idempotent no-op.
  const again = await selectStale(pool, "ob_entities", {
    reasons: ["missing"],
    scope: { namespaces: [NS_A] },
  });
  expect(again.find((c) => c.id === enId)).toBeUndefined();
}

async function sourceDriftDetectedThenCleared(): Promise<void> {
  // Seed a thought and repair it so content_hash = hash("v1").
  const id = await seedMissingThought(pool, NS_A, "v1");
  const [c1] = await selectStale(pool, "thoughts", {
    reasons: ["missing"],
    scope: { namespaces: [NS_A] },
  });
  const seeded = expectDefined(c1, "seeded candidate");
  await repairOne(pool, seeded, stubEmbed, { scope: { namespaces: [NS_A] } });

  // Now the source text changes out from under the stored hash.
  await pool.query("UPDATE thoughts SET content = $1 WHERE id = $2", ["v2-edited", id]);

  const drifted = await selectStale(pool, "thoughts", {
    reasons: ["source_drift"],
    scope: { namespaces: [NS_A] },
  });
  const hit = drifted.find((c) => c.id === id);
  expect(hit).toBeTruthy();
  const drift = expectDefined(hit, "drifted candidate");
  expect(drift.reasons).toContain("source_drift");

  // Repair re-embeds and writes the fresh hash; drift is gone.
  await repairOne(pool, drift, stubEmbed, { scope: { namespaces: [NS_A] } });
  const { rows } = await pool.query("SELECT content_hash FROM thoughts WHERE id = $1", [
    id,
  ]);
  expect(rows[0].content_hash).toBe(contentHash("v2-edited"));
}

describe("embedding repair scope and drift (live Postgres)", () => {
  // --- Cross-namespace isolation on SELECT ---------------------------------

  it(
    "selectStale only returns rows in the auth-derived namespace",
    selectStaleScopesToNamespace,
  );

  // --- Cross-namespace isolation on the guarded UPDATE ---------------------

  it(
    "repairOne cannot mutate a row outside its scope even by id",
    repairOneCannotEscapeScope,
  );

  it(
    "repairOne repairs a missing embedding within scope and detection converges",
    repairOneRepairsMissingInScope,
  );

  it(
    "repairStaleBatch is bounded and idempotent (replay is a no-op)",
    repairStaleBatchReplayIsNoOp,
  );

  it(
    "entities (no content_hash) repair writes only the embedding column",
    entitiesRepairWritesEmbeddingOnly,
  );

  it(
    "source_drift is detected then cleared by repair (hash written back)",
    sourceDriftDetectedThenCleared,
  );
});
