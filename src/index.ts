import express from "express";
import cors from "cors";
import type { Request, Response, NextFunction } from "express";
import type pg from "pg";
import { createPool, checkPoolHealth } from "./db/pool.ts";
import { buildTokenMap, authMiddleware } from "./auth.ts";
import { createBrainServer } from "./server.ts";
import { createTransportHandlers } from "./transport.ts";
import { registerAllTools } from "./tools/index.ts";
import { generateEmbedding, EMBEDDING_DIMENSIONS } from "./embedding.ts";
import { runMigrations } from "./db/migrate.ts";
import { logger } from "./logger.ts";
import { requestLogger } from "./middleware/request-logger.ts";
import { createRestRouter } from "./rest-api.ts";
import { createPromotionRouter } from "./rest-promotion.ts";
import {
  readNatsRuntimeBoundary,
  summarizeNatsUrlForLog,
} from "./nats-runtime.ts";
import {
  createNatsBridgeHealth,
  startNatsContextPackBridge,
  type NatsBridgeRuntime,
} from "./nats-bridge.ts";
import type { ToolDeps } from "./tools/index.ts";
import type { AuthInfo, HealthStatus } from "./types.ts";

const EMBEDDING_BASE_URL = process.env.EMBEDDING_BASE_URL;

function serverIps(): string[] {
  const configured = process.env.OPEN_BRAIN_SERVER_IP?.trim();
  if (configured) return [configured];

  return ["unknown"];
}

