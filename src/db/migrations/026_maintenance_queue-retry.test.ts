import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Pool } from "pg";
import {
  MaintenanceQueue,
  MaintenanceQueueRunner,
  type MaintenanceJob,
  type MaintenanceJobHandler,
} from "../../maintenance-queue.ts";
import { requireTestDatabaseUrl } from "../../../scripts/test-support/require-test-database.ts";
import {
  cleanup,
  enqueue as enqueueWith,
  expectDefined,
  migrate,
  queue as queueWith,
} from "./026_maintenance_queue-test-helpers.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });
const queue = () => queueWith(pool);
const enqueue = (input: Parameters<typeof enqueueWith>[1] = {}) =>
  enqueueWith(pool, input);

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

// The `it` bodies live at module scope rather than inline so the describe
// callback stays inside the repo's per-function line rule. Test names, order,
// and assertions are unchanged by the move.

async function deadLettersExpiredLeaseWhenAttemptsExhausted(): Promise<void> {
  // maxAttempts=1: exactly one handler execution is allowed. The claim below
  // consumes it (attempts 0 -> 1). The lease then expires without a
  // complete()/fail(), simulating a handler that hung or crashed.
  await enqueue({
    idempotencyKey: "expired-bound",
    retry: { maxAttempts: 1 },
  });
  const now = new Date("2026-07-22T14:00:00.000Z");
  const [maybeFirst] = await queue().claimDueJobs({
    limit: 1,
    now,
    leaseMs: 1_000,
  });
  expect(maybeFirst).toBeDefined();
  expect(maybeFirst?.attempts).toBe(1);
  const first = expectDefined(maybeFirst, "first");

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
    [first.id],
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
}

async function reclaimsExpiredLeaseWithAttemptsRemaining(): Promise<void> {
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
}

async function retriesDeterministicallyAndRecoversAfterRestart(): Promise<void> {
  const now = new Date("2026-07-22T13:00:00.000Z");
  await enqueue({
    idempotencyKey: "retry",
    retry: { maxAttempts: 2, backoffBaseMs: 1_000, backoffMaxMs: 4_000 },
  });
  const [maybeFirst] = await queue().claimDueJobs({
    limit: 1,
    now,
    leaseMs: 1_000,
  });
  const retry = await queue().fail({
    job: expectDefined(maybeFirst, "first"),
    error: new TypeError("content must not persist"),
    now,
  });
  expect(retry).toMatchObject({
    state: "queued",
    lastErrorCategory: "type_error",
  });
  expect(retry?.runAfter.toISOString()).toBe("2026-07-22T13:00:01.000Z");

  const retryRunAfter = expectDefined(retry, "retry").runAfter;
  const [maybeSecond] = await queue().claimDueJobs({
    limit: 1,
    now: retryRunAfter,
    leaseMs: 1_000,
  });
  const deadLetter = await queue().fail({
    job: expectDefined(maybeSecond, "second"),
    error: new Error("still private"),
    now: retryRunAfter,
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
}

async function deadLettersWhenHandlerInflatesRetryPolicy(): Promise<void> {
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
}

async function schedulesRetryFromPersistedBackoff(): Promise<void> {
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
  }>("SELECT state, attempts, run_after FROM maintenance_jobs WHERE id = $1", [
    created.id,
  ]);
  const row = rows[0];
  expect(row?.state).toBe("queued");
  expect(row?.attempts).toBe(1);
  // First retry uses the persisted base (2000ms), exponent semantics
  // unchanged. A handler-mutated 1ms backoff would have scheduled +1ms.
  expect(new Date(expectDefined(row, "row").run_after).toISOString()).toBe(
    "2026-07-22T17:00:02.000Z",
  );
}

async function failDerivesTransitionFromDurableRow(): Promise<void> {
  // Direct-queue proof independent of the runner: claim, then tamper the
  // returned job's retry fields exactly as a handler holding the reference
  // could, and fail it. maxAttempts=1 on the row must still dead-letter.
  const created = await enqueue({
    idempotencyKey: "direct-tamper",
    retry: { maxAttempts: 1, backoffBaseMs: 1_000, backoffMaxMs: 4_000 },
  });
  const now = new Date("2026-07-22T18:00:00.000Z");
  const [maybeClaimed] = await queue().claimDueJobs({
    limit: 1,
    now,
    leaseMs: 60_000,
  });
  expect(maybeClaimed?.attempts).toBe(1);
  const claimed = expectDefined(maybeClaimed, "claimed");
  // Tamper every retry-policy field the old code read from the object.
  claimed.maxAttempts = 99;
  claimed.attempts = 0;
  claimed.backoffBaseMs = 1;
  claimed.backoffMaxMs = 1;
  const result = await queue().fail({
    job: claimed,
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
}

describe("026 maintenance queue retry and dead-letter (live Postgres)", () => {
  beforeEach(async () => {
    await migrate(pool);
    await cleanup(pool);
  });
  afterAll(async () => {
    await cleanup(pool);
    await pool.end();
  });

  it(
    "dead-letters an expired lease once its execution attempts are exhausted, not reclaims it forever",
    deadLettersExpiredLeaseWhenAttemptsExhausted,
  );

  it(
    "still reclaims an expired lease that has execution attempts remaining",
    reclaimsExpiredLeaseWithAttemptsRemaining,
  );

  it(
    "retries at a deterministic time, dead-letters terminal attempts, and recovers after a restart",
    retriesDeterministicallyAndRecoversAfterRestart,
  );

  it(
    "dead-letters at attempt 1 when a handler inflates maxAttempts/backoff before throwing",
    deadLettersWhenHandlerInflatesRetryPolicy,
  );

  it(
    "schedules the next retry from the persisted backoff, not a handler-mutated one",
    schedulesRetryFromPersistedBackoff,
  );

  it(
    "fail() derives the transition from the durable row when the passed job is tampered",
    failDerivesTransitionFromDurableRow,
  );
});
