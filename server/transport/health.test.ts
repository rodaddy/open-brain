/**
 * Single-worker health boundary tests.
 *
 * Design authority: `_plans/463-server-rewrite-charter.md` phase 4 freezes the
 * single-worker health shape -- database and embedding probed together, NATS
 * degradation reflected in status, and `workers[]` deliberately absent because
 * only the aggregate front owns it (`src/index.ts` `/health`).
 *
 * The database probe and `fetch` are injected, so this test opens no socket and
 * touches no Postgres.
 */
import { describe, expect, it } from "bun:test";
import type { DatabaseHealth } from "../db/pool.ts";
import { getSingleWorkerHealth } from "./index.ts";
import type { SingleWorkerHealthInput, TransportNatsHealth } from "./index.ts";
import { silentLogger } from "./testing/silent-logger.ts";

const CONNECTED: DatabaseHealth = { connected: true, total: 4, idle: 3, waiting: 0 };
const DISCONNECTED: DatabaseHealth = {
  connected: false,
  total: 0,
  idle: 0,
  waiting: 0,
  errorCategory: "Error",
};

function input(overrides?: Partial<SingleWorkerHealthInput>): SingleWorkerHealthInput {
  return {
    databaseHealth: async () => CONNECTED,
    hostname: "production-host",
    serverIp: "192.0.2.21",
    serverIps: ["192.0.2.21"],
    probeTimeoutMs: 3_000,
    logger: silentLogger(),
    ...overrides,
  };
}

function okFetch(calls: { url: string; authorization: string | null }[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), authorization: headers.get("Authorization") });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

describe("single worker health boundary", () => {
  it("reports healthy with a connected database and reachable embedding provider", async () => {
    const calls: { url: string; authorization: string | null }[] = [];
    const health = await getSingleWorkerHealth(
      input({
        embeddingBaseUrl: "http://127.0.0.1:8791/v1",
        embeddingApiKey: "probe-secret",
        fetch: okFetch(calls),
      }),
    );

    expect(health.status).toBe("healthy");
    expect(health.database).toEqual(CONNECTED);
    expect(health.embedding).toEqual({ configured: true, connected: true });
    expect(health.server_ip).toBe("192.0.2.21");
    expect(health.server_ips).toEqual(["192.0.2.21"]);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8791/v1/models");
    expect(calls[0]?.authorization).toBe("Bearer probe-secret");
  });

  it("omits the worker roster that only the aggregate front owns", async () => {
    const health = await getSingleWorkerHealth(input());
    expect(health).not.toHaveProperty("workers");
  });

  it("degrades when the database probe reports disconnected", async () => {
    const health = await getSingleWorkerHealth(
      input({ databaseHealth: async () => DISCONNECTED }),
    );
    expect(health.status).toBe("degraded");
    expect(health.database.errorCategory).toBe("Error");
  });

  it("stays healthy but reports the embedding provider unreachable", async () => {
    const health = await getSingleWorkerHealth(
      input({
        embeddingBaseUrl: "http://127.0.0.1:8791/v1",
        fetch: (async () => {
          throw new Error("connection refused");
        }) as unknown as typeof fetch,
      }),
    );

    expect(health.status).toBe("healthy");
    expect(health.embedding).toEqual({ configured: true, connected: false });
  });

  it("reports an unconfigured embedding provider without probing", async () => {
    let probed = false;
    const health = await getSingleWorkerHealth(
      input({
        fetch: (async () => {
          probed = true;
          return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch,
      }),
    );

    expect(probed).toBe(false);
    expect(health.embedding).toEqual({ configured: false, connected: false });
  });

  it("treats a non-2xx embedding response as unreachable", async () => {
    const health = await getSingleWorkerHealth(
      input({
        embeddingBaseUrl: "http://127.0.0.1:8791/v1/",
        fetch: (async () =>
          new Response("nope", { status: 503 })) as unknown as typeof fetch,
      }),
    );
    expect(health.embedding.connected).toBe(false);
  });

  it("degrades when NATS is the requested transport and is unavailable", async () => {
    const natsHealth: TransportNatsHealth = {
      requested_transport: "nats",
      availability: "not_runtime_available",
      context_pack_subject: "openbrain.context-pack.v1",
      fallback_http: true,
      consecutive_failures: 3,
      last_error: "redacted",
    };
    const health = await getSingleWorkerHealth(input({ natsHealth: () => natsHealth }));

    expect(health.status).toBe("degraded");
    expect(health.nats).toEqual(natsHealth);
  });

  it("stays healthy over HTTP transport even when NATS is not runtime available", async () => {
    const health = await getSingleWorkerHealth(
      input({
        natsHealth: () => ({
          requested_transport: "http",
          availability: "not_runtime_available",
          context_pack_subject: "openbrain.context-pack.v1",
          fallback_http: true,
          consecutive_failures: 0,
          last_error: null,
        }),
      }),
    );
    expect(health.status).toBe("healthy");
  });

  it("never surfaces a raw NATS error string", async () => {
    const health = await getSingleWorkerHealth(
      input({
        natsHealth: () => ({
          requested_transport: "nats",
          availability: "not_runtime_available",
          context_pack_subject: "openbrain.context-pack.v1",
          fallback_http: true,
          consecutive_failures: 1,
          last_error: "redacted",
        }),
      }),
    );
    expect(health.nats.last_error).toBe("redacted");
  });
});
