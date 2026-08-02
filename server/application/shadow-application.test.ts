/**
 * Shadow application composition boundary tests.
 *
 * Design authority: `_plans/463-server-rewrite-charter.md` phase 4 -- the
 * candidate composes transport, health, and auth behind injected factories and
 * "binds only ephemeral test ports; production start scripts remain unchanged."
 * These tests drive the composed Express app over a real ephemeral listener so
 * routing, auth placement, and status codes are proven rather than assumed.
 *
 * The database is a fake probe and the MCP server factory is a stub, so no
 * Postgres connection is opened. Read `SERVER_REWRITE_STATE` below: this
 * composition still serves no production traffic.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import type { RequestHandler } from "express";
import { createShadowApplication } from "./index.ts";
import type { ShadowApplication } from "./index.ts";
import { parseServerConfig } from "../config.ts";
import type { ServerConfig } from "../config.ts";
import type { Database, DatabaseHealth } from "../db/pool.ts";
import { SERVER_REWRITE_STATE } from "../state.ts";
import { silentLogger } from "../transport/testing/silent-logger.ts";

const CONNECTED: DatabaseHealth = { connected: true, total: 2, idle: 2, waiting: 0 };

function testConfig(overrides: Record<string, string> = {}): ServerConfig {
  const result = parseServerConfig({
    DB_HOST: "db.internal",
    DB_NAME: "open_brain_test",
    DB_USER: "open_brain",
    LOG_FILE: "logs/open-brain.log",
    OPEN_BRAIN_SERVER_IP: "10.71.1.21",
    ...overrides,
  });
  if (!result.ok) {
    throw new Error(`invalid test configuration: ${JSON.stringify(result.issues)}`);
  }
  return result.config;
}

function fakeDatabase(health: DatabaseHealth = CONNECTED): Database {
  return {
    pool: {} as Database["pool"],
    close: async () => {},
    health: async () => health,
  } as Database;
}

/** Accept a fixed bearer token and attach the identity the session binds to. */
function bearerAuth(token = "test-token"): RequestHandler {
  return (request, response, next) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }
    (request as { auth?: unknown }).auth = {
      role: "agent",
      clientId: "agent",
      tokenClientId: "agent",
      namespaceSource: "token",
    };
    next();
  };
}

const live: { application?: ShadowApplication; server?: Server } = {};

