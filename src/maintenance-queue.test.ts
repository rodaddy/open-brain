import { describe, expect, it } from "bun:test";
import {
  MaintenanceQueue,
  MaintenanceQueueRunner,
  MaintenanceTerminalError,
  isMaintenanceTerminalError,
  maintenanceBackoffMs,
  safeMaintenanceErrorCategory,
  type MaintenanceJob,
  type MaintenanceJobState,
  type MaintenanceQueuePort,
} from "./maintenance-queue.ts";

function job(overrides: Partial<MaintenanceJob> = {}): MaintenanceJob {
  return {
    id: "job-1",
    kind: "maintenance.test",
    version: 1,
    payload: { private: "must never reach logs" },
    idempotencyKey: "once",
    state: "running",
    runAfter: new Date("2026-07-22T12:00:00.000Z"),
    leaseToken: "00000000-0000-4000-8000-000000000001",
    leaseUntil: new Date("2026-07-22T12:00:30.000Z"),
    attempts: 1,
    maxAttempts: 3,
    backoffBaseMs: 1_000,
    backoffMaxMs: 4_000,
    lastErrorCategory: null,
    terminalAt: null,
    deadLetteredAt: null,
    namespace: null,
    provenance: null,
    createdAt: new Date("2026-07-22T12:00:00.000Z"),
    updatedAt: new Date("2026-07-22T12:00:00.000Z"),
    ...overrides,
  };
}

