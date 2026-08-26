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
 * STATE. `SERVER_REWRITE_STATE.servesTraffic` is now true (charter §4 Phase 6)
 * and is asserted below. This test still composes its own instance on an
 * ephemeral port and still touches no start script; what the flip changed is
 * which implementation the deployed chain spawns, not what this file drives.
 * Passing here means the rewrite answers the real protocol correctly -- proof
 * that it is RUNNING comes from `/health` on the deployed clone, not from here.
 *
 * DATABASE. Skips loudly (`describe.skip`) without
 * `OPENBRAIN_TEST_DATABASE_URL`, which must point at an isolated test/playground
 * database. Never the dogfood database.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
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
import { RecoveryWalStore } from "../realtime/recovery-wal.ts";
import { WorkingSetStore } from "../realtime/working-set.ts";
import { SERVER_REWRITE_STATE } from "../state.ts";
import { registerMemoryTools } from "../tools/index.ts";
import { DEFAULT_SHARED_NAMESPACE_NAMES } from "../tools/shared-namespace-fixture.ts";
import { createWorkerProxyHandler } from "../transport/index.ts";
import type {
  AggregateHealth,
  SingleWorkerHealth,
} from "../transport/index.ts";
import { silentLogger } from "../transport/testing/silent-logger.ts";
import {
  expectRecordedShape,
  loadServerFixture,
} from "../../contracts/fixture-shape.ts";

const DB_URL = process.env.OPENBRAIN_TEST_DATABASE_URL;
const dbDescribe = DB_URL ? describe : describe.skip;
const pool = DB_URL ? new Pool({ connectionString: DB_URL }) : null;

const TEST_TOKEN = "sdk-protocol-proof-token";
const CONNECTED: DatabaseHealth = {
  connected: true,
  total: 2,
  idle: 2,
  waiting: 0,
};

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
    throw new Error(
      `invalid test configuration: ${JSON.stringify(result.issues)}`,
    );
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
 * Extra applications and listeners a single test composed for itself.
 *
 * The `live` harness above holds ONE of each, which is right for the tests that
 * drive a single client. The two-worker front needs three at once (two workers
 * plus the front), so they are tracked here and torn down by the same
 * `afterEach`. Without this they would leak a listener per run, and a leaked
 * listener is the failure that shows up as an unrelated later test hanging.
 */
const extraApplications: ShadowApplication[] = [];
const extraServers: Server[] = [];

/**
 * Realtime stores, injected per composed application rather than inherited.
 *
 * The realtime fixture records `id: "ws-1"` / `"rw-1"`, and those ids come from
 * a MONOTONIC counter that lives as long as the store does. `realtime-stores.ts`
 * falls back to a MODULE-scoped store when a composition root injects none --
 * correct, and deliberately so, because a store rebuilt per request would report
 * a permanent zero. But Bun runs every test file in ONE process, so an
 * uninjected suite shares that fallback with every other suite in the run:
 * measured on this branch, `contracts/server-tool-parity.test.ts` exercises the
 * same three tools first and this suite then observed `ws-2`, passing alone and
 * failing in file order.
 *
 * Injecting is not a test workaround; it is what a composition root does. The
 * store is per APPLICATION here, matching one server process owning its own
 * realtime state, which is exactly the lifetime the fixture recorded against.
 */
function freshRealtimeStores(): {
  workingSetStore: WorkingSetStore;
  recoveryWalStore: RecoveryWalStore;
} {
  return {
    workingSetStore: new WorkingSetStore({ logger: pino({ level: "silent" }) }),
    // `walPath: null` keeps this RAM-only. A path would make the suite replay
    // whatever a previous run left on disk, reintroducing the same cross-run
    // contamination one layer down.
    recoveryWalStore: new RecoveryWalStore({
      walPath: null,
      logger: pino({ level: "silent" }),
    }),
  };
}

/**
 * Compose one real single-worker application and bind it to an ephemeral port.
 *
 * Factored out of `connectRealClient` because the two-worker proof needs REAL
 * worker processes-equivalents behind the front -- the whole point of that test
 * is that the aggregate reads a genuine `/health` body off a genuine socket
 * rather than a hand-written `{status}` object from an injected `fetch`.
 */
