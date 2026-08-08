import { describe, expect, it, mock } from "bun:test";
import { MEMORY_DISTILL_JOB_KIND } from "./distill-handler.ts";
import { GRAPH_DERIVATION_JOB_KIND } from "./graph-derivation-handler.ts";
import { startMaintenanceQueue } from "./maintenance-bootstrap.ts";
import {
  runMaintenanceSweep,
  startRecurringMaintenanceSweep,
  type MaintenanceSweepSummary,
} from "./maintenance-sweep.ts";
import type {
  EnqueueMaintenanceJob,
  MaintenanceJob,
  MaintenanceQueueLogger,
} from "./maintenance-queue.ts";

const HASH = "a".repeat(64);
const NOW = new Date("2026-08-05T12:00:00.000Z");

function maintenanceJob(
  input: EnqueueMaintenanceJob,
  sequence: number,
): MaintenanceJob {
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    kind: input.kind,
    version: input.version,
    payload: input.payload,
    idempotencyKey: input.idempotencyKey,
    state: "queued",
    runAfter: input.runAfter ?? NOW,
    leaseToken: null,
    leaseUntil: null,
    attempts: 0,
    maxAttempts: input.retry?.maxAttempts ?? 3,
    backoffBaseMs: input.retry?.backoffBaseMs ?? 1_000,
    backoffMaxMs: input.retry?.backoffMaxMs ?? 300_000,
    lastErrorCategory: null,
    terminalAt: null,
    deadLetteredAt: null,
    namespace: input.scope?.namespace ?? null,
    provenance: input.scope?.provenance ?? null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function recordingLogger() {
  const info: Array<{ message: string; fields: Record<string, string | number> }> =
    [];
  const warn: Array<{ message: string; fields: Record<string, string | number> }> =
    [];
  const error: Array<{
    message: string;
    fields: Record<string, string | number>;
  }> = [];
  const logger: MaintenanceQueueLogger = {
    info: (message, fields) => info.push({ message, fields }),
    warn: (message, fields) => warn.push({ message, fields }),
    error: (message, fields) => error.push({ message, fields }),
  };
  return { logger, info, warn, error };
}

function producerPool(graphRows = 1) {
  const query = mock(async (sql: string) => {
    if (sql.includes("WITH due_turns")) {
      return {
        rows: [
          {
            lane_id: "11111111-1111-4111-8111-111111111111",
            namespace: "lane-a",
            batch_hash: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            pending_turns: 9,
            processable_turns: 4,
            total_batches: 3,
          },
          {
            lane_id: null,
            namespace: "unassigned-ns",
            batch_hash: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            pending_turns: 2,
            processable_turns: 2,
            total_batches: 3,
          },
        ],
        rowCount: 2,
      };
    }
    if (sql.includes("LEFT JOIN ob_entities anchor")) {
      const rows = Array.from({ length: graphRows }, (_, index) => ({
        id: `33333333-3333-4333-8333-${String(index + 1).padStart(12, "3")}`,
        namespace: "source-ns",
        source_kind: "git",
        external_id: `https://example.invalid/repo-${index}.git`,
        content_hash: HASH,
        revision: 2,
        derived_content_hash: null,
      }));
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  });
  return { query };
}

describe("runMaintenanceSweep", () => {
  it("produces bounded distill batches and drifted graph jobs in one tick", async () => {
    const pool = producerPool();
    const enqueued: EnqueueMaintenanceJob[] = [];
    const queue = {
      enqueue: async (input: EnqueueMaintenanceJob) => {
        enqueued.push(input);
        return maintenanceJob(input, enqueued.length);
      },
    };
    const logs = recordingLogger();

    const summary: MaintenanceSweepSummary = await runMaintenanceSweep({
      pool: pool as any,
      queue,
      logger: logs.logger,
      distillBatchSize: 5,
      maxDistillBatchesPerTick: 2,
      graphDerivationLimit: 1,
    });

    expect(enqueued.map((job) => job.kind)).toEqual([
      MEMORY_DISTILL_JOB_KIND,
      MEMORY_DISTILL_JOB_KIND,
      GRAPH_DERIVATION_JOB_KIND,
    ]);
    expect(enqueued[0]?.payload).toMatchObject({
      lane_id: "11111111-1111-4111-8111-111111111111",
      max_sessions: 4,
      max_turns: 5,
    });
    expect(enqueued[1]?.scope?.namespace).toBe("unassigned-ns");
    expect(enqueued[1]?.payload).toMatchObject({ lane_id: null, max_turns: 5 });
    expect(summary).toEqual({
      distillBatchesSelected: 2,
      distillJobsEnqueued: 2,
      distillBatchesDeferred: 1,
      distillTurnsDeferred: 5,
      graphJobsEnqueued: 1,
      graphLimitReached: false,
    });
    expect(logs.warn.map((entry) => entry.message)).toEqual([
      "maintenance_sweep_distill_cap_hit",
    ]);
    expect(logs.info.at(-1)?.message).toBe("maintenance_sweep_complete");
  });

  it("reports graph deferral only when a sentinel source exists", async () => {
    const pool = producerPool(2);
    const enqueued: EnqueueMaintenanceJob[] = [];
    const queue = {
      enqueue: async (input: EnqueueMaintenanceJob) => {
        enqueued.push(input);
        return maintenanceJob(input, enqueued.length);
      },
    };
    const logs = recordingLogger();

    const summary = await runMaintenanceSweep({
      pool: pool as any,
      queue,
      logger: logs.logger,
      graphDerivationLimit: 1,
    });

    expect(
      enqueued.filter((job) => job.kind === GRAPH_DERIVATION_JOB_KIND),
    ).toHaveLength(1);
    expect(summary.graphLimitReached).toBe(true);
  });
});

function bootstrapPool(insertedKinds: string[]) {
  let sequence = 0;
  const query = mock(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("WITH due_turns")) {
      return {
        rows: [
          {
            lane_id: "44444444-4444-4444-8444-444444444444",
            namespace: "bootstrap-ns",
            batch_hash: "55555555-5555-4555-8555-555555555555",
            pending_turns: 1,
            processable_turns: 1,
            total_batches: 1,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("LEFT JOIN ob_entities anchor")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO maintenance_jobs")) {
      const input: EnqueueMaintenanceJob = {
        kind: params[0] as string,
        version: params[1] as number,
        payload: JSON.parse(params[2] as string) as Record<string, unknown>,
        idempotencyKey: params[3] as string,
        runAfter: params[4] as Date,
        retry: {
          maxAttempts: params[5] as number,
          backoffBaseMs: params[6] as number,
          backoffMaxMs: params[7] as number,
        },
        ...(params[8] === null
          ? {}
          : { scope: { namespace: params[8] as string } }),
      };
      insertedKinds.push(input.kind);
      sequence++;
      const job = maintenanceJob(input, sequence);
      return {
        rows: [
          {
            id: job.id,
            job_kind: job.kind,
            job_version: job.version,
            payload: job.payload,
            idempotency_key: job.idempotencyKey,
            state: job.state,
            run_after: job.runAfter,
            lease_token: null,
            lease_until: null,
            attempts: job.attempts,
            max_attempts: job.maxAttempts,
            backoff_base_ms: job.backoffBaseMs,
            backoff_max_ms: job.backoffMaxMs,
            last_error_category: null,
            terminal_at: null,
            dead_lettered_at: null,
            namespace: job.namespace,
            provenance: job.provenance,
            created_at: job.createdAt,
            updated_at: job.updatedAt,
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release: mock(() => undefined) };
  return {
    query,
    connect: mock(async () => client),
    end: mock(async () => undefined),
  };
}

async function waitForEnqueue(insertedKinds: string[]): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (insertedKinds.length > 0) return;
    await Bun.sleep(1);
  }
  throw new Error("maintenance bootstrap produced no jobs");
}

describe("startMaintenanceQueue recurring producer", () => {
  it("enqueues sweep work automatically without an operator call", async () => {
    const insertedKinds: string[] = [];
    const pool = bootstrapPool(insertedKinds);
    const logs = recordingLogger();
    const runtime = startMaintenanceQueue({
      pool: pool as any,
      logger: logs.logger,
      embedFn: async () => ({ embedding: Array(768).fill(0.01) }),
      pollIntervalMs: 60_000,
    });

    await waitForEnqueue(insertedKinds);
    await runtime.stop();

    expect(insertedKinds).toEqual([MEMORY_DISTILL_JOB_KIND]);
    expect(logs.error).toEqual([]);
  });
});

/**
 * #625 — a producer that goes quiet must SAY so.
 *
 * Every assertion here runs off an injected clock. Wall-clock assertions are a
 * known flake generator in this repo (docs/lane-contract.md, Tightenings round
 * 5 — #632/#634), and staleness is precisely the property that tempts one, so
 * time is a variable these tests assign rather than a duration they wait out.
 */
describe("startRecurringMaintenanceSweep liveness (#625)", () => {
  /** A pool whose sweep query hangs until released, to wedge a tick on demand. */
  function stallingPool() {
    let releaseHang: (() => void) | undefined;
    const hang = new Promise<void>((resolve) => {
      releaseHang = resolve;
    });
    return {
      release: () => releaseHang?.(),
      pool: {
        query: mock(async () => {
          await hang;
          return { rows: [], rowCount: 0 };
        }),
      },
    };
  }

  const idleQueue = {
    enqueue: async (input: EnqueueMaintenanceJob) => maintenanceJob(input, 1),
  };

  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  }

  it("warns when a tick is skipped because the previous one is still running", async () => {
    let now = 1_000_000;
    const stalled = stallingPool();
    const logs = recordingLogger();
    const sweep = startRecurringMaintenanceSweep({
      pool: stalled.pool as never,
      queue: idleQueue as never,
      logger: logs.logger,
      intervalMs: 10,
      now: () => now,
      quietThresholdMs: 60_000,
    });

    await settle();
    // Let the real interval fire into the overlap guard while tick 1 hangs.
    now += 90_000;
    await new Promise((r) => setTimeout(r, 40));
    await settle();

    const overlaps = logs.warn.filter(
      (line) => line.message === "maintenance_sweep_tick_overlapped",
    );
    expect(overlaps.length).toBeGreaterThan(0);
    expect(overlaps[0]?.fields.quiet_ms).toBe(90_000);
    expect(overlaps[0]?.fields.quiet_threshold_ms).toBe(60_000);

    // One warning per stall, not one per skipped tick: the counter carries the
    // extent so an operator sees the scale without 200 identical lines.
    expect(overlaps.length).toBe(1);
    expect(
      Number(overlaps[0]?.fields.overlapped_ticks),
    ).toBeGreaterThanOrEqual(1);

    stalled.release();
    await sweep.stop();
  });

  it("reports stale once quiet exceeds the threshold, and fresh before it", async () => {
    let now = 2_000_000;
    const stalled = stallingPool();
    const logs = recordingLogger();
    const sweep = startRecurringMaintenanceSweep({
      pool: stalled.pool as never,
      queue: idleQueue as never,
      logger: logs.logger,
      intervalMs: 10_000,
      now: () => now,
      quietThresholdMs: 60_000,
    });

    await settle();
    now += 30_000;
    expect(sweep.liveness().stale).toBe(false);
    expect(sweep.liveness().quietMs).toBe(30_000);

    now += 60_000;
    const stale = sweep.liveness();
    expect(stale.stale).toBe(true);
    expect(stale.quietMs).toBe(90_000);
    expect(stale.quietThresholdMs).toBe(60_000);

    stalled.release();
    await sweep.stop();
  });

  it("clears staleness and logs recovery once a tick completes again", async () => {
    let now = 3_000_000;
    const stalled = stallingPool();
    const logs = recordingLogger();
    const sweep = startRecurringMaintenanceSweep({
      pool: stalled.pool as never,
      queue: idleQueue as never,
      logger: logs.logger,
      intervalMs: 10,
      now: () => now,
      quietThresholdMs: 60_000,
    });

    await settle();
    now += 120_000;
    await new Promise((r) => setTimeout(r, 40));
    await settle();
    expect(sweep.liveness().stale).toBe(true);

    stalled.release();
    await settle();

    expect(sweep.liveness().stale).toBe(false);
    expect(sweep.liveness().quietMs).toBe(0);
    expect(
      logs.warn.some(
        (line) => line.message === "maintenance_sweep_tick_recovered",
      ),
    ).toBe(true);

    await sweep.stop();
  });

  it("counts a handled failure as a completed tick, not as silence", async () => {
    let now = 4_000_000;
    const logs = recordingLogger();
    const failingPool = {
      query: mock(async () => {
        throw new Error("boom");
      }),
    };
    const sweep = startRecurringMaintenanceSweep({
      pool: failingPool as never,
      queue: idleQueue as never,
      logger: logs.logger,
      intervalMs: 10_000,
      now: () => now,
      quietThresholdMs: 60_000,
    });

    await settle();
    // The tick failed and SAID so; the producer is alive, so it is not stale.
    expect(
      logs.error.some((line) => line.message === "maintenance_sweep_failed"),
    ).toBe(true);
    expect(sweep.liveness().completedTicks).toBeGreaterThan(0);
    expect(sweep.liveness().stale).toBe(false);

    await sweep.stop();
  });
});