describe("maintenance queue runner", () => {
  it("bounds dispatch and waits for in-flight work during shutdown", async () => {
    let resolveHandler: (() => void) | undefined;
    let concurrent = 0;
    let peakConcurrent = 0;
    const queue: MaintenanceQueuePort = {
      claimDueJobs: async () => [job(), job({ id: "job-2" })],
      complete: async () => true,
      fail: async () => null,
    };
    const runner = new MaintenanceQueueRunner({
      queue,
      handlers: new Map([
        [
          "maintenance.test",
          async () => {
            concurrent += 1;
            peakConcurrent = Math.max(peakConcurrent, concurrent);
            await new Promise<void>((resolve) => {
              resolveHandler = resolve;
            });
            concurrent -= 1;
          },
        ],
      ]),
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      concurrency: 1,
    });

    await runner.runOnce();
    const stopping = runner.stop();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(peakConcurrent).toBe(1);
    expect(stopped).toBe(false);

    resolveHandler?.();
    await stopping;
    expect(stopped).toBe(true);
  });

  it("dispatches and drains a claim already in flight when stop() begins", async () => {
    // The claim resolves only after stop() has flipped `stopping`. The old
    // mid-loop `if (this.stopping) return` abandoned every job the in-flight
    // claim returned: the handler never ran, complete()/fail() was never
    // invoked, and the leased rows were left stranded outside `active`.
    let resolveClaim: ((jobs: MaintenanceJob[]) => void) | undefined;
    let handlerRan = false;
    let completeCalled = false;
    const claimStarted = Promise.withResolvers<void>();
    const queue: MaintenanceQueuePort = {
      claimDueJobs: () => {
        claimStarted.resolve();
        return new Promise<MaintenanceJob[]>((resolve) => {
          resolveClaim = resolve;
        });
      },
      complete: async () => {
        completeCalled = true;
        return true;
      },
      fail: async () => null,
    };
    const runner = new MaintenanceQueueRunner({
      queue,
      handlers: new Map([
        [
          "maintenance.test",
          async () => {
            handlerRan = true;
          },
        ],
      ]),
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      concurrency: 1,
    });

    const tick = runner.runOnce();
    // Wait until the claim is genuinely in flight before beginning shutdown.
    await claimStarted.promise;

    const stopping = runner.stop();
    let stopResolved = false;
    void stopping.then(() => {
      stopResolved = true;
    });
    // Let stop() run up to its await; the leased jobs are not yet delivered.
    await Promise.resolve();
    expect(stopResolved).toBe(false);
    expect(handlerRan).toBe(false);

    // The claim commits its lease after stop began. Every returned job must be
    // dispatched, executed, and completed; stop() must not resolve before that.
    resolveClaim?.([job()]);
    await tick;
    await stopping;
    expect(handlerRan).toBe(true);
    expect(completeCalled).toBe(true);
    expect(stopResolved).toBe(true);
  });

  it("does not begin a new claim once stopping is observed", async () => {
    // A tick that starts after stop() has flipped `stopping` must not lease any
    // new rows: no claim, no handler, immediate drain.
    let claimCalls = 0;
    let handlerRan = false;
    const queue: MaintenanceQueuePort = {
      claimDueJobs: async () => {
        claimCalls += 1;
        return [job()];
      },
      complete: async () => true,
      fail: async () => null,
    };
    const runner = new MaintenanceQueueRunner({
      queue,
      handlers: new Map([
        [
          "maintenance.test",
          async () => {
            handlerRan = true;
          },
        ],
      ]),
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      concurrency: 1,
    });

    await runner.stop();
    await runner.runOnce();
    expect(claimCalls).toBe(0);
    expect(handlerRan).toBe(false);
  });

  it("stores unsupported_job_kind as its own category, not non_error", async () => {
    const failCalls: Array<{ error: unknown; category?: string }> = [];
    const logs: string[] = [];
    const queue: MaintenanceQueuePort = {
      claimDueJobs: async () => [job()],
      complete: async () => true,
      fail: async (input) => {
        failCalls.push({ error: input.error, category: input.category });
        return job({
          state: "dead_letter",
          lastErrorCategory: input.category ?? null,
        });
      },
    };
    const runner = new MaintenanceQueueRunner({
      queue,
      // No handler registered for the claimed job's kind.
      handlers: new Map([["some.other.kind", async () => undefined]]),
      logger: {
        info: (message, fields) =>
          logs.push(JSON.stringify({ message, fields })),
        warn: (message, fields) =>
          logs.push(JSON.stringify({ message, fields })),
        error: (message, fields) =>
          logs.push(JSON.stringify({ message, fields })),
      },
    });

    await runner.runOnce();
    // Old behavior: fail() received the raw string and derived "non_error" for storage.
    expect(failCalls).toHaveLength(1);
    expect(failCalls[0]?.category).toBe("unsupported_job_kind");
    expect(logs.join("\n")).toContain(
      '"error_category":"unsupported_job_kind"',
    );
    expect(logs.join("\n")).not.toContain('"error_category":"non_error"');
  });

  it("keeps runner logs content-free and categorizes failures without messages", async () => {
    const logs: string[] = [];
    const queue: MaintenanceQueuePort = {
      claimDueJobs: async () => [job()],
      complete: async () => true,
      fail: async () => job({ state: "queued" }),
    };
    const runner = new MaintenanceQueueRunner({
      queue,
      handlers: new Map([
        [
          "maintenance.test",
          async () => {
            throw new TypeError("secret payload text");
          },
        ],
      ]),
      logger: {
        info: (message, fields) =>
          logs.push(JSON.stringify({ message, fields })),
        warn: (message, fields) =>
          logs.push(JSON.stringify({ message, fields })),
        error: (message, fields) =>
          logs.push(JSON.stringify({ message, fields })),
      },
    });

    await runner.runOnce();
    expect(logs.join("\n")).not.toContain("secret payload text");
    expect(logs.join("\n")).not.toContain("must never reach logs");
    expect(logs.join("\n")).toContain('"error_category":"type_error"');
  });

  it("routes a MaintenanceTerminalError to fail() as terminal, category 'terminal'", async () => {
    const failCalls: Array<{ category?: string; terminal?: boolean }> = [];
    const logs: string[] = [];
    const queue: MaintenanceQueuePort = {
      claimDueJobs: async () => [job()],
      complete: async () => true,
      fail: async (input) => {
        failCalls.push({ category: input.category, terminal: input.terminal });
        // The queue dead-letters immediately for a terminal failure.
        return job({ state: "dead_letter", lastErrorCategory: "terminal" });
      },
    };
    const runner = new MaintenanceQueueRunner({
      queue,
      handlers: new Map([
        [
          "maintenance.test",
          async () => {
            throw new MaintenanceTerminalError("private terminal reason text");
          },
        ],
      ]),
      logger: {
        info: (message, fields) =>
          logs.push(JSON.stringify({ message, fields })),
        warn: (message, fields) =>
          logs.push(JSON.stringify({ message, fields })),
        error: (message, fields) =>
          logs.push(JSON.stringify({ message, fields })),
      },
    });

    await runner.runOnce();
    expect(failCalls).toHaveLength(1);
    expect(failCalls[0]?.terminal).toBe(true);
    expect(failCalls[0]?.category).toBe("terminal");
    // Content-free: the terminal category is logged; the reason text is not.
    expect(logs.join("\n")).toContain('"error_category":"terminal"');
    expect(logs.join("\n")).not.toContain("private terminal reason text");
    expect(logs.join("\n")).toContain('"status":"dead_letter"');
  });

  it("routes an ordinary error to fail() as non-terminal (bounded retry preserved)", async () => {
    const failCalls: Array<{ category?: string; terminal?: boolean }> = [];
    const queue: MaintenanceQueuePort = {
      claimDueJobs: async () => [job()],
      complete: async () => true,
      fail: async (input) => {
        failCalls.push({ category: input.category, terminal: input.terminal });
        return job({ state: "queued" });
      },
    };
    const runner = new MaintenanceQueueRunner({
      queue,
      handlers: new Map([
        [
          "maintenance.test",
          async () => {
            throw new Error("transient DB blip");
          },
        ],
      ]),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });

    await runner.runOnce();
    expect(failCalls).toHaveLength(1);
    // An ordinary error is NOT terminal: the queue keeps the bounded-retry path.
    expect(failCalls[0]?.terminal).toBe(false);
    expect(failCalls[0]?.category).toBe("error");
  });

  it("classifies a MaintenanceTerminalError subclass as terminal", () => {
    class HandlerTerminal extends MaintenanceTerminalError {}
    expect(isMaintenanceTerminalError(new HandlerTerminal("x"))).toBe(true);
    expect(isMaintenanceTerminalError(new Error("x"))).toBe(false);
    expect(isMaintenanceTerminalError("unsupported_job_kind")).toBe(false);
  });

  it("contains persistence failures as content-free runner errors", async () => {
    const logs: string[] = [];
    const queue: MaintenanceQueuePort = {
      claimDueJobs: async () => [job()],
      complete: async () => true,
      fail: async () => {
        throw new Error("failed to store private payload text");
      },
    };
    const runner = new MaintenanceQueueRunner({
      queue,
      handlers: new Map([
        [
          "maintenance.test",
          async () => {
            throw new Error("private handler text");
          },
        ],
      ]),
      logger: {
        info: (message, fields) =>
          logs.push(JSON.stringify({ message, fields })),
        warn: (message, fields) =>
          logs.push(JSON.stringify({ message, fields })),
        error: (message, fields) =>
          logs.push(JSON.stringify({ message, fields })),
      },
    });

    await runner.runOnce();
    expect(logs.join("\n")).toContain(
      "maintenance queue failure recording failed",
    );
    expect(logs.join("\n")).not.toContain("private payload text");
    expect(logs.join("\n")).not.toContain("private handler text");
  });
});

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "existing-1",
    job_kind: "maintenance.test",
    job_version: 1,
    payload: { a: 1 },
    idempotency_key: "dup",
    state: "queued" as MaintenanceJobState,
    run_after: new Date("2026-07-22T12:00:00.000Z"),
    lease_token: null,
    lease_until: null,
    attempts: 0,
    max_attempts: 3,
    backoff_base_ms: 1_000,
    backoff_max_ms: 300_000,
    last_error_category: null,
    terminal_at: null,
    dead_lettered_at: null,
    namespace: null,
    provenance: null,
    created_at: new Date("2026-07-22T12:00:00.000Z"),
    updated_at: new Date("2026-07-22T12:00:00.000Z"),
    ...overrides,
  };
}

