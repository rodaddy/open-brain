/**
 * Real-SDK protocol proof for the rewrite candidate (charter Phase 5 gate).
 *
 * WHAT THIS CONVERTS. `server/application/shadow-application.test.ts` proves the
 * composed Express app routes, authenticates, and reports health -- but it hands
 * `createShadowApplication` a STUB server factory
 * (`serverFactory: () => ({ connect: async () => {} })`), so no MCP server is
 * ever attached and no tool is ever reachable. Everything past the session
 * boundary was therefore asserted under a stub, and PR #481 honestly recorded
 * "behavior parity under stub" as PROPOSED. The parity fixtures
 * (`contracts/server-tool-parity.test.ts`) do exercise real tools, but over
 * `InMemoryTransport` -- a linked in-process pair with NO HTTP, no initialize
 * handshake over the wire, no `Mcp-Session-Id`, and an `authInfo` that the test
 * injects directly onto each outbound message.
 *
 * Neither one exercises the join. This file does: it composes the REAL
 * `server/` stack (`createShadowApplication` = transport + application, with
 * `registerMemoryTools` = the tool boundary) behind a REAL ephemeral HTTP
 * listener, and drives it with the REAL `@modelcontextprotocol/sdk` `Client`
 * over `StreamableHTTPClientTransport`.
 *
 * WHY THE JOIN IS THE INTERESTING PART. Under `InMemoryTransport` the tests set
 * `authInfo` on the message envelope themselves. Over HTTP nobody does: the SDK
 * server transport reads `req.auth`
 * (`@modelcontextprotocol/sdk/dist/cjs/server/streamableHttp.js`, `const
 * authInfo = req.auth`), which only exists because the Express `authenticate`
 * middleware put it there, and which then arrives at a handler as
 * `extra.authInfo` for `authIdentity()` to turn into the namespace predicate.
 * That chain -- bearer token -> middleware -> `req.auth` -> SDK -> `extra` ->
 * namespace isolation -- is pure composition, is what production actually runs,
 * and was covered by NOTHING before this file. A namespace predicate that works
 * under an injected identity and silently reads as `undefined` over the wire is
 * exactly the defect shape this closes.
 *
 * WHAT IS ASSERTED. A real `initialize` handshake that yields a real
 * `Mcp-Session-Id`; `tools/list` over the wire; then the four behaviors the
 * charter names, each compared against the SHAPES RECORDED IN THE PARITY
 * FIXTURES rather than against hand-written guesses:
 *   - session lifecycle round-trip  (`server-session-lifecycle.fixture.json`)
 *   - one capture write             (`server-capture-checkpoint.fixture.json`)
 *   - one search read               (`server-recall-family.fixture.json`)
 *   - `agent_context_pack` fetch    (`server-context-pack-sections.fixture.json`)
 * The fixture comparator is imported rather than reimplemented, so "equals the
 * recorded shape" means the same thing here as it does in the parity suite.
 *
 * STATE. `SERVER_REWRITE_STATE.servesTraffic` stays false and is asserted below.
 * This test composes its own instance on an ephemeral port; it changes no
 * production flag and no start script. Passing here means the candidate answers
 * the real protocol correctly -- it does NOT mean it serves traffic.
 *
 * DATABASE. Skips loudly (`describe.skip`) without
 * `OPENBRAIN_TEST_DATABASE_URL`, which must point at an isolated test/playground
 * database. Never the dogfood database.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import express from "express";
import type { RequestHandler } from "express";
import pino from "pino";
import { Pool } from "pg";
import { createShadowApplication } from "./index.ts";
import type { ShadowApplication } from "./index.ts";
import { parseServerConfig } from "../config.ts";
import type { ServerConfig } from "../config.ts";
import type { Database, DatabaseHealth } from "../db/pool.ts";
import { SERVER_REWRITE_STATE } from "../state.ts";
import { registerMemoryTools } from "../tools/index.ts";
import { silentLogger } from "../transport/testing/silent-logger.ts";
import { expectRecordedShape, loadServerFixture } from "../../contracts/fixture-shape.ts";

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;
const pool = DB_URL ? new Pool({ connectionString: DB_URL }) : null;

const TEST_TOKEN = "sdk-protocol-proof-token";
const CONNECTED: DatabaseHealth = { connected: true, total: 2, idle: 2, waiting: 0 };

/**
 * One namespace per TEST, not per run.
 *
 * The parity fixtures record behavior in an EMPTY namespace, so their shapes
 * (`item_count: 0`, `empty_reason: "no_matches"`, `total_count: 1`) are only
 * reproducible if a test observes nothing but its own writes. A single
 * run-scoped namespace does NOT deliver that: measured on the first green run of
 * this file, the capture and search tests each left a real row behind, and the
 * later `agent_context_pack` fetch then found them -- `durable_memory` came back
 * populated where the fixture froze `empty_reason: "no_matches"`, and the search
 * test matched an earlier test's thought as well as its own. Both passed in
 * isolation and failed in file order, which is the signature of shared state
 * rather than a shape defect.
 *
 * Each test therefore takes a fresh namespace, and the auth middleware reads
 * this mutable value so the identity it stamps on `req.auth` follows.
 */
