import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import type { Pool } from "pg";
import {
  MaintenanceQueue,
  MaintenanceQueueRunner,
  type MaintenanceJob,
  type MaintenanceJobHandler,
} from "../../maintenance-queue.ts";

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

  it("dead-letters an expired lease once its execution attempts are exhausted, not reclaims it forever", async () => {
    // maxAttempts=1: exactly one handler execution is allowed. The claim below
    // consumes it (attempts 0 -> 1). The lease then expires without a
    // complete()/fail(), simulating a handler that hung or crashed.
    await enqueue({
      idempotencyKey: "expired-bound",
      retry: { maxAttempts: 1 },
    });
    const now = new Date("2026-07-22T14:00:00.000Z");
    const [first] = await queue().claimDueJobs({
      limit: 1,
      now,
      leaseMs: 1_000,
    });
    expect(first).toBeDefined();
    expect(first?.attempts).toBe(1);

    // Old behavior: the expired running row is reclaimed unconditionally,
    // attempts -> 2, state stays running, and it is returned as a fresh claim —
    // a second handler execution past the maxAttempts=1 bound. The bounded
    // behavior returns nothing and terminates the row instead.
    const afterExpiry = new Date(now.getTime() + 1_000);
    const reclaimed = await queue().claimDueJobs({
      limit: 1,
      now: afterExpiry,
      leaseMs: 1_000,
    });
    expect(reclaimed).toHaveLength(0);

    const { rows } = await pool.query<{
      state: string;
      attempts: number;
      lease_token: string | null;
      lease_until: string | null;
      last_error_category: string | null;
      terminal_at: string | null;
      dead_lettered_at: string | null;
    }>(
      `SELECT state, attempts, lease_token, lease_until, last_error_category,
              terminal_at, dead_lettered_at
         FROM maintenance_jobs WHERE id = $1`,
      [first!.id],
    );
    const row = rows[0];
    expect(row?.state).toBe("dead_letter");
    // attempts stays at the number of execution leases actually consumed (1),
    // never inflated past max_attempts by the expiry sweep.
    expect(row?.attempts).toBe(1);
    expect(row?.lease_token).toBeNull();
    expect(row?.lease_until).toBeNull();
    expect(row?.last_error_category).toBe("lease_expired");
    expect(row?.terminal_at).not.toBeNull();
    expect(row?.dead_lettered_at).not.toBeNull();

    // The terminated row cannot be reclaimed again on any later sweep.
    const laterSweep = await queue().claimDueJobs({
      limit: 1,
      now: new Date(now.getTime() + 10_000),
      leaseMs: 1_000,
    });
    expect(laterSweep).toHaveLength(0);
  });

  it("still reclaims an expired lease that has execution attempts remaining", async () => {
    // maxAttempts=3: after one claim (attempts 1) an expired lease has budget,
    // so the bounded sweep must still reclaim it rather than dead-letter it.
    await enqueue({
      idempotencyKey: "expired-with-budget",
      retry: { maxAttempts: 3 },
    });
    const now = new Date("2026-07-22T15:00:00.000Z");
    const [first] = await queue().claimDueJobs({
      limit: 1,
      now,
      leaseMs: 1_000,
    });
    expect(first?.attempts).toBe(1);
    const [reclaimed] = await queue().claimDueJobs({
      limit: 1,
      now: new Date(now.getTime() + 1_000),
      leaseMs: 1_000,
    });
    expect(reclaimed?.id).toBe(first?.id);
    expect(reclaimed?.attempts).toBe(2);
    expect(reclaimed?.state).toBe("running");
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

  // Drive the real runner over the real queue with a handler that mutates the
  // job's durable retry fields before throwing. The terminal decision and the
  // retry schedule must come from the persisted row, not the mutated object, so
  // no caller-supplied retry-policy value can decide the transition.
  function runnerFor(
    handlers: Record<string, MaintenanceJobHandler>,
    fixedNow: Date,
  ): MaintenanceQueueRunner {
    return new MaintenanceQueueRunner({
      queue: queue(),
      handlers: new Map(Object.entries(handlers)),
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      concurrency: 1,
      leaseMs: 60_000,
      now: () => fixedNow,
    });
  }

  it("dead-letters at attempt 1 when a handler inflates maxAttempts/backoff before throwing", async () => {
    // maxAttempts=1: exactly one execution is allowed, so a first failure must
    // dead-letter. The handler tries to buy itself more attempts and a larger
    // backoff by mutating the job it was handed. The durable row's max_attempts
    // must still terminate it — the caller cannot override the terminal bound.
    const created = await enqueue({
      idempotencyKey: "mutating-terminal",
      retry: { maxAttempts: 1, backoffBaseMs: 1_000, backoffMaxMs: 4_000 },
    });
    const fixedNow = new Date("2026-07-22T16:00:00.000Z");
    let observed: MaintenanceJob | undefined;
    const runner = runnerFor(
      {
        "maintenance.test": async (job) => {
          observed = job;
          // Handler mutates the in-memory retry policy, then throws.
          job.maxAttempts = 99;
          job.backoffBaseMs = 1;
          job.backoffMaxMs = 1;
          job.attempts = 0;
          throw new Error("handler blew up after tampering with retry policy");
        },
      },
      fixedNow,
    );
    await runner.runOnce();
    await runner.stop();

    expect(observed?.id).toBe(created.id);
    const { rows } = await pool.query<{
      state: string;
      attempts: number;
      max_attempts: number;
      run_after: string;
      lease_token: string | null;
      terminal_at: string | null;
      dead_lettered_at: string | null;
    }>(
      `SELECT state, attempts, max_attempts, run_after, lease_token,
              terminal_at, dead_lettered_at
         FROM maintenance_jobs WHERE id = $1`,
      [created.id],
    );
    const row = rows[0];
    // Persisted policy wins: one execution consumed, terminal at attempt 1.
    expect(row?.state).toBe("dead_letter");
    expect(row?.attempts).toBe(1);
    expect(row?.max_attempts).toBe(1);
    expect(row?.lease_token).toBeNull();
    expect(row?.terminal_at).not.toBeNull();
    expect(row?.dead_lettered_at).not.toBeNull();

    // No requeue: the terminated row is never claimed again.
    const later = await queue().claimDueJobs({
      limit: 1,
      now: new Date(fixedNow.getTime() + 60_000),
      leaseMs: 1_000,
    });
    expect(later).toHaveLength(0);
  });

  it("schedules the next retry from the persisted backoff, not a handler-mutated one", async () => {
    // maxAttempts=3 leaves budget after the first failure, so the row requeues.
    // The handler shrinks backoff_base/max on the object before throwing; the
    // persisted schedule (base 2000ms at attempt 1) must be used, so run_after
    // is now + 2000ms, not now + 1ms.
    const created = await enqueue({
      idempotencyKey: "mutating-schedule",
      retry: { maxAttempts: 3, backoffBaseMs: 2_000, backoffMaxMs: 8_000 },
    });
    const fixedNow = new Date("2026-07-22T17:00:00.000Z");
    const runner = runnerFor(
      {
        "maintenance.test": async (job) => {
          job.backoffBaseMs = 1;
          job.backoffMaxMs = 1;
          job.maxAttempts = 25;
          throw new Error("handler blew up after shrinking its own backoff");
        },
      },
      fixedNow,
    );
    await runner.runOnce();
    await runner.stop();

    const { rows } = await pool.query<{
      state: string;
      attempts: number;
      run_after: string;
    }>(
      "SELECT state, attempts, run_after FROM maintenance_jobs WHERE id = $1",
      [created.id],
    );
    const row = rows[0];
    expect(row?.state).toBe("queued");
    expect(row?.attempts).toBe(1);
    // First retry uses the persisted base (2000ms), capped exponent semantics
    // unchanged. A handler-mutated 1ms backoff would have scheduled +1ms.
    expect(new Date(row!.run_after).toISOString()).toBe(
      "2026-07-22T17:00:02.000Z",
    );
  });

  it("fail() derives the transition from the durable row when the passed job is tampered", async () => {
    // Direct-queue proof independent of the runner: claim, then tamper the
    // returned job's retry fields exactly as a handler holding the reference
    // could, and fail it. maxAttempts=1 on the row must still dead-letter.
    const created = await enqueue({
      idempotencyKey: "direct-tamper",
      retry: { maxAttempts: 1, backoffBaseMs: 1_000, backoffMaxMs: 4_000 },
    });
    const now = new Date("2026-07-22T18:00:00.000Z");
    const [claimed] = await queue().claimDueJobs({
      limit: 1,
      now,
      leaseMs: 60_000,
    });
    expect(claimed?.attempts).toBe(1);
    // Tamper every retry-policy field the old code read from the object.
    claimed!.maxAttempts = 99;
    claimed!.attempts = 0;
    claimed!.backoffBaseMs = 1;
    claimed!.backoffMaxMs = 1;
    const result = await queue().fail({
      job: claimed!,
      error: new Error("still private"),
      now,
    });
    expect(result?.state).toBe("dead_letter");
    const { rows } = await pool.query<{ state: string; attempts: number }>(
      "SELECT state, attempts FROM maintenance_jobs WHERE id = $1",
      [created.id],
    );
    expect(rows[0]?.state).toBe("dead_letter");
    expect(rows[0]?.attempts).toBe(1);
  });
});
