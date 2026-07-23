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
  composeMaintenanceHandlers,
  MAINTENANCE_GRAPH_AUTH,
} from "./maintenance-bootstrap.ts";
import {
  EMBEDDING_REPAIR_JOB_KIND,
  EMBEDDING_REPAIR_JOB_VERSION,
} from "./embedding-repair-handler.ts";
import {
  GRAPH_DERIVATION_JOB_KIND,
  GRAPH_DERIVATION_JOB_VERSION,
  GraphDerivationTerminalError,
} from "./graph-derivation-handler.ts";
import type {
  MaintenanceJob,
  MaintenanceQueueLogger,
} from "./maintenance-queue.ts";
import type { EmbedWithMetaFn } from "./embedding-repair.ts";
import type { AuthInfo } from "./types.ts";
import { sharedNamespaceConfig } from "./shared-namespace.ts";

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
    job_kind: EMBEDDING_REPAIR_JOB_KIND as string,
    job_version: EMBEDDING_REPAIR_JOB_VERSION,
    payload: { table: "thoughts", scope: { global: true } } as Record<
      string,
      unknown
    >,
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
    namespace: null as string | null,
    provenance: null,
    created_at: now,
    updated_at: now,
  };
}

/** A leased graph.derive job row. The payload is intentionally schema-INVALID
 * (missing every required field) so the graph handler dispatches, throws its
 * GraphDerivationTerminalError, and the runner fails it as `terminal` — proving
 * the handler was actually reached WITHOUT needing to fake the full derivation
 * SQL. A dispatch to no handler would fail as `unsupported_job_kind` instead. */
function graphJobRow() {
  const base = jobRow();
  return {
    ...base,
    id: "job-graph-1",
    job_kind: GRAPH_DERIVATION_JOB_KIND,
    job_version: GRAPH_DERIVATION_JOB_VERSION,
    // Schema-invalid on purpose (missing every required field).
    payload: {} as Record<string, unknown>,
    idempotency_key: "boot-graph-k",
    namespace: "some-ns" as string | null,
  };
}

/**
 * Fake pool emulating exactly the SQL the MaintenanceQueue + handlers issue:
 *  - claimDueJobs(): pool.connect() -> BEGIN, the claim CTE (returns `claimRows`
 *    ONCE, then nothing so a second tick claims no work), COMMIT, release().
 *  - the embedding handler's repair SELECT -> empty (convergent no-op).
 *  - the fail UPDATE -> rowCount 1, capturing the category param ($4).
 *  - complete(): UPDATE ... state='succeeded' -> rowCount 1.
 */
type FakeJobRow = ReturnType<typeof jobRow>;

function fakePool(claimRows: FakeJobRow[]) {
  let claimed = false;
  const completeCalls: unknown[][] = [];
  const failCategories: Array<string | null> = [];

  const runQuery = async (sql: string, params: unknown[] = []) => {
    if (/state\s*=\s*'succeeded'/i.test(sql)) {
      completeCalls.push(params);
      return { rows: [], rowCount: 1 };
    }
    // The fail UPDATE forks on CASE and records last_error_category = $4.
    if (/UPDATE\s+maintenance_jobs[\s\S]*state\s*=\s*CASE/i.test(sql)) {
      failCategories.push((params?.[3] as string) ?? null);
      return { rows: [], rowCount: 1 };
    }
    // The claim CTE ends in an UPDATE ... SET state='running' ... RETURNING.
    if (/SET\s+state\s*=\s*'running'/i.test(sql)) {
      if (claimed) return { rows: [], rowCount: 0 };
      claimed = true;
      return { rows: claimRows, rowCount: claimRows.length };
    }
    // Any handler SELECT: no rows (embedding: no stale; graph: never reaches it
    // because the invalid-payload guard throws terminal first).
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
  return { pool: pool as any, client, completeCalls, failCategories };
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

  it("throws for an unknown kind — proves only registered kinds are handled", async () => {
    // A job of an unregistered kind must be failed as unsupported_job_kind, not
    // silently handled. We assert the runner claimed+failed it (no complete).
    const wrong = { ...jobRow(), job_kind: "not.a.real.kind" };
    const { pool, completeCalls, failCategories } = fakePool([wrong]);
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
    expect(failCategories).toEqual(["unsupported_job_kind"]);
  });

  it("dispatches BOTH embedding.repair (complete) and graph.derive (its own handler)", async () => {
    // Seed one of each kind. The embedding job SELECTs no stale rows and
    // completes. The graph job carries a schema-invalid payload, so the
    // graph-derivation handler runs and throws its terminal error — the runner
    // fails it as `terminal`. Both outcomes are handler-specific: an unregistered
    // graph.derive would instead fail as `unsupported_job_kind`.
    const { pool, completeCalls, failCategories } = fakePool([
      jobRow(),
      graphJobRow(),
    ]);
    const rt = startMaintenanceQueue({
      pool,
      logger: silentLogger,
      embedFn: stubEmbed,
      autoStart: false,
    });
    await rt.runner.runOnce();
    await rt.stop();

    // embedding.repair reached completion.
    expect(completeCalls.map((c) => c[0])).toContain("job-boot-1");
    // graph.derive was dispatched to ITS handler (terminal), not unsupported.
    expect(failCategories).toContain("terminal");
    expect(failCategories).not.toContain("unsupported_job_kind");
  });
});

