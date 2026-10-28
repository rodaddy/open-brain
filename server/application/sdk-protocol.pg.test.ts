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
 * DATABASE. Demands the test database rather than skipping itself: the module
 * calls `requireTestDatabaseUrl()`, which throws `test_database_required` when
 * the variable is unset. It must point at an isolated test/playground database.
 * Never the dogfood database.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Pool } from "pg";
import pino from "pino";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createShadowApplication } from "./index.ts";
import { registerMemoryTools } from "../tools/index.ts";
import { DEFAULT_SHARED_NAMESPACE_NAMES } from "../tools/shared-namespace-fixture.ts";
import { SERVER_REWRITE_STATE } from "../state.ts";
import { silentLogger } from "../transport/testing/silent-logger.ts";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  expectRecordedShape,
  loadServerFixture,
} from "../../contracts/fixture-shape.ts";
import { requireTestDatabaseUrl } from "../../scripts/test-support/require-test-database.ts";
import {
  isolateSharedNamespace,
  restoreSharedNamespace,
} from "../../scripts/test-support/shared-namespace-env.ts";
import {
  callTool,
  currentNamespace,
  bearerAuth,
  fakeHealthDatabase,
  testConfig,
  closeExtras,
  connectRealClient,
  expectDefined,
  freshNamespace,
  live,
  SHARED_ISOLATION,
} from "./sdk-protocol-test-helpers.ts";

const pool = new Pool({ connectionString: requireTestDatabaseUrl() });

afterEach(async () => {
  await closeExtras();
});

afterAll(async () => {
  restoreSharedNamespace();
  await pool.end();
});

function provesServingTarget(): void {
  expect(SERVER_REWRITE_STATE.servesTraffic).toBe(true);
  expect(SERVER_REWRITE_STATE.cutoverStarted).toBe(true);
}

async function completesHandshake(): Promise<void> {
  const client = await connectRealClient(pool);

  // A server-assigned session id only exists if the handshake really happened:
  // the SDK client reads it off the `Mcp-Session-Id` response header, and the
  // session manager only sets one from `onsessioninitialized`.
  expect(typeof live.transport?.sessionId).toBe("string");
  expect(
    expectDefined(
      expectDefined(live.transport, "live transport").sessionId,
      "session id",
    ),
  ).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  // The composed session boundary now holds exactly this one live session.
  expect(live.application?.sessions.sessionCount()).toBe(1);
  expect(client.getServerVersion()?.name).toBe("open-brain-rewrite");
}

async function listsToolSurface(): Promise<void> {
  const client = await connectRealClient(pool);
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
  expect(sessionStart?.inputSchema).toEqual(expect.any(Object));
}

async function roundTripsLifecycle(): Promise<void> {
  const client = await connectRealClient(pool);
  const fixture = await loadServerFixture("server-session-lifecycle");
  const sessionKey = `sdk-proof/lifecycle-${Date.now()}`;

  for (const step of fixture.steps) {
    const args = { ...step.arguments, session_key: sessionKey };
    const observed = await callTool(client, step.tool, args);

    expect(observed.isError).toBe(step.expectation.is_error);
    expectRecordedShape(observed.body, step.expectation.json, {
      "{{namespace}}": currentNamespace(),
      "parity/lifecycle": sessionKey,
    });
  }
}

async function performsCaptureWrite(): Promise<void> {
  const client = await connectRealClient(pool);
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
    "{{namespace}}": currentNamespace(),
  });

  // The wire said it wrote; Postgres is the authority on whether it did.
  // "A row was written" is an assertion, not an assumption.
  const written = (observed.body as { id: string }).id;
  const { rows } = await pool.query(
    "SELECT namespace, content FROM thoughts WHERE id = $1 AND archived_at IS NULL",
    [written],
  );
  expect(rows.length).toBe(1);
  expect(rows[0].namespace).toBe(currentNamespace());
  expect(rows[0].content).toBe(content);
}

async function performsSearchRead(): Promise<void> {
  const client = await connectRealClient(pool);
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
    "{{namespace}}": currentNamespace(),
    "{{thought_id}}": writtenId,
    "parity recall probe thought": content,
  });
}

