import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Request, Response } from "express";
import type { AuthInfo } from "./types.ts";
import { logger } from "./logger.ts";

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_SESSIONS = 100;

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  auth: AuthInfo;
  timer: ReturnType<typeof setTimeout>;
}

const sessions: Map<string, SessionEntry> = new Map();

function resetTimer(sessionId: string): void {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    logger.info("Session expired due to inactivity", { sessionId });
    entry.transport.close();
    sessions.delete(sessionId);
  }, SESSION_TTL_MS);
}

function removeSession(sessionId: string): void {
  const entry = sessions.get(sessionId);
  if (entry) {
    clearTimeout(entry.timer);
    sessions.delete(sessionId);
  }
}

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
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
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
            const timer = setTimeout(() => {
              logger.info("Session expired due to inactivity", {
                sessionId: id,
              });
              transport.close();
              sessions.delete(id);
            }, SESSION_TTL_MS);

            sessions.set(id, { transport, auth: reqAuth, timer });
          },
        });

        transport.onclose = () => {
          const id = transport.sessionId;
          if (id) {
            removeSession(id);
          }
        };

        const server = serverFactory();
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      res.status(400).json({
        error: "Bad request: missing session or not an initialize request",
      });
    },

    async handleGet(req: Request, res: Response): Promise<void> {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

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
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

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

        await entry.transport.close();
        removeSession(sessionId);
        res.status(200).json({ status: "session closed" });
        return;
      }

      res.status(400).json({ error: "Invalid or missing session" });
    },
  };
}
