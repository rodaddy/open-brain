#!/usr/bin/env bun

import type pg from "pg";
import { buildTokenMap } from "../src/auth.ts";
import { createPool } from "../src/db/pool.ts";
import {
  createEmbedWatermarkObserver,
  EMBED_WATERMARK_CACHE_TTL_MS,
} from "../src/embed-watermark-observer.ts";
import { logger } from "../src/logger.ts";
import {
  natsWorkerLogSummary,
  readNatsWorkerBoundary,
  startNatsWorker,
  type NatsWorkerRuntime,
} from "../src/nats-worker.ts";
import type { AuthInfo } from "../src/types.ts";
import { createTracingRuntime } from "../server/observability/langfuse-tracing.ts";

type LoggerLike = Pick<typeof logger, "error" | "info">;
type HealthServer = { stop(force?: boolean): void };
type ServeFn = typeof Bun.serve;
type TracingRuntime = ReturnType<typeof createTracingRuntime>;

/**
 * The embed lane's liveness, as the worker's `/health` on 3110 reports it.
 *
 * WHY THIS IS A HEALTH INPUT AT ALL (#724 item 3). The maintenance producer
 * ticked for three days with no consumer draining the embed queue: raw rows
 * kept arriving, embedded rows stopped, and nothing anywhere COMPARED the two.
 * Every liveness surface stayed green while the corpus quietly stopped being
 * searchable. This is the #625 producer argument and the #647 capture argument
 * applied to the third background lane — the pattern those two established is
 * matched here deliberately (`server/transport/health.ts:14-33` and `:35-79`):
 * a snake_case named block, a boolean `stale` that is THE verdict, the raw
 * counters beside it, an explicit `*_threshold_*` naming the bound the verdict
 * used, and a content-free `reason`.
 *
 * WHY ON 3110 AND NOT 3100. `docs/core01-nats-worker-runbook.md` ("What
 * `/health` on 3100 does and does NOT show") is explicit that the HTTP service
 * derives its blocks from its OWN process environment
 * (`parseNatsConfig(process.env)` in `server/config/nats.ts`) and deliberately
 * never observes the separate worker process — and forbids "fixing" 3100 by
 * putting it back in the worker's business.
 *
 * `*_age_seconds` is the repo's spelling for an age
 * (`src/operator-doctor.ts:111` `oldest_undistilled_age_seconds`); `quiet_ms`
 * on the producer block is a duration, not an age, and is not the precedent.
 */
export interface EmbedWatermarkHealth {
  /**
   * True once the embed lane is behind past its threshold WITH fresh raw rows
   * present. Both halves are required — see `raw_rows_recent`.
   */
  readonly stale: boolean;
  /** Age of the newest raw row. */
  readonly newest_raw_age_seconds: number;
  /** Age of the newest embedded row. */
  readonly newest_embedded_age_seconds: number;
  /** How far the embedded watermark trails the raw one. */
  readonly lag_seconds: number;
  /** The bound the `stale` verdict was taken against. */
  readonly lag_threshold_seconds: number;
  /**
   * Raw rows seen recently. `stale` REQUIRES this to be positive: a quiet week
   * produces an old embedded row too, and alarming on an idle corpus is how a
   * check stops being read (`server/capture/liveness-observer.ts`
   * MIN_SESSIONS_FOR_SILENCE carries the same argument for capture).
   */
  readonly raw_rows_recent: number;
  /** Content-free sentence naming which condition produced the verdict. */
  readonly reason: string;
}

/**
 * Default bound for the embed watermark lag verdict, in seconds.
 *
 * One hour: the outage this block exists to catch ran three days, and the
 * stated goal was catching it "in about an hour instead of three days".
 * Overridable via `OPENBRAIN_EMBED_WATERMARK_LAG_THRESHOLD_SECONDS`.
 */
export const DEFAULT_EMBED_WATERMARK_LAG_THRESHOLD_SECONDS = 3600;

