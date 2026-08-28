/**
 * Live-Postgres tests for #345 stale-embedding repair: the writer-parity half.
 * These suites prove that rows written by the live formula are not falsely
 * flagged as source_drift, that the decision ON CONFLICT tag merge stays
 * stable, and that the real MaintenanceQueue + runner repairs a scoped batch.
 *
 * The suite demands the test database through requireTestDatabaseUrl(): absent
 * the variable it throws rather than skipping, so a database-less run fails
 * loudly instead of reporting a green suite that exercised nothing.
 *
 * The embedding PROVIDER is stubbed with a deterministic in-process vector so
 * the test never depends on a live endpoint; everything else runs against real
 * Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "../scripts/test-support/require-test-database.ts";
import { runMigrations } from "./db/migrate.ts";
import { EMBEDDING_MODEL, contentHash } from "./embedding.ts";
import {
  decisionCanonicalText,
  sessionSourceHashInput,
} from "./embedding-canonical.ts";
import { selectStale, repairOne, repairStaleBatch } from "./embedding-repair.ts";
import { MaintenanceQueue, MaintenanceQueueRunner } from "./maintenance-queue.ts";
import {
  buildEmbeddingRepairHandlers,
  EMBEDDING_REPAIR_JOB_KIND,
  EMBEDDING_REPAIR_JOB_VERSION,
} from "./embedding-repair-handler.ts";
import {
  CREATED_BY,
  NS_A,
  NS_B,
  STUB_VECTOR,
  cleanup,
  embeddingIsNull,
  expectDefined,
  seedMissingThought,
  seedWrittenDecision,
  seedWrittenSession,
  silentLogger,
  storedHash,
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

describe("embedding repair decisions by the live formula (live Postgres)", () => {
  const DECISION = {
    title: "Use Bun",
    rationale: "It is fast",
    context: "greenfield service",
    alternatives: ["Node", "Deno"],
    tags: ["runtime", "perf"],
  };

  it("a freshly written decision is NOT selected for source_drift", async () => {
    const id = await seedWrittenDecision(pool, NS_A, DECISION);
    const drifted = await selectStale(pool, "decisions", {
      reasons: ["source_drift"],
      scope: { namespaces: [NS_A] },
    });
    // The row's stored hash equals the registry's recomputed hash -> no drift.
    expect(drifted.find((c) => c.id === id)).toBeUndefined();
  });

  it("repeat-run repair is a no-op and preserves the content_hash", async () => {
    const id = await seedWrittenDecision(pool, NS_A, DECISION);
    const before = await storedHash(pool, "decisions", id);
    // Ask for every detectable reason -- none should fire for a valid row.
    const batch = await repairStaleBatch(pool, "decisions", stubEmbed, {
      scope: { namespaces: [NS_A] },
      reasons: ["missing", "source_drift"],
    });
    expect(batch.results.find((r) => r.id === id)).toBeUndefined();
    expect(batch.repaired).toBe(0);
    // The dedup key is untouched by a no-op repair pass.
    expect(await storedHash(pool, "decisions", id)).toBe(before);
    expect(before).toBe(contentHash(decisionCanonicalText(DECISION)));
  });

  it("a genuine source edit IS detected and repair writes the fresh hash back", async () => {
    const id = await seedWrittenDecision(pool, NS_A, DECISION);
    // Edit a field that participates in the canonical text.
    await pool.query("UPDATE decisions SET rationale = $1 WHERE id = $2", [
      "It is fast and safe",
      id,
    ]);
    const drifted = await selectStale(pool, "decisions", {
      reasons: ["source_drift"],
      scope: { namespaces: [NS_A] },
    });
    const hit = drifted.find((c) => c.id === id);
    expect(hit).toBeTruthy();
    await repairOne(pool, expectDefined(hit, "drifted row"), stubEmbed, {
      scope: { namespaces: [NS_A] },
    });
    expect(await storedHash(pool, "decisions", id)).toBe(
      contentHash(
        decisionCanonicalText({
          ...DECISION,
          rationale: "It is fast and safe",
        }),
      ),
    );
  });
});

const MERGE_DECISION = {
  title: "Adopt queue substrate",
  rationale: "durable retries",
  context: "MAINT lane",
  alternatives: ["cron", "inline"],
};

/** Insert/merge exactly like log_decision / POST /decisions. */
async function writeDecision(pool: Pool, ns: string, tags: string[]): Promise<string> {
  const pgvector = await import("pgvector/pg");
  const text = decisionCanonicalText({ ...MERGE_DECISION, tags });
  const hash = contentHash(text);
  const { rows } = await pool.query(
    `INSERT INTO decisions
       (title, rationale, alternatives, tags, context, created_by, namespace,
        embedding, content_hash, embedded_at, embedding_model)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, NOW(), $10)
     ON CONFLICT (content_hash, namespace) WHERE content_hash IS NOT NULL
     DO UPDATE SET
       tags = (
         SELECT COALESCE(array_agg(DISTINCT tag), '{}')
         FROM unnest(decisions.tags || EXCLUDED.tags) AS tag
         WHERE tag IS NOT NULL
       ),
       updated_at = NOW()
     RETURNING id`,
    [
      MERGE_DECISION.title,
      MERGE_DECISION.rationale,
      JSON.stringify(MERGE_DECISION.alternatives),
      tags,
      MERGE_DECISION.context,
      CREATED_BY,
      ns,
      pgvector.toSql(STUB_VECTOR),
      hash,
      EMBEDDING_MODEL,
    ],
  );
  return rows[0].id as string;
}

