/**
 * Live-Postgres tests for #345 stale-embedding repair, exercising the real
 * schema, real cross-namespace isolation, and the real MaintenanceQueue +
 * MaintenanceQueueRunner from #343.
 *
 * Gated on OPENBRAIN_TEST_DATABASE_URL (repo convention); skips when unset so a
 * DB-less CI job passes while the db-integration job runs it against Postgres.
 *
 * The embedding PROVIDER is stubbed with a deterministic in-process vector so
 * the test never depends on a live MLX/OpenAI endpoint; everything else — the
 * SELECTs, the guarded UPDATEs, namespace binding, and the queue handler — runs
 * against real Postgres.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import type { Pool } from "pg";
import { runMigrations } from "./db/migrate.ts";
import { EMBEDDING_DIMENSIONS, contentHash } from "./embedding.ts";
import {
  selectStale,
  repairOne,
  repairStaleBatch,
  type EmbedWithMetaFn,
} from "./embedding-repair.ts";
import {
  MaintenanceQueue,
  MaintenanceQueueRunner,
  type MaintenanceQueueLogger,
} from "./maintenance-queue.ts";
import {
  buildEmbeddingRepairHandlers,
  EMBEDDING_REPAIR_JOB_KIND,
  EMBEDDING_REPAIR_JOB_VERSION,
} from "./embedding-repair-handler.ts";

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;

// Deterministic, provider-free embedding: a fixed unit vector. Repair only needs
// a valid halfvec(768); content correctness is the provider's concern, not ours.
const stubEmbed: EmbedWithMetaFn = async () => ({
  embedding: Array(EMBEDDING_DIMENSIONS).fill(0.01),
});

const NS_A = "ns-a-lane345";
const NS_B = "ns-b-lane345";
const CREATED_BY = "lane345-test";
// Every maintenance job this suite enqueues shares this idempotency-key prefix,
// so cleanup can delete exactly the queue rows this suite owns and nothing else.
const JOB_KEY_PREFIX = "lane345-";

const silentLogger: MaintenanceQueueLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

dbDescribe("embedding repair (live Postgres, multi-namespace)", () => {
  let pool: Pool;

  beforeAll(async () => {
    const { Pool } = await import("pg");
    const pgvector = await import("pgvector/pg");
    pool = new Pool({ connectionString: DB_URL });
    pool.on("connect", (client) => {
      pgvector.registerTypes(client).catch(() => {});
    });
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    await runMigrations(pool);
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  async function cleanup(): Promise<void> {
    await pool.query("DELETE FROM ob_session_events WHERE created_by = $1", [
      CREATED_BY,
    ]);
    await pool.query("DELETE FROM ob_session_lanes WHERE created_by = $1", [
      CREATED_BY,
    ]);
    for (const t of ["thoughts", "ob_entities"]) {
      await pool.query(`DELETE FROM ${t} WHERE created_by = $1`, [CREATED_BY]);
    }
    // Clear the suite's own queue rows too. maintenance_jobs is durable and its
    // ON CONFLICT (job_kind, idempotency_key) DO NOTHING enqueue is idempotent:
    // a job left in a terminal `succeeded` state from a prior run is no longer
    // claimable, so re-enqueuing the same key returns that stale succeeded job
    // and the runner never repairs the freshly-seeded rows. Deleting the
    // suite-owned keys makes every run start with a claimable queue.
    await pool.query(
      "DELETE FROM maintenance_jobs WHERE idempotency_key LIKE $1",
      [`${JOB_KEY_PREFIX}%`],
    );
  }

  beforeEach(cleanup);

  /** Seed a thought with NO embedding (missing) in a given namespace. */
  async function seedMissingThought(
    ns: string,
    content: string,
  ): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO thoughts (content, created_by, namespace) VALUES ($1, $2, $3) RETURNING id`,
      [content, CREATED_BY, ns],
    );
    return rows[0].id as string;
  }

  async function seedMissingEntity(ns: string, name: string): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO ob_entities (entity_type, name, created_by, namespace)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      ["person", name, CREATED_BY, ns],
    );
    return rows[0].id as string;
  }

  async function embeddingIsNull(table: string, id: string): Promise<boolean> {
    const { rows } = await pool.query(
      `SELECT embedding IS NULL AS is_null FROM ${table} WHERE id = $1`,
      [id],
    );
    return rows[0].is_null as boolean;
  }

  // --- Cross-namespace isolation on SELECT ---------------------------------

  it("selectStale only returns rows in the auth-derived namespace", async () => {
    await seedMissingThought(NS_A, "a1");
    await seedMissingThought(NS_B, "b1");

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
  });

  // --- Cross-namespace isolation on the guarded UPDATE ---------------------

  it("repairOne cannot mutate a row outside its scope even by id", async () => {
    const bId = await seedMissingThought(NS_B, "b-secret");
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
    expect(await embeddingIsNull("thoughts", bId)).toBe(true);
  });

  it("repairOne repairs a missing embedding within scope and detection converges", async () => {
    const aId = await seedMissingThought(NS_A, "repair me");
    const [cand] = await selectStale(pool, "thoughts", {
      reasons: ["missing"],
      scope: { namespaces: [NS_A] },
    });
    expect(cand!.id).toBe(aId);
    const res = await repairOne(pool, cand!, stubEmbed, {
      scope: { namespaces: [NS_A] },
    });
    expect(res.status).toBe("repaired");
    expect(await embeddingIsNull("thoughts", aId)).toBe(false);

    // Content-hash + model were written -> the row is no longer "missing" and
    // no longer model/source drifted, so a re-scan finds nothing.
    const again = await selectStale(pool, "thoughts", {
      reasons: ["missing", "model_drift", "source_drift"],
      scope: { namespaces: [NS_A] },
    });
    expect(again.find((c) => c.id === aId)).toBeUndefined();
  });

  it("repairStaleBatch is bounded and idempotent (replay is a no-op)", async () => {
    for (let i = 0; i < 5; i++) await seedMissingThought(NS_A, `batch-${i}`);
    await seedMissingThought(NS_B, "other-ns"); // must never be touched

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
  });

  it("entities (no content_hash) repair writes only the embedding column", async () => {
    const enId = await seedMissingEntity(NS_A, "Ada");
    const [cand] = await selectStale(pool, "ob_entities", {
      reasons: ["missing"],
      scope: { namespaces: [NS_A] },
    });
    expect(cand!.id).toBe(enId);
    const res = await repairOne(pool, cand!, stubEmbed, {
      scope: { namespaces: [NS_A] },
    });
    expect(res.status).toBe("repaired");
    expect(await embeddingIsNull("ob_entities", enId)).toBe(false);

    // Replaying finds nothing (embedding now present) -> idempotent no-op.
    const again = await selectStale(pool, "ob_entities", {
      reasons: ["missing"],
      scope: { namespaces: [NS_A] },
    });
    expect(again.find((c) => c.id === enId)).toBeUndefined();
  });

  it("source_drift is detected then cleared by repair (hash written back)", async () => {
    // Seed a thought and repair it so content_hash = hash("v1").
    const id = await seedMissingThought(NS_A, "v1");
    const [c1] = await selectStale(pool, "thoughts", {
      reasons: ["missing"],
      scope: { namespaces: [NS_A] },
    });
    await repairOne(pool, c1!, stubEmbed, { scope: { namespaces: [NS_A] } });

    // Now the source text changes out from under the stored hash.
    await pool.query("UPDATE thoughts SET content = $1 WHERE id = $2", [
      "v2-edited",
      id,
    ]);

    const drifted = await selectStale(pool, "thoughts", {
      reasons: ["source_drift"],
      scope: { namespaces: [NS_A] },
    });
    const hit = drifted.find((c) => c.id === id);
    expect(hit).toBeTruthy();
    expect(hit!.reasons).toContain("source_drift");

    // Repair re-embeds and writes the fresh hash; drift is gone.
    await repairOne(pool, hit!, stubEmbed, { scope: { namespaces: [NS_A] } });
    const { rows } = await pool.query(
      "SELECT content_hash FROM thoughts WHERE id = $1",
      [id],
    );
    expect(rows[0].content_hash).toBe(contentHash("v2-edited"));
  });

  // --- End-to-end through the real queue + runner --------------------------

  describe("through the real MaintenanceQueue + runner", () => {
    it("an enqueued embedding.repair job repairs the scoped batch and completes", async () => {
      const aId = await seedMissingThought(NS_A, "queued-a");
      const bId = await seedMissingThought(NS_B, "queued-b");

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
      expect(await embeddingIsNull("thoughts", aId)).toBe(false);
      expect(await embeddingIsNull("thoughts", bId)).toBe(true);

      // The job reached a terminal succeeded state (no dead-letter).
      const { rows } = await pool.query(
        "SELECT state FROM maintenance_jobs WHERE idempotency_key = $1",
        [`lane345-${NS_A}-thoughts`],
      );
      expect(rows[0].state).toBe("succeeded");
    });

    it("re-running the same job after repair is a no-op and still succeeds", async () => {
      await seedMissingThought(NS_A, "idem-1");
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
});
