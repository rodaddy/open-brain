import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Request, Response } from "express";
import type { AuthInfo } from "./types.ts";
import { logger } from "./logger.ts";

// An idle session holds a slot against a hard cap, and the two costs are not
// comparable. Measured 2026-07-30 against the local service: re-initializing on
// a live connection is 6 ms, and a warm tool call is ~20 ms. Exhausting the pool
// is a 429 that stops every client until slots free.
//
// This was 30 minutes, with the safety-net sweeper at 2x -- so a client that
// made one call and vanished held a slot for up to an hour. A backfill leaked
// 100 sessions in ~45 seconds and the service refused all new connections; the
// cap was reached long before a single session had aged out.
//
// 30 seconds is sized for the CONCURRENT case, which is the one that breaks.
// The single-client math is easy -- during bulk work the gap between calls is
// milliseconds and the slowest measured step (read + strip a 256 MB transcript)
// was 603 ms. The case that matters is deployment_host with 60-70 clients: every one of
// them idling inside the TTL window holds a slot simultaneously, and nothing is
// malfunctioning when that fills the pool. At a 30 s hold, 70 clients leave real
// headroom in 100 slots; at 60 s they do not.
//
// The timer resets on every request (resetTimer), so this bounds IDLE time, not
// session lifetime. A busy client is never expired mid-work, and a client that
// does go quiet pays one 6 ms handshake on its next call.
const SESSION_TTL_MS =
  readPositiveInt(process.env.OPEN_BRAIN_SESSION_TTL_SECONDS, 30) * 1000;
// Sweep often enough that the safety net (2x TTL) is a backstop rather than the
// effective policy.
const SWEEP_INTERVAL_MS = 30 * 1000; // 30 seconds
const CLOSE_TIMEOUT_MS = 5_000; // 5 seconds max for transport.close()
const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_SESSION_RETRY_AFTER_SECONDS = 2;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  auth: AuthInfo;
  timer: ReturnType<typeof setTimeout>;
  lastActivity: number;
  // Requests currently executing against this session. The idle TTL bounds time
  // BETWEEN calls, not the duration of a call: a single tool call (a large
  // decompose, a batch of embeddings) can legitimately run longer than
  // SESSION_TTL_MS, and expiring it mid-flight would close the transport out
  // from under an in-progress request. So expiry defers while inFlight > 0 and
  // the timer is re-armed from request completion (see runWithSession).
  inFlight: number;
}

const sessions: Map<string, SessionEntry> = new Map();
let pendingInitializes = 0;

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function maxSessions(): number {
  return readPositiveInt(
    process.env.OPEN_BRAIN_MAX_SESSIONS,
    DEFAULT_MAX_SESSIONS,
  );
}

function retryAfterSeconds(): number {
  return readPositiveInt(
    process.env.OPEN_BRAIN_SESSION_RETRY_AFTER_SECONDS,
    DEFAULT_SESSION_RETRY_AFTER_SECONDS,
  );
}

function rejectSessionCap(res: Response): void {
  const max = maxSessions();
  const retryAfter = retryAfterSeconds();
  res.setHeader("Retry-After", String(retryAfter));
  res.status(429).json({
    error: "Too many active sessions",
    code: "session_cap_exceeded",
    active_sessions: sessions.size + pendingInitializes,
    max_sessions: max,
    retry_after_seconds: retryAfter,
  });
}