let NAMESPACE = "";

function freshNamespace(): string {
  NAMESPACE = `sdk-proof-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return NAMESPACE;
}

/**
 * Repoint the shared namespace at a value no row can belong to.
 *
 * Same reasoning as `contracts/server-tool-parity.test.ts`: `readableNamespaces()`
 * grants every non-admin role read access to the shared namespace as well, so
 * with the real `shared-kb` this suite would also observe whatever the target
 * database happens to hold there, and the recorded counts would assert an
 * accident of that database. Scoped to this suite (installed in `beforeAll`,
 * removed in `afterAll`) because `sharedNamespaceConfig()` re-reads the
 * environment on every call and Bun runs every test file in ONE process -- a
 * module-scope assignment leaks into sibling files and fails them by load order.
 */
const SHARED_ISOLATION = `sdk-proof-shared-${process.pid}-${Date.now()}`;
const priorSharedEnv = {
  canonical: process.env.SHARED_NAMESPACE_CANONICAL,
  physical: process.env.SHARED_NAMESPACE_PHYSICAL,
};

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function testConfig(): ServerConfig {
  const result = parseServerConfig({
    DB_HOST: "db.internal",
    DB_NAME: "open_brain_test",
    DB_USER: "open_brain",
    LOG_FILE: "logs/open-brain.log",
    OPEN_BRAIN_SERVER_IP: "127.0.0.1",
  });
  if (!result.ok) {
    throw new Error(`invalid test configuration: ${JSON.stringify(result.issues)}`);
  }
  return result.config;
}

/**
 * The health probe is a fake; the TOOLS are not.
 *
 * `/health` exists to prove liveness, and pointing it at the real pool would add
 * a second connection without proving anything this file is about. Every tool
 * call below runs against the real `Pool`.
 */
function fakeHealthDatabase(): Database {
  return {
    pool: {} as Database["pool"],
    close: async () => {},
    health: async (): Promise<DatabaseHealth> => CONNECTED,
  } as Database;
}

/**
 * The production-shaped auth seam: a bearer token becomes `req.auth`.
 *
 * This is deliberately the SAME placement production uses (`src/index.ts` mounts
 * `authMiddleware` on `/mcp`), because the placement is what is under test. The
 * token map is a single fixed token rather than the real loader -- the point is
 * that SOMETHING sets `req.auth` before the SDK reads it, not how the token is
 * looked up.
 */
function bearerAuth(): RequestHandler {
  return (request, response, next) => {
    if (request.headers.authorization !== `Bearer ${TEST_TOKEN}`) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }
    (request as { auth?: unknown }).auth = {
      role: "agent",
      clientId: NAMESPACE,
      tokenClientId: NAMESPACE,
      namespaceSource: "token",
    };
    next();
  };
}

interface LiveHarness {
  client: Client;
  application: ShadowApplication;
  server: Server;
  transport: StreamableHTTPClientTransport;
}

const live: Partial<LiveHarness> = {};

/**
 * Compose the real stack, bind an ephemeral port, and connect a real SDK client.
 *
 * `serverFactory` is the whole point: it builds a REAL `McpServer` and registers
 * the REAL tool boundary, where `shadow-application.test.ts` passes a stub. The
 * factory runs per initialize, matching production, so each session gets its own
 * server instance bound to the shared pool.
 */
async function connectRealClient(): Promise<Client> {
  if (!pool) throw new Error("OPENBRAIN_TEST_DATABASE_URL is required");
  freshNamespace();
  const application = createShadowApplication({
    config: testConfig(),
    logger: silentLogger(),
    database: fakeHealthDatabase(),
    authenticate: bearerAuth(),
    parseRequestBody: express.json(),
    serverFactory: () => {
      const server = new McpServer({ name: "open-brain-rewrite", version: "1.0.0" });
      registerMemoryTools(server, {
        pool,
        embedFn: async () => Array(768).fill(0.01) as number[],
        logger: pino({ level: "silent" }),
        embeddingModel: "sdk-protocol-proof",
      });
      return server;
    },
  });
  live.application = application;

  // Port 0 asks the kernel for an ephemeral port; nothing well-known is bound.
  const httpServer = await new Promise<Server>((resolve) => {
    const listener = application.app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  live.server = httpServer;
  const { port } = httpServer.address() as AddressInfo;

  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { authorization: `Bearer ${TEST_TOKEN}` } } },
  );
  live.transport = transport;
  const client = new Client({ name: "sdk-protocol-proof", version: "1.0.0" });
  // `connect` performs the real initialize handshake over HTTP.
  await client.connect(transport);
  live.client = client;
  return client;
}

/** Call a tool over the wire and parse the single text content block. */
async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; body: unknown; text: string }> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = { text };
  }
  return { isError: result.isError === true, body, text };
}

afterEach(async () => {
  if (live.client) {
    await live.client.close();
    live.client = undefined;
  }
  live.transport = undefined;
  if (live.server) {
    await new Promise<void>((resolve) => live.server!.close(() => resolve()));
    live.server = undefined;
  }
  if (live.application) {
    await live.application.close();
    live.application = undefined;
  }
});

afterAll(async () => {
  restoreEnv("SHARED_NAMESPACE_CANONICAL", priorSharedEnv.canonical);
  restoreEnv("SHARED_NAMESPACE_PHYSICAL", priorSharedEnv.physical);
  await pool?.end();
});

// The "(live Postgres)" marker is REQUIRED, not decorative: the anti-skip guard
// in `scripts/assert-db-tests-ran.ts` selects suites by that literal substring
// (both its `<testsuite>` scan and its `<testcase>` cross-check), so a
// DB-backed suite named without it is invisible to the guard and can skip in CI
// with the job still green. Observed on this branch before the rename: the guard
// reported this suite as MISSING while the JUnit record showed `tests="8"
// failures="0" skipped="0"`.
dbDescribe("rewrite candidate over the real MCP SDK and real HTTP transport (live Postgres)", () => {
  beforeAll(() => {
    process.env.SHARED_NAMESPACE_CANONICAL = SHARED_ISOLATION;
    process.env.SHARED_NAMESPACE_PHYSICAL = SHARED_ISOLATION;
  });

  test("composing and proving protocol behavior does not make the candidate serve traffic", () => {
    expect(SERVER_REWRITE_STATE.servesTraffic).toBe(false);
    expect(SERVER_REWRITE_STATE.cutoverStarted).toBe(false);
  });

  test("completes a real initialize handshake and issues an Mcp-Session-Id", async () => {
    const client = await connectRealClient();

    // A server-assigned session id only exists if the handshake really happened:
    // the SDK client reads it off the `Mcp-Session-Id` response header, and the
    // session manager only sets one from `onsessioninitialized`.
    expect(live.transport?.sessionId).toBeString();
    expect(live.transport!.sessionId!).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    // The composed session boundary now holds exactly this one live session.
    expect(live.application?.sessions.sessionCount()).toBe(1);
    expect(client.getServerVersion()?.name).toBe("open-brain-rewrite");
  });

  test("lists the registered tool surface over the wire", async () => {
    const client = await connectRealClient();
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);

    // Every tool exercised below must be reachable through protocol discovery,
    // not merely present in the registry: a tool that is registered but not
    // advertised is invisible to a real client.
    for (const required of [
      "session_start",
      "append_session_event",
      "session_context",
      "session_wrap",
      "log_thought",
      "search_all",
      "agent_context_pack",
    ]) {
      expect(names).toContain(required);
    }
    // Discovery must return real schemas, not bare names.
    const sessionStart = listed.tools.find((tool) => tool.name === "session_start");
    expect(sessionStart?.inputSchema).toBeObject();
  });

  test("round-trips the session lifecycle against the recorded fixture shape", async () => {
    const client = await connectRealClient();
    const fixture = await loadServerFixture("server-session-lifecycle");
    const sessionKey = `sdk-proof/lifecycle-${Date.now()}`;

    for (const step of fixture.steps) {
      const args = { ...step.arguments, session_key: sessionKey };
      const observed = await callTool(client, step.tool, args);

      expect(observed.isError).toBe(step.expectation.is_error);
      expectRecordedShape(observed.body, step.expectation.json, {
        "{{namespace}}": NAMESPACE,
        "parity/lifecycle": sessionKey,
      });
    }
  });

  test("performs a capture write that lands a real row and matches the recorded shape", async () => {
    const client = await connectRealClient();
    const fixture = await loadServerFixture("server-capture-checkpoint");
    const logThought = fixture.steps.find((step) => step.tool === "log_thought");
    if (!logThought) throw new Error("fixture no longer records a log_thought step");

    const content = `sdk protocol proof capture ${Date.now()}`;
    const observed = await callTool(client, "log_thought", {
      ...logThought.arguments,
      content,
    });

    expect(observed.isError).toBe(false);
    expectRecordedShape(observed.body, logThought.expectation.json, {
      "{{namespace}}": NAMESPACE,
    });

    // The wire said it wrote; Postgres is the authority on whether it did.
    // "A row was written" is an assertion, not an assumption.
    const written = (observed.body as { id: string }).id;
    const { rows } = await pool!.query(
      "SELECT namespace, content FROM thoughts WHERE id = $1 AND archived_at IS NULL",
      [written],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].namespace).toBe(NAMESPACE);
    expect(rows[0].content).toBe(content);
  });

  test("performs a search read that finds what this session wrote", async () => {
    const client = await connectRealClient();
    const content = `sdk protocol proof searchable ${Date.now()}`;
    const write = await callTool(client, "log_thought", {
      content,
      tags: ["parity"],
    });
    expect(write.isError).toBe(false);
    const writtenId = (write.body as { id: string }).id;

    const observed = await callTool(client, "search_all", { query: content });
    expect(observed.isError).toBe(false);

    // Compared against the recall fixture's recorded envelope, with the ids and
    // content this run actually produced substituted in.
    const fixture = await loadServerFixture("server-recall-family");
    const searchStep = fixture.steps.find((step) => step.tool === "search_all");
    if (!searchStep) throw new Error("fixture no longer records a search_all step");
    expectRecordedShape(observed.body, searchStep.expectation.json, {
      "{{namespace}}": NAMESPACE,
      "{{thought_id}}": writtenId,
      "parity recall probe thought": content,
    });
  });

  test("fetches agent_context_pack with every requested section over the wire", async () => {
    const client = await connectRealClient();
    const fixture = await loadServerFixture("server-context-pack-sections");
    const packStep = fixture.steps.find((step) => step.tool === "agent_context_pack");
    if (!packStep) throw new Error("fixture no longer records an agent_context_pack step");

    const sessionKey = `sdk-proof/pack-${Date.now()}`;
    const observed = await callTool(client, "agent_context_pack", {
      ...packStep.arguments,
      session_key: sessionKey,
    });

    expect(observed.isError).toBe(false);
    expectRecordedShape(observed.body, packStep.expectation.json, {
      "{{namespace}}": NAMESPACE,
      "parity/pack": sessionKey,
    });
  });

  test("refuses an unauthenticated client at the transport before any tool runs", async () => {
    // The identity chain is the thing this file exists to prove, so its failure
    // path is behavior too: no token means no `req.auth`, and the SDK must never
    // reach a handler. Asserted as a rejected connect, not a tool-level error.
    if (!pool) throw new Error("OPENBRAIN_TEST_DATABASE_URL is required");
    freshNamespace();
    const application = createShadowApplication({
      config: testConfig(),
      logger: silentLogger(),
      database: fakeHealthDatabase(),
      authenticate: bearerAuth(),
      parseRequestBody: express.json(),
      serverFactory: () => {
        const server = new McpServer({ name: "open-brain-rewrite", version: "1.0.0" });
        registerMemoryTools(server, {
          pool,
          embedFn: async () => Array(768).fill(0.01) as number[],
          logger: pino({ level: "silent" }),
          embeddingModel: "sdk-protocol-proof",
        });
        return server;
      },
    });
    live.application = application;
    const httpServer = await new Promise<Server>((resolve) => {
      const listener = application.app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    live.server = httpServer;
    const { port } = httpServer.address() as AddressInfo;

    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
    );
    const client = new Client({ name: "sdk-protocol-proof-anon", version: "1.0.0" });
    await expect(client.connect(transport)).rejects.toThrow();
    // Nothing was admitted: the session boundary stayed empty.
    expect(application.sessions.sessionCount()).toBe(0);
  });
});
