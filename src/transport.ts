import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Request, Response } from "express";

const transports: Record<string, StreamableHTTPServerTransport> = {};

export interface TransportHandlers {
  handlePost(req: Request, res: Response): Promise<void>;
  handleGet(req: Request, res: Response): Promise<void>;
  handleDelete(req: Request, res: Response): Promise<void>;
}

export function createTransportHandlers(server: McpServer): TransportHandlers {
  return {
    async handlePost(req: Request, res: Response): Promise<void> {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && transports[sessionId]) {
        const transport = transports[sessionId]!;
        await transport.handleRequest(req, res, req.body);
        return;
      }

      if (!sessionId && isInitializeRequest(req.body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id: string) => {
            transports[id] = transport;
          },
        });

        transport.onclose = () => {
          const id = transport.sessionId;
          if (id) {
            delete transports[id];
          }
        };

        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      res
        .status(400)
        .json({
          error: "Bad request: missing session or not an initialize request",
        });
    },

    async handleGet(req: Request, res: Response): Promise<void> {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && transports[sessionId]) {
        const transport = transports[sessionId]!;
        await transport.handleRequest(req, res);
        return;
      }

      res.status(400).json({ error: "Invalid or missing session" });
    },

    async handleDelete(req: Request, res: Response): Promise<void> {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && transports[sessionId]) {
        const transport = transports[sessionId]!;
        await transport.close();
        delete transports[sessionId];
        res.status(200).json({ status: "session closed" });
        return;
      }

      res.status(400).json({ error: "Invalid or missing session" });
    },
  };
}