describe("embedding repair decision tag merge (live Postgres)", () => {
  it("reversed-tag re-write hits the merge but is NOT flagged as drift", async () => {
    // First write bakes the content_hash from the normalized (sorted) tags.
    const id = await writeDecision(pool, NS_A, ["runtime", "perf"]);
    const before = await storedHash(pool, "decisions", id);
    // Re-write the SAME decision with tags reversed. Because the canonical text
    // is order-independent, the content_hash matches -> the ON CONFLICT merge
    // fires and array_agg(DISTINCT) rewrites the tags column (possibly a new
    // order), WITHOUT changing content_hash.
    const mergedId = await writeDecision(pool, NS_A, ["perf", "runtime"]);
    expect(mergedId).toBe(id); // proves the merge path, not a second row
    expect(await storedHash(pool, "decisions", id)).toBe(before);

    // The repair registry recomputes source hash from the merged row's tags.
    // With deterministic normalization it must equal the stored hash -> NO drift.
    const drifted = await selectStale(pool, "decisions", {
      reasons: ["source_drift"],
      scope: { namespaces: [NS_A] },
    });
    expect(drifted.find((c) => c.id === id)).toBeUndefined();

    // And a full repair pass is a no-op: no rewrite, hash preserved.
    const batch = await repairStaleBatch(pool, "decisions", stubEmbed, {
      scope: { namespaces: [NS_A] },
      reasons: ["missing", "source_drift"],
    });
    expect(batch.results.find((r) => r.id === id)).toBeUndefined();
    expect(batch.repaired).toBe(0);
    expect(await storedHash(pool, "decisions", id)).toBe(before);
  });

  it("a duplicate-tag merge (array_agg DISTINCT) also stays stable", async () => {
    const id = await writeDecision(pool, NS_A, ["alpha", "beta"]);
    const before = await storedHash(pool, "decisions", id);
    // Merge a superset with a duplicate; array_agg(DISTINCT) collapses it.
    const mergedId = await writeDecision(pool, NS_A, ["beta", "alpha", "beta"]);
    expect(mergedId).toBe(id);
    const drifted = await selectStale(pool, "decisions", {
      reasons: ["source_drift"],
      scope: { namespaces: [NS_A] },
    });
    expect(drifted.find((c) => c.id === id)).toBeUndefined();
    expect(await storedHash(pool, "decisions", id)).toBe(before);
  });
});

