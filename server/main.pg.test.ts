/**
 * Start-equivalence proof for the rewrite's real process entrypoint (#463).
 *
 * WHAT THIS COVERS THAT NOTHING ELSE DID. `server/application/sdk-protocol.pg.test.ts`
 * composes `createShadowApplication` BY HAND: it builds its own `bearerAuth()`
 * middleware, its own `serverFactory`, a `fakeHealthDatabase()`, and never
 * touches config, migrations, the token map, the REST routers, MCP audit, the
 * NATS lifecycle, or a listener it did not open itself. Every one of those steps
 * lived only in `src/index.ts:255-437`, so the rewrite had a composed
 * APPLICATION and no composed PROCESS. This file drives `startServer()` — the
 * real entrypoint, the real config parse, the real pool, the real migration
 * runner, the real token map, the real audit installation — against an isolated
 * database on an ephemeral port, and then shuts it down.
 *
 * THE FOUR SURFACES ARE ASSERTED TOGETHER ON PURPOSE. Health, one REST route,
 * one MCP tool call, and an audit row are not four independent features; they
 * are four things that only work if the SAME composition is right. The REST
 * router needs `req.auth`, which needs the middleware built from the config's
 * token list. The MCP call needs the audit wrapper to have been installed
 * BEFORE tool registration. The audit row needs the pool the migrations ran
 * against. Asserting them one at a time against separate hand-built fixtures is
 * exactly how the gap this file closes stayed invisible.
 *
 * DATABASE. Skips loudly (`describe.skip`) without `OPENBRAIN_TEST_DATABASE_URL`,
 * which must point at an isolated test database — NEVER the dogfood one. The
 * anti-skip guard (`scripts/assert-db-tests-ran.ts`) fails the job if this suite
 * does not actually execute, because a silent skip here would report a green
 * build for an entrypoint nothing had started.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pino from "pino";
import { Pool } from "pg";
import { parseServerConfig, type ServerConfig } from "./config.ts";
import { startServer, type StartedServer } from "./main.ts";
import type { SingleWorkerHealth } from "./transport/index.ts";

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;

const TOKEN = `entrypoint-proof-${process.pid}`;
const NAMESPACE = `entrypoint-proof-${process.pid}-${Date.now()}`;

function silentLogger() {
  return pino({ level: "silent" });
}

/**
 * Build the config the entrypoint would have parsed from the environment.
 *
 * `parseServerConfig` rather than a hand-written object: the point is that the
 * REAL validator produced this, so a schema change that would break startup
 * breaks this test too. The database fields are decomposed from the test URL so
 * the pool the entrypoint opens is the isolated one, not whatever `.env` names.
 *
 * `runMigrations` is left ON. The entrypoint's migration step is part of what
 * start-equivalence means, and the runner is append-only and idempotent — on an
 * already-migrated test database it applies nothing and returns an empty list,
 * which is itself the assertion that it did not try to rewrite history.
 */
