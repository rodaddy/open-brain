/**
 * Probe-endpoint boundary tests for the single-worker transport app (issue 762).
 *
 * The k3s delivery rail splits liveness from readiness on purpose
 * (`rtech-infra/templates/k3s-app-template/app/healthz.md`): a failing liveness
 * probe RESTARTS the pod, a failing readiness probe only takes it out of the
 * service. The property that keeps that split honest is that `/healthz` does no
 * dependency I/O at all, so these tests assert it by supplying a health input
 * whose database probe THROWS and whose call is counted -- a `/healthz` that
 * ever reaches the dependency fails here loudly rather than passing on a
 * happy-path fixture.
 *
 * The app is exercised through `fetch` against a listener bound to port 0, so
 * no fixed port is claimed and no Postgres is touched.
 */
import { afterAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { RequestHandler } from "express";
import express from "express";
import type { DatabaseHealth } from "../db/pool.ts";
import type { SingleWorkerHealthInput, TransportNatsHealth } from "./health.ts";
import { createSingleWorkerTransportApp } from "./http-app.ts";
import { silentLogger } from "./testing/silent-logger.ts";

const CONNECTED: DatabaseHealth = { connected: true, total: 4, idle: 3, waiting: 0 };
const DISCONNECTED: DatabaseHealth = {
  connected: false,
  total: 0,
  idle: 0,
  waiting: 0,
  errorCategory: "Error",
};

const NATS_DEGRADED: TransportNatsHealth = {
  requested_transport: "nats",
  availability: "not_runtime_available",
  context_pack_subject: "openbrain.context-pack.v1",
  fallback_http: true,
  consecutive_failures: 3,
  last_error: "redacted",
};

/** A health input that records every dependency call it is asked to make. */
function countingHealth(
  database: DatabaseHealth | "throws",
  calls: { database: number },
  overrides?: Partial<SingleWorkerHealthInput>,
): SingleWorkerHealthInput {
  return {
    databaseHealth: async () => {
      calls.database += 1;
      if (database === "throws") {
        throw new Error("liveness_probe_must_not_reach_the_database");
      }
      return database;
    },
    hostname: "probe-host",
    serverIp: "192.0.2.21",
    serverIps: ["192.0.2.21"],
    probeTimeoutMs: 3_000,
    logger: silentLogger(),
    ...overrides,
  };
}

const notCalled: RequestHandler = (_request, _response, next) => next();

const servers: Server[] = [];

/** Bind the app on an ephemeral port and return its base URL. */
async function serve(
  health: SingleWorkerHealthInput,
  observeMcpRequest?: () => void,
): Promise<string> {
  const app = createSingleWorkerTransportApp({
    authenticate: notCalled,
    parseRequestBody: express.json(),
    sessions: {
      handlePost: async (_request, response) => {
        response.status(204).end();
      },
      handleGet: async () => {},
      handleDelete: async () => {},
      sessionCount: () => 0,
      pendingInitializeCount: () => 0,
      close: async () => {},
    },
    health,
    logger: silentLogger(),
    ...(observeMcpRequest ? { observeMcpRequest } : {}),
  });
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterAll(() => {
  for (const server of servers) server.close();
});

describe("transport probe endpoints", () => {
  it("observes every MCP route spelling accepted by the Express router", async () => {
    const calls = { database: 0, mcp: 0 };
    const base = await serve(countingHealth(CONNECTED, calls), () => {
      calls.mcp += 1;
    });

    expect((await fetch(`${base}/mcp`, { method: "POST" })).status).toBe(204);
    expect((await fetch(`${base}/mcp/`, { method: "POST" })).status).toBe(204);
    expect((await fetch(`${base}/MCP`, { method: "POST" })).status).toBe(204);
    expect(calls.mcp).toBe(3);
  });

  it("serves /healthz as 200 plain text without touching any dependency", async () => {
    const calls = { database: 0 };
    const base = await serve(countingHealth("throws", calls));

    const response = await fetch(`${base}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(response.headers.get("content-type")).toContain("text/plain");
    // The database probe throws, so a non-zero count would ALSO have produced a
    // 500 above; asserting the count names the actual defect rather than its
    // symptom.
    expect(calls.database).toBe(0);
  });

  it("serves /readyz as 200 when every dependency is healthy", async () => {
    const calls = { database: 0 };
    const base = await serve(countingHealth(CONNECTED, calls));

    const response = await fetch(`${base}/readyz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready" });
    expect(calls.database).toBe(1);
  });

  it("serves /readyz as 503 naming the database when it is disconnected", async () => {
    const calls = { database: 0 };
    const base = await serve(countingHealth(DISCONNECTED, calls));

    const response = await fetch(`${base}/readyz`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: "not_ready",
      failed: ["database"],
    });
  });

  it("names every failing check, not just the first", async () => {
    const calls = { database: 0 };
    const base = await serve(
      countingHealth(DISCONNECTED, calls, {
        natsHealth: () => NATS_DEGRADED,
        captureHealth: () => ({
          stale: true,
          reason: "no_turns",
          sessions_observed: 0,
          turns_delivered: 0,
          spool_pending: 0,
          watermark_wedged: false,
          spool_unannounced: false,
          silent_roles: [],
          silence_seconds: 900,
        }),
      }),
    );

    const response = await fetch(`${base}/readyz`);
    const body = (await response.json()) as { failed: string[] };

    expect(response.status).toBe(503);
    expect(body.failed).toContain("database");
    expect(body.failed).toContain("nats");
    expect(body.failed).toContain("capture");
  });

  it("leaves /health returning the full health document", async () => {
    const calls = { database: 0 };
    const base = await serve(countingHealth(CONNECTED, calls));

    const response = await fetch(`${base}/health`);
    const body = (await response.json()) as { status: string; hostname: string };

    expect(response.status).toBe(200);
    expect(body.status).toBe("healthy");
    expect(body.hostname).toBe("probe-host");
  });
});
