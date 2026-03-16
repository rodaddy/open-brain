import express from "express";
import cors from "cors";
import type { Request, Response, NextFunction } from "express";
import type pg from "pg";
import { createPool, checkPoolHealth } from "./db/pool.ts";
import { buildTokenMap, authMiddleware } from "./auth.ts";
import { createBrainServer } from "./server.ts";
import { createTransportHandlers } from "./transport.ts";
import { registerAllTools } from "./tools/index.ts";
import { generateEmbedding } from "./embedding.ts";
import { runMigrations } from "./db/migrate.ts";
import { logger } from "./logger.ts";
import { requestLogger } from "./middleware/request-logger.ts";
import type { AuthInfo, HealthStatus } from "./types.ts";

const LITELLM_URL = process.env.LITELLM_URL;

export function createApp(
  pool: pg.Pool,
  tokenMap: Map<string, AuthInfo>,
): express.Express {
  const app = express();

  app.use(
    cors({
      origin: process.env.ALLOWED_ORIGINS?.split(",") ?? [],
      credentials: false,
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(requestLogger);

  // Health endpoint -- no auth required
  app.get("/health", async (_req: Request, res: Response) => {
    const dbHealth = await checkPoolHealth(pool);

    let litellmConnected = false;
    if (LITELLM_URL) {
      try {
        const headers: Record<string, string> = {};
        const apiKey = process.env.LITELLM_API_KEY;
        if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
        const resp = await fetch(`${LITELLM_URL}/health/liveliness`, {
          headers,
          signal: AbortSignal.timeout(3000),
        });
        litellmConnected = resp.ok;
      } catch {
        litellmConnected = false;
      }
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

  // MCP server factory -- creates a fresh server per session to avoid
  // "Already connected to a transport" errors with concurrent clients
  const toolDeps = { pool, embedFn: generateEmbedding };
  const serverFactory = () => {
    const s = createBrainServer();
    registerAllTools(s, toolDeps);
    return s;
  };
  const handlers = createTransportHandlers(serverFactory);

  app.post("/mcp", auth, (req: Request, res: Response, _next: NextFunction) => {
    handlers.handlePost(req, res).catch((err) => {
      logger.error("MCP POST error", {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) res.status(500).json({ error: "Internal error" });
    });
  });
  app.get("/mcp", auth, (req: Request, res: Response, _next: NextFunction) => {
    handlers.handleGet(req, res).catch((err) => {
      logger.error("MCP GET error", {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) res.status(500).json({ error: "Internal error" });
    });
  });
  app.delete(
    "/mcp",
    auth,
    (req: Request, res: Response, _next: NextFunction) => {
      handlers.handleDelete(req, res).catch((err) => {
        logger.error("MCP DELETE error", {
          error: err instanceof Error ? err.message : String(err),
        });
        if (!res.headersSent) res.status(500).json({ error: "Internal error" });
      });
    },
  );

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

  if (tokenMap.size === 0) {
    logger.error("No auth tokens configured -- cannot start");
    process.exit(1);
  }

  const app = createApp(pool, tokenMap);
  const port = parseInt(process.env.PORT || "3100", 10);

  const server = app.listen(port, () => {
    logger.info("open-brain server started", { port });
  });

  const shutdown = async () => {
    logger.info("Shutting down...");
    server.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