async function probeUrl(
  url: string,
  headers: Record<string, string>,
): Promise<boolean> {
  try {
    const resp = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(3000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export function createApp(
  pool: pg.Pool,
  tokenMap: Map<string, AuthInfo>,
  deps?: ToolDeps,
): express.Express {
  const app = express();
  const natsRuntimeBoundary =
    deps?.natsRuntimeBoundary ?? readNatsRuntimeBoundary(process.env);
  const natsBridgeHealth =
    deps?.natsBridgeHealth ?? createNatsBridgeHealth("not_runtime_available");
  const toolDeps: ToolDeps = {
    pool,
    embedFn: generateEmbedding,
    ...deps,
    natsRuntimeBoundary,
    natsBridgeHealth,
  };

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
    const embeddingHeaders: Record<string, string> = {};
    if (process.env.EMBEDDING_API_KEY) {
      embeddingHeaders["Authorization"] =
        `Bearer ${process.env.EMBEDDING_API_KEY}`;
    }

    const [dbHealth, embeddingConnected] = await Promise.all([
      checkPoolHealth(pool),
      // Any OpenAI-compatible provider serves GET {base}/models
      EMBEDDING_BASE_URL
        ? probeUrl(
            `${EMBEDDING_BASE_URL.replace(/\/$/, "")}/models`,
            embeddingHeaders,
          )
        : Promise.resolve(false),
    ]);

    const ips = serverIps();
    const natsAvailability =
      toolDeps.natsBridgeHealth?.availability ??
      natsRuntimeBoundary.nats.availability;
    const natsDegraded =
      natsRuntimeBoundary.requested_transport === "nats" &&
      natsAvailability !== "available";
    const status: HealthStatus = {
      status: dbHealth.connected && !natsDegraded ? "healthy" : "degraded",
      server_ip: ips[0] ?? "unknown",
      server_ips: ips,
      database: dbHealth,
      embedding: {
        configured: Boolean(EMBEDDING_BASE_URL),
        connected: embeddingConnected,
      },
      nats: {
        requested_transport: natsRuntimeBoundary.requested_transport,
        availability: natsAvailability,
        context_pack_subject: natsRuntimeBoundary.nats.context_pack_subject,
        fallback_http: natsRuntimeBoundary.nats.fallback_http,
        consecutive_failures:
          toolDeps.natsBridgeHealth?.consecutiveFailures ?? 0,
        last_error: toolDeps.natsBridgeHealth?.lastError ?? null,
      },
      timestamp: new Date().toISOString(),
    };

    res.status(status.status === "healthy" ? 200 : 503).json(status);
  });

  // Auth middleware
  const auth = authMiddleware(tokenMap);

  // REST API -- no MCP handshake required
  app.use("/api/v1", auth, createRestRouter(toolDeps));
  app.use("/api/v1", auth, createPromotionRouter(toolDeps));
  app.use(
    "/api/v1",
    (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      const pgCode =
        typeof err === "object" && err !== null && "code" in err
          ? String((err as { code?: unknown }).code)
          : undefined;
      const statusCode =
        typeof err === "object" && err !== null && "statusCode" in err
          ? Number((err as { statusCode?: unknown }).statusCode)
          : undefined;
      const status = statusCode && statusCode >= 400 ? statusCode : pgCode === "23505" ? 409 : 500;
      logger.error("REST API error", {
        error: err instanceof Error ? err.message : String(err),
        code: pgCode,
      });
      res.status(status).json({
        error: status === 500 ? "Internal error" : err instanceof Error ? err.message : "Request failed",
      });
    },
  );

  // MCP server factory -- creates a fresh server per session to avoid
  // "Already connected to a transport" errors with concurrent clients
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
  // The vector columns are halfvec(768) in the schema; a mismatched
  // EMBEDDING_DIMENSIONS makes every embedding INSERT fail at runtime.
  if (EMBEDDING_DIMENSIONS !== 768) {
    logger.warn("EMBEDDING_DIMENSIONS does not match the halfvec(768) schema", {
      configured: EMBEDDING_DIMENSIONS,
      schema: 768,
      consequence: "embedding writes will fail until columns are migrated",
    });
  }

  const pool = createPool();

  if (process.env.OPEN_BRAIN_RUN_MIGRATIONS !== "0") {
    try {
      await runMigrations(pool);
      logger.info("Migrations complete");
    } catch (err) {
      logger.error("migration_failed", {
        error: String(err),
      });
      process.exit(1);
    }
  } else {
    logger.info("Skipping migrations for worker", {
      OPEN_BRAIN_RUN_MIGRATIONS: process.env.OPEN_BRAIN_RUN_MIGRATIONS,
    });
  }

  const tokenMap = buildTokenMap(
    process.env as Record<string, string | undefined>,
  );

  const natsRuntimeBoundary = readNatsRuntimeBoundary(process.env);
  const natsBridgeHealth = createNatsBridgeHealth(
    natsRuntimeBoundary.nats.availability,
  );
  const toolDeps: ToolDeps = {
    pool,
    embedFn: generateEmbedding,
    natsRuntimeBoundary,
    natsBridgeHealth,
  };
  let natsBridge: NatsBridgeRuntime | null = null;
  if (
    natsRuntimeBoundary.requested_transport === "nats" &&
    natsRuntimeBoundary.nats.availability === "available"
  ) {
    try {
      natsBridge = await startNatsContextPackBridge({
        boundary: natsRuntimeBoundary,
        tokenMap,
        deps: toolDeps,
        health: natsBridgeHealth,
      });
      logger.info("NATS context-pack bridge started", {
        subject: natsBridge?.subject,
        availability: natsBridge?.availability,
        nats_url: summarizeNatsUrlForLog(natsRuntimeBoundary.nats.url),
      });
    } catch (err) {
      natsBridgeHealth.availability = "not_runtime_available";
      natsBridgeHealth.consecutiveFailures += 1;
      natsBridgeHealth.lastError =
        err instanceof Error ? err.message : String(err);
      logger.error("NATS context-pack bridge failed to start", {
        error: err instanceof Error ? err.message : String(err),
        nats_url: summarizeNatsUrlForLog(natsRuntimeBoundary.nats.url),
      });
      process.exit(1);
    }
  } else if (natsRuntimeBoundary.requested_transport === "nats") {
    logger.warn("OPENBRAIN_TRANSPORT=nats requested but bridge is not available", {
      availability: natsRuntimeBoundary.nats.availability,
      fallback_transport: natsRuntimeBoundary.fallback_transport,
      fallback_http: natsRuntimeBoundary.nats.fallback_http,
      context_pack_subject: natsRuntimeBoundary.nats.context_pack_subject,
      nats_url: summarizeNatsUrlForLog(natsRuntimeBoundary.nats.url),
    });
  }

  if (tokenMap.size === 0) {
    logger.error("No auth tokens configured -- cannot start");
    process.exit(1);
  }

  const app = createApp(pool, tokenMap, toolDeps);
  const port = parseInt(process.env.PORT || "3100", 10);

  const server = app.listen(port, () => {
    logger.info("open-brain server started", { port });
  });

  const shutdown = async () => {
    logger.info("Shutting down...");
    server.close();
    if (natsBridge) {
      try {
        await Promise.race([
          natsBridge.close(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("NATS bridge close timed out")), 5000),
          ),
        ]);
      } catch (err) {
        logger.error("NATS context-pack bridge failed to close during shutdown", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    try {
      await pool.end();
    } catch (err) {
      logger.error("Database pool failed to close during shutdown", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