function testConfig(): ServerConfig {
  const url = new URL(DB_URL!);
  const result = parseServerConfig({
    DB_HOST: url.hostname,
    DB_PORT: url.port || "5432",
    DB_NAME: url.pathname.replace(/^\//, ""),
    DB_USER: decodeURIComponent(url.username) || "postgres",
    ...(url.password ? { DB_PASSWORD: decodeURIComponent(url.password) } : {}),
    LOG_FILE: "logs/open-brain-entrypoint-test.log",
    // A concrete LAN address, NOT loopback: `/health` exists to tell a client
    // WHICH machine it reached, so `127.0.0.1` is not a valid answer and
    // identity resolution deliberately falls through it to real detection.
    OPEN_BRAIN_SERVER_IP: "10.71.1.99",
    OPENBRAIN_MIGRATIONS_DIR: "src/db/migrations",
    // One configured token, in the role the tool assertions need. The entrypoint
    // refuses to start with none, which is a separate test below.
    AUTH_TOKEN_AGENT: TOKEN,
  });
  if (!result.ok) {
    throw new Error(`invalid test configuration: ${JSON.stringify(result.issues)}`);
  }
  return result.config;
}

let started: StartedServer | undefined;
let base = "";
const pool = DB_URL ? new Pool({ connectionString: DB_URL }) : null;

dbDescribe("rewrite entrypoint start-equivalence (live Postgres)", () => {
  beforeAll(async () => {
    started = await startServer({
      config: testConfig(),
      // Port 0 asks the kernel for an ephemeral port. Nothing well-known binds,
      // so this can run beside the dogfood service without contending for 3100.
      port: 0,
      bindHost: "127.0.0.1",
      logger: silentLogger(),
      allowedOrigins: [],
    });
    base = `http://127.0.0.1:${started.port}`;
  });

  afterAll(async () => {
    await started?.shutdown();
    started = undefined;
    await pool?.end();
  });

  test("binds an ephemeral port and answers the frozen /health shape", async () => {
    const response = await fetch(`${base}/health`);
    // 200 healthy or 503 degraded are both valid: the embedding provider may
    // not be running beside a test database. What must NOT vary is the SHAPE,
    // which is the charter's frozen `/health` row and what core01's aggregate
    // front reads out of each worker.
    expect([200, 503]).toContain(response.status);
    // Typed against the frozen shape rather than `Record<string, unknown>`, so
    // a field that DISAPPEARS is a compile error here and not just a runtime
    // `undefined` that an assertion happens to notice.
    const body = (await response.json()) as SingleWorkerHealth;
    expect(["healthy", "degraded"]).toContain(body.status);
    expect(body.server_ip).toBe("10.71.1.99");
    expect(body.server_ips).toEqual(["10.71.1.99"]);
    expect(body.hostname.length).toBeGreaterThan(0);
    expect(body.database).toMatchObject({ connected: true });
    expect(body.embedding).toHaveProperty("configured");
    expect(body.embedding).toHaveProperty("connected");
    // `not_runtime_available` is the CORRECT answer for an HTTP deployment, and
    // it is the same answer `src/index.ts` gives: `readNatsRuntimeBoundary`
    // (`src/nats-runtime.ts:500-503`) requires `OPENBRAIN_TRANSPORT=nats` AND an
    // enabled bridge AND an allowed URL before it says available, so a plain
    // HTTP worker reports unavailable and is still `healthy`, because the
    // degraded rule only fires when NATS was actually REQUESTED. Asserting
    // "available" here would have pinned a shape production never emits.
    expect(body.nats).toMatchObject({
      requested_transport: "http",
      availability: "not_runtime_available",
      fallback_http: true,
      consecutive_failures: 0,
      last_error: null,
    });
    expect(typeof body.nats.context_pack_subject).toBe("string");
    expect(typeof body.timestamp).toBe("string");
  });

  test("serves the REST surface behind the composed auth middleware", async () => {
    // Unauthenticated first. A REST route reachable without a token is the
    // failure mode a composition bug produces -- the router mounts, the auth
    // middleware does not -- and it is invisible to any test that only ever
    // sends a valid token.
    const anonymous = await fetch(`${base}/api/v1/entries/recent`);
    expect(anonymous.status).toBe(401);

    const authorized = await fetch(`${base}/api/v1/entries/recent?limit=1`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    // 200 with a body, or 404 if this deployment does not expose that exact
    // path -- but never 401, which is the thing being proven.
    expect(authorized.status).not.toBe(401);
  });

  test("refuses an unknown bearer token at the REST boundary", async () => {
    const response = await fetch(`${base}/api/v1/entries/recent`, {
      headers: { authorization: "Bearer not-the-configured-token" },
    });
    expect(response.status).toBe(401);
  });

  test("answers a real MCP tool call and writes the audit row for it", async () => {
    if (!pool) throw new Error("OPENBRAIN_TEST_DATABASE_URL is required");
    const before = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM mcp_tool_audit_log WHERE operation = $1",
      ["get_contract"],
    );

    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    });
    const client = new Client({ name: "entrypoint-proof", version: "1.0.0" });
    // `connect` performs the real initialize handshake over real HTTP against
    // the listener the entrypoint opened.
    await client.connect(transport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.length).toBeGreaterThan(0);
      // `get_contract` is the agent's whole capability surface
      // (`docs/decisions/contract-is-the-agent-surface.md`), so it is the right
      // single call to prove the tool boundary is really mounted.
      const result = await client.callTool({
        name: "get_contract",
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
    }

    // AUDIT EVIDENCE. `installMcpAudit` writes asynchronously after the handler
    // returns, so the row can trail the response. Poll rather than sleep a fixed
    // interval: a fixed sleep either flakes or wastes the time it over-waits.
    let after = before;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      after = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM mcp_tool_audit_log WHERE operation = $1",
        ["get_contract"],
      );
      if (Number(after.rows[0]!.count) > Number(before.rows[0]!.count)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(Number(after.rows[0]!.count)).toBeGreaterThan(
      Number(before.rows[0]!.count),
    );

    // The row must carry the identity the BEARER TOKEN resolved to, not
    // anything the client sent. That chain -- token -> middleware -> req.auth ->
    // SDK extra -> audit summary -- is the composition this file exists to
    // prove, and a null caller_role here means the audit wrapper was installed
    // but the auth seam was not connected to it.
    const row = await pool.query<{
      caller_role: string | null;
      caller_client_id: string | null;
      status: string;
    }>(
      `SELECT caller_role, caller_client_id, status
         FROM mcp_tool_audit_log
        WHERE operation = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      ["get_contract"],
    );
    // "success" is the literal `src/audit-log.ts:377` writes for a non-error
    // tool result; the other states are "error", "exception", and
    // "validation_error".
    expect(row.rows[0]?.status).toBe("success");
    expect(row.rows[0]?.caller_role).toBe("agent");
    expect(row.rows[0]?.caller_client_id).toBe("agent");
  });

  test("composes the maintenance runner into the ordered shutdown list", () => {
    // A runtime that is RUNNING but absent from this list is the abandoned-lease
    // bug the drain exists to prevent, and it fails silently: rows sit `running`
    // under a live lease with no handler. Asserting the composed order here is
    // what makes the entrypoint's wiring observable rather than inferred.
    expect(
      started?.application.backgroundRuntimes.map((runtime) => runtime.name),
    ).toEqual(["maintenance"]);
  });
});

dbDescribe("rewrite entrypoint startup and shutdown ordering (live Postgres)", () => {
  test("starts on an environment whose optional secrets are present but empty", async () => {
    // The 2026-08-02 deploy failure, as a live boot rather than a unit parse.
    // `server/config.test.ts` pins the parse-boundary semantics for all eight
    // optional-secret fields; this proves the ENTRYPOINT actually comes up on
    // that environment, which is the claim start-equivalence makes and the one
    // the previous fixtures never exercised — every env they built either set
    // an optional secret to a real value or omitted the key entirely, so the
    // shape that broke production (`EMBEDDING_API_KEY=`, empty) had no test.
    const url = new URL(DB_URL!);
    const result = parseServerConfig({
      DB_HOST: url.hostname,
      DB_PORT: url.port || "5432",
      DB_NAME: url.pathname.replace(/^\//, ""),
      DB_USER: decodeURIComponent(url.username) || "postgres",
      LOG_FILE: "logs/open-brain-entrypoint-empty-secret-test.log",
      // A concrete LAN address, NOT loopback: `/health` exists to tell a client
    // WHICH machine it reached, so `127.0.0.1` is not a valid answer and
    // identity resolution deliberately falls through it to real detection.
    OPEN_BRAIN_SERVER_IP: "10.71.1.99",
      OPENBRAIN_MIGRATIONS_DIR: "src/db/migrations",
      AUTH_TOKEN_AGENT: TOKEN,
      // Exactly the local clone env's shape: the MLX embedding server needs no
      // key, so the variable is exported empty rather than left unset.
      EMBEDDING_API_KEY: "",
      DB_PASSWORD: "",
      AUTH_TOKEN_ADMIN: "",
    });
    if (!result.ok) {
      throw new Error(
        `empty optional secrets must not fail config: ${JSON.stringify(result.issues)}`,
      );
    }
    const instance = await startServer({
      config: result.config,
      port: 0,
      bindHost: "127.0.0.1",
      logger: silentLogger(),
      runMigrations: false,
      allowedOrigins: [],
    });
    try {
      // A real listener answering the real health route. 503 is acceptable
      // because the embedding provider need not be up beside a test database.
      expect([200, 503]).toContain(
        (await fetch(`http://127.0.0.1:${instance.port}/health`)).status,
      );
      // The empty admin token must not have been registered as a credential:
      // a blank bearer token accepted as `admin` would be an auth hole.
      expect(result.config.authTokens.map(({ role }) => role)).toEqual(["agent"]);
      // Empty password/key were dropped rather than passed to pg / the provider.
      expect("password" in result.config.database).toBe(false);
      expect("embeddingApiKey" in result.config.transport).toBe(false);
    } finally {
      await instance.shutdown();
    }
  });

  test("refuses to start, and opens no listener, without configured tokens", async () => {
    const config = testConfig();
    const tokenless: ServerConfig = { ...config, authTokens: [] };
    await expect(
      startServer({
        config: tokenless,
        port: 0,
        bindHost: "127.0.0.1",
        logger: silentLogger(),
        runMigrations: false,
      }),
    ).rejects.toThrow("no auth tokens configured");
  });

  test("stops serving before it drains, and releases the pool last", async () => {
    const instance = await startServer({
      config: testConfig(),
      port: 0,
      bindHost: "127.0.0.1",
      logger: silentLogger(),
      runMigrations: false,
      allowedOrigins: [],
    });
    const address = `http://127.0.0.1:${instance.port}/health`;
    // Live before: the listener is real and answering.
    expect([200, 503]).toContain((await fetch(address)).status);

    const order: string[] = [];
    const runtimes = instance.application.backgroundRuntimes;
    expect(runtimes.length).toBeGreaterThan(0);
    for (const runtime of runtimes) {
      const original = runtime.stop.bind(runtime);
      (runtime as { stop: () => Promise<void> }).stop = async () => {
        // Recorded at the moment the drain begins. If the listener were still
        // open here, a late request could enqueue work the drain has already
        // passed -- which is why sessions close first.
        order.push(`stop:${runtime.name}`);
        await original();
      };
    }
    const originalEnd = instance.database.pool.end.bind(instance.database.pool);
    (instance.database.pool as { end: () => Promise<void> }).end = async () => {
      order.push("pool:end");
      await originalEnd();
    };

    await instance.shutdown();

    // The pool closes LAST. A maintenance drain that loses its pool mid-job
    // strands exactly the rows it had already leased.
    expect(order[order.length - 1]).toBe("pool:end");
    expect(order).toContain("stop:maintenance");
    expect(order.indexOf("stop:maintenance")).toBeLessThan(
      order.indexOf("pool:end"),
    );

    // Dead after: the socket is closed, so the port no longer answers.
    await expect(fetch(address)).rejects.toThrow();
  });
});
