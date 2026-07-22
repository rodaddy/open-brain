import { describe, it, expect, mock } from "bun:test";
import type { EmbeddingError } from "./embedding.ts";
import {
  MaintenanceQueueRunner,
  type MaintenanceJob,
  type MaintenanceJobHandler,
  type MaintenanceQueuePort,
  type MaintenanceQueueLogger,
} from "./maintenance-queue.ts";
import {
  createEmbeddingRepairHandler,
  buildEmbeddingRepairHandlers,
  embeddingRepairPayloadSchema,
  EMBEDDING_REPAIR_JOB_KIND,
  EMBEDDING_REPAIR_JOB_VERSION,
} from "./embedding-repair-handler.ts";

// --- Helpers -----------------------------------------------------------------

/** A logger that records every (message, fields) so we can assert content-free. */
function recordingLogger(): {
  logger: MaintenanceQueueLogger;
  lines: Array<{
    level: string;
    message: string;
    fields: Record<string, unknown>;
  }>;
} {
  const lines: Array<{
    level: string;
    message: string;
    fields: Record<string, unknown>;
  }> = [];
  const push =
    (level: string) =>
    (message: string, fields: Record<string, string | number>) =>
      lines.push({ level, message, fields });
  return {
    lines,
    logger: { info: push("info"), warn: push("warn"), error: push("error") },
  };
}

