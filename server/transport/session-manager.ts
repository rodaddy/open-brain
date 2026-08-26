import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";
import type { Logger } from "pino";
import { SessionStore, sameIdentity } from "./session-store.ts";
import type {
  SessionIdentity,
  SessionTransportConfig,
} from "./session-store.ts";

export type {
  SessionIdentity,
  SessionTransportConfig,
} from "./session-store.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SessionTransportFactoryInput {
  readonly sessionIdGenerator: () => string;
  readonly onSessionInitialized: (sessionId: string) => void;
}

export type SessionTransportFactory = (
  input: SessionTransportFactoryInput,
) => StreamableHTTPServerTransport;

export type McpServerFactory = () => Pick<McpServer, "connect">;

type AuthenticatedRequest = Request & { auth?: SessionIdentity };

export interface SessionTransportHandlers {
  handlePost(request: Request, response: Response): Promise<void>;
  handleGet(request: Request, response: Response): Promise<void>;
  handleDelete(request: Request, response: Response): Promise<void>;
  sessionCount(): number;
  pendingInitializeCount(): number;
  close(): Promise<void>;
}

/** Everything the module-level handler helpers need from one manager instance. */
interface HandlerContext {
  readonly store: SessionStore;
  readonly config: SessionTransportConfig;
  readonly logger: Logger;
  readonly serverFactory: McpServerFactory;
  readonly transportFactory: SessionTransportFactory;
}

function defaultTransportFactory(
  input: SessionTransportFactoryInput,
): StreamableHTTPServerTransport {
  return new StreamableHTTPServerTransport({
    sessionIdGenerator: input.sessionIdGenerator,
    onsessioninitialized: input.onSessionInitialized,
  });
}

function requestSessionId(request: Request): string | undefined {
  const raw = request.headers["mcp-session-id"];
  return typeof raw === "string" && UUID_RE.test(raw) ? raw : undefined;
}

function rejectIdentity(
  context: HandlerContext,
  response: Response,
  sessionId: string,
): void {
  context.logger.warn({ session_id: sessionId }, "session_identity_rejected");
  response
    .status(403)
    .json({ error: "Request identity does not match session" });
}

function rejectAdmission(context: HandlerContext, response: Response): void {
  const activeSessions = context.store.activeCount;
  context.logger.warn(
    {
      active_sessions: activeSessions,
      max_sessions: context.config.maxSessions,
    },
    "session_admission_rejected",
  );
  response.setHeader("Retry-After", String(context.config.retryAfterSeconds));
  response.status(429).json({
    error: "Too many active sessions",
    code: "session_cap_exceeded",
    active_sessions: activeSessions,
    max_sessions: context.config.maxSessions,
    retry_after_seconds: context.config.retryAfterSeconds,
  });
}

/**
 * Serve a request against an already-live session, answering whether it was
 * handled here. `false` means no such session, and the caller decides what that
 * means for its own method.
 */
async function handleExisting(input: {
  readonly context: HandlerContext;
  readonly request: Request;
  readonly response: Response;
  readonly sessionId: string;
  readonly includeBody: boolean;
}): Promise<boolean> {
  const { context, request, response, sessionId } = input;
  const entry = context.store.get(sessionId);
  if (!entry) return false;
  const identity = (request as AuthenticatedRequest).auth;
  if (!sameIdentity(identity, entry.identity)) {
    rejectIdentity(context, response, sessionId);
    return true;
  }
  context.store.armExpiry(sessionId);
  await context.store.runWithSession(sessionId, () =>
    entry.transport.handleRequest(
      request,
      response,
      input.includeBody ? request.body : undefined,
    ),
  );
  return true;
}

/** Build the transport for a new session, wiring registration and close-out. */
function createInitializeTransport(
  context: HandlerContext,
  identity: SessionIdentity,
): StreamableHTTPServerTransport {
  const transport = context.transportFactory({
    sessionIdGenerator: randomUUID,
    onSessionInitialized: (initializedId) => {
      context.store.register(initializedId, transport, identity);
    },
  });
  transport.onclose = () => {
    const initializedId = transport.sessionId;
    if (!initializedId) return;
    context.store.forget(initializedId);
  };
  return transport;
}

/**
 * Reject an initialize request that cannot be admitted, answering whether a
 * response was already sent.
 */