async function startWorkerApplication(): Promise<{
  application: ShadowApplication;
  server: Server;
  port: number;
}> {
  if (!pool) throw new Error("OPENBRAIN_TEST_DATABASE_URL is required");
  // One store pair per APPLICATION, shared by every session it serves -- the
  // realtime state belongs to the process, not to a connection.
  const realtime = freshRealtimeStores();
  const application = createShadowApplication({
    config: testConfig(),
    logger: silentLogger(),
    database: fakeHealthDatabase(),
    authenticate: bearerAuth(),
    parseRequestBody: express.json(),
    serverFactory: () => {
      const server = new McpServer({
        name: "open-brain-rewrite",
        version: "1.0.0",
      });
      registerMemoryTools(server, {
        pool,
        embedFn: async () => Array(768).fill(0.01) as number[],
        logger: pino({ level: "silent" }),
        sharedNamespaceNames: DEFAULT_SHARED_NAMESPACE_NAMES,
        embeddingModel: "sdk-protocol-proof",
        ...realtime,
      });
      return server;
    },
  });
  const server = await new Promise<Server>((resolve) => {
    const listener = application.app.listen(0, "127.0.0.1", () =>
      resolve(listener),
    );
  });
  const { port } = server.address() as AddressInfo;
  extraApplications.push(application);
  extraServers.push(server);
  return { application, server, port };
}

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
  // One store pair per APPLICATION, shared by every session it serves -- the
  // realtime state belongs to the process, not to a connection.
  const realtime = freshRealtimeStores();
  const application = createShadowApplication({
    config: testConfig(),
    logger: silentLogger(),
    database: fakeHealthDatabase(),
    authenticate: bearerAuth(),
    parseRequestBody: express.json(),
    serverFactory: () => {
      const server = new McpServer({
        name: "open-brain-rewrite",
        version: "1.0.0",
      });
      registerMemoryTools(server, {
        pool,
        embedFn: async () => Array(768).fill(0.01) as number[],
        logger: pino({ level: "silent" }),
        sharedNamespaceNames: DEFAULT_SHARED_NAMESPACE_NAMES,
        embeddingModel: "sdk-protocol-proof",
        ...realtime,
      });
      return server;
    },
  });
  live.application = application;

  // Port 0 asks the kernel for an ephemeral port; nothing well-known is bound.
  const httpServer = await new Promise<Server>((resolve) => {
    const listener = application.app.listen(0, "127.0.0.1", () =>
      resolve(listener),
    );
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
  while (extraServers.length > 0) {
    const server = extraServers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  while (extraApplications.length > 0) {
    await extraApplications.pop()!.close();
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
dbDescribe(
  "rewrite candidate over the real MCP SDK and real HTTP transport (live Postgres)",
  () => {
    beforeAll(() => {
      process.env.SHARED_NAMESPACE_CANONICAL = SHARED_ISOLATION;
      process.env.SHARED_NAMESPACE_PHYSICAL = SHARED_ISOLATION;
    });

    test("proves protocol behavior for the implementation the cutover made the serving target", () => {
      expect(SERVER_REWRITE_STATE.servesTraffic).toBe(true);
      expect(SERVER_REWRITE_STATE.cutoverStarted).toBe(true);
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
      const sessionStart = listed.tools.find(
        (tool) => tool.name === "session_start",
      );
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
      const logThought = fixture.steps.find(
        (step) => step.tool === "log_thought",
      );
      if (!logThought)
        throw new Error("fixture no longer records a log_thought step");

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
      const searchStep = fixture.steps.find(
        (step) => step.tool === "search_all",
      );
      if (!searchStep)
        throw new Error("fixture no longer records a search_all step");
      expectRecordedShape(observed.body, searchStep.expectation.json, {
        "{{namespace}}": NAMESPACE,
        "{{thought_id}}": writtenId,
        "parity recall probe thought": content,
      });
    });

    test("fetches agent_context_pack with every requested section over the wire", async () => {
      const client = await connectRealClient();
      const fixture = await loadServerFixture("server-context-pack-sections");
      const packStep = fixture.steps.find(
        (step) => step.tool === "agent_context_pack",
      );
      if (!packStep)
        throw new Error("fixture no longer records an agent_context_pack step");

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
          const server = new McpServer({
            name: "open-brain-rewrite",
            version: "1.0.0",
          });
          registerMemoryTools(server, {
            pool,
            embedFn: async () => Array(768).fill(0.01) as number[],
            logger: pino({ level: "silent" }),
            sharedNamespaceNames: DEFAULT_SHARED_NAMESPACE_NAMES,
            embeddingModel: "sdk-protocol-proof",
          });
          return server;
        },
      });
      live.application = application;
      const httpServer = await new Promise<Server>((resolve) => {
        const listener = application.app.listen(0, "127.0.0.1", () =>
          resolve(listener),
        );
      });
      live.server = httpServer;
      const { port } = httpServer.address() as AddressInfo;

      const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
      );
      const client = new Client({
        name: "sdk-protocol-proof-anon",
        version: "1.0.0",
      });
      await expect(client.connect(transport)).rejects.toThrow();
      // Nothing was admitted: the session boundary stayed empty.
      expect(application.sessions.sessionCount()).toBe(0);
    });

    test("appends realtime working-set and recovery state against the recorded shapes", async () => {
      // The realtime WRITE half only became reachable in this wave. Before it, the
      // fixture was marked `scaffold-declared` for the rewrite provider: the
      // stores existed and the context pack READ them, but no tool could put
      // anything in, so every recorded shape here was asserted against
      // `current-src` alone.
      const client = await connectRealClient();
      const fixture = await loadServerFixture(
        "server-realtime-working-recovery",
      );
      const sessionKey = `sdk-proof/realtime-${Date.now()}`;

      for (const step of fixture.steps) {
        const observed = await callTool(client, step.tool, {
          ...step.arguments,
          session_key: sessionKey,
        });
        expect(observed.isError).toBe(step.expectation.is_error);
        expectRecordedShape(observed.body, step.expectation.json, {
          "{{namespace}}": NAMESPACE,
          "parity/realtime": sessionKey,
        });
      }
    });

    test("a working-set append is visible to the context pack that reads the same store", async () => {
      // This is the join the two halves share and neither one proves alone. The
      // stores are RAM-only and process-lifetime, so a write that landed in a
      // DIFFERENT store object than the pack reads would still return
      // `accepted: true` and then be invisible forever -- and nothing durable
      // would ever contradict it, because nothing about this state is durable.
      // Asserting the append's own response cannot catch that; only reading it
      // back through the other tool can.
      const client = await connectRealClient();
      const sessionKey = `sdk-proof/join-${Date.now()}`;
      const scope = {
        agent: "fixture-agent",
        platform: "test",
        server_id: "server-1",
        channel_id: "channel-1",
        session_key: sessionKey,
      };
      const content = `working-set join proof ${Date.now()}`;

      const appended = await callTool(client, "working_set_append", {
        ...scope,
        kind: "current_intent",
        content,
      });
      expect(appended.isError).toBe(false);
      expect((appended.body as { accepted: boolean }).accepted).toBe(true);

      const pack = await callTool(client, "agent_context_pack", {
        ...scope,
        requested_sections: ["working_set"],
      });
      expect(pack.isError).toBe(false);
      // The exact content must come back, not merely a non-empty section: a
      // section that happened to be populated by anything else would pass a
      // count-only assertion while proving nothing about THIS write.
      expect(pack.text).toContain(content);
    });

    test("the two-worker front aggregates real worker health off real sockets", async () => {
      // Charter section 1.5: production-host runs the aggregate front and each nested
      // worker body must be preserved. `server/transport/worker-proxy.test.ts`
      // proves the aggregation logic, but only against an injected `fetch` that
      // returns a hand-written `{status}` object -- so the thing it never checks
      // is that a REAL single-worker `/health` payload survives nesting. That is
      // the join, and this binds two real listeners to prove it.
      const workerOne = await startWorkerApplication();
      const workerTwo = await startWorkerApplication();
      const workers = [
        {
          name: "open-brain-worker-1",
          port: workerOne.port,
          baseUrl: `http://127.0.0.1:${workerOne.port}`,
        },
        {
          name: "open-brain-worker-2",
          port: workerTwo.port,
          baseUrl: `http://127.0.0.1:${workerTwo.port}`,
        },
      ];
      const front = createWorkerProxyHandler({
        workers,
        hostname: "test-host",
        serverIp: "127.0.0.1",
        serverIps: ["127.0.0.1"],
        healthProbeTimeoutMs: 2_000,
        logger: silentLogger(),
      });

      const response = await front(new Request("http://127.0.0.1/health"));
      const aggregate = (await response.json()) as AggregateHealth;

      expect(response.status).toBe(200);
      expect(aggregate.status).toBe("healthy");
      expect(aggregate.workers.map((worker) => worker.name)).toEqual([
        "open-brain-worker-1",
        "open-brain-worker-2",
      ]);
      // Every nested body is a REAL single-worker payload, not a stub: it carries
      // the fields the charter freezes for the single-worker surface.
      for (const worker of aggregate.workers) {
        expect(worker.ok).toBe(true);
        const body = worker.body as SingleWorkerHealth;
        expect(body.status).toBe("healthy");
        expect(body.database.connected).toBe(true);
        expect(body.nats.requested_transport).toBe("http");
        expect(typeof body.timestamp).toBe("string");
      }
    });

    test("the two-worker front pins one MCP session to one worker", async () => {
      // Session affinity is the reason the front exists at all: sessions live in
      // a PROCESS-LOCAL map per worker (charter 1.5), so a follow-up request
      // routed to the other worker finds no session and the client breaks. Proven
      // over real sockets with a real SDK handshake, because the session id being
      // pinned is one the SDK server assigned, not one the test made up.
      const workerOne = await startWorkerApplication();
      const workerTwo = await startWorkerApplication();
      const front = createWorkerProxyHandler({
        workers: [
          {
            name: "open-brain-worker-1",
            port: workerOne.port,
            baseUrl: `http://127.0.0.1:${workerOne.port}`,
          },
          {
            name: "open-brain-worker-2",
            port: workerTwo.port,
            baseUrl: `http://127.0.0.1:${workerTwo.port}`,
          },
        ],
        hostname: "test-host",
        serverIp: "127.0.0.1",
        serverIps: ["127.0.0.1"],
        healthProbeTimeoutMs: 2_000,
        logger: silentLogger(),
      });
      freshNamespace();

      const initialize = await front(
        new Request("http://127.0.0.1/mcp", {
          method: "POST",
          headers: {
            authorization: `Bearer ${TEST_TOKEN}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "two-worker-affinity", version: "1.0.0" },
            },
          }),
        }),
      );
      expect(initialize.status).toBe(200);
      const sessionId = initialize.headers.get("mcp-session-id");
      expect(sessionId).toBeString();

      // Exactly one worker admitted the session; the other saw nothing. That
      // asymmetry is what makes affinity load-bearing rather than cosmetic.
      const admitted = [workerOne, workerTwo].filter(
        (worker) => worker.application.sessions.sessionCount() === 1,
      );
      expect(admitted.length).toBe(1);

      // Each follow-up must SUCCEED, and success is the assertion that matters.
      //
      // The obvious version of this test compares the front's own
      // `x-open-brain-worker` value across requests -- and it proves nothing: that
      // header is set on the OUTBOUND request the front sends to a worker, never
      // on the response handed back, so reading it here yields `null` on every
      // request and `null === null` passes with affinity deliberately broken.
      // Measured on this branch: disabling the `sessionWorkers` lookup outright
      // left that version 12/12 green.
      //
      // Reaching the wrong worker is instead observable in the only place it is
      // real -- the session map is PROCESS-LOCAL, so the other worker has never
      // heard of this session id and answers a JSON-RPC error rather than a
      // result. Asserting on the answered payload cannot be satisfied by routing
      // to the wrong process.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const followUp = await front(
          new Request("http://127.0.0.1/mcp", {
            method: "POST",
            headers: {
              authorization: `Bearer ${TEST_TOKEN}`,
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              "mcp-session-id": sessionId!,
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: attempt + 2,
              method: "tools/list",
            }),
          }),
        );
        expect(followUp.status).toBe(200);
        const answered = await followUp.text();
        expect(answered).toContain('"result"');
        expect(answered).toContain("working_set_append");
        expect(answered).not.toContain("Session not found");
      }
      // Still exactly one session in the fleet: affinity routed, it did not
      // create a second session on the other worker.
      expect(
        workerOne.application.sessions.sessionCount() +
          workerTwo.application.sessions.sessionCount(),
      ).toBe(1);
    });
  },
);
