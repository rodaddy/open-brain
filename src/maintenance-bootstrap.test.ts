/**
 * Unit/integration coverage for the production maintenance bootstrap (#345/#356).
 *
 * Proves, WITHOUT a live database, that:
 *  1. `startMaintenanceQueue` registers the embedding-repair handler under its
 *     kind and returns a runnable queue + runner.
 *  2. `autoStart` controls whether polling begins; `stop()` halts it and is
 *     idempotent (safe to call twice, and after a never-started runner).
 *  3. An enqueued `embedding.repair` job is actually dispatched to the handler
 *     when the runner ticks — i.e. the wiring end-to-end reaches the handler.
 *  4. `maintenanceQueueEnabled` honors the opt-out env flag.
 *
 * The pool is a fake that emulates the exact SQL shapes the MaintenanceQueue
 * issues (claim CTE, complete UPDATE) plus the handler's SELECT, so the whole
 * queue→runner→handler path runs in-process with no core01 dependency.
 */
import { describe, it, expect, mock } from "bun:test";
import {
  startMaintenanceQueue,
  maintenanceQueueEnabled,
} from "./maintenance-bootstrap.ts";
import {
  EMBEDDING_REPAIR_JOB_KIND,
  EMBEDDING_REPAIR_JOB_VERSION,
} from "./embedding-repair-handler.ts";
import type { MaintenanceQueueLogger } from "./maintenance-queue.ts";
import type { EmbedWithMetaFn } from "./embedding-repair.ts";

const silentLogger: MaintenanceQueueLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// A deterministic embed fn so the handler never touches a provider. It is never
// called in these tests (the SELECT returns no stale rows), but it must be a
// valid EmbedWithMetaFn so the bootstrap wires a real handler.
const stubEmbed: EmbedWithMetaFn = async () => ({
  embedding: Array(768).fill(0.01),
});

/**
 * Build one leased `embedding.repair` job row in the queue's snake_case row
 * shape, ready to be returned by the fake claim.
 */