async function fetchesContextPack(): Promise<void> {
  const client = await connectRealClient(pool);
  const fixture = await loadServerFixture("server-context-pack-sections");
  const packStep = fixture.steps.find((step) => step.tool === "agent_context_pack");
  if (!packStep)
    throw new Error("fixture no longer records an agent_context_pack step");

  const sessionKey = `sdk-proof/pack-${Date.now()}`;
  const observed = await callTool(client, "agent_context_pack", {
    ...packStep.arguments,
    session_key: sessionKey,
  });

  expect(observed.isError).toBe(false);
  expectRecordedShape(observed.body, packStep.expectation.json, {
    "{{namespace}}": currentNamespace(),
    "parity/pack": sessionKey,
  });
}

async function refusesUnauthenticated(): Promise<void> {
  // The identity chain is the thing this file exists to prove, so its failure
  // path is behavior too: no token means no `req.auth`, and the SDK must never
  // reach a handler. Asserted as a rejected connect, not a tool-level error.
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
    const listener = application.app.listen(0, "127.0.0.1", () => resolve(listener));
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
}

async function appendsRealtimeState(): Promise<void> {
  // The realtime WRITE half only became reachable in this wave. Before it, the
  // fixture was marked `scaffold-declared` for the rewrite provider: the
  // stores existed and the context pack READ them, but no tool could put
  // anything in, so every recorded shape here was asserted against
  // `current-src` alone.
  const client = await connectRealClient(pool);
  const fixture = await loadServerFixture("server-realtime-working-recovery");
  const sessionKey = `sdk-proof/realtime-${Date.now()}`;

  for (const step of fixture.steps) {
    const observed = await callTool(client, step.tool, {
      ...step.arguments,
      session_key: sessionKey,
    });
    expect(observed.isError).toBe(step.expectation.is_error);
    expectRecordedShape(observed.body, step.expectation.json, {
      "{{namespace}}": currentNamespace(),
      "parity/realtime": sessionKey,
    });
  }
}

async function workingSetVisibleToPack(): Promise<void> {
  // This is the join the two halves share and neither one proves alone. The
  // stores are RAM-only and process-lifetime, so a write that landed in a
  // DIFFERENT store object than the pack reads would still return
  // `accepted: true` and then be invisible forever -- and nothing durable
  // would ever contradict it, because nothing about this state is durable.
  // Asserting the append's own response cannot catch that; only reading it
  // back through the other tool can.
  const client = await connectRealClient(pool);
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
}

// The "(live Postgres)" marker is REQUIRED, not decorative: the anti-skip guard
// in `scripts/assert-db-tests-ran.ts` selects suites by that literal substring
// (both its `<testsuite>` scan and its `<testcase>` cross-check), so a
// DB-backed suite named without it is invisible to the guard and can skip in CI
// with the job still green. Observed on this branch before the rename: the guard
// reported this suite as MISSING while the JUnit record showed `tests="8"
// failures="0" skipped="0"`.
describe("rewrite candidate over the real MCP SDK and real HTTP transport (live Postgres)", () => {
  beforeAll(() => {
    isolateSharedNamespace(SHARED_ISOLATION);
  });

  test(
    "proves protocol behavior for the implementation the cutover made the serving target",
    provesServingTarget,
  );

  test(
    "completes a real initialize handshake and issues an Mcp-Session-Id",
    completesHandshake,
  );

  test("lists the registered tool surface over the wire", listsToolSurface);

  test(
    "round-trips the session lifecycle against the recorded fixture shape",
    roundTripsLifecycle,
  );

  test(
    "performs a capture write that lands a real row and matches the recorded shape",
    performsCaptureWrite,
  );

  test("performs a search read that finds what this session wrote", performsSearchRead);

  test(
    "fetches agent_context_pack with every requested section over the wire",
    fetchesContextPack,
  );

  test(
    "refuses an unauthenticated client at the transport before any tool runs",
    refusesUnauthenticated,
  );

  test(
    "appends realtime working-set and recovery state against the recorded shapes",
    appendsRealtimeState,
  );

  test(
    "a working-set append is visible to the context pack that reads the same store",
    workingSetVisibleToPack,
  );
});
