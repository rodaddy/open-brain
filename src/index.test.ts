import { describe, expect, it, mock } from "bun:test";
import { silentTracingLogger } from "../server/observability/trace-logger-fixture.ts";
import {
  createTracingRuntime,
  type McpTracingConfig,
  type TraceBody,
  type TracingSink,
} from "../server/observability/langfuse-tracing.ts";
import { EMBEDDING_REPAIR_JOB_VERSION } from "./embedding-repair-handler.ts";
import { startServerMaintenanceQueue } from "./index.ts";

const ENABLED_CONFIG: McpTracingConfig = {
  enabled: true,
  maskingEnabled: true,
  endpoint: "http://127.0.0.1:3000",
  publicKey: "pk-test",
  secretKey: "sk-test",
};

function recordingSink(): TracingSink & { bodies: TraceBody[] } {
  const bodies: TraceBody[] = [];
  return {
    bodies,
    emit: (body) => bodies.push(body),
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
}

function maintenancePool() {
  let claimed = false;
  const now = new Date("2026-08-06T00:00:00.000Z");
  const job = {
    id: "job-index-composition",
    job_kind: "embedding.repair",
    job_version: EMBEDDING_REPAIR_JOB_VERSION,
    payload: { table: "thoughts", scope: { global: true } },
    idempotency_key: "index-composition",
    state: "running",
    run_after: now,
    lease_token: "00000000-0000-4000-8000-000000000001",
    lease_until: new Date("2026-08-06T00:00:30.000Z"),
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
  const query = mock(async (sql: string) => {
    if (/SET\s+state\s*=\s*'running'/i.test(sql)) {
      if (claimed) return { rows: [], rowCount: 0 };
      claimed = true;
      return { rows: [job], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release: () => undefined };
  return { query, connect: async () => client } as any;
}

describe("server background tracing composition", () => {
  it("routes a maintenance handler trace into the process-owned sink", async () => {
    const sink = recordingSink();
    const tracing = createTracingRuntime({
      config: ENABLED_CONFIG,
      sink,
      logger: silentTracingLogger(),
    });
    const runtime = startServerMaintenanceQueue(
      {
        pool: maintenancePool(),
        logger: {
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        },
        autoStart: false,
      },
      tracing,
    );

    await runtime.runner.runOnce();
    await runtime.stop();
    await tracing.shutdown();

    expect(sink.bodies).toHaveLength(1);
    expect(sink.bodies[0]).toMatchObject({
      name: "embedding.repair",
      metadata: { status: "success" },
    });
    expect(sink.bodies[0]?.tags).toEqual(
      expect.arrayContaining(["background-job", "embedding"]),
    );
  });
});
