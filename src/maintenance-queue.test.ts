import { describe, expect, it } from "bun:test";
import {
  MaintenanceQueue,
  MaintenanceQueueRunner,
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