// Fake pool: INSERT ... ON CONFLICT DO NOTHING returns no row, SELECT returns
// the pre-existing job. Lets us exercise the conflict path without Postgres.
function conflictPool(existing: Record<string, unknown>) {
  return {
    query: async (sql: string) => {
      if (/^\s*INSERT/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/^\s*SELECT/i.test(sql)) return { rows: [existing], rowCount: 1 };
      throw new Error("unexpected query");
    },
    connect: async () => {
      throw new Error("connect not expected");
    },
  };
}

describe("maintenance queue enqueue idempotency", () => {
  const base = {
    kind: "maintenance.test",
    version: 1,
    payload: { a: 1 },
    idempotencyKey: "dup",
  };

  it("returns the existing job when semantics match, key order aside", async () => {
    const queue = new MaintenanceQueue(conflictPool(storedRow()) as never);
    const result = await queue.enqueue({ ...base, payload: { a: 1 } });
    expect(result.id).toBe("existing-1");
  });

  it("rejects a reused key with a divergent payload content-free", async () => {
    const queue = new MaintenanceQueue(conflictPool(storedRow()) as never);
    await expect(queue.enqueue({ ...base, payload: { a: 2 } })).rejects.toThrow(
      "divergent job semantics",
    );
  });

  it("rejects a reused key with divergent version, retry, or scope", async () => {
    const queue = new MaintenanceQueue(conflictPool(storedRow()) as never);
    await expect(queue.enqueue({ ...base, version: 2 })).rejects.toThrow(
      "divergent job semantics",
    );
    const q2 = new MaintenanceQueue(conflictPool(storedRow()) as never);
    await expect(
      q2.enqueue({ ...base, retry: { maxAttempts: 9 } }),
    ).rejects.toThrow("divergent job semantics");
    const q3 = new MaintenanceQueue(conflictPool(storedRow()) as never);
    await expect(
      q3.enqueue({ ...base, scope: { namespace: "other-ns" } }),
    ).rejects.toThrow("divergent job semantics");
  });

  it("rejects an invalid namespace and an out-of-bounds claim limit before querying", async () => {
    const noQuery = {
      query: async () => {
        throw new Error("must not query on validation failure");
      },
      connect: async () => {
        throw new Error("must not connect on validation failure");
      },
    };
    const queue = new MaintenanceQueue(noQuery as never);
    await expect(
      queue.enqueue({ ...base, scope: { namespace: "bad ns!" } }),
    ).rejects.toThrow("namespace is invalid");
    await expect(
      queue.claimDueJobs({ limit: 100_000, leaseMs: 1_000 }),
    ).rejects.toThrow("claim limit exceeds the bound");
  });
});

