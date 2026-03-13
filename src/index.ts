import express from "express";
import cors from "cors";
import type { Request, Response } from "express";
import type pg from "pg";
import { createPool, checkPoolHealth } from "./db/pool.ts";
import { buildTokenMap, authMiddleware } from "./auth.ts";
import { createBrainServer } from "./server.ts";
import { createTransportHandlers } from "./transport.ts";
import { runMigrations } from "./db/migrate.ts";
import { logger } from "./logger.ts";
import type { AuthInfo, HealthStatus } from "./types.ts";

const LITELLM_URL = process.env.LITELLM_URL || "http://10.71.20.49:4000";

export function createApp(
  pool: pg.Pool,
  tokenMap: Map<string, AuthInfo>,
): express.Express {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Health endpoint -- no auth required
  app.get("/health", async (_req: Request, res: Response) => {
    const dbHealth = await checkPoolHealth(pool);

    let litellmConnected = false;
    try {
      const resp = await fetch(`${LITELLM_URL}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      litellmConnected = resp.ok;
    } catch {
      litellmConnected = false;
    }

    const status: HealthStatus = {
      status: dbHealth.connected && litellmConnected ? "healthy" : "degraded",
      database: dbHealth,
      litellm: { connected: litellmConnected },
      timestamp: new Date().toISOString(),
    };

    res.status(status.status === "healthy" ? 200 : 503).json(status);
  });

  // Auth middleware for MCP routes only
  const auth = authMiddleware(tokenMap);

  // MCP server and transport
  const mcpServer = createBrainServer();
  const handlers = createTransportHandlers(mcpServer);

  app.post("/mcp", auth, (req: Request, res: Response) => {
    handlers.handlePost(req, res);
  });
  app.get("/mcp", auth, (req: Request, res: Response) => {
    handlers.handleGet(req, res);
  });
  app.delete("/mcp", auth, (req: Request, res: Response) => {
    handlers.handleDelete(req, res);
  });

  return app;
}

if (import.meta.main) {
  const pool = createPool();

  try {
    await runMigrations(pool);
    logger.info("Migrations complete");
  } catch (err) {
    logger.error("Migration error (continuing startup)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const tokenMap = buildTokenMap(
    process.env as Record<string, string | undefined>,
  );
  const app = createApp(pool, tokenMap);
  const port = parseInt(process.env.PORT || "3100", 10);

  app.listen(port, () => {
    logger.info("open-brain server started", { port });
  });
}