async function listen(
  overrides?: Partial<Parameters<typeof createShadowApplication>[0]>,
): Promise<string> {
  const application = createShadowApplication({
    config: testConfig(),
    logger: silentLogger(),
    database: fakeDatabase(),
    authenticate: bearerAuth(),
    parseRequestBody: express.json(),
    serverFactory: () => ({ connect: async () => {} }) as never,
    fetch: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    ...overrides,
  });
  live.application = application;
  const server = await new Promise<Server>((resolve) => {
    // Port 0 asks the kernel for an ephemeral port; nothing well-known is bound.
    const listener = application.app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  live.server = server;
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  if (live.server) {
    await new Promise<void>((resolve) => live.server!.close(() => resolve()));
    live.server = undefined;
  }
  if (live.application) {
    await live.application.close();
    live.application = undefined;
  }
});

describe("shadow application composition", () => {
  it("still declares itself non-serving", () => {
    expect(SERVER_REWRITE_STATE.servesTraffic).toBe(false);
    expect(SERVER_REWRITE_STATE.cutoverStarted).toBe(false);
  });

  it("serves single-worker health without authentication and without a worker roster", async () => {
    const base = await listen();
    const response = await fetch(`${base}/health`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.status).toBe("healthy");
    expect(body.server_ip).toBe("10.71.1.21");
    expect(body).not.toHaveProperty("workers");
  });

  it("answers 503 on /health when the database is unreachable", async () => {
    const base = await listen({
      database: fakeDatabase({
        connected: false,
        total: 0,
        idle: 0,
        waiting: 0,
        errorCategory: "Error",
      }),
    });
    const response = await fetch(`${base}/health`);

    expect(response.status).toBe(503);
    expect(((await response.json()) as { status: string }).status).toBe("degraded");
  });

  it("reports the configured NATS boundary in health without any caller supplying it", async () => {
    // Before config owned this, `server/transport/health.ts` fell back to a
    // hardcoded `http`/`available` literal whenever nothing passed a
    // `natsHealth` port -- and NOTHING did. So the `nats` block was a constant,
    // and the degraded branch below was unreachable in the composed app.
    const base = await listen();
    const body = (await (await fetch(`${base}/health`)).json()) as {
      status: string;
      nats: { requested_transport: string; availability: string };
    };

    expect(body.status).toBe("healthy");
    expect(body.nats.requested_transport).toBe("http");
  });

  it("degrades health when NATS is the requested transport but the bridge is not available", async () => {
    // The charter freezes this: degraded means NATS was explicitly REQUESTED
    // and the runtime bridge is not available. A worker misconfigured this way
    // previously reported itself healthy on the strength of the literal.
    const base = await listen({
      config: testConfig({
        OPENBRAIN_TRANSPORT: "nats",
        OPENBRAIN_NATS_ENABLE_BRIDGE: "true",
        OPENBRAIN_NATS_URL: "nats://10.71.1.99:4222",
      }),
    });
    const response = await fetch(`${base}/health`);
    const body = (await response.json()) as {
      status: string;
      database: { connected: boolean };
      nats: { requested_transport: string; availability: string };
    };

    expect(response.status).toBe(503);
    expect(body.status).toBe("degraded");
    // The database is fine; NATS alone is what degraded it. Asserting this
    // keeps the test from passing for the unrelated reason the suite above
    // already covers.
    expect(body.database.connected).toBe(true);
    expect(body.nats.requested_transport).toBe("nats");
    expect(body.nats.availability).toBe("not_runtime_available");
  });

  it("drains background runtimes on close, after the session boundary", async () => {
    // The application boundary DECLARES it owns "shutdown ordering", and until
    // this port existed `close()` closed sessions and nothing else -- so a
    // maintenance runner composed into this application was never stopped at
    // all. Order is the assertion, not merely that stop ran: while a session is
    // live an MCP handler can still enqueue maintenance work, so draining
    // before sessions close lets a late request refill the queue behind the
    // drain.
    const order: string[] = [];
    const application = createShadowApplication({
      config: testConfig(),
      logger: silentLogger(),
      database: fakeDatabase(),
      authenticate: bearerAuth(),
      parseRequestBody: express.json(),
      serverFactory: () => ({ connect: async () => {} }) as never,
      backgroundRuntimes: [
        {
          name: "maintenance",
          stop: async () => {
            order.push("maintenance");
          },
        },
      ],
    });
    const originalSessionClose = application.sessions.close.bind(application.sessions);
    (application.sessions as { close: () => Promise<void> }).close = async () => {
      order.push("sessions");
      await originalSessionClose();
    };

    await application.close();

    expect(order).toEqual(["sessions", "maintenance"]);
  });

  it("composes the maintenance runner into the shutdown order, last", async () => {
    // The port used to have NO production supplier: every proof of ordered
    // shutdown above runs against a fake runtime, so "the application drains
    // maintenance" was true of a shape and not of a runner. This asserts the
    // real composition -- supplying handlers builds a queue runner and places it
    // in the shutdown order.
    //
    // LAST is the assertion, not merely present. The queue runner is the drain
    // that needs the database for the longest, because it must finish jobs it
    // has already leased; anything stopped after it would be stopped while it
    // was still using the pool.
    const application = createShadowApplication({
      config: testConfig(),
      logger: silentLogger(),
      database: fakeDatabase(),
      authenticate: bearerAuth(),
      parseRequestBody: express.json(),
      serverFactory: () => ({ connect: async () => {} }) as never,
      backgroundRuntimes: [{ name: "other", stop: async () => {} }],
      maintenanceHandlers: new Map([["noop.kind", async () => {}]]),
      // No timer: this test asserts composition, not polling, and a live poller
      // would query the fake database.
      maintenanceAutoStart: false,
    });

    expect(application.backgroundRuntimes.map((runtime) => runtime.name)).toEqual([
      "other",
      "maintenance",
    ]);
    await application.close();
  });

  it("composes no maintenance runner when the operator disabled it", async () => {
    // An operator opting a worker out must leave NOTHING in the shutdown order,
    // not an idle runner that still holds a pool connection to poll with.
    const application = createShadowApplication({
      config: testConfig({ OPEN_BRAIN_MAINTENANCE_ENABLED: "0" }),
      logger: silentLogger(),
      database: fakeDatabase(),
      authenticate: bearerAuth(),
      parseRequestBody: express.json(),
      serverFactory: () => ({ connect: async () => {} }) as never,
      maintenanceHandlers: new Map([["noop.kind", async () => {}]]),
      maintenanceAutoStart: false,
    });

    expect(application.backgroundRuntimes).toEqual([]);
    await application.close();
  });

  it("composes no maintenance runner when the process dispatches no job kinds", async () => {
    // Distinct from the disabled case above and deliberately so: this process
    // was never given a dispatch surface, so there is nothing for a runner to
    // run. Both end with an empty shutdown order, but only one of them is an
    // operator decision.
    const application = createShadowApplication({
      config: testConfig(),
      logger: silentLogger(),
      database: fakeDatabase(),
      authenticate: bearerAuth(),
      parseRequestBody: express.json(),
      serverFactory: () => ({ connect: async () => {} }) as never,
    });

    expect(application.backgroundRuntimes).toEqual([]);
    await application.close();
  });

  it("stops every background runtime even when an earlier one throws", async () => {
    // A shutdown that abandons the remaining runtimes on the first failure
    // leaks exactly when something is already wrong. The failure is still
    // surfaced -- a partial shutdown must not read as a clean one.
    const stopped: string[] = [];
    const application = createShadowApplication({
      config: testConfig(),
      logger: silentLogger(),
      database: fakeDatabase(),
      authenticate: bearerAuth(),
      parseRequestBody: express.json(),
      serverFactory: () => ({ connect: async () => {} }) as never,
      backgroundRuntimes: [
        {
          name: "broken",
          stop: async () => {
            stopped.push("broken");
            throw new Error("stop failed");
          },
        },
        {
          name: "maintenance",
          stop: async () => {
            stopped.push("maintenance");
          },
        },
      ],
    });

    await expect(application.close()).rejects.toThrow("stop failed");
    expect(stopped).toEqual(["broken", "maintenance"]);
  });

  it("requires authentication on every /mcp method", async () => {
    const base = await listen();
    for (const method of ["POST", "GET", "DELETE"]) {
      const response = await fetch(`${base}/mcp`, {
        method,
        headers: { "content-type": "application/json" },
        ...(method === "GET" ? {} : { body: "{}" }),
      });
      expect(response.status).toBe(401);
    }
  });

  it("passes an authenticated non-initialize POST through to the session boundary", async () => {
    const base = await listen();
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-token",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toEqual({
      error: "Bad request: missing session or not an initialize request",
    });
  });

  it("converts an unexpected route failure into 500 without leaking the error", async () => {
    const base = await listen({
      database: {
        pool: {} as Database["pool"],
        close: async () => {},
        health: async () => {
          throw new Error("pool exploded: password=hunter2");
        },
      } as Database,
    });
    const response = await fetch(`${base}/health`);

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: "Internal error" });
    expect(body).not.toContain("hunter2");
  });

  it("exposes the live session count through the composed handlers", async () => {
    await listen();
    expect(live.application?.sessions.sessionCount()).toBe(0);
    expect(live.application?.sessions.pendingInitializeCount()).toBe(0);
  });

  it("carries transport configuration from the environment into the session boundary", () => {
    const config = testConfig({
      OPEN_BRAIN_SESSION_TTL_SECONDS: "45",
      OPEN_BRAIN_SESSION_RETRY_AFTER_SECONDS: "9",
    });
    expect(config.transport.sessionTtlMs).toBe(45_000);
    expect(config.transport.retryAfterSeconds).toBe(9);
    expect(config.transport.serverIp).toBe("10.71.1.21");
  });
});
