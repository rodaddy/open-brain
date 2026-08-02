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
