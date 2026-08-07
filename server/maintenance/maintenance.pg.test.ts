/**
 * Real-PostgreSQL lease proof for the maintenance runtime composed at the
 * `server/` boundary (charter Phase 5 "maintenance" gate).
 *
 * WHY THIS FILE HAS TO USE A REAL DATABASE. Both invariants under test are
 * statements about DURABLE ROW STATE observed across a concurrency boundary, and
 * both fail SILENTLY: a row sits `running` with a live lease, no handler
 * attached, and nothing throws. A fake queue cannot prove either one, because a
 * fake is free to report whatever the test wants — the whole failure mode is
 * that the in-memory story and the row disagree. So every assertion below reads
 * `maintenance_jobs` back with SQL after the fact.
 *
 * This complements rather than duplicates `src/maintenance-queue.pg.test.ts`:
 * that file proves the queue in isolation, this one proves the invariants
 * SURVIVE the composition — the runtime built by `createMaintenanceRuntime` and
 * stopped through the application's ordered shutdown. A port that kept the code
 * and lost the wiring would pass there and fail here.
 *
 * THE TWO INVARIANTS, both from the PR #350 / issue #343 review swarm:
 *
 *  1. `docs/sme/domain-backend.md` — stop is a DRAIN. A claim in flight when
 *     `stop()` is called has already leased rows; every one of them must be
 *     dispatched, tracked, and completed before `stop()` resolves. The recorded
 *     defect was a mid-loop `if (stopping) return` that abandoned them until
 *     lease expiry.
 *
 *  2. `docs/sme/correctness.md` — the retry bound governs the EXPIRY path too.
 *     An expired `running` row that has consumed `max_attempts` executions
 *     dead-letters inside the claim statement instead of being reclaimed
 *     forever, and never appears to the runner as claimed work.
 *
 * DATABASE. Skips loudly without `OPENBRAIN_TEST_DATABASE_URL`, which must point
 * at an isolated test database. Never the dogfood database. Each test uses its
 * own job-kind prefix and deletes only its own rows, so a shared test database
 * stays usable and no test can observe another's jobs.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import pg from "pg";
import pino from "pino";
import {
  MaintenanceTerminalError,
  type MaintenanceJob,
  type MaintenanceJobHandler,
} from "../../src/maintenance-queue.ts";
import { createMaintenanceRuntime } from "./index.ts";
import type { MaintenanceConfig } from "../config/maintenance.ts";

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;
const pool = DB_URL ? new pg.Pool({ connectionString: DB_URL }) : null;

/** Job kinds are namespaced per run so concurrent suites cannot collide. */
const KIND_PREFIX = `maint.port.${process.pid}`;

function silentLogger() {
  return pino({ level: "silent" });
}

function config(overrides: Partial<MaintenanceConfig> = {}): MaintenanceConfig {
  return { enabled: true, ...overrides };
}

async function db(): Promise<pg.Pool> {
  if (!pool) throw new Error("OPENBRAIN_TEST_DATABASE_URL is required");
  return pool;
}