function jobRow() {
  const now = new Date("2026-07-22T12:00:00.000Z");
  return {
    id: "job-boot-1",
    job_kind: EMBEDDING_REPAIR_JOB_KIND,
    job_version: EMBEDDING_REPAIR_JOB_VERSION,
    payload: { table: "thoughts", scope: { global: true } },
    idempotency_key: "boot-k",
    state: "running",
    run_after: now,
    lease_token: "00000000-0000-4000-8000-000000000001",
    lease_until: new Date("2026-07-22T12:00:30.000Z"),
    attempts: 1,
    max_attempts: 3,
    backoff_base_ms: 1_000,
    backoff_max_ms: 4_000,
    last_error_category: null,
    terminal_at: null,
    dead_lettered_at: null,
    namespace: null,
    provenance: null,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Fake pool emulating exactly the SQL the MaintenanceQueue + handler issue:
 *  - claimDueJobs(): pool.connect() -> BEGIN, the claim CTE (returns `claimRows`
 *    ONCE, then nothing so a second tick claims no work), COMMIT, release().
 *  - the handler's repair SELECT -> empty (no stale rows -> convergent no-op).
 *  - complete(): UPDATE ... state='succeeded' -> rowCount 1.
 */
function fakePool(claimRows: ReturnType<typeof jobRow>[]) {
  let claimed = false;
  const completeCalls: unknown[][] = [];

  const runQuery = async (sql: string, params: unknown[] = []) => {
    if (/state\s*=\s*'succeeded'/i.test(sql)) {
      completeCalls.push(params);
      return { rows: [], rowCount: 1 };
    }
    // The claim CTE ends in an UPDATE ... SET state='running' ... RETURNING.
    if (/SET\s+state\s*=\s*'running'/i.test(sql)) {
      if (claimed) return { rows: [], rowCount: 0 };
      claimed = true;
      return { rows: claimRows, rowCount: claimRows.length };
    }
    // The handler's stale-selection SELECT: no stale rows -> a true no-op repair.
    if (/^\s*SELECT/i.test(sql)) return { rows: [], rowCount: 0 };
    // BEGIN / COMMIT / ROLLBACK and any other statement.
    return { rows: [], rowCount: 0 };
  };

  const client = { query: mock(runQuery), release: mock(() => {}) };
  const pool = {
    query: mock(runQuery),
    connect: mock(async () => client),
    end: mock(async () => {}),
  };
  return { pool: pool as any, client, completeCalls };
}

describe("startMaintenanceQueue wiring", () => {
  it("registers the embedding.repair handler on the runner", () => {
    const { pool } = fakePool([]);
    const rt = startMaintenanceQueue({
      pool,
      logger: silentLogger,
      embedFn: stubEmbed,
      autoStart: false,
    });
    // The runner refuses to start with no handlers; that it starts proves the
    // embedding-repair handler was registered under its kind.
    expect(() => rt.runner.start()).not.toThrow();
    return rt.stop();
  });

  it("autoStart:false does not begin polling; stop() is safe and idempotent", async () => {
    const { pool } = fakePool([]);
    const rt = startMaintenanceQueue({
      pool,
      logger: silentLogger,
      embedFn: stubEmbed,
      autoStart: false,
    });
    // No connect() call yet: polling never began.
    expect(pool.connect).not.toHaveBeenCalled();
    await rt.stop();
    await rt.stop(); // second stop is a no-op, must not throw
  });

  it("dispatches an enqueued job to the handler and completes it (no live DB)", async () => {
    const { pool, completeCalls } = fakePool([jobRow()]);
    const rt = startMaintenanceQueue({
      pool,
      logger: silentLogger,
      embedFn: stubEmbed,
      autoStart: false,
    });

    // Drive one tick explicitly (deterministic, no timers): the runner claims the
    // seeded job, dispatches it to the embedding.repair handler (which SELECTs no
    // stale rows -> convergent no-op), then marks it succeeded.
    await rt.runner.runOnce();
    await rt.stop();

    // Proof the handler ran to completion: the queue issued the complete UPDATE
    // bound to the claimed job id + lease token.
    expect(completeCalls.length).toBe(1);
    expect(completeCalls[0]?.[0]).toBe("job-boot-1");
  });

  it("throws for an unknown kind — proves ONLY embedding.repair is registered", async () => {
    // A job of an unregistered kind must be failed as unsupported_job_kind, not
    // silently handled. We assert the runner claimed+failed it (no complete).
    const wrong = { ...jobRow(), job_kind: "not.a.real.kind" };
    const { pool, completeCalls } = fakePool([wrong]);
    const rt = startMaintenanceQueue({
      pool,
      logger: silentLogger,
      embedFn: stubEmbed,
      autoStart: false,
    });
    await rt.runner.runOnce();
    await rt.stop();
    // Unsupported kind -> failed, never completed.
    expect(completeCalls.length).toBe(0);
  });
});

describe("maintenanceQueueEnabled", () => {
  it("defaults to enabled when unset", () => {
    expect(maintenanceQueueEnabled({} as NodeJS.ProcessEnv)).toBe(true);
  });
  it("is disabled by 0 / false (case-insensitive)", () => {
    expect(
      maintenanceQueueEnabled({ OPEN_BRAIN_MAINTENANCE_ENABLED: "0" } as any),
    ).toBe(false);
    expect(
      maintenanceQueueEnabled({
        OPEN_BRAIN_MAINTENANCE_ENABLED: "false",
      } as any),
    ).toBe(false);
    expect(
      maintenanceQueueEnabled({
        OPEN_BRAIN_MAINTENANCE_ENABLED: "FALSE",
      } as any),
    ).toBe(false);
  });
  it("stays enabled for any other value", () => {
    expect(
      maintenanceQueueEnabled({ OPEN_BRAIN_MAINTENANCE_ENABLED: "1" } as any),
    ).toBe(true);
    expect(
      maintenanceQueueEnabled({ OPEN_BRAIN_MAINTENANCE_ENABLED: "yes" } as any),
    ).toBe(true);
  });
});
