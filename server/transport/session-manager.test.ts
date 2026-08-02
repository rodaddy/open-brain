/**
 * MCP session lifecycle boundary tests.
 *
 * Design authority: `_plans/463-server-rewrite-charter.md` phase 4 freezes the
 * behavior these assertions pin -- a fresh MCP server per session, auth-bound
 * session identity, admission accounting that counts pending initializes,
 * in-flight-safe idle expiry, and the 429 retry payload. The equivalent
 * assertions against the current server live in `src/transport.test.ts`.
 *
 * Every dependency is injected, so no socket is bound and no database is
 * touched -- unchanged by the Phase 6 cutover, which moved the deployed spawn
 * target to `server/main.ts` and set `SERVER_REWRITE_STATE.servesTraffic` to
 * true. These handlers are now the ones behind the serving process, so the
 * frozen behavior above is a production contract rather than a candidate's.
 */
import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { createSessionTransportHandlers } from "./index.ts";
import type {
  McpServerFactory,
  SessionIdentity,
  SessionTransportConfig,
  SessionTransportFactory,
  SessionTransportFactoryInput,
} from "./index.ts";
import { silentLogger } from "./testing/silent-logger.ts";

const CONFIG: SessionTransportConfig = {
  sessionTtlMs: 30_000,
  maxSessions: 2,
  retryAfterSeconds: 2,
  closeTimeoutMs: 5_000,
  sweepIntervalMs: 30_000,
};

const IDENTITY: SessionIdentity = {
  role: "agent",
  clientId: "agent",
  tokenClientId: "agent",
  namespaceSource: "token",
};

interface RecordedResponse {
  status?: number;
  body?: unknown;
  headers: Record<string, string>;
}

function fakeResponse(): { response: Response; recorded: RecordedResponse } {
  const recorded: RecordedResponse = { headers: {} };
  const stub = {
    statusCode: 200,
    headersSent: false,
    status(code: number) {
      recorded.status = code;
      stub.statusCode = code;
      return stub;
    },
    json(payload: unknown) {
      recorded.body = payload;
      return stub;
    },
    setHeader(name: string, value: string) {
      recorded.headers[name] = value;
      return stub;
    },
  };
  return { response: stub as unknown as Response, recorded };
}

function initializeRequest(identity: SessionIdentity = IDENTITY): Request {
  return {
    headers: {},
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    },
    auth: identity,
  } as unknown as Request;
}

function sessionRequest(sessionId: string, identity: SessionIdentity | undefined): Request {
  return {
    headers: { "mcp-session-id": sessionId },
    body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
    auth: identity,
  } as unknown as Request;
}

/**
 * A transport double that drives the SAME initialization callback the real
 * StreamableHTTPServerTransport invokes, so the manager's registration path is
 * exercised rather than simulated.
 */
interface StubTransport {
  sessionId?: string;
  onclose?: () => void;
  closed: boolean;
  handled: number;
  handleRequest(request: Request, response: Response, body?: unknown): Promise<void>;
  close(): Promise<void>;
}

function stubTransportFactory(options?: {
  readonly onHandle?: (transport: StubTransport) => Promise<void>;
}): {
  factory: SessionTransportFactory;
  transports: StubTransport[];
} {
  const transports: StubTransport[] = [];
  const factory = ((input: SessionTransportFactoryInput) => {
    const transport: StubTransport = {
      closed: false,
      handled: 0,
      async handleRequest(_request, _response, _body) {
        transport.handled += 1;
        if (!transport.sessionId) {
          transport.sessionId = input.sessionIdGenerator();
          input.onSessionInitialized(transport.sessionId);
        }
        if (options?.onHandle) await options.onHandle(transport);
      },
      async close() {
        transport.closed = true;
        transport.onclose?.();
      },
    };
    transports.push(transport);
    return transport as unknown as ReturnType<SessionTransportFactory>;
  }) as SessionTransportFactory;
  return { factory, transports };
}

function countingServerFactory(): { factory: McpServerFactory; created: () => number } {
  let created = 0;
  const factory: McpServerFactory = () => {
    created += 1;
    return { connect: async () => {} } as ReturnType<McpServerFactory>;
  };
  return { factory, created: () => created };
}

function makeHandlers(overrides?: {
  readonly config?: Partial<SessionTransportConfig>;
  readonly transportFactory?: SessionTransportFactory;
  readonly serverFactory?: McpServerFactory;
}) {
  return createSessionTransportHandlers({
    config: { ...CONFIG, ...overrides?.config },
    logger: silentLogger(),
    serverFactory: overrides?.serverFactory ?? countingServerFactory().factory,
    ...(overrides?.transportFactory
      ? { transportFactory: overrides.transportFactory }
      : {}),
  });
}