/** Read a row back by id. The durable row is the oracle, never the job object. */
async function readRow(id: string): Promise<{
  state: string;
  attempts: number;
  max_attempts: number;
  lease_token: string | null;
  lease_until: Date | null;
  last_error_category: string | null;
  terminal_at: Date | null;
  dead_lettered_at: Date | null;
}> {
  const client = await db();
  const result = await client.query(
    `SELECT state, attempts, max_attempts, lease_token, lease_until,
            last_error_category, terminal_at, dead_lettered_at
       FROM maintenance_jobs WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`maintenance job ${id} not found`);
  return row;
}

async function deleteKind(kind: string): Promise<void> {
  const client = await db();
  await client.query(`DELETE FROM maintenance_jobs WHERE job_kind = $1`, [kind]);
}

afterAll(async () => {
  if (!pool) return;
  await pool.query(`DELETE FROM maintenance_jobs WHERE job_kind LIKE $1`, [
    `${KIND_PREFIX}%`,
  ]);
  await pool.end();
});

// The "(live Postgres)" marker is REQUIRED, not decorative: the anti-skip guard
// (`scripts/assert-db-tests-ran.ts`) matches suites by this name, and without it
// a CI Postgres misconfiguration would silently skip the ONE suite that proves
// the lease invariants survive the port -- leaving the job green while proving
// nothing about the failure mode that never throws.
dbDescribe("maintenance runtime lease boundary (live Postgres)", () => {
  beforeEach(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM maintenance_jobs WHERE job_kind LIKE $1`, [
      `${KIND_PREFIX}%`,
    ]);
  });

  it("drains a job whose claim was already in flight when stop() began", async () => {
    // INVARIANT 1, and the reason this whole port had to be proven rather than
    // asserted. The window is real and narrow: stop() flips `stopping` while a
    // claim is mid-COMMIT. The claim still leases its rows, so those rows are
    // this runner's owned work; a runner that checks `stopping` AFTER the claim
    // returns drops them on the floor, and they stay `running` under a live
    // lease with no handler until expiry -- with nothing logged and nothing
    // thrown.
    //
    // THE WINDOW IS THE CLAIM, NOT THE HANDLER. This is the whole subtlety, and
    // getting it wrong is how this test first passed under the very mutation it
    // exists to catch. Once a job has been dispatched it is already tracked in
    // the runner's `active` set, and `stop()` waits on that set -- so a stop
    // observed at handler-start is drained by any implementation and proves
    // nothing. The defect lives EARLIER: between the claim committing its leases
    // and those rows being tracked. To reach it, `stop()` must be entered while
    // `claimDueJobs` is still in flight.
    //
    // The queue is therefore wrapped so the test controls exactly when the claim
    // returns. The real claim runs first (the leases are genuinely committed in
    // PostgreSQL), then the wrapper holds the resolved rows until the test has
    // called stop(). The rows are real, leased, and not yet tracked -- the
    // recorded defect's exact state.
    const kind = `${KIND_PREFIX}.drain`;
    let claimReached!: () => void;
    const claimInFlight = new Promise<void>((resolve) => {
      claimReached = resolve;
    });
    let releaseClaim!: () => void;
    const claimMayReturn = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const seen: string[] = [];

    const handler: MaintenanceJobHandler = async (job: MaintenanceJob) => {
      seen.push(job.id);
    };

    const runtime = createMaintenanceRuntime({
      config: config({ concurrency: 1, leaseMs: 60_000 }),
      logger: silentLogger(),
      pool: await db(),
      handlers: new Map([[kind, handler]]),
      // No timer: the tick boundary must be exact for this window to be a
      // window rather than a race.
      autoStart: false,
    });
    if (!runtime) throw new Error("maintenance runtime should be composed");

    const job = await runtime.queue.enqueue({
      kind,
      version: 1,
      payload: { proof: "drain" },
      idempotencyKey: "drain-1",
    });

    const realClaim = runtime.queue.claimDueJobs.bind(runtime.queue);
    (runtime.queue as { claimDueJobs: typeof realClaim }).claimDueJobs = async (
      request,
    ) => {
      const claimed = await realClaim(request);
      claimReached();
      await claimMayReturn;
      return claimed;
    };

    // Drive one tick; do NOT await it. The claim commits real leases and then
    // parks, so the tick sits precisely in the defect's window.
    const tick = runtime.runner.runOnce();
    await claimInFlight;

    // The row is leased to this runner right now, and no handler has seen it:
    // that is what makes the assertion after the drain meaningful.
    const leased = await readRow(job.id);
    expect(leased.state).toBe("running");
    expect(leased.lease_token).not.toBeNull();
    expect(seen).toEqual([]);

    // Enter stop() while the claim is still parked, then let the claim return.
    // The runner now observes `stopping === true` holding rows it has already
    // leased: it must treat them as owned work and dispatch them anyway.
    const stopping = runtime.stop();
    releaseClaim();

    // THE ASSERTION BINDS TO stop() RESOLVING, and deliberately does NOT await
    // the tick first. Awaiting the tick here is what makes this test vacuous:
    // it guarantees the dispatch finished regardless of what stop() did, so the
    // row would read terminal even under a stop() that abandoned it. Observed
    // during red-proof: with `await tick` before this read, deleting
    // `await this.tickPromise` from the runner's stop() still passed 5/5.
    //
    // Read the row the instant stop() resolves. A stop that is a DRAIN cannot
    // resolve until the leased job is complete; a stop that abandons the
    // in-flight claim resolves with the row still `running` under a live lease.
    await stopping;
    const drained = await readRow(job.id);
    expect(seen).toEqual([job.id]);
    expect(drained.state).toBe("succeeded");
    expect(drained.lease_token).toBeNull();
    expect(drained.lease_until).toBeNull();
    expect(drained.terminal_at).not.toBeNull();

    // Only now is the tick joined, so the test leaves nothing running.
    await tick;
    await deleteKind(kind);
  });

  it("refuses to begin a new claim once stopping, leaving queued work untouched", async () => {
    // The other half of invariant 1. Refusing to BEGIN a claim is what keeps
    // shutdown bounded: a claim mutates durable state, so starting one during
    // stop would lease rows this process is about to stop being able to run.
    // A queued row must therefore still be `queued`, unleased, and at attempts
    // 0 after a stop -- available to the next worker rather than stranded.
    const kind = `${KIND_PREFIX}.noclaim`;
    const seen: string[] = [];
    const runtime = createMaintenanceRuntime({
      config: config({ concurrency: 1 }),
      logger: silentLogger(),
      pool: await db(),
      handlers: new Map([
        [
          kind,
          async (job: MaintenanceJob) => {
            seen.push(job.id);
          },
        ],
      ]),
      autoStart: false,
    });
    if (!runtime) throw new Error("maintenance runtime should be composed");

    const job = await runtime.queue.enqueue({
      kind,
      version: 1,
      payload: { proof: "noclaim" },
      idempotencyKey: "noclaim-1",
    });

    await runtime.stop();
    // A tick attempted after stop must claim nothing at all.
    await runtime.runner.runOnce();

    expect(seen).toEqual([]);
    const untouched = await readRow(job.id);
    expect(untouched.state).toBe("queued");
    expect(untouched.attempts).toBe(0);
    expect(untouched.lease_token).toBeNull();

    await deleteKind(kind);
  });

  it("dead-letters an expired lease that has consumed its attempts instead of reclaiming it", async () => {
    // INVARIANT 2. A handler that hangs or crashes never calls complete/fail, so
    // the ONLY path that ever revisits its row is the expiry reclaim. If that
    // path ignores max_attempts the job is re-executed forever past its bound --
    // the retry cap enforced on one exit and not the other.
    //
    // The expired state is constructed durably (a past lease_until on a row that
    // has already consumed its attempts) rather than by waiting out a real lease,
    // so the assertion is about the claim statement's rule and not about timing.
    const kind = `${KIND_PREFIX}.expired`;
    const seen: string[] = [];
    const runtime = createMaintenanceRuntime({
      config: config({ concurrency: 4 }),
      logger: silentLogger(),
      pool: await db(),
      handlers: new Map([
        [
          kind,
          async (job: MaintenanceJob) => {
            seen.push(job.id);
          },
        ],
      ]),
      autoStart: false,
    });
    if (!runtime) throw new Error("maintenance runtime should be composed");

    const exhausted = await runtime.queue.enqueue({
      kind,
      version: 1,
      payload: { proof: "expired" },
      idempotencyKey: "expired-1",
      retry: { maxAttempts: 2 },
    });
    // A second job with budget REMAINING, expired the same way. It proves the
    // rule terminates only the bounded row and does not simply stop reclaiming
    // expired leases altogether -- a "fix" that stalled every recoverable job
    // would otherwise pass the first assertion.
    const recoverable = await runtime.queue.enqueue({
      kind,
      version: 1,
      payload: { proof: "recoverable" },
      idempotencyKey: "expired-2",
      retry: { maxAttempts: 5 },
    });

    const client = await db();
    await client.query(
      `UPDATE maintenance_jobs
          SET state = 'running',
              lease_token = gen_random_uuid(),
              lease_until = now() - interval '1 minute',
              attempts = max_attempts
        WHERE id = $1`,
      [exhausted.id],
    );
    await client.query(
      `UPDATE maintenance_jobs
          SET state = 'running',
              lease_token = gen_random_uuid(),
              lease_until = now() - interval '1 minute',
              attempts = 1
        WHERE id = $1`,
      [recoverable.id],
    );

    await runtime.runner.runOnce();

    // The exhausted row terminated in the claim statement: it was never handed
    // to a handler, and it satisfies every migration CHECK for a terminal row.
    expect(seen).not.toContain(exhausted.id);
    const dead = await readRow(exhausted.id);
    expect(dead.state).toBe("dead_letter");
    expect(dead.last_error_category).toBe("lease_expired");
    expect(dead.lease_token).toBeNull();
    expect(dead.lease_until).toBeNull();
    expect(dead.terminal_at).not.toBeNull();
    expect(dead.dead_lettered_at).not.toBeNull();
    // attempts stays at the number of leases actually consumed; the sweep must
    // not inflate the counter that gates the bound.
    expect(dead.attempts).toBe(dead.max_attempts);

    // The row with budget left was reclaimed and run normally.
    expect(seen).toContain(recoverable.id);
    const recovered = await readRow(recoverable.id);
    expect(recovered.state).toBe("succeeded");

    await deleteKind(kind);
  });

  it("dead-letters a terminal handler failure on this attempt and keeps bounded retry otherwise", async () => {
    // The runner's failure classification, proven through the composed runtime.
    // A handler declaring its own failure non-retryable must dead-letter NOW
    // regardless of remaining budget, while an ordinary throw must go back to
    // `queued` with a future run_after -- the two must not collapse into one
    // policy, because that is how a permanent failure burns three retries or a
    // transient one is discarded after the first.
    const kind = `${KIND_PREFIX}.terminal`;
    const ordinaryKind = `${KIND_PREFIX}.ordinary`;
    const runtime = createMaintenanceRuntime({
      config: config({ concurrency: 4 }),
      logger: silentLogger(),
      pool: await db(),
      handlers: new Map<string, MaintenanceJobHandler>([
        [
          kind,
          async () => {
            throw new MaintenanceTerminalError("not retryable");
          },
        ],
        [
          ordinaryKind,
          async () => {
            throw new Error("transient");
          },
        ],
      ]),
      autoStart: false,
    });
    if (!runtime) throw new Error("maintenance runtime should be composed");

    const terminal = await runtime.queue.enqueue({
      kind,
      version: 1,
      payload: { proof: "terminal" },
      idempotencyKey: "terminal-1",
      retry: { maxAttempts: 3 },
    });
    const ordinary = await runtime.queue.enqueue({
      kind: ordinaryKind,
      version: 1,
      payload: { proof: "ordinary" },
      idempotencyKey: "ordinary-1",
      retry: { maxAttempts: 3, backoffBaseMs: 60_000, backoffMaxMs: 120_000 },
    });

    await runtime.runner.runOnce();
    await runtime.stop();

    const dead = await readRow(terminal.id);
    expect(dead.state).toBe("dead_letter");
    expect(dead.last_error_category).toBe("terminal");
    // Dead-lettered on attempt 1 of 3: the budget was NOT consumed first.
    expect(dead.attempts).toBe(1);
    expect(dead.max_attempts).toBe(3);

    const retried = await readRow(ordinary.id);
    expect(retried.state).toBe("queued");
    expect(retried.last_error_category).toBe("error");
    expect(retried.lease_token).toBeNull();
    expect(retried.terminal_at).toBeNull();

    await deleteKind(kind);
    await deleteKind(ordinaryKind);
  });

  it("starts a producer, so an autostarted runtime enqueues without an operator", async () => {
    // THE #384 REGRESSION. This boundary composed the CONSUMER half and nothing
    // else: `createMaintenanceRuntime` built a runner, `src/maintenance-
    // bootstrap.ts` built a runner AND started the sweep, and `server/main.ts`
    // — the post-Phase-6 serving entrypoint — reached only the first. Measured
    // on the local clone 2026-08-07: 319 "maintenance queue idle" lines, zero
    // `maintenance_sweep_complete`, maintenance enabled throughout. The runner
    // polled a queue nothing filled.
    //
    // WHAT MAKES THIS TEST ABLE TO FAIL. It asserts on OBSERVED PRODUCTION, not
    // on the presence of a field: a runtime is composed with autoStart, given a
    // real derivable source, and then the DATABASE is read to see whether a job
    // appeared that no test enqueued. Every enqueue here is the server's own.
    // Asserting `runtime.sweep !== undefined` would pass against a sweep that
    // is constructed and never ticks, which is the defect's own shape one level
    // up.
    const client = await db();
    const namespace = `${KIND_PREFIX}.producer`;
    const contentHash = "a".repeat(64);

    await client.query(`DELETE FROM ob_sources WHERE namespace = $1`, [
      namespace,
    ]);
    await client.query(
      `INSERT INTO ob_sources
         (namespace, source_kind, external_id, title, approval_state,
          approved_by, approved_at, lifecycle_state, content_hash, created_by)
       VALUES ($1, 'drop', $2, 'producer proof', 'approved', 'test', now(),
               'active', $3, 'test')`,
      [namespace, `${KIND_PREFIX}-producer`, contentHash],
    );

    // A short interval so the proof does not depend on the 5s default, and no
    // handlers for graph.derive: this asserts the PRODUCER ran, and letting the
    // real deriver execute would drag an embedding provider into a lease test.
    const runtime = createMaintenanceRuntime({
      config: config({ pollIntervalMs: 50, graphDerivationLimit: 10 }),
      logger: silentLogger(),
      pool: client,
      handlers: new Map([[`${KIND_PREFIX}.noop`, async () => {}]]),
    });
    if (!runtime) throw new Error("maintenance runtime should be composed");

    try {
      let produced = 0;
      for (let attempt = 0; attempt < 40 && produced === 0; attempt += 1) {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM maintenance_jobs
            WHERE namespace = $1 AND job_kind = 'graph.derive'`,
          [namespace],
        );
        produced = Number.parseInt(rows[0]?.count ?? "0", 10);
        if (produced === 0) await new Promise((r) => setTimeout(r, 50));
      }
      expect(produced).toBeGreaterThan(0);
    } finally {
      await runtime.stop();
      await client.query(`DELETE FROM maintenance_jobs WHERE namespace = $1`, [
        namespace,
      ]);
      await client.query(`DELETE FROM ob_sources WHERE namespace = $1`, [
        namespace,
      ]);
    }
  });

  it("composes no runtime when the operator disabled maintenance", async () => {
    // A disabled process must hold no poller at all. Returning `undefined`
    // rather than an idle runner is what keeps "disabled" and "absent from the
    // shutdown order" the same state -- they cannot disagree.
    const runtime = createMaintenanceRuntime({
      config: config({ enabled: false }),
      logger: silentLogger(),
      pool: await db(),
      handlers: new Map([[`${KIND_PREFIX}.disabled`, async () => {}]]),
    });
    expect(runtime).toBeUndefined();
  });
});