/**
 * Resolve the embed watermark lag threshold from the environment.
 *
 * NOTHING IS ADJUSTED SILENTLY (AGENTS.md Coding Standards, 2026-08-08): an
 * unset key announces the default it fell back to, and an unusable value
 * announces the original alongside the substitute. The caller logs what this
 * returns; the reader can map what was configured to what is in force.
 */
export function readEmbedWatermarkThresholdSeconds(env: NodeJS.ProcessEnv): {
  thresholdSeconds: number;
  source: "env" | "default" | "invalid_env_default";
  configured: string | null;
} {
  const configured =
    env.OPENBRAIN_EMBED_WATERMARK_LAG_THRESHOLD_SECONDS ?? null;
  if (configured === null || configured.trim() === "") {
    return {
      thresholdSeconds: DEFAULT_EMBED_WATERMARK_LAG_THRESHOLD_SECONDS,
      source: "default",
      configured: null,
    };
  }
  const parsed = Number.parseInt(configured, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return {
      thresholdSeconds: DEFAULT_EMBED_WATERMARK_LAG_THRESHOLD_SECONDS,
      source: "invalid_env_default",
      configured,
    };
  }
  return { thresholdSeconds: parsed, source: "env", configured };
}

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
  createTracing?: typeof createTracingRuntime;
  serve?: ServeFn;
  /**
   * The embed lane's liveness reading, injected the same way `natsHealth`,
   * `producerHealth`, and `captureHealth` are on the HTTP side
   * (`server/transport/health.ts:118-138`): the live component knows its own
   * counters and the health composer must not guess them.
   *
   * ABSENCE IS NOT STALENESS. Omitted composes no `embed_watermark` block and
   * cannot degrade the status — the ordinary case for a worker that does not
   * own the embed lane, exactly as `maintenance_producer` and `capture` are
   * optional on the HTTP payload (`server/transport/health.ts:93-105`).
   * Absent means "not my job"; `stale: true` means "my job and I am not doing
   * it".
   */
  embedWatermarkHealth?: () => EmbedWatermarkHealth | undefined;
}

