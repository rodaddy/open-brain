import { describe, expect, it } from "bun:test";
import type { NatsBridgeDriver, NatsRequestMessage } from "./nats-bridge.ts";
import { readNatsWorkerBoundary, startNatsWorker } from "./nats-worker.ts";

function fakePool() {
  return {
    query: async () => ({ rows: [] }),
    end: async () => undefined,
  } as any;
}

function fakeDriver() {
  const state: { subscribedSubject: string | null; closed: boolean } = {
    subscribedSubject: null,
    closed: false,
  };
  const driver: NatsBridgeDriver = {
    subscribe: async (subject: string, _handler: (message: NatsRequestMessage) => Promise<void>) => {
      state.subscribedSubject = subject;
      return {
        close: async () => {
          state.closed = true;
        },
      };
    },
    close: async () => {
      state.closed = true;
    },
  };
  return { driver, state };
}

describe("readNatsWorkerBoundary", () => {
  it("forces the dedicated worker into NATS mode without changing HTTP worker env", () => {
    const boundary = readNatsWorkerBoundary({
      OPENBRAIN_TRANSPORT: "http",
      OPENBRAIN_NATS_ENABLE_BRIDGE: "false",
      OPENBRAIN_NATS_URL: "nats://127.0.0.1:4222",
    });

    expect(boundary).toMatchObject({
      requested_transport: "nats",
      nats: {
        availability: "available",
        url: "nats://127.0.0.1:4222",
        context_pack_subject: "dev.ob.memory.context_pack",
      },
    });
  });

  it("fails closed when no NATS URL is configured", () => {
    const boundary = readNatsWorkerBoundary({});

    expect(boundary).toMatchObject({
      requested_transport: "nats",
      nats: {
        availability: "not_runtime_available",
        url: null,
      },
    });
  });
});

describe("startNatsWorker", () => {
  it("starts only the NATS bridge subscription and exposes separate health", async () => {
    const { driver, state } = fakeDriver();
    const runtime = await startNatsWorker({
      env: {
        OPENBRAIN_TRANSPORT: "http",
        OPENBRAIN_NATS_ENABLE_BRIDGE: "false",
        OPENBRAIN_NATS_URL: "nats://127.0.0.1:4222",
      },
      pool: fakePool(),
      tokenMap: new Map([["secret-token", { role: "admin", clientId: "rico" }]]),
      driver,
    });

    expect(runtime.subject).toBe("dev.ob.memory.context_pack");
    expect(state.subscribedSubject).toBe("dev.ob.memory.context_pack");
    expect(runtime.health.availability).toBe("available");

    await runtime.close();
    expect(state.closed).toBe(true);
  });

  it("does not start when the broker URL is unavailable or disallowed", async () => {
    await expect(
      startNatsWorker({
        env: {},
        pool: fakePool(),
        tokenMap: new Map(),
      }),
    ).rejects.toThrow("Dedicated NATS worker requires an allowed OPENBRAIN_NATS_URL");
  });
});
