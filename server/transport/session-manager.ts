import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";
import type { Logger } from "pino";
import type { AuthIdentity } from "../auth/types.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface SessionIdentity extends AuthIdentity {
  readonly agentId?: string;
}

export interface SessionTransportConfig {
  readonly sessionTtlMs: number;
  readonly maxSessions: number;
  readonly retryAfterSeconds: number;
  readonly closeTimeoutMs: number;
  readonly sweepIntervalMs: number;
}

export interface SessionTransportFactoryInput {
  readonly sessionIdGenerator: () => string;
  readonly onSessionInitialized: (sessionId: string) => void;
}

export type SessionTransportFactory = (
  input: SessionTransportFactoryInput,
) => StreamableHTTPServerTransport;

export type McpServerFactory = () => Pick<McpServer, "connect">;

type AuthenticatedRequest = Request & { auth?: SessionIdentity };

interface SessionEntry {
  readonly transport: StreamableHTTPServerTransport;
  readonly identity: SessionIdentity;
  timer: ReturnType<typeof setTimeout>;
  lastActivity: number;
  inFlight: number;
}

export interface SessionTransportHandlers {
  handlePost(request: Request, response: Response): Promise<void>;
  handleGet(request: Request, response: Response): Promise<void>;
  handleDelete(request: Request, response: Response): Promise<void>;
  sessionCount(): number;
  pendingInitializeCount(): number;
  close(): Promise<void>;
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

function sameIdentity(left: SessionIdentity | undefined, right: SessionIdentity): boolean {
  return (
    left?.tokenClientId === right.tokenClientId &&
    left?.role === right.role &&
    left?.clientId === right.clientId &&
    left?.namespaceSource === right.namespaceSource &&
    (left?.agentId ?? "") === (right.agentId ?? "")
  );
}

export function createSessionTransportHandlers(input: {
  readonly config: SessionTransportConfig;
  readonly logger: Logger;
  readonly serverFactory: McpServerFactory;
  readonly transportFactory?: SessionTransportFactory;
}): SessionTransportHandlers {
  const sessions = new Map<string, SessionEntry>();
  const transportFactory = input.transportFactory ?? defaultTransportFactory;
  let pendingInitializes = 0;

  function armExpiry(sessionId: string): void {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.lastActivity = Date.now();
    entry.timer = setTimeout(() => {
      void expireSession(sessionId, "inactivity");
    }, input.config.sessionTtlMs);
  }

  async function closeTransport(
    transport: StreamableHTTPServerTransport,
    sessionId: string,
    reason: string,
  ): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        transport.close(),
        new Promise<void>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("session_transport_close_timeout")),
            input.config.closeTimeoutMs,
          );
          timeout.unref();
        }),
      ]);
      input.logger.info({ session_id: sessionId, reason }, "session_closed");
    } catch (error: unknown) {
      input.logger.warn(
        {
          session_id: sessionId,
          reason,
          error_category: error instanceof Error ? error.name : typeof error,
        },
        "session_close_failed",
      );
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  async function expireSession(sessionId: string, reason: string): Promise<void> {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    if (entry.inFlight > 0) {
      input.logger.debug({ session_id: sessionId, reason }, "session_expiry_deferred");
      armExpiry(sessionId);
      return;
    }
    clearTimeout(entry.timer);
    sessions.delete(sessionId);
    await closeTransport(entry.transport, sessionId, reason);
  }

  async function runWithSession(
    sessionId: string,
    work: () => Promise<void>,
  ): Promise<void> {
    const entry = sessions.get(sessionId);
    if (!entry) {
      await work();
      return;
    }
    entry.inFlight += 1;
    try {
      await work();
    } finally {
      const current = sessions.get(sessionId);
      if (current) {
        current.inFlight = Math.max(0, current.inFlight - 1);
        armExpiry(sessionId);
      }
    }
  }

  function rejectIdentity(response: Response, sessionId: string): void {
    input.logger.warn({ session_id: sessionId }, "session_identity_rejected");
    response.status(403).json({ error: "Request identity does not match session" });
  }

  function rejectAdmission(response: Response): void {
    const activeSessions = sessions.size + pendingInitializes;
    input.logger.warn(
      { active_sessions: activeSessions, max_sessions: input.config.maxSessions },
      "session_admission_rejected",
    );
    response.setHeader("Retry-After", String(input.config.retryAfterSeconds));
    response.status(429).json({
      error: "Too many active sessions",
      code: "session_cap_exceeded",
      active_sessions: activeSessions,
      max_sessions: input.config.maxSessions,
      retry_after_seconds: input.config.retryAfterSeconds,
    });
  }

  async function handleExisting(
    request: Request,
    response: Response,
    sessionId: string,
    includeBody: boolean,
  ): Promise<boolean> {
    const entry = sessions.get(sessionId);
    if (!entry) return false;
    const identity = (request as AuthenticatedRequest).auth;
    if (!sameIdentity(identity, entry.identity)) {
      rejectIdentity(response, sessionId);
      return true;
    }
    armExpiry(sessionId);
    await runWithSession(sessionId, () =>
      entry.transport.handleRequest(
        request,
        response,
        includeBody ? request.body : undefined,
      ),
    );
    return true;
  }

  const sweepTimer = setInterval(() => {
    const now = Date.now();
    let swept = 0;
    for (const [sessionId, entry] of sessions) {
      if (entry.inFlight > 0) continue;
      if (now - entry.lastActivity <= input.config.sessionTtlMs * 2) continue;
      swept += 1;
      void expireSession(sessionId, "sweeper");
    }
    input.logger.debug(
      { active_sessions: sessions.size, swept_sessions: swept },
      "session_sweeper_result",
    );
  }, input.config.sweepIntervalMs);
  sweepTimer.unref();

  return {
    async handlePost(request, response) {
      const sessionId = requestSessionId(request);
      if (sessionId && (await handleExisting(request, response, sessionId, true))) return;
      if (sessionId || !isInitializeRequest(request.body)) {
        response.status(400).json({
          error: "Bad request: missing session or not an initialize request",
        });
        return;
      }
      if (sessions.size + pendingInitializes >= input.config.maxSessions) {
        rejectAdmission(response);
        return;
      }
      const identity = (request as AuthenticatedRequest).auth;
      if (!identity) {
        response.status(401).json({ error: "Auth info missing" });
        return;
      }

      pendingInitializes += 1;
      const transport = transportFactory({
        sessionIdGenerator: randomUUID,
        onSessionInitialized: (initializedId) => {
          const timer = setTimeout(() => {
            void expireSession(initializedId, "inactivity");
          }, input.config.sessionTtlMs);
          sessions.set(initializedId, {
            transport,
            identity,
            timer,
            lastActivity: Date.now(),
            inFlight: 0,
          });
          input.logger.info({ session_id: initializedId }, "session_initialized");
        },
      });
      transport.onclose = () => {
        const initializedId = transport.sessionId;
        if (!initializedId) return;
        const entry = sessions.get(initializedId);
        if (!entry) return;
        clearTimeout(entry.timer);
        sessions.delete(initializedId);
        input.logger.info({ session_id: initializedId }, "session_transport_closed");
      };

      try {
        const server = input.serverFactory();
        await server.connect(transport);
        await transport.handleRequest(request, response, request.body);
      } catch (error: unknown) {
        const initializedId = transport.sessionId;
        if (initializedId && sessions.has(initializedId)) {
          await expireSession(initializedId, "initialize_error");
        } else {
          await closeTransport(transport, initializedId ?? "pending", "initialize_error");
        }
        throw error;
      } finally {
        pendingInitializes = Math.max(0, pendingInitializes - 1);
      }
    },

    async handleGet(request, response) {
      const sessionId = requestSessionId(request);
      if (sessionId && (await handleExisting(request, response, sessionId, false))) return;
      response.status(400).json({ error: "Invalid or missing session" });
    },

    async handleDelete(request, response) {
      const sessionId = requestSessionId(request);
      const entry = sessionId ? sessions.get(sessionId) : undefined;
      if (!sessionId || !entry) {
        response.status(400).json({ error: "Invalid or missing session" });
        return;
      }
      const identity = (request as AuthenticatedRequest).auth;
      if (!sameIdentity(identity, entry.identity)) {
        rejectIdentity(response, sessionId);
        return;
      }
      await expireSession(sessionId, "client_delete");
      response.status(200).json({ status: "session closed" });
    },

    sessionCount: () => sessions.size,
    pendingInitializeCount: () => pendingInitializes,
    async close() {
      clearInterval(sweepTimer);
      await Promise.all(
        [...sessions.keys()].map((sessionId) => expireSession(sessionId, "manager_close")),
      );
    },
  };
}
