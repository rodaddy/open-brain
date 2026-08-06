import { describe, expect, it } from "bun:test";
import { createNatsBridgeHealth } from "../src/nats-bridge.ts";
import {
  readNatsWorkerBoundary,
  type NatsWorkerRuntime,
  type StartNatsWorkerOptions,
} from "../src/nats-worker.ts";
import type { BackgroundTraceBody } from "../src/background-tracing.ts";
import {
  createTracingRuntime,
  type McpTracingConfig,
  type TraceBody,
  type TracingSink,
} from "../server/observability/langfuse-tracing.ts";
import { safeWorkerError, startNatsWorkerProcess } from "./run-nats-worker.ts";

const ENABLED_CONFIG: McpTracingConfig = {
  enabled: true,
  maskingEnabled: true,
  endpoint: "http://127.0.0.1:3000",
  publicKey: "pk-test",
  secretKey: "sk-test",
};

function recordingSink(): TracingSink & { bodies: TraceBody[]; shutdowns: number } {
  const bodies: TraceBody[] = [];
  return {
    bodies,
    shutdowns: 0,
    emit: (body) => bodies.push(body),
    forceFlush: () => Promise.resolve(),
    async shutdown() {
      this.shutdowns += 1;
    },
  };
}

describe("startNatsWorkerProcess", () => {
  it("routes background traces into the process-owned sink and drains it on shutdown", async () => {
    const env = {
      OPENBRAIN_NATS_URL: "nats://127.0.0.1:4222",
      OPEN_BRAIN_NATS_WORKER_HEALTH_PORT: "0",
    };
    const sink = recordingSink();
    const body: BackgroundTraceBody = {
      name: "nats.message",
      tags: ["background-job", "nats"],
      metadata: { status: "success" },
      observations: [],
      startedAt: 1,
      endedAt: 2,
    };
    const runtime: NatsWorkerRuntime = {
      boundary: readNatsWorkerBoundary(env),
      health: createNatsBridgeHealth("available"),
      subject: "dev.ob.memory.context_pack",
      close: async () => undefined,
    };

    const processRuntime = await startNatsWorkerProcess({
      env,
      log: { info: () => undefined, error: () => undefined },
      buildTokens: () =>
        new Map([["secret-token", { role: "admin", clientId: "rico" }]]),
      createDbPool: () => ({ end: async () => undefined }) as any,
      createTracing: () => createTracingRuntime({ config: ENABLED_CONFIG, sink }),
      startWorker: async (options: StartNatsWorkerOptions) => {
        options.tracing?.emitBackground(body);
        return runtime;
      },
    });

    expect(sink.bodies).toHaveLength(1);
    expect(sink.bodies[0]).toMatchObject({ name: "nats.message" });
    await processRuntime.shutdown();
    expect(sink.shutdowns).toBe(1);
  });

  it("closes the bridge and pool when health server bind fails after subscription startup", async () => {
    const env = {
      OPENBRAIN_NATS_URL: "nats://user:pass@127.0.0.1:4222",
      OPEN_BRAIN_NATS_WORKER_HEALTH_PORT: "3110",
    };
    let runtimeClosed = false;
    let poolEnded = false;
    const infoLogs: string[] = [];
    const errorLogs: string[] = [];
    const runtime: NatsWorkerRuntime = {
      boundary: readNatsWorkerBoundary(env),
      health: createNatsBridgeHealth("available"),
      subject: "dev.ob.memory.context_pack",
      close: async () => {
        runtimeClosed = true;
      },
    };

    await expect(
      startNatsWorkerProcess({
        env,
        log: {
          info: (message, extra) => {
            infoLogs.push(JSON.stringify({ message, extra }));
          },
          error: (message, extra) => {
            errorLogs.push(JSON.stringify({ message, extra }));
          },
        },
        buildTokens: () =>
          new Map([["secret-token", { role: "admin", clientId: "rico" }]]),
        createDbPool: () =>
          ({
            end: async () => {
              poolEnded = true;
            },
          }) as any,
        startWorker: async () => runtime,
        serve: (() => {
          throw new Error("listen failed for nats://user:pass@broker.internal");
        }) as any,
      }),
    ).rejects.toThrow("listen failed");

    expect(runtimeClosed).toBe(true);
    expect(poolEnded).toBe(true);
    expect(infoLogs.join("\n")).not.toContain("Open Brain NATS worker started");
    expect(errorLogs.join("\n")).not.toContain("user:pass");
    expect(errorLogs.join("\n")).not.toContain("broker.internal");
  });

  it("continues pool shutdown when bridge close times out", async () => {
    const env = {
      OPENBRAIN_NATS_URL: "nats://127.0.0.1:4222",
      OPEN_BRAIN_NATS_WORKER_HEALTH_PORT: "0",
      OPEN_BRAIN_NATS_WORKER_SHUTDOWN_TIMEOUT_MS: "1",
    };
    let poolEnded = false;
    const errorLogs: string[] = [];
    const runtime: NatsWorkerRuntime = {
      boundary: readNatsWorkerBoundary(env),
      health: createNatsBridgeHealth("available"),
      subject: "dev.ob.memory.context_pack",
      close: async () => {
        await new Promise(() => undefined);
      },
    };

    const processRuntime = await startNatsWorkerProcess({
      env,
      log: {
        info: () => undefined,
        error: (message, extra) => {
          errorLogs.push(JSON.stringify({ message, extra }));
        },
      },
      buildTokens: () =>
        new Map([["secret-token", { role: "admin", clientId: "rico" }]]),
      createDbPool: () =>
        ({
          end: async () => {
            poolEnded = true;
          },
        }) as any,
      startWorker: async () => runtime,
    });

    await processRuntime.shutdown();

    expect(poolEnded).toBe(true);
    expect(errorLogs.join("\n")).toContain(
      "Open Brain NATS worker bridge close failed",
    );
    expect(errorLogs.join("\n")).not.toContain("timed out");
  });
});

describe("safeWorkerError", () => {
  it("reports error type without leaking the message", () => {
    expect(
      safeWorkerError(new Error("nats://user:pass@broker.internal failed")),
    ).toEqual({ error_type: "Error" });
  });

  it("classifies by an instanceof allowlist, not the mutable err.name (#283)", () => {
    // A hostile/mutable name that embeds a secret must NOT be surfaced.
    const err = new Error("boom");
    err.name = "NatsError nats://user:pass@broker.internal";
    expect(safeWorkerError(err)).toEqual({ error_type: "Error" });

    expect(safeWorkerError(new SyntaxError("x"))).toEqual({
      error_type: "SyntaxError",
    });
    expect(safeWorkerError(new TypeError("x"))).toEqual({
      error_type: "TypeError",
    });
    expect(safeWorkerError(new RangeError("x"))).toEqual({
      error_type: "RangeError",
    });
    expect(
      safeWorkerError(new AggregateError([new Error("a")], "agg")),
    ).toEqual({ error_type: "AggregateError" });
  });

  it("reports typeof for non-Error throws", () => {
    expect(safeWorkerError("just a string")).toEqual({ error_type: "string" });
    expect(safeWorkerError(42)).toEqual({ error_type: "number" });
  });
});