describe("maintenance queue retry policy", () => {
  it("uses deterministic capped exponential backoff and safe categories", () => {
    expect(maintenanceBackoffMs(job({ attempts: 1 }))).toBe(1_000);
    expect(maintenanceBackoffMs(job({ attempts: 3 }))).toBe(4_000);
    expect(maintenanceBackoffMs(job({ attempts: 9 }))).toBe(4_000);
    expect(safeMaintenanceErrorCategory(new Error("private error text"))).toBe(
      "error",
    );
    expect(safeMaintenanceErrorCategory("private error text")).toBe(
      "non_error",
    );
  });
});

// A fake pool that captures the params of the fail UPDATE and echoes a row so
// MaintenanceQueue.fail resolves. It proves the terminal flag reaches SQL as the
// 5th positional param and picks the category, WITHOUT a live database. The
// exact dead-letter/queued row transition on a real CHECK/CASE is proven by the
// live-Postgres test in maintenance-queue.pg.test.ts.
function captureFailPool() {
  const failParams: unknown[][] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (/UPDATE\s+maintenance_jobs[\s\S]*state\s*=\s*CASE/i.test(sql)) {
        failParams.push(params);
      }
      // Echo a minimal running->transition row so toJob() succeeds.
      return {
        rows: [
          {
            id: "job-1",
            job_kind: "maintenance.test",
            job_version: 1,
            payload: {},
            idempotency_key: "once",
            state: "dead_letter",
            run_after: new Date("2026-07-22T12:00:00.000Z"),
            lease_token: null,
            lease_until: null,
            attempts: 1,
            max_attempts: 3,
            backoff_base_ms: 1_000,
            backoff_max_ms: 4_000,
            last_error_category: (params?.[3] as string) ?? null,
            terminal_at: new Date("2026-07-22T12:00:01.000Z"),
            dead_lettered_at: new Date("2026-07-22T12:00:01.000Z"),
            namespace: null,
            provenance: null,
            created_at: new Date("2026-07-22T12:00:00.000Z"),
            updated_at: new Date("2026-07-22T12:00:01.000Z"),
          },
        ],
        rowCount: 1,
      };
    },
    connect: async () => {
      throw new Error("fail() must not open a transaction");
    },
  };
  return { pool: pool as never, failParams };
}

describe("maintenance queue fail() terminal short-circuit", () => {
  it("passes terminal=true and category 'terminal' to the fail UPDATE", async () => {
    const { pool, failParams } = captureFailPool();
    const queue = new MaintenanceQueue(pool);
    // A job with retry budget remaining (attempts 1 < max 3): only the terminal
    // flag can force an immediate dead-letter, not the attempt bound.
    const failed = await queue.fail({
      job: job({ attempts: 1, maxAttempts: 3 }),
      error: new MaintenanceTerminalError("private terminal text"),
      category: "terminal",
      terminal: true,
    });
    expect(failParams).toHaveLength(1);
    // $4 = category, $5 = terminal flag.
    expect(failParams[0]?.[3]).toBe("terminal");
    expect(failParams[0]?.[4]).toBe(true);
    expect(failed?.state).toBe("dead_letter");
  });

  it("passes terminal=false for an ordinary error (bounded retry preserved)", async () => {
    const { pool, failParams } = captureFailPool();
    const queue = new MaintenanceQueue(pool);
    await queue.fail({
      job: job({ attempts: 1, maxAttempts: 3 }),
      error: new Error("transient text"),
    });
    expect(failParams).toHaveLength(1);
    expect(failParams[0]?.[3]).toBe("error");
    expect(failParams[0]?.[4]).toBe(false);
  });
});