// Redaction: classify by an instanceof-allowlist returning STATIC strings,
// matching safeErrorType in nats-bridge.ts. err.name is mutable/attacker-
// influenced and err.message can embed a NATS url with credentials, so neither
// is ever surfaced. (#283 low finding.)
export function safeWorkerError(err: unknown): { error_type: string } {
  if (err instanceof SyntaxError) return { error_type: "SyntaxError" };
  if (err instanceof AggregateError) return { error_type: "AggregateError" };
  if (err instanceof TypeError) return { error_type: "TypeError" };
  if (err instanceof RangeError) return { error_type: "RangeError" };
  if (err instanceof Error) return { error_type: "Error" };
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
  embedWatermarkHealth?: () => EmbedWatermarkHealth | undefined;
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
      const bridgeAvailable = input.runtime.health.availability === "available";
      // #724 item 3: a stalled embed lane degrades this worker, on the same
      // argument as the producer (#625) and capture (#647) blocks on the HTTP
      // payload. A healthy BRIDGE must not be able to hold this endpoint green
      // while the corpus stops being searchable — that combination is exactly
      // the shape of the three-day outage. A worker that composes no observer
      // supplies nothing here and is unaffected: absence is not staleness.
      const embedWatermark = input.embedWatermarkHealth?.();
      const embedDegraded = embedWatermark?.stale === true;
      const healthy = bridgeAvailable && !embedDegraded;
      return Response.json(
        {
          status: healthy ? "healthy" : "degraded",
          nats: {
            availability: input.runtime.health.availability,
            context_pack_subject:
              input.runtime.boundary.nats.context_pack_subject,
            consecutive_failures: input.runtime.health.consecutiveFailures,
            last_error: input.runtime.health.lastError ? "redacted" : null,
          },
          ...(embedWatermark ? { embed_watermark: embedWatermark } : {}),
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
    log.error(
      "Open Brain NATS worker bridge close failed",
      safeWorkerError(err),
    );
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

async function closeTracing(
  tracing: TracingRuntime | undefined,
  log: LoggerLike,
): Promise<void> {
  if (!tracing) return;
  try {
    await tracing.shutdown();
  } catch (err) {
    log.error(
      "Open Brain NATS worker tracing shutdown failed",
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
  const createTracing = options.createTracing ?? createTracingRuntime;
  const serve = options.serve ?? Bun.serve;
  const env = options.env;

  let pool: pg.Pool | undefined;
  let tracing: TracingRuntime | undefined;
  let runtime: NatsWorkerRuntime | undefined;
  let healthServer: HealthServer | null = null;
  const shutdownTimeoutMs = shutdownTimeoutMsFromEnv(env);

  try {
    const tokenMap = buildTokens(env as Record<string, string | undefined>);
    if (tokenMap.size === 0) {
      throw new Error("No auth tokens configured");
    }

    pool = createDbPool();
    tracing = createTracing();
    // NOTHING IS ADJUSTED SILENTLY: read the threshold before composing the
    // observer, so the bound the observer takes its verdict against is the
    // same one announced in the startup summary below.
    const embedThreshold = readEmbedWatermarkThresholdSeconds(env);
    // #724 item 3: the DEPLOYED worker must construct its own observer. The
    // option stays an override (PR #728's fixture test injects one), but its
    // ABSENCE no longer means "no observer" — that is what left the surface in
    // the tree and out of the serving process. The live entrypoint passes only
    // `{ env: process.env }` and needs no change: it lands here.
    let embedWatermarkHealth = options.embedWatermarkHealth;
    if (!embedWatermarkHealth) {
      const observer = createEmbedWatermarkObserver({
        pool,
        lagThresholdSeconds: embedThreshold.thresholdSeconds,
        log,
      });
      // Prime it once so the first probe answers with numbers rather than the
      // "not measured yet" absence. A failure here composes the read-failure
      // reading inside the observer and never throws into startup.
      await observer.refresh();
      embedWatermarkHealth = observer.read;
    }
    runtime = await startWorker({
      env,
      pool,
      tokenMap: tokenMap as Map<string, AuthInfo>,
      ...(tracing.background ? { tracing: tracing.background } : {}),
    });
    healthServer = startHealthServer({
      env,
      runtime,
      serve,
      embedWatermarkHealth,
    });
    // NOTHING IS ADJUSTED SILENTLY: the threshold in force is announced at
    // startup along with WHERE it came from, so an unset env key is visible as
    // a default rather than looking like a configured value; the cache TTL is
    // announced beside it because a cached reading is what /health actually
    // serves, and a reader cannot interpret the block without knowing how old
    // it may be.
    log.info("Open Brain NATS worker started", {
      ...natsWorkerLogSummary(runtime.boundary),
      availability: runtime.health.availability,
      health_port: healthPortFromEnv(env),
      embed_watermark_observed: Boolean(embedWatermarkHealth),
      embed_watermark_observer_source: options.embedWatermarkHealth
        ? "injected"
        : "default_pool_observer",
      embed_watermark_cache_ttl_seconds: EMBED_WATERMARK_CACHE_TTL_MS / 1000,
      embed_watermark_lag_threshold_seconds: embedThreshold.thresholdSeconds,
      embed_watermark_lag_threshold_source: embedThreshold.source,
      ...(embedThreshold.source === "invalid_env_default"
        ? {
            embed_watermark_lag_threshold_configured: embedThreshold.configured,
          }
        : {}),
    });
    return {
      runtime,
      pool,
      healthServer,
      shutdown: async () => {
        log.info("Shutting down Open Brain NATS worker");
        closeHealthServer(healthServer, log);
        await closeRuntime(runtime, log, shutdownTimeoutMs);
        await closeTracing(tracing, log);
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
    await closeTracing(tracing, log);
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