describe("embedding repair sessions by the live formula (live Postgres)", () => {
  const SESSION = {
    summary: "did a lot of work",
    project: "open-brain",
    key_decisions: ["chose A", "dropped B"],
    next_steps: ["ship it"],
    blockers: ["waiting on review"],
  };

  it("a freshly written session is NOT selected for source_drift", async () => {
    const id = await seedWrittenSession(pool, NS_A, SESSION);
    const drifted = await selectStale(pool, "sessions", {
      reasons: ["source_drift"],
      scope: { namespaces: [NS_A] },
    });
    // Hash is summary|project (embed text differs) -- must still not drift.
    expect(drifted.find((c) => c.id === id)).toBeUndefined();
  });

  it("repeat-run repair is a no-op and preserves the content_hash", async () => {
    const id = await seedWrittenSession(pool, NS_A, SESSION);
    const before = await storedHash(pool, "sessions", id);
    const batch = await repairStaleBatch(pool, "sessions", stubEmbed, {
      scope: { namespaces: [NS_A] },
      reasons: ["missing", "source_drift"],
    });
    expect(batch.results.find((r) => r.id === id)).toBeUndefined();
    expect(batch.repaired).toBe(0);
    expect(await storedHash(pool, "sessions", id)).toBe(before);
    expect(before).toBe(contentHash(sessionSourceHashInput(SESSION)));
  });

  it("editing summary/project IS detected; editing only key_decisions is NOT (hash ignores it)", async () => {
    const id = await seedWrittenSession(pool, NS_A, SESSION);

    // key_decisions is embed-only, not part of the hash input: editing it must
    // NOT register as source_drift (the stored hash still matches).
    await pool.query("UPDATE sessions SET key_decisions = $1 WHERE id = $2", [
      ["chose A", "dropped B", "added C"],
      id,
    ]);
    let drifted = await selectStale(pool, "sessions", {
      reasons: ["source_drift"],
      scope: { namespaces: [NS_A] },
    });
    expect(drifted.find((c) => c.id === id)).toBeUndefined();

    // Editing the summary DOES change the hash input -> drift is detected.
    await pool.query("UPDATE sessions SET summary = $1 WHERE id = $2", [
      "did even more work",
      id,
    ]);
    drifted = await selectStale(pool, "sessions", {
      reasons: ["source_drift"],
      scope: { namespaces: [NS_A] },
    });
    const hit = drifted.find((c) => c.id === id);
    expect(hit).toBeTruthy();
    await repairOne(pool, expectDefined(hit, "drifted row"), stubEmbed, {
      scope: { namespaces: [NS_A] },
    });
    expect(await storedHash(pool, "sessions", id)).toBe(
      contentHash(
        sessionSourceHashInput({ ...SESSION, summary: "did even more work" }),
      ),
    );
  });
});

describe("embedding repair through the real maintenance queue (live Postgres)", () => {
  it("an enqueued embedding.repair job repairs the scoped batch and completes", async () => {
    const aId = await seedMissingThought(pool, NS_A, "queued-a");
    const bId = await seedMissingThought(pool, NS_B, "queued-b");

    const queue = new MaintenanceQueue(pool);
    await queue.enqueue({
      kind: EMBEDDING_REPAIR_JOB_KIND,
      version: EMBEDDING_REPAIR_JOB_VERSION,
      payload: { table: "thoughts", scope: { namespaces: [NS_A] } },
      idempotencyKey: `lane345-${NS_A}-thoughts`,
      scope: { namespace: NS_A },
      runAfter: new Date("2000-01-01T00:00:00.000Z"),
    });

    const handlers = buildEmbeddingRepairHandlers({
      db: pool,
      logger: silentLogger,
      embedFn: stubEmbed,
    });
    const runner = new MaintenanceQueueRunner({
      queue,
      handlers,
      logger: silentLogger,
      pollIntervalMs: 5,
      leaseMs: 30_000,
    });
    await runner.runOnce();
    // Give the dispatched handler time to finish, then drain.
    await runner.stop();

    // The ns-A row got repaired; the ns-B row (out of the job's scope) did not.
    expect(await embeddingIsNull(pool, "thoughts", aId)).toBe(false);
    expect(await embeddingIsNull(pool, "thoughts", bId)).toBe(true);

    // The job reached a terminal succeeded state (no dead-letter).
    const { rows } = await pool.query(
      "SELECT state FROM maintenance_jobs WHERE idempotency_key = $1",
      [`lane345-${NS_A}-thoughts`],
    );
    expect(rows[0].state).toBe("succeeded");
  });

  it("re-running the same job after repair is a no-op and still succeeds", async () => {
    await seedMissingThought(pool, NS_A, "idem-1");
    const queue = new MaintenanceQueue(pool);
    const handlers = buildEmbeddingRepairHandlers({
      db: pool,
      logger: silentLogger,
      embedFn: stubEmbed,
    });

    async function runJob(key: string): Promise<string> {
      await queue.enqueue({
        kind: EMBEDDING_REPAIR_JOB_KIND,
        version: EMBEDDING_REPAIR_JOB_VERSION,
        payload: { table: "thoughts", scope: { namespaces: [NS_A] } },
        idempotencyKey: key,
        scope: { namespace: NS_A },
        runAfter: new Date("2000-01-01T00:00:00.000Z"),
      });
      const runner = new MaintenanceQueueRunner({
        queue,
        handlers,
        logger: silentLogger,
        pollIntervalMs: 5,
      });
      await runner.runOnce();
      await runner.stop();
      const { rows } = await pool.query(
        "SELECT state FROM maintenance_jobs WHERE idempotency_key = $1",
        [key],
      );
      return rows[0].state as string;
    }

    // Distinct keys so each is a fresh queue unit; the SECOND finds nothing
    // stale (already repaired) yet still succeeds — a durable no-op.
    expect(await runJob("lane345-idem-run-1")).toBe("succeeded");
    expect(await runJob("lane345-idem-run-2")).toBe("succeeded");
  });
});