function rejectInitialize(input: {
  readonly context: HandlerContext;
  readonly response: Response;
  readonly body: unknown;
  readonly sessionId: string | undefined;
  readonly identity: SessionIdentity | undefined;
}): boolean {
  const { context, response } = input;
  if (input.sessionId || !isInitializeRequest(input.body)) {
    response.status(400).json({
      error: "Bad request: missing session or not an initialize request",
    });
    return true;
  }
  if (!context.store.admits()) {
    rejectAdmission(context, response);
    return true;
  }
  if (!input.identity) {
    response.status(401).json({ error: "Auth info missing" });
    return true;
  }
  return false;
}

/** Run the initialize handshake, retiring the transport if it throws. */
async function runInitialize(
  context: HandlerContext,
  request: Request,
  response: Response,
  identity: SessionIdentity,
): Promise<void> {
  context.store.beginInitialize();
  const transport = createInitializeTransport(context, identity);
  try {
    const server = context.serverFactory();
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  } catch (error: unknown) {
    const initializedId = transport.sessionId;
    if (initializedId && context.store.get(initializedId)) {
      await context.store.expire(initializedId, "initialize_error");
    } else {
      await context.store.closeTransport(
        transport,
        initializedId ?? "pending",
        "initialize_error",
      );
    }
    throw error;
  } finally {
    context.store.endInitialize();
  }
}

async function handlePost(
  context: HandlerContext,
  request: Request,
  response: Response,
): Promise<void> {
  const sessionId = requestSessionId(request);
  if (
    sessionId &&
    (await handleExisting({
      context,
      request,
      response,
      sessionId,
      includeBody: true,
    }))
  ) {
    return;
  }
  const identity = (request as AuthenticatedRequest).auth;
  if (
    rejectInitialize({
      context,
      response,
      body: request.body,
      sessionId,
      identity,
    })
  ) {
    return;
  }
  await runInitialize(context, request, response, identity as SessionIdentity);
}

async function handleGet(
  context: HandlerContext,
  request: Request,
  response: Response,
): Promise<void> {
  const sessionId = requestSessionId(request);
  if (
    sessionId &&
    (await handleExisting({
      context,
      request,
      response,
      sessionId,
      includeBody: false,
    }))
  ) {
    return;
  }
  response.status(400).json({ error: "Invalid or missing session" });
}

async function handleDelete(
  context: HandlerContext,
  request: Request,
  response: Response,
): Promise<void> {
  const sessionId = requestSessionId(request);
  const entry = sessionId ? context.store.get(sessionId) : undefined;
  if (!sessionId || !entry) {
    response.status(400).json({ error: "Invalid or missing session" });
    return;
  }
  const identity = (request as AuthenticatedRequest).auth;
  if (!sameIdentity(identity, entry.identity)) {
    rejectIdentity(context, response, sessionId);
    return;
  }
  await context.store.expire(sessionId, "client_delete");
  response.status(200).json({ status: "session closed" });
}

function startSweeper(context: HandlerContext): ReturnType<typeof setInterval> {
  const sweepTimer = setInterval(() => {
    const swept = context.store.sweep();
    context.logger.debug(
      { active_sessions: context.store.size, swept_sessions: swept },
      "session_sweeper_result",
    );
  }, context.config.sweepIntervalMs);
  sweepTimer.unref();
  return sweepTimer;
}

export function createSessionTransportHandlers(input: {
  readonly config: SessionTransportConfig;
  readonly logger: Logger;
  readonly serverFactory: McpServerFactory;
  readonly transportFactory?: SessionTransportFactory;
}): SessionTransportHandlers {
  const context: HandlerContext = {
    store: new SessionStore(input.config, input.logger),
    config: input.config,
    logger: input.logger,
    serverFactory: input.serverFactory,
    transportFactory: input.transportFactory ?? defaultTransportFactory,
  };
  const sweepTimer = startSweeper(context);

  return {
    handlePost: (request, response) => handlePost(context, request, response),
    handleGet: (request, response) => handleGet(context, request, response),
    handleDelete: (request, response) =>
      handleDelete(context, request, response),
    sessionCount: () => context.store.size,
    pendingInitializeCount: () => context.store.pendingCount,
    async close() {
      clearInterval(sweepTimer);
      await Promise.all(
        context.store
          .ids()
          .map((sessionId) => context.store.expire(sessionId, "manager_close")),
      );
    },
  };
}
