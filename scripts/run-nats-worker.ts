#!/usr/bin/env bun

import { buildTokenMap } from "../src/auth.ts";
import { createPool } from "../src/db/pool.ts";
import { logger } from "../src/logger.ts";
import {
  natsWorkerLogSummary,
  startNatsWorker,
  type NatsWorkerRuntime,
} from "../src/nats-worker.ts";

const tokenMap = buildTokenMap(process.env as Record<string, string | undefined>);
if (tokenMap.size === 0) {
  logger.error("No auth tokens configured -- cannot start NATS worker");
  process.exit(1);
}

const pool = createPool();
let runtime: NatsWorkerRuntime;
try {
  runtime = await startNatsWorker({
    env: process.env,
    pool,
    tokenMap,
  });
  logger.info("Open Brain NATS worker started", {
    ...natsWorkerLogSummary(runtime.boundary),
    availability: runtime.health.availability,
  });
} catch (err) {
  logger.error("Open Brain NATS worker failed to start", {
    error: err instanceof Error ? err.message : String(err),
  });
  await pool.end().catch(() => undefined);
  process.exit(1);
}

const healthPort = Number.parseInt(
  process.env.OPEN_BRAIN_NATS_WORKER_HEALTH_PORT ?? "3110",
  10,
);
const healthServer =
  Number.isFinite(healthPort) && healthPort > 0
    ? Bun.serve({
        port: healthPort,
        fetch(request) {
          const url = new URL(request.url);
          if (url.pathname !== "/health") {
            return Response.json({ error: "Not found" }, { status: 404 });
          }
          const healthy = runtime.health.availability === "available";
          return Response.json(
            {
              status: healthy ? "healthy" : "degraded",
              nats: {
                availability: runtime.health.availability,
                context_pack_subject:
                  runtime.boundary.nats.context_pack_subject,
                consecutive_failures: runtime.health.consecutiveFailures,
                last_error: runtime.health.lastError ? "redacted" : null,
              },
              timestamp: new Date().toISOString(),
            },
            { status: healthy ? 200 : 503 },
          );
        },
      })
    : null;

if (healthServer) {
  logger.info("Open Brain NATS worker health server started", {
    port: healthPort,
  });
}

async function shutdown() {
  logger.info("Shutting down Open Brain NATS worker");
  healthServer?.stop(true);
  try {
    await runtime.close();
  } catch (err) {
    logger.error("Open Brain NATS worker bridge close failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    await pool.end();
  } catch (err) {
    logger.error("Open Brain NATS worker pool close failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});

await new Promise(() => undefined);