describe("composeMaintenanceHandlers", () => {
  const fakeDbPool = { query: async () => ({ rows: [], rowCount: 0 }) } as any;

  it("registers both embedding.repair and graph.derive under their kinds", () => {
    const handlers = composeMaintenanceHandlers({
      pool: fakeDbPool,
      logger: silentLogger,
      embedFn: stubEmbed,
      graphAuth: MAINTENANCE_GRAPH_AUTH,
    });
    expect(handlers.has(EMBEDDING_REPAIR_JOB_KIND)).toBe(true);
    expect(handlers.has(GRAPH_DERIVATION_JOB_KIND)).toBe(true);
    expect(handlers.size).toBe(2);
  });

  it("refuses to register without a clear auth identity (fail closed)", () => {
    const noRole = { clientId: "x" } as unknown as AuthInfo;
    const noClient = { role: "ob-admin" } as unknown as AuthInfo;
    expect(() =>
      composeMaintenanceHandlers({
        pool: fakeDbPool,
        logger: silentLogger,
        embedFn: stubEmbed,
        graphAuth: noRole,
      }),
    ).toThrow(/auth identity/);
    expect(() =>
      composeMaintenanceHandlers({
        pool: fakeDbPool,
        logger: silentLogger,
        embedFn: stubEmbed,
        graphAuth: noClient,
      }),
    ).toThrow(/auth identity/);
  });

  it("the default maintenance identity is a token-sourced global admin", () => {
    // Token-sourced (not header-pinned) so it can serve jobs across namespaces;
    // ob-admin so it can write the derived namespace. The per-job namespace and
    // source-snapshot guards inside the handler remain the actual authority.
    expect(MAINTENANCE_GRAPH_AUTH.namespaceSource).toBe("token");
    expect(MAINTENANCE_GRAPH_AUTH.role).toBe("ob-admin");
    expect(MAINTENANCE_GRAPH_AUTH.clientId.length).toBeGreaterThan(0);
  });
});

/**
 * Regression for #358 finding 1 (P1): the PRODUCTION-composed graph.derive
 * handler must authorize and dispatch a shared-kb job, because
 * MAINTENANCE_GRAPH_AUTH now satisfies the existing shared-kb promoter
 * convention (tokenClientId ∈ PROMOTER_CLIENT_IDS). Before the fix, ob-admin
 * without a promoter tokenClientId failed canWriteNamespace for the shared
 * namespace, so every shared-kb graph.derive job terminal-dead-lettered.
 *
 * The handler under test is pulled from composeMaintenanceHandlers with the real
 * default identity — no synthetic auth — so this exercises exactly what the
 * server wires. Proof of "authorization passed, dispatch reached": the handler
 * gets PAST canWriteNamespace and issues the snapshot-guard SELECT; with an
 * empty source table that guard then throws the SNAPSHOT terminal reason, which
 * is a distinct signal from the pre-read authorization rejection. Foreign
 * namespace authority remains guarded: the same production identity is still
 * rejected pre-read for a frozen namespace, and the promoter grant never
 * bypasses the per-job namespace/source guards.
 */
