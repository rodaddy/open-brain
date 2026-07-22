import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import type { Pool } from "pg";
import { MaintenanceQueue } from "../../maintenance-queue.ts";

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;
const migrationUrl = new URL("026_maintenance_queue.sql", import.meta.url);
const namespace = "test-maintenance-queue-026";

dbDescribe("026 maintenance queue (live Postgres)", () => {
  let pool: Pool;

  beforeAll(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: DB_URL });
  });

  async function migrate(): Promise<void> {
    await pool.query(await Bun.file(migrationUrl).text());
  }

  async function cleanup(): Promise<void> {
    await pool.query("DELETE FROM maintenance_jobs WHERE namespace = $1", [
      namespace,
    ]);
  }

  function queue(): MaintenanceQueue {
    return new MaintenanceQueue(pool);
  }

  async function enqueue(
    input: Partial<Parameters<MaintenanceQueue["enqueue"]>[0]> = {},
  ) {
    return queue().enqueue({
      kind: "maintenance.test",
      version: 1,
      payload: {},
      idempotencyKey: crypto.randomUUID(),
      scope: { namespace },
      // Default to a far-past run_after so tests that claim with a fixed
      // deterministic `now` see the job as due, instead of racing the DB's NOW().
      runAfter: new Date("2000-01-01T00:00:00.000Z"),
      ...input,
    });
  }

  beforeEach(async () => {
    await migrate();
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("enforces live migration constraints and idempotent enqueue", async () => {
    const first = await enqueue({
      idempotencyKey: "same-key",
      payload: { a: 1 },
    });
    // Identical semantics (key order aside) is a safe idempotent replay.
    const second = await enqueue({
      idempotencyKey: "same-key",
      payload: { a: 1 },
    });
    expect(second.id).toBe(first.id);

    // Reusing the key with a divergent payload must be rejected content-free,
    // not silently return the stale job under the old contract.
    await expect(
      enqueue({ idempotencyKey: "same-key", payload: { a: 2 } }),
    ).rejects.toThrow("divergent job semantics");
    // Divergent retry semantics under the same key must also be rejected.
    await expect(
      enqueue({
        idempotencyKey: "same-key",
        payload: { a: 1 },
        retry: { maxAttempts: 5 },
      }),
    ).rejects.toThrow("divergent job semantics");

    const { rows } = await pool.query<{ conname: string }>(
      `SELECT conname
         FROM pg_constraint
        WHERE conrelid = 'maintenance_jobs'::regclass`,
    );
    expect(rows.map((row) => row.conname)).toContain(
      "maintenance_jobs_unique_kind_idempotency",
    );
    expect(rows.map((row) => row.conname)).toContain(
      "maintenance_jobs_lease_shape",
    );
    expect(rows.map((row) => row.conname)).toContain(
      "maintenance_jobs_terminal_shape",
    );
  });

  it("persists the caller-forced terminal category (unsupported kind is not non_error)", async () => {
    await enqueue({ idempotencyKey: "unsupported", retry: { maxAttempts: 1 } });
    const [claimed] = await queue().claimDueJobs({
      limit: 1,
      now: new Date(),
      leaseMs: 60_000,
    });
    const dead = await queue().fail({
      job: claimed!,
      error: "unsupported_job_kind",
      category: "unsupported_job_kind",
    });
    expect(dead?.state).toBe("dead_letter");
    // Old behavior stored non_error because the sentinel is a plain string.
    expect(dead?.lastErrorCategory).toBe("unsupported_job_kind");
    const { rows } = await pool.query<{ last_error_category: string }>(
      "SELECT last_error_category FROM maintenance_jobs WHERE id = $1",
      [claimed!.id],
    );
    expect(rows[0]?.last_error_category).toBe("unsupported_job_kind");
  });

  it("rejects an out-of-bounds direct claim limit before touching the table", async () => {
    await expect(
      queue().claimDueJobs({ limit: 1_000, now: new Date(), leaseMs: 60_000 }),
    ).rejects.toThrow("claim limit exceeds the bound");
  });

  it("rejects an invalid namespace token content-free", async () => {
    await expect(
      enqueue({
        idempotencyKey: "bad-ns",
        scope: { namespace: "not a valid namespace!" },
      }),
    ).rejects.toThrow("namespace is invalid");
  });

  it("allows only one concurrent runner to claim a due job", async () => {
    await enqueue({ idempotencyKey: "single-claim" });
    const now = new Date();
    const [first, second] = await Promise.all([
      queue().claimDueJobs({ limit: 1, now, leaseMs: 60_000 }),
      queue().claimDueJobs({ limit: 1, now, leaseMs: 60_000 }),
    ]);
    expect(first.length + second.length).toBe(1);
  });

  it("does not steal an unexpired lease, reclaims an expired one, and rejects stale completion", async () => {
    await enqueue({ idempotencyKey: "leases" });
    const now = new Date("2026-07-22T12:00:00.000Z");
    const [first] = await queue().claimDueJobs({
      limit: 1,
      now,
      leaseMs: 1_000,
    });
    expect(first).toBeDefined();
    expect(
      await queue().claimDueJobs({
        limit: 1,
        now: new Date(now.getTime() + 999),
        leaseMs: 1_000,
      }),
    ).toHaveLength(0);

    const [reclaimed] = await queue().claimDueJobs({
      limit: 1,
      now: new Date(now.getTime() + 1_000),
      leaseMs: 1_000,
    });
    expect(reclaimed?.id).toBe(first?.id);
    expect(reclaimed?.attempts).toBe(2);
    expect(
      await queue().complete(
        first!.id,
        first!.leaseToken!,
        new Date(now.getTime() + 1_001),
      ),
    ).toBe(false);
    expect(
      await queue().complete(
        reclaimed!.id,
        reclaimed!.leaseToken!,
        new Date(now.getTime() + 1_001),
      ),
    ).toBe(true);
  });

  it("retries at a deterministic time, dead-letters terminal attempts, and recovers after a restart", async () => {
    const now = new Date("2026-07-22T13:00:00.000Z");
    await enqueue({
      idempotencyKey: "retry",
      retry: { maxAttempts: 2, backoffBaseMs: 1_000, backoffMaxMs: 4_000 },
    });
    const [first] = await queue().claimDueJobs({
      limit: 1,
      now,
      leaseMs: 1_000,
    });
    const retry = await queue().fail({
      job: first!,
      error: new TypeError("content must not persist"),
      now,
    });
    expect(retry).toMatchObject({
      state: "queued",
      lastErrorCategory: "type_error",
    });
    expect(retry?.runAfter.toISOString()).toBe("2026-07-22T13:00:01.000Z");

    const [second] = await queue().claimDueJobs({
      limit: 1,
      now: retry!.runAfter,
      leaseMs: 1_000,
    });
    const deadLetter = await queue().fail({
      job: second!,
      error: new Error("still private"),
      now: retry!.runAfter,
    });
    expect(deadLetter?.state).toBe("dead_letter");
    expect(deadLetter?.terminalAt).toBeInstanceOf(Date);
    expect(deadLetter?.deadLetteredAt).toBeInstanceOf(Date);

    const recovered = await enqueue({ idempotencyKey: "restart" });
    const [beforeRestart] = await queue().claimDueJobs({
      limit: 1,
      now,
      leaseMs: 1_000,
    });
    expect(beforeRestart?.id).toBe(recovered.id);
    const restartedQueue = new MaintenanceQueue(pool);
    const [afterRestart] = await restartedQueue.claimDueJobs({
      limit: 1,
      now: new Date(now.getTime() + 1_000),
      leaseMs: 1_000,
    });
    expect(afterRestart?.id).toBe(recovered.id);
    expect(afterRestart?.attempts).toBe(2);
  });
});
