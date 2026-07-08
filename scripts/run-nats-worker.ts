#!/usr/bin/env bun

import type pg from "pg";
import { buildTokenMap } from "../src/auth.ts";
import { createPool } from "../src/db/pool.ts";
import { logger } from "../src/logger.ts";
import {
  natsWorkerLogSummary,
  readNatsWorkerBoundary,
  startNatsWorker,
  type NatsWorkerRuntime,
} from "../src/nats-worker.ts";
import type { AuthInfo } from "../src/types.ts";

type LoggerLike = Pick<typeof logger, "error" | "info">;
type HealthServer = { stop(force?: boolean): void };
type ServeFn = typeof Bun.serve;

export interface NatsWorkerProcess {
  runtime: NatsWorkerRuntime;
  pool: pg.Pool;
  healthServer: HealthServer | null;
  shutdown(): Promise<void>;
}

export interface StartNatsWorkerProcessOptions {
  env: NodeJS.ProcessEnv;
  log?: LoggerLike;
  buildTokens?: typeof buildTokenMap;
  createDbPool?: typeof createPool;
  startWorker?: typeof startNatsWorker;
  serve?: ServeFn;
}

export function safeWorkerError(err: unknown): { error_type: string } {
  if (err instanceof Error) return { error_type: err.name || "Error" };
  return { error_type: typeof err };
}

function healthPortFromEnv(env: NodeJS.ProcessEnv): number | null {
  const healthPort = Number.parseInt(
    env.OPEN_BRAIN_NATS_WORKER_HEALTH_PORT ?? "3110",
    10,
  );
  return Number.isFinite(healthPort) && healthPort > 0 ? healthPort : null;
}

function shutdownTimeoutMsFromEnv(env: NodeJS.ProcessEnv): number {
  const timeoutMs = Number.parseInt(
    env.OPEN_BRAIN_NATS_WORKER_SHUTDOWN_TIMEOUT_MS ?? "5000",
    10,
  );
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function startHealthServer(input: {
  env: NodeJS.ProcessEnv;
  runtime: NatsWorkerRuntime;
  serve: ServeFn;
}): HealthServer | null {
  const healthPort = healthPortFromEnv(input.env);
  if (!healthPort) return null;

  return input.serve({
    port: healthPort,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/health") {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      const healthy = input.runtime.health.availability === "available";
      return Response.json(
        {
          status: healthy ? "healthy" : "degraded",
          nats: {
            availability: input.runtime.health.availability,
            context_pack_subject: input.runtime.boundary.nats.context_pack_subject,
            consecutive_failures: input.runtime.health.consecutiveFailures,
            last_error: input.runtime.health.lastError ? "redacted" : null,
          },
          timestamp: new Date().toISOString(),
        },
        { status: healthy ? 200 : 503 },
      );
    },
  });
}

async function closeRuntime(
  runtime: NatsWorkerRuntime | undefined,
  log: LoggerLike,
  timeoutMs: number,
): Promise<void> {
  if (!runtime) return;
  try {
    await withTimeout(
      runtime.close(),
      timeoutMs,
      "Open Brain NATS worker bridge close timed out",
    );
  } catch (err) {
    log.error("Open Brain NATS worker bridge close failed", safeWorkerError(err));
  }
}

function closeHealthServer(
  healthServer: HealthServer | null,
  log: LoggerLike,
): void {
  if (!healthServer) return;
  try {
    healthServer.stop(true);
  } catch (err) {
    log.error(
      "Open Brain NATS worker health server close failed",
      safeWorkerError(err),
    );
  }
}

async function closePool(
  pool: pg.Pool | undefined,
  log: LoggerLike,
): Promise<void> {
  if (!pool) return;
  try {
    await pool.end();
  } catch (err) {
    log.error("Open Brain NATS worker pool close failed", safeWorkerError(err));
  }
}

export async function startNatsWorkerProcess(
  options: StartNatsWorkerProcessOptions,
): Promise<NatsWorkerProcess> {
  const log = options.log ?? logger;
  const buildTokens = options.buildTokens ?? buildTokenMap;
  const createDbPool = options.createDbPool ?? createPool;
  const startWorker = options.startWorker ?? startNatsWorker;
  const serve = options.serve ?? Bun.serve;
  const env = options.env;

  let pool: pg.Pool | undefined;
  let runtime: NatsWorkerRuntime | undefined;
  let healthServer: HealthServer | null = null;
  const shutdownTimeoutMs = shutdownTimeoutMsFromEnv(env);

  try {
    const tokenMap = buildTokens(env as Record<string, string | undefined>);
    if (tokenMap.size === 0) {
      throw new Error("No auth tokens configured");
    }

    pool = createDbPool();
    runtime = await startWorker({
      env,
      pool,
      tokenMap: tokenMap as Map<string, AuthInfo>,
    });
    healthServer = startHealthServer({ env, runtime, serve });
    log.info("Open Brain NATS worker started", {
      ...natsWorkerLogSummary(runtime.boundary),
      availability: runtime.health.availability,
      health_port: healthPortFromEnv(env),
    });
    return {
      runtime,
      pool,
      healthServer,
      shutdown: async () => {
        log.info("Shutting down Open Brain NATS worker");
        closeHealthServer(healthServer, log);
        await closeRuntime(runtime, log, shutdownTimeoutMs);
        await closePool(pool, log);
      },
    };
  } catch (err) {
    log.error("Open Brain NATS worker failed to start", {
      ...safeWorkerError(err),
      ...natsWorkerLogSummary(readNatsWorkerBoundary(env)),
    });
    closeHealthServer(healthServer, log);
    await closeRuntime(runtime, log, shutdownTimeoutMs);
    await closePool(pool, log);
    throw err;
  }
}

if (import.meta.main) {
  try {
    const processRuntime = await startNatsWorkerProcess({ env: process.env });
    const shutdown = async () => {
      await processRuntime.shutdown();
      process.exit(0);
    };
    process.on("SIGTERM", () => {
      void shutdown();
    });
    process.on("SIGINT", () => {
      void shutdown();
    });

    await new Promise(() => undefined);
  } catch {
    process.exit(1);
  }
}