async function expireSession(sessionId: string, reason: string): Promise<void> {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  // Never close a session that has a request executing against it. The idle
  // TTL fired, but the session is not idle; re-arm and let the request's own
  // completion (runWithSession's finally) decide expiry. A forced sweep also
  // honours this: closing here would drop a response mid-write.
  if (entry.inFlight > 0) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      expireSession(sessionId, "inactivity");
    }, SESSION_TTL_MS);
    return;
  }
  clearTimeout(entry.timer);
  sessions.delete(sessionId); // delete BEFORE close — can't leak
  try {
    await Promise.race([
      entry.transport.close(),
      new Promise<void>((_, reject) =>
        setTimeout(
          () => reject(new Error("close timed out")),
          CLOSE_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (err) {
    logger.warn("Error closing transport during session expiry", {
      sessionId,
      reason,
      error: String(err),
    });
  }
}

function resetTimer(sessionId: string): void {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.lastActivity = Date.now();
  entry.timer = setTimeout(() => {
    expireSession(sessionId, "inactivity");
  }, SESSION_TTL_MS);
}

/**
 * Run one request against a session so the idle TTL cannot expire it mid-flight.
 *
 * The inactivity timer bounds the gap BETWEEN calls; a single call may run
 * longer than SESSION_TTL_MS. Marking the session in-flight makes expireSession
 * (timer or sweeper) defer while the request executes, and the `finally`
 * re-arms the timer from COMPLETION time -- so a busy client is never expired
 * mid-work and a client that goes quiet right after still ages out on schedule.
 */
async function runWithSession(
  sessionId: string,
  handle: () => Promise<void>,
): Promise<void> {
  const entry = sessions.get(sessionId);
  if (!entry) {
    await handle();
    return;
  }
  entry.inFlight += 1;
  try {
    await handle();
  } finally {
    const current = sessions.get(sessionId);
    if (current) {
      current.inFlight = Math.max(0, current.inFlight - 1);
      // Re-arm from completion, not from request start, so the idle window is
      // measured from when this call finished.
      resetTimer(sessionId);
    }
  }
}

// Safety-net sweeper: force-clean sessions that survived past 2x TTL
// unref() so the timer doesn't prevent clean process exit
const sweepTimer = setInterval(() => {
  const now = Date.now();
  let swept = 0;
  for (const [id, entry] of sessions) {
    // An in-flight request is not idle no matter how long it has run; the
    // safety net still refuses to close it (expireSession defers), so skip it
    // here rather than count a sweep that will not happen.
    if (entry.inFlight > 0) continue;
    if (now - entry.lastActivity > SESSION_TTL_MS * 2) {
      expireSession(id, "sweeper");
      swept++;
    }
  }
  logger.debug("Session sweeper tick", {
    active: sessions.size,
    swept,
  });
}, SWEEP_INTERVAL_MS);
sweepTimer.unref();

function getSessionAuth(sessionId: string): AuthInfo | undefined {
  return sessions.get(sessionId)?.auth;
}

function tokenClientId(auth: AuthInfo | undefined): string | undefined {
  return auth?.tokenClientId ?? auth?.clientId;
}

function sameSessionIdentity(
  requestAuth: AuthInfo | undefined,
  sessionAuth: AuthInfo,
): boolean {
  return (
    tokenClientId(requestAuth) === tokenClientId(sessionAuth) &&
    requestAuth?.role === sessionAuth.role &&
    requestAuth?.clientId === sessionAuth.clientId &&
    requestAuth?.namespaceSource === sessionAuth.namespaceSource &&
    (requestAuth?.agentId ?? "") === (sessionAuth.agentId ?? "")
  );
}

function rejectSessionIdentityMismatch(res: Response): void {
  res.status(403).json({ error: "Request identity does not match session" });
}

export function getSessionCount(): number {
  return sessions.size;
}

export interface TransportHandlers {
  handlePost(req: Request, res: Response): Promise<void>;
  handleGet(req: Request, res: Response): Promise<void>;
  handleDelete(req: Request, res: Response): Promise<void>;
}

export function createTransportHandlers(
  serverFactory: () => McpServer,
): TransportHandlers {
  return {
    async handlePost(req: Request, res: Response): Promise<void> {
      const rawId = req.headers["mcp-session-id"];
      const sessionId =
        typeof rawId === "string" && UUID_RE.test(rawId) ? rawId : undefined;
      const reqAuth = (req as any).auth as AuthInfo | undefined;

      if (sessionId && sessions.has(sessionId)) {
        const entry = sessions.get(sessionId)!;

        // Verify the bearer token matches the session's original auth
        if (!sameSessionIdentity(reqAuth, entry.auth)) {
          rejectSessionIdentityMismatch(res);
          return;
        }

        resetTimer(sessionId);
        await runWithSession(sessionId, () =>
          entry.transport.handleRequest(req, res, req.body),
        );
        return;
      }

      if (!sessionId && isInitializeRequest(req.body)) {
        if (sessions.size + pendingInitializes >= maxSessions()) {
          rejectSessionCap(res);
          return;
        }

        if (!reqAuth) {
          res.status(401).json({ error: "Auth info missing" });
          return;
        }

        pendingInitializes++;
        let initialized = false;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id: string) => {
            const max = maxSessions();
            if (sessions.size >= max) {
              logger.warn("session_cap_race", {
                id,
                active: sessions.size,
                max,
                message:
                  "Admitted initialize completed while active sessions met or exceeded current cap",
              });
            }

            initialized = true;
            const timer = setTimeout(() => {
              expireSession(id, "inactivity");
            }, SESSION_TTL_MS);

            sessions.set(id, {
              transport,
              auth: reqAuth,
              timer,
              lastActivity: Date.now(),
              inFlight: 0,
            });
          },
        });

        // Inline cleanup — transport is already closing, so do NOT call close() again
        transport.onclose = () => {
          const id = transport.sessionId;
          if (id) {
            const e = sessions.get(id);
            if (e) {
              clearTimeout(e.timer);
              sessions.delete(id);
            }
          }
        };

        const server = serverFactory();
        try {
          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
        } catch (err) {
          // If handleRequest fails after session was registered, clean up
          const id = transport.sessionId;
          if (id) expireSession(id, "init-error");
          throw err;
        } finally {
          if (initialized || pendingInitializes > 0) {
            pendingInitializes--;
          }
        }
        return;
      }

      res.status(400).json({
        error: "Bad request: missing session or not an initialize request",
      });
    },

    async handleGet(req: Request, res: Response): Promise<void> {
      const rawId = req.headers["mcp-session-id"];
      const sessionId =
        typeof rawId === "string" && UUID_RE.test(rawId) ? rawId : undefined;

      if (sessionId && sessions.has(sessionId)) {
        const entry = sessions.get(sessionId)!;
        const reqAuth = (req as any).auth as AuthInfo | undefined;

        if (!sameSessionIdentity(reqAuth, entry.auth)) {
          rejectSessionIdentityMismatch(res);
          return;
        }

        resetTimer(sessionId);
        await runWithSession(sessionId, () =>
          entry.transport.handleRequest(req, res),
        );
        return;
      }

      res.status(400).json({ error: "Invalid or missing session" });
    },

    async handleDelete(req: Request, res: Response): Promise<void> {
      const rawId = req.headers["mcp-session-id"];
      const sessionId =
        typeof rawId === "string" && UUID_RE.test(rawId) ? rawId : undefined;

      if (sessionId && sessions.has(sessionId)) {
        const entry = sessions.get(sessionId)!;
        const reqAuth = (req as any).auth as AuthInfo | undefined;

        if (!sameSessionIdentity(reqAuth, entry.auth)) {
          rejectSessionIdentityMismatch(res);
          return;
        }

        await expireSession(sessionId, "client-delete");
        res.status(200).json({ status: "session closed" });
        return;
      }

      res.status(400).json({ error: "Invalid or missing session" });
    },
  };
}

/**
 * Test-only seam for the mid-flight expiry invariant (F1).
 *
 * Registering a real session requires a full MCP handshake and a tool that
 * blocks longer than the TTL, neither of which is deterministic in a unit test.
 * This seam registers a session backed by a stub transport, arms its idle timer
 * at a caller-supplied short interval, then drives one request through the SAME
 * `runWithSession` production path. It exists solely to prove that an in-flight
 * request is not closed when its idle timer fires -- do not use it in
 * production code. `close` records whether the stub transport was ever closed.
 */
export const __testing = {
  async runSlowRequestUnderShortTtl(opts: {
    sessionId: string;
    ttlMs: number;
    work: () => Promise<void>;
  }): Promise<{ closedDuringRequest: boolean; existedAfterRequest: boolean }> {
    let closed = false;
    let closedDuringRequest = false;
    const stub = {
      close: async () => {
        closed = true;
      },
    } as unknown as StreamableHTTPServerTransport;
    const timer = setTimeout(() => {
      expireSession(opts.sessionId, "inactivity");
    }, opts.ttlMs);
    sessions.set(opts.sessionId, {
      transport: stub,
      auth: { role: "admin", clientId: "test" },
      timer,
      lastActivity: Date.now(),
      inFlight: 0,
    });
    try {
      await runWithSession(opts.sessionId, async () => {
        await opts.work();
        // The idle timer has fired by now (ttlMs < work duration). The session
        // must still be present and its transport unclosed: expiry deferred
        // because the request was in flight.
        closedDuringRequest = closed;
      });
      const existedAfterRequest = sessions.has(opts.sessionId);
      return { closedDuringRequest, existedAfterRequest };
    } finally {
      clearTimeout(timer);
      const entry = sessions.get(opts.sessionId);
      if (entry) {
        clearTimeout(entry.timer);
        sessions.delete(opts.sessionId);
      }
    }
  },
};