describe("mcp session transport boundary", () => {
  it("builds a fresh MCP server for every initialized session", async () => {
    const { factory } = stubTransportFactory();
    const server = countingServerFactory();
    const handlers = makeHandlers({
      transportFactory: factory,
      serverFactory: server.factory,
    });

    await handlers.handlePost(initializeRequest(), fakeResponse().response);
    await handlers.handlePost(initializeRequest(), fakeResponse().response);

    expect(server.created()).toBe(2);
    expect(handlers.sessionCount()).toBe(2);
    await handlers.close();
  });

  it("binds the session to its initializing identity and refuses another token", async () => {
    const { factory, transports } = stubTransportFactory();
    const handlers = makeHandlers({ transportFactory: factory });

    await handlers.handlePost(initializeRequest(), fakeResponse().response);
    const sessionId = transports[0]?.sessionId;
    expect(sessionId).toBeDefined();

    const owner = fakeResponse();
    await handlers.handlePost(sessionRequest(sessionId!, IDENTITY), owner.response);
    expect(owner.recorded.status).toBeUndefined();
    expect(transports[0]?.handled).toBe(2);

    const intruder = fakeResponse();
    await handlers.handlePost(
      sessionRequest(sessionId!, { ...IDENTITY, tokenClientId: "discord" }),
      intruder.response,
    );
    expect(intruder.recorded.status).toBe(403);
    expect(intruder.recorded.body).toEqual({
      error: "Request identity does not match session",
    });
    expect(transports[0]?.handled).toBe(2);

    await handlers.close();
  });

  it("refuses a session-bearing GET and DELETE from a different identity", async () => {
    const { factory, transports } = stubTransportFactory();
    const handlers = makeHandlers({ transportFactory: factory });
    await handlers.handlePost(initializeRequest(), fakeResponse().response);
    const sessionId = transports[0]!.sessionId!;

    const get = fakeResponse();
    await handlers.handleGet(
      sessionRequest(sessionId, { ...IDENTITY, role: "admin" }),
      get.response,
    );
    expect(get.recorded.status).toBe(403);

    const del = fakeResponse();
    await handlers.handleDelete(
      sessionRequest(sessionId, { ...IDENTITY, clientId: "someone-else" }),
      del.response,
    );
    expect(del.recorded.status).toBe(403);
    expect(handlers.sessionCount()).toBe(1);

    await handlers.close();
  });

  it("counts a pending initialize against admission before its session exists", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { factory } = stubTransportFactory({ onHandle: () => gate });
    const handlers = makeHandlers({
      config: { maxSessions: 1 },
      transportFactory: factory,
    });

    const slow = handlers.handlePost(initializeRequest(), fakeResponse().response);
    expect(handlers.pendingInitializeCount()).toBe(1);

    const rejected = fakeResponse();
    await handlers.handlePost(initializeRequest(), rejected.response);
    expect(rejected.recorded.status).toBe(429);

    release!();
    await slow;
    await handlers.close();
  });

  it("answers an exhausted admission with 429, Retry-After, and retry metadata", async () => {
    const { factory } = stubTransportFactory();
    const handlers = makeHandlers({
      config: { maxSessions: 1, retryAfterSeconds: 7 },
      transportFactory: factory,
    });
    await handlers.handlePost(initializeRequest(), fakeResponse().response);

    const rejected = fakeResponse();
    await handlers.handlePost(initializeRequest(), rejected.response);

    expect(rejected.recorded.status).toBe(429);
    expect(rejected.recorded.headers["Retry-After"]).toBe("7");
    expect(rejected.recorded.body).toEqual({
      error: "Too many active sessions",
      code: "session_cap_exceeded",
      active_sessions: 1,
      max_sessions: 1,
      retry_after_seconds: 7,
    });

    await handlers.close();
  });

  it("does not expire a session while a request is still in flight", async () => {
    let release: (() => void) | undefined;
    let seenClosedDuringRequest: boolean | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { factory, transports } = stubTransportFactory({
      onHandle: async (transport) => {
        if (transport.handled < 2) return;
        await gate;
        seenClosedDuringRequest = transport.closed;
      },
    });
    const handlers = makeHandlers({
      config: { sessionTtlMs: 5 },
      transportFactory: factory,
    });

    await handlers.handlePost(initializeRequest(), fakeResponse().response);
    const sessionId = transports[0]!.sessionId!;

    const inFlight = handlers.handlePost(
      sessionRequest(sessionId, IDENTITY),
      fakeResponse().response,
    );
    // Let the 5 ms idle timer fire while the request is still executing.
    await Bun.sleep(40);
    expect(transports[0]?.closed).toBe(false);
    expect(handlers.sessionCount()).toBe(1);

    release!();
    await inFlight;
    expect(seenClosedDuringRequest).toBe(false);

    await handlers.close();
  });

  it("expires an idle session once no request is in flight", async () => {
    const { factory, transports } = stubTransportFactory();
    const handlers = makeHandlers({
      config: { sessionTtlMs: 5 },
      transportFactory: factory,
    });
    await handlers.handlePost(initializeRequest(), fakeResponse().response);
    expect(handlers.sessionCount()).toBe(1);

    await Bun.sleep(60);

    expect(handlers.sessionCount()).toBe(0);
    expect(transports[0]?.closed).toBe(true);
    await handlers.close();
  });

  it("closes a session on client DELETE and frees its admission slot", async () => {
    const { factory, transports } = stubTransportFactory();
    const handlers = makeHandlers({
      config: { maxSessions: 1 },
      transportFactory: factory,
    });
    await handlers.handlePost(initializeRequest(), fakeResponse().response);
    const sessionId = transports[0]!.sessionId!;

    const deleted = fakeResponse();
    await handlers.handleDelete(sessionRequest(sessionId, IDENTITY), deleted.response);
    expect(deleted.recorded.status).toBe(200);
    expect(deleted.recorded.body).toEqual({ status: "session closed" });
    expect(handlers.sessionCount()).toBe(0);
    expect(transports[0]?.closed).toBe(true);

    const readmitted = fakeResponse();
    await handlers.handlePost(initializeRequest(), readmitted.response);
    expect(readmitted.recorded.status).toBeUndefined();
    expect(handlers.sessionCount()).toBe(1);

    await handlers.close();
  });

  it("rejects a non-initialize POST that carries no session", async () => {
    const handlers = makeHandlers({ transportFactory: stubTransportFactory().factory });
    const recorded = fakeResponse();
    await handlers.handlePost(
      { headers: {}, body: { jsonrpc: "2.0", id: 3, method: "tools/list" }, auth: IDENTITY } as unknown as Request,
      recorded.response,
    );
    expect(recorded.recorded.status).toBe(400);
    await handlers.close();
  });

  it("rejects an unknown session id on GET and DELETE", async () => {
    const handlers = makeHandlers({ transportFactory: stubTransportFactory().factory });
    const unknown = randomUUID();

    const get = fakeResponse();
    await handlers.handleGet(sessionRequest(unknown, IDENTITY), get.response);
    expect(get.recorded.status).toBe(400);

    const del = fakeResponse();
    await handlers.handleDelete(sessionRequest(unknown, IDENTITY), del.response);
    expect(del.recorded.status).toBe(400);

    await handlers.close();
  });

  it("refuses an initialize that arrives without authenticated identity", async () => {
    const handlers = makeHandlers({ transportFactory: stubTransportFactory().factory });
    const recorded = fakeResponse();
    const unauthenticated = initializeRequest();
    delete (unauthenticated as { auth?: SessionIdentity }).auth;

    await handlers.handlePost(unauthenticated, recorded.response);

    expect(recorded.recorded.status).toBe(401);
    expect(recorded.recorded.body).toEqual({ error: "Auth info missing" });
    expect(handlers.sessionCount()).toBe(0);
    await handlers.close();
  });

  it("ignores a malformed session header instead of trusting it", async () => {
    const { factory } = stubTransportFactory();
    const handlers = makeHandlers({ transportFactory: factory });
    const recorded = fakeResponse();
    await handlers.handleGet(
      { headers: { "mcp-session-id": "not-a-uuid" }, auth: IDENTITY } as unknown as Request,
      recorded.response,
    );
    expect(recorded.recorded.status).toBe(400);
    await handlers.close();
  });

  it("releases the pending initialize slot when the handshake throws", async () => {
    const failing: McpServerFactory = () => ({
      connect: async () => {
        throw new Error("connect_failed");
      },
    }) as ReturnType<McpServerFactory>;
    const handlers = makeHandlers({
      config: { maxSessions: 1 },
      transportFactory: stubTransportFactory().factory,
      serverFactory: failing,
    });

    await expect(
      handlers.handlePost(initializeRequest(), fakeResponse().response),
    ).rejects.toThrow("connect_failed");
    expect(handlers.pendingInitializeCount()).toBe(0);
    expect(handlers.sessionCount()).toBe(0);

    await handlers.close();
  });

  it("closes every live session when the manager shuts down", async () => {
    const { factory, transports } = stubTransportFactory();
    const handlers = makeHandlers({ transportFactory: factory });
    await handlers.handlePost(initializeRequest(), fakeResponse().response);
    await handlers.handlePost(initializeRequest(), fakeResponse().response);
    expect(handlers.sessionCount()).toBe(2);

    await handlers.close();

    expect(handlers.sessionCount()).toBe(0);
    expect(transports.every((transport) => transport.closed)).toBe(true);
  });
});
