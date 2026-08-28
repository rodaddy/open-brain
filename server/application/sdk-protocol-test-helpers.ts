/**
 * Shared harness for the real-SDK protocol proof.
 *
 * Holds the constants, module state, and helper functions that compose the real
 * `server/` stack behind a real ephemeral HTTP listener. It holds no test and
 * creates no pool: every helper that touches the database takes the caller's
 * `Pool` as its first parameter, so the file that owns the pool also owns
 * ending it.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import express from "express";
import type { RequestHandler } from "express";
import pino from "pino";
import type { Pool } from "pg";
import { createShadowApplication } from "./index.ts";
import type { ShadowApplication } from "./index.ts";
import { parseServerConfig } from "../config.ts";
import type { ServerConfig } from "../config.ts";
import type { Database, DatabaseHealth } from "../db/pool.ts";
import { RecoveryWalStore } from "../realtime/recovery-wal.ts";
import { WorkingSetStore } from "../realtime/working-set.ts";
import { registerMemoryTools } from "../tools/index.ts";
import { DEFAULT_SHARED_NAMESPACE_NAMES } from "../tools/shared-namespace-fixture.ts";
import { silentLogger } from "../transport/testing/silent-logger.ts";

/**
 * Assert a value is present and return it narrowed.
 *
 * Replaces the non-null assertion operator: `x!` tells the compiler to stop
 * checking, while this throws a labelled error at the moment the assumption is
 * actually wrong, which is what a test wants to read in its failure output.
 */
export function expectDefined<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${label} to be defined`);
  }
  return value;
}

export const TEST_TOKEN = "sdk-protocol-proof-token";
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

export function freshNamespace(): string {
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
export const SHARED_ISOLATION = `sdk-proof-shared-${process.pid}-${Date.now()}`;

export function testConfig(): ServerConfig {
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
export function fakeHealthDatabase(): Database {
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
export function bearerAuth(): RequestHandler {
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

export const live: Partial<LiveHarness> = {};

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
export function freshRealtimeStores(): {
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
export async function startWorkerApplication(pool: Pool): Promise<{
  application: ShadowApplication;
  server: Server;
  port: number;
}> {
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
    const listener = application.app.listen(0, "127.0.0.1", () => resolve(listener));
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
export async function connectRealClient(pool: Pool): Promise<Client> {
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
export async function callTool(
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

/**
 * Tear down everything a single test composed: the `live` harness client,
 * listener, and application, plus any extra listeners and applications the
 * two-worker proof stood up. Called from the suite's `afterEach`, so a leaked
 * listener never surfaces later as an unrelated test hanging.
 */
export async function closeExtras(): Promise<void> {
  if (live.client) {
    await live.client.close();
    live.client = undefined;
  }
  live.transport = undefined;
  if (live.server) {
    const server = live.server;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    live.server = undefined;
  }
  if (live.application) {
    await live.application.close();
    live.application = undefined;
  }
  while (extraServers.length > 0) {
    const server = expectDefined(extraServers.pop(), "extra server");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  while (extraApplications.length > 0) {
    await expectDefined(extraApplications.pop(), "extra application").close();
  }
}

/** The namespace the most recent `freshNamespace()` installed. */
export function currentNamespace(): string {
  return NAMESPACE;
}