function job(overrides: Partial<MaintenanceJob> = {}): MaintenanceJob {
  return {
    id: "job-1",
    kind: EMBEDDING_REPAIR_JOB_KIND,
    version: EMBEDDING_REPAIR_JOB_VERSION,
    payload: { table: "thoughts", scope: { global: true } },
    idempotencyKey: "k",
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

/** Mock db: SELECT returns `selectRows` (once, then empty to model repair convergence). */
function mockDb(script: {
  selectRowsByCall?: Record<string, unknown>[][];
  updateRowCount?: number;
}) {
  let selectCall = 0;
  const calls: { sql: string; params: unknown[] }[] = [];
  const query = mock(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (/^\s*SELECT/i.test(sql)) {
      const rows = script.selectRowsByCall?.[selectCall] ?? [];
      selectCall += 1;
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: script.updateRowCount ?? 1 };
  });
  return {
    db: { query } as any,
    calls,
    updates: () => calls.filter((c) => /^\s*UPDATE/i.test(c.sql)),
  };
}

const okEmbed = mock(
  async (): Promise<{
    embedding: number[] | null;
    error?: EmbeddingError;
  }> => ({
    embedding: Array(768).fill(0.1),
  }),
);
function failEmbed(code: EmbeddingError["code"]) {
  return mock(async () => ({
    embedding: null,
    error: { code, message: "x", attempts: 1 } as EmbeddingError,
  }));
}

const missingThought = (id: string) => ({
  id,
  content: "hi",
  tags: [],
  namespace: "ns-a",
  __embedding_missing: true,
});

// --- Payload schema ----------------------------------------------------------

describe("embedding.repair payload schema", () => {
  it("accepts a namespaced scope + known table", () => {
    const r = embeddingRepairPayloadSchema.safeParse({
      table: "thoughts",
      scope: { namespaces: ["ns-a"] },
    });
    expect(r.success).toBe(true);
  });

  it("accepts the explicit global scope", () => {
    expect(
      embeddingRepairPayloadSchema.safeParse({
        table: "thoughts",
        scope: { global: true },
      }).success,
    ).toBe(true);
  });

  it("rejects a missing scope (no unscoped default)", () => {
    expect(
      embeddingRepairPayloadSchema.safeParse({ table: "thoughts" }).success,
    ).toBe(false);
  });

  it("rejects an empty namespaces list", () => {
    expect(
      embeddingRepairPayloadSchema.safeParse({
        table: "thoughts",
        scope: { namespaces: [] },
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown table (allowlist gate)", () => {
    expect(
      embeddingRepairPayloadSchema.safeParse({
        table: "robert'); DROP TABLE thoughts;--",
        scope: { global: true },
      }).success,
    ).toBe(false);
  });

  it("rejects an oversized limit", () => {
    expect(
      embeddingRepairPayloadSchema.safeParse({
        table: "thoughts",
        scope: { global: true },
        limit: 100000,
      }).success,
    ).toBe(false);
  });
});

// --- Handler behavior --------------------------------------------------------

describe("createEmbeddingRepairHandler", () => {
  it("repairs a bounded batch and resolves (queue marks succeeded)", async () => {
    const { db, updates } = mockDb({
      selectRowsByCall: [[missingThought("t1"), missingThought("t2")]],
      updateRowCount: 1,
    });
    const { logger, lines } = recordingLogger();
    const handler = createEmbeddingRepairHandler({
      db,
      logger,
      embedFn: okEmbed,
    });

    await expect(handler(job())).resolves.toBeUndefined();
    expect(updates().length).toBe(2);
    const done = lines.find((l) => l.message === "embedding_repair_job_done");
    expect(done?.fields.repaired).toBe(2);
    expect(done?.fields.table).toBe("thoughts");
  });

  it("is a no-op on replay after a full repair (idempotent, selected:0)", async () => {
    // First call sees two stale rows; the (idempotent) second call sees none,
    // modeling that the repair converged and nothing is stale anymore.
    const { db, updates } = mockDb({
      selectRowsByCall: [[missingThought("t1")], []],
      updateRowCount: 1,
    });
    const { logger, lines } = recordingLogger();
    const handler = createEmbeddingRepairHandler({
      db,
      logger,
      embedFn: okEmbed,
    });

    await handler(job());
    await handler(job()); // replay

    const dones = lines.filter(
      (l) => l.message === "embedding_repair_job_done",
    );
    expect(dones[0]!.fields.repaired).toBe(1);
    // Replay selected nothing -> a true no-op: zero repairs, zero updates added.
    expect(dones[1]!.fields.selected).toBe(0);
    expect(dones[1]!.fields.repaired).toBe(0);
    expect(updates().length).toBe(1); // only the first call issued an UPDATE
  });

  it("THROWS on a retryable provider failure so the queue re-delivers", async () => {
    const { db, updates } = mockDb({
      selectRowsByCall: [[missingThought("t1")]],
    });
    const { logger } = recordingLogger();
    const handler = createEmbeddingRepairHandler({
      db,
      logger,
      embedFn: failEmbed("timeout") as any,
    });
    await expect(handler(job())).rejects.toThrow(/retryable/i);
    expect(updates().length).toBe(0); // never wrote a vector on provider failure
  });

  it("does NOT throw on a permanent provider failure (won't dead-letter the batch)", async () => {
    const { db } = mockDb({ selectRowsByCall: [[missingThought("t1")]] });
    const { logger, lines } = recordingLogger();
    const handler = createEmbeddingRepairHandler({
      db,
      logger,
      embedFn: failEmbed("input_invalid") as any,
    });
    await expect(handler(job())).resolves.toBeUndefined();
    const done = lines.find((l) => l.message === "embedding_repair_job_done");
    expect(done?.fields.permanent_failures).toBe(1);
    expect(done?.fields.retryable_failures).toBe(0);
  });

  it("rejects an unsupported payload version (permanent input error)", async () => {
    const { db } = mockDb({ selectRowsByCall: [[]] });
    const { logger } = recordingLogger();
    const handler = createEmbeddingRepairHandler({
      db,
      logger,
      embedFn: okEmbed,
    });
    await expect(
      handler(job({ version: EMBEDDING_REPAIR_JOB_VERSION + 1 })),
    ).rejects.toThrow(/version/i);
  });

  it("rejects an invalid payload without leaking its contents", async () => {
    const { db } = mockDb({ selectRowsByCall: [[]] });
    const { logger } = recordingLogger();
    const handler = createEmbeddingRepairHandler({
      db,
      logger,
      embedFn: okEmbed,
    });
    let caught: unknown;
    try {
      // Missing scope -> schema rejects.
      await handler(
        job({ payload: { table: "thoughts", secret: "leak me" } as any }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message)).not.toContain("leak me");
  });

  it("passes the payload scope straight through to the guarded read+write", async () => {
    const { db, calls } = mockDb({
      selectRowsByCall: [[missingThought("t1")]],
      updateRowCount: 1,
    });
    const { logger } = recordingLogger();
    const handler = createEmbeddingRepairHandler({
      db,
      logger,
      embedFn: okEmbed,
    });
    await handler(
      job({ payload: { table: "thoughts", scope: { namespaces: ["ns-x"] } } }),
    );
    const select = calls.find((c) => /^\s*SELECT/i.test(c.sql))!;
    const update = calls.find((c) => /^\s*UPDATE/i.test(c.sql))!;
    // Same auth-derived namespace list is bound on BOTH statements.
    expect(select.params).toContainEqual(["ns-x"]);
    expect(update.params).toContainEqual(["ns-x"]);
  });

  it("telemetry is content-free (no source text, no namespace values)", async () => {
    const { db } = mockDb({
      selectRowsByCall: [
        [
          {
            id: "t1",
            content: "SECRET SOURCE TEXT",
            tags: [],
            namespace: "ns-secret",
            __embedding_missing: true,
          },
        ],
      ],
      updateRowCount: 1,
    });
    const { logger, lines } = recordingLogger();
    const handler = createEmbeddingRepairHandler({
      db,
      logger,
      embedFn: okEmbed,
    });
    await handler(
      job({
        payload: { table: "thoughts", scope: { namespaces: ["ns-secret"] } },
      }),
    );
    const payload = JSON.stringify(lines);
    expect(payload).not.toContain("SECRET SOURCE TEXT");
    expect(payload).not.toContain("ns-secret");
  });
});

// --- Registration with the REAL runner --------------------------------------

describe("registration with the real MaintenanceQueueRunner", () => {
  function fakeQueue(claimed: MaintenanceJob[]): {
    queue: MaintenanceQueuePort;
    completed: string[];
    failed: string[];
  } {
    const completed: string[] = [];
    const failed: string[] = [];
    let handedOut = false;
    const queue: MaintenanceQueuePort = {
      claimDueJobs: async () => {
        if (handedOut) return [];
        handedOut = true;
        return claimed;
      },
      complete: async (id) => {
        completed.push(id);
        return true;
      },
      fail: async ({ job: j }) => {
        failed.push(j.id);
        return { ...j, state: "queued" };
      },
    };
    return { queue, completed, failed };
  }

  it("buildEmbeddingRepairHandlers registers under the job kind", () => {
    const { logger } = recordingLogger();
    const { db } = mockDb({ selectRowsByCall: [[]] });
    const handlers = buildEmbeddingRepairHandlers({
      db,
      logger,
      embedFn: okEmbed,
    });
    expect(handlers.has(EMBEDDING_REPAIR_JOB_KIND)).toBe(true);
    expect(typeof handlers.get(EMBEDDING_REPAIR_JOB_KIND)).toBe("function");
  });

  it("the runner claims, dispatches to our handler, and completes the job", async () => {
    const { db } = mockDb({
      selectRowsByCall: [[missingThought("t1")]],
      updateRowCount: 1,
    });
    const { logger } = recordingLogger();
    const handlers = buildEmbeddingRepairHandlers({
      db,
      logger,
      embedFn: okEmbed,
    });
    const { queue, completed, failed } = fakeQueue([job({ id: "run-1" })]);

    const runner = new MaintenanceQueueRunner({ queue, handlers, logger });
    await runner.runOnce();
    await runner.stop();

    expect(completed).toEqual(["run-1"]);
    expect(failed).toEqual([]);
  });

  it("a retryable provider failure makes the runner FAIL (re-queue) the job", async () => {
    const { db } = mockDb({ selectRowsByCall: [[missingThought("t1")]] });
    const { logger } = recordingLogger();
    const handlers: ReadonlyMap<string, MaintenanceJobHandler> = new Map([
      [
        EMBEDDING_REPAIR_JOB_KIND,
        createEmbeddingRepairHandler({
          db,
          logger,
          embedFn: failEmbed("network") as any,
        }),
      ],
    ]);
    const { queue, completed, failed } = fakeQueue([job({ id: "run-2" })]);

    const runner = new MaintenanceQueueRunner({ queue, handlers, logger });
    await runner.runOnce();
    await runner.stop();

    expect(completed).toEqual([]);
    expect(failed).toEqual(["run-2"]);
  });
});
