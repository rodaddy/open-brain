/**
 * Live-Postgres regression for the queue-owned terminal (non-retryable)
 * dead-letter path (#346), exercised against the real maintenance_jobs schema,
 * the real CHECK constraint on last_error_category, and the real CASE forks in
 * MaintenanceQueue.fail.
 *
 * Gated on OPENBRAIN_TEST_DATABASE_URL (repo convention); skips when unset so a
 * DB-less CI job passes while the db-integration job runs it against Postgres.
 *
 * The two facts proven end to end:
 *  1. A terminal handler failure dead-letters on attempt 1 — before the retry
 *     bound — recording the content-free `terminal` category, with no backoff
 *     reschedule.
 *  2. An ordinary (non-terminal) failure on the same fresh job keeps its bounded
 *     retry: it goes back to `queued`, schedules a future run_after, and does NOT
 *     dead-letter until attempts reach max_attempts.
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
import {
  MaintenanceQueue,
  MaintenanceQueueRunner,
  MaintenanceTerminalError,
  type MaintenanceJob,
} from "./maintenance-queue.ts";

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;

// Every job this suite enqueues shares this idempotency-key prefix so cleanup
// deletes exactly the queue rows this suite owns and nothing else.
const JOB_KEY_PREFIX = "lane346-queue-";

dbDescribe("maintenance queue terminal dead-letter (live Postgres)", () => {
  let pool: Pool;
  let queue: MaintenanceQueue;

  beforeAll(async () => {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: DB_URL });
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    await runMigrations(pool);
    queue = new MaintenanceQueue(pool);
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  async function cleanup(): Promise<void> {
    await pool.query(
      "DELETE FROM maintenance_jobs WHERE idempotency_key LIKE $1",
      [`${JOB_KEY_PREFIX}%`],
    );
  }

  beforeEach(cleanup);

  /** Enqueue one bounded test job and claim it so it is running at attempts=1. */
  async function enqueueAndClaim(key: string): Promise<MaintenanceJob> {
    await queue.enqueue({
      kind: "maintenance.test",
      version: 1,
      payload: { unit: key },
      idempotencyKey: `${JOB_KEY_PREFIX}${key}`,
      retry: { maxAttempts: 3, backoffBaseMs: 1_000, backoffMaxMs: 4_000 },
    });
    const claimed = await queue.claimDueJobs({ limit: 10, leaseMs: 30_000 });
    const job = claimed.find(
      (j) => j.idempotencyKey === `${JOB_KEY_PREFIX}${key}`,
    );
    if (!job) throw new Error("test job was not claimed");
    return job;
  }

  async function readRow(id: string) {
    const { rows } = await pool.query(
      `SELECT state, attempts, last_error_category, terminal_at,
              dead_lettered_at, run_after
         FROM maintenance_jobs WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  it("dead-letters a terminal failure on attempt 1, before the retry bound", async () => {
    const job = await enqueueAndClaim("terminal-1");
    expect(job.attempts).toBe(1);
    expect(job.maxAttempts).toBe(3);

    const failed = await queue.fail({
      job,
      error: new MaintenanceTerminalError("private terminal reason"),
      terminal: true,
    });

    // Returned + persisted: immediate dead-letter despite attempts (1) < max (3).
    expect(failed?.state).toBe("dead_letter");
    const row = await readRow(job.id);
    expect(row.state).toBe("dead_letter");
    expect(row.attempts).toBe(1);
    expect(row.last_error_category).toBe("terminal");
    expect(row.terminal_at).not.toBeNull();
    expect(row.dead_lettered_at).not.toBeNull();
  });

  it("keeps bounded retry for an ordinary failure on the same fresh job", async () => {
    const job = await enqueueAndClaim("retry-1");
    expect(job.attempts).toBe(1);

    const before = Date.now();
    const failed = await queue.fail({
      job,
      error: new Error("transient blip"),
    });

    // Non-terminal: back to queued with a scheduled backoff, not dead-lettered.
    expect(failed?.state).toBe("queued");
    const row = await readRow(job.id);
    expect(row.state).toBe("queued");
    expect(row.attempts).toBe(1);
    expect(row.last_error_category).toBe("error");
    expect(row.terminal_at).toBeNull();
    expect(row.dead_lettered_at).toBeNull();
    // Backoff scheduled a future run_after (base 1s from now).
    expect(new Date(row.run_after).getTime()).toBeGreaterThan(before);
  });

  it("subclassed terminal marker also dead-letters immediately (queue owns the type)", async () => {
    class HandlerTerminal extends MaintenanceTerminalError {}
    const job = await enqueueAndClaim("terminal-subclass");

    // The runner derives terminal/category from the thrown type; here we assert
    // the same category the runner would pass for a subclass reaches the row.
    const failed = await queue.fail({
      job,
      error: new HandlerTerminal("subclass reason"),
      terminal: true,
      category: "terminal",
    });
    expect(failed?.state).toBe("dead_letter");
    const row = await readRow(job.id);
    expect(row.last_error_category).toBe("terminal");
  });

  it("renews a live handler lease across competing claim windows", async () => {
    await queue.enqueue({
      kind: "maintenance.heartbeat-test",
      version: 1,
      payload: { unit: "lease-renew" },
      idempotencyKey: `${JOB_KEY_PREFIX}lease-renew`,
      retry: { maxAttempts: 3, backoffBaseMs: 10, backoffMaxMs: 40 },
    });

    let handlerStartedResolve!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      handlerStartedResolve = resolve;
    });
    let releaseHandler!: () => void;
    const handlerBlocked = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const logger = { info: () => {}, warn: () => {}, error: () => {} };
    const runner = new MaintenanceQueueRunner({
      queue,
      handlers: new Map([
        [
          "maintenance.heartbeat-test",
          async () => {
            handlerStartedResolve();
            await handlerBlocked;
          },
        ],
      ]),
      logger,
      concurrency: 1,
      leaseMs: 100,
      leaseRenewMs: 20,
    });

    await runner.runOnce();
    await handlerStarted;

    const { rows: initialRows } = await pool.query(
      `SELECT id, lease_until, attempts
         FROM maintenance_jobs
        WHERE idempotency_key = $1`,
      [`${JOB_KEY_PREFIX}lease-renew`],
    );
    const jobId: string = initialRows[0].id;
    const initialLeaseUntil = new Date(initialRows[0].lease_until).getTime();
    expect(initialRows[0].attempts).toBe(1);

    // Cross several original lease windows. A second queue instance repeatedly
    // attempts to reclaim due work; the live runner's heartbeat must keep this
    // exact job unavailable without incrementing its attempt count.
    const competitor = new MaintenanceQueue(pool);
    for (let i = 0; i < 3; i += 1) {
      await Bun.sleep(120);
      const claimed = await competitor.claimDueJobs({
        limit: 10,
        leaseMs: 100,
      });
      expect(claimed.some((candidate) => candidate.id === jobId)).toBe(false);
    }

    const { rows: heldRows } = await pool.query(
      `SELECT state, lease_until, attempts, dead_lettered_at
         FROM maintenance_jobs
        WHERE id = $1`,
      [jobId],
    );
    expect(heldRows[0].state).toBe("running");
    expect(heldRows[0].attempts).toBe(1);
    expect(heldRows[0].dead_lettered_at).toBeNull();
    expect(new Date(heldRows[0].lease_until).getTime()).toBeGreaterThan(
      initialLeaseUntil,
    );

    releaseHandler();
    await runner.stop();

    const completed = await readRow(jobId);
    expect(completed.state).toBe("succeeded");
    expect(completed.attempts).toBe(1);
    expect(completed.last_error_category).toBeNull();
    expect(completed.dead_lettered_at).toBeNull();
  });
});