describe("MAINTENANCE_GRAPH_AUTH shared-kb authorization (#358 finding 1)", () => {
  const SHARED_NS = sharedNamespaceConfig().physicalSharedNamespace;
  const VALID_SOURCE_ID = "44444444-4444-4444-8444-444444444444";

  /** A fake pool that records every SQL statement and returns no rows for the
   * snapshot-guard SELECT (empty source table) so the handler terminates there
   * — AFTER passing authorization. */
  function recordingPool() {
    const sqls: string[] = [];
    const query = async (sql: string) => {
      sqls.push(sql);
      return { rows: [], rowCount: 0 };
    };
    return { pool: { query } as any, sqls };
  }

  /** The production-composed graph.derive handler under the real default id. */
  function productionGraphHandler(pool: any) {
    const handlers = composeMaintenanceHandlers({
      pool,
      logger: silentLogger,
      embedFn: stubEmbed,
      graphAuth: MAINTENANCE_GRAPH_AUTH,
    });
    const handler = handlers.get(GRAPH_DERIVATION_JOB_KIND);
    if (!handler) throw new Error("graph.derive handler not registered");
    return handler;
  }

  function graphJob(namespace: string | null): MaintenanceJob {
    const now = new Date("2026-07-22T12:00:00.000Z");
    return {
      id: "job-shared-1",
      kind: GRAPH_DERIVATION_JOB_KIND,
      version: GRAPH_DERIVATION_JOB_VERSION,
      payload: {
        source_id: VALID_SOURCE_ID,
        source_kind: "git",
        external_id: "https://example.invalid/repo.git",
        content_hash: "a".repeat(64),
        revision: 3,
      },
      idempotencyKey: "k-shared",
      state: "running",
      runAfter: now,
      leaseToken: "00000000-0000-4000-8000-000000000001",
      leaseUntil: new Date("2026-07-22T12:00:30.000Z"),
      attempts: 1,
      maxAttempts: 3,
      backoffBaseMs: 1_000,
      backoffMaxMs: 4_000,
      lastErrorCategory: null,
      terminalAt: null,
      deadLetteredAt: null,
      namespace,
      provenance: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  it("a shared-kb job PASSES authorization and reaches snapshot dispatch", async () => {
    const { pool, sqls } = recordingPool();
    const handler = productionGraphHandler(pool);

    // The empty source table makes the snapshot guard the terminal cause. The
    // point is WHICH terminal cause: it must be the post-auth snapshot guard,
    // proving canWriteNamespace(MAINTENANCE_GRAPH_AUTH, shared-kb) allowed.
    let thrown: unknown;
    try {
      await handler(graphJob(SHARED_NS));
      throw new Error("expected the snapshot guard to terminate this job");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GraphDerivationTerminalError);
    // Authorization passed: the reason is the snapshot guard, NOT "not writable".
    expect(String((thrown as Error).message)).toContain("snapshot changed");
    expect(String((thrown as Error).message)).not.toContain("not writable");
    // Dispatch reached the DB: the snapshot-guard SELECT was actually issued.
    expect(sqls.some((s) => s.includes("SELECT title"))).toBe(true);
  });

  it("the canonical shared alias also passes authorization to snapshot dispatch", async () => {
    const canonical = sharedNamespaceConfig().canonicalSharedNamespace;
    const { pool, sqls } = recordingPool();
    const handler = productionGraphHandler(pool);
    await expect(handler(graphJob(canonical))).rejects.toThrow(
      "snapshot changed",
    );
    expect(sqls.some((s) => s.includes("SELECT title"))).toBe(true);
  });

  it("foreign namespace authority stays guarded: a frozen namespace is rejected pre-read", async () => {
    // Even the promoter-conventioned maintenance identity cannot write a frozen
    // snapshot namespace; it is rejected before any source read. Proof the grant
    // is scoped to shared-kb and does not blanket-open canWriteNamespace.
    const { pool, sqls } = recordingPool();
    const handler = productionGraphHandler(pool);
    await expect(handler(graphJob("collab"))).rejects.toBeInstanceOf(
      GraphDerivationTerminalError,
    );
    // Rejected before the snapshot read: no SELECT issued.
    expect(sqls.some((s) => s.includes("SELECT title"))).toBe(false);
  });

  it("still fails closed on a missing job namespace (no bypass introduced)", async () => {
    const { pool, sqls } = recordingPool();
    const handler = productionGraphHandler(pool);
    await expect(handler(graphJob(null))).rejects.toBeInstanceOf(
      GraphDerivationTerminalError,
    );
    expect(sqls.some((s) => s.includes("SELECT title"))).toBe(false);
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
