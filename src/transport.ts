import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Request, Response } from "express";
import type { AuthInfo } from "./types.ts";
import { logger } from "./logger.ts";

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const CLOSE_TIMEOUT_MS = 5_000; // 5 seconds max for transport.close()
const MAX_SESSIONS = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  auth: AuthInfo;
  timer: ReturnType<typeof setTimeout>;
  lastActivity: number;
}

const sessions: Map<string, SessionEntry> = new Map();

async function expireSession(
  sessionId: string,
  reason: string,
): Promise<void> {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  clearTimeout(entry.timer);
  sessions.delete(sessionId); // delete BEFORE close — can't leak
  try {
    await Promise.race([
      entry.transport.close(),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("close timed out")), CLOSE_TIMEOUT_MS),
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

// Safety-net sweeper: force-clean sessions that survived past 2x TTL
// unref() so the timer doesn't prevent clean process exit
const sweepTimer = setInterval(() => {
  const now = Date.now();
  let swept = 0;
  for (const [id, entry] of sessions) {
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

export function getSessionAuth(sessionId: string): AuthInfo | undefined {
  return sessions.get(sessionId)?.auth;
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
        if (
          reqAuth?.clientId !== entry.auth.clientId ||
          reqAuth?.role !== entry.auth.role
        ) {
          res
            .status(403)
            .json({ error: "Token does not match session identity" });
          return;
        }

        resetTimer(sessionId);
        await entry.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!sessionId && isInitializeRequest(req.body)) {
        if (sessions.size >= MAX_SESSIONS) {
          res.status(503).json({ error: "Too many active sessions" });
          return;
        }

        if (!reqAuth) {
          res.status(401).json({ error: "Auth info missing" });
          return;
        }

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id: string) => {
            // Re-check cap atomically at registration time
            if (sessions.size >= MAX_SESSIONS) {
              logger.warn("Session cap exceeded at registration", { id });
              void transport.close().catch(() => {}); // clean up untracked transport
              return;
            }

            const timer = setTimeout(() => {
              expireSession(id, "inactivity");
            }, SESSION_TTL_MS);

            sessions.set(id, {
              transport,
              auth: reqAuth,
              timer,
              lastActivity: Date.now(),
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
        await server.connect(transport);
        try {
          await transport.handleRequest(req, res, req.body);
        } catch (err) {
          // If handleRequest fails after session was registered, clean up
          const id = transport.sessionId;
          if (id) expireSession(id, "init-error");
          throw err;
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

        if (
          reqAuth?.clientId !== entry.auth.clientId ||
          reqAuth?.role !== entry.auth.role
        ) {
          res
            .status(403)
            .json({ error: "Token does not match session identity" });
          return;
        }

        resetTimer(sessionId);
        await entry.transport.handleRequest(req, res);
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

        if (
          reqAuth?.clientId !== entry.auth.clientId ||
          reqAuth?.role !== entry.auth.role
        ) {
          res
            .status(403)
            .json({ error: "Token does not match session identity" });
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
