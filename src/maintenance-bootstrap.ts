/**
 * Production bootstrap for the server-owned maintenance queue (#343 substrate,
 * #345 handler). This is the piece that was missing: `buildEmbeddingRepairHandlers`
 * and `MaintenanceQueueRunner` both existed, but nothing in the running server
 * constructed the durable queue, registered the handler, or started polling — so
 * an enqueued `embedding.repair` job could never actually run in production.
 *
 * `startMaintenanceQueue` constructs the durable `MaintenanceQueue` over the real
 * pool, registers the embedding-repair handler with the real embed provider and a
 * content-free logger, and starts the runner's bounded automatic polling. The
 * returned handle exposes `stop()`, which the server's shutdown path awaits before
 * `pool.end()` so in-flight jobs drain (their leases are honored) instead of being
 * stranded mid-run.
 *
 * #343 invariants preserved verbatim — this only wires them, it changes none:
 *  - Bounded concurrency: the runner clamps to [1, MAX_CONCURRENCY].
 *  - No overlapping ticks: `runOnce` is single-flight; `start()` reuses it.
 *  - Persisted retries/backoff: owned by `MaintenanceQueue.fail`, durable-row-derived.
 *  - Content-free logs: the handler and runner log counts/table/kind only.
 *  - No Dream/MCP mutation path: this bootstrap touches only `maintenance_jobs`
 *    and the embedding columns via the repair primitive; it never enqueues jobs.
 *    Enqueue stays an explicit, auth-scoped operator/caller boundary (a job
 *    payload MUST carry an explicit namespace scope — the bootstrap invents none).
 */
import type pg from "pg";
import { generateEmbeddingWithMetadata } from "./embedding.ts";
import type { EmbedWithMetaFn } from "./embedding-repair.ts";
import {
  MaintenanceQueue,
  MaintenanceQueueRunner,
  type MaintenanceQueueLogger,
} from "./maintenance-queue.ts";
import { buildEmbeddingRepairHandlers } from "./embedding-repair-handler.ts";

/**
 * Runtime handle for the started maintenance queue. `stop()` halts polling and
 * drains in-flight jobs; it is idempotent and safe to call once from shutdown.
 */
export interface MaintenanceRuntime {
  readonly queue: MaintenanceQueue;
  readonly runner: MaintenanceQueueRunner;
  stop(): Promise<void>;
}

export interface StartMaintenanceQueueOptions {
  pool: pg.Pool;
  /** Content-free logger; the app logger satisfies this shape. */
  logger: MaintenanceQueueLogger;
  /** Injectable embed fn for tests; defaults to the configured provider. */
  embedFn?: EmbedWithMetaFn;
  /** Poll cadence override; else env, else the runner default. */
  pollIntervalMs?: number;
  /** Concurrency override; else env, else the runner default. */
  concurrency?: number;
  /** Lease duration override; else env, else the runner default. */
  leaseMs?: number;
  /** Start automatic polling immediately (default true). Set false to wire without polling. */
  autoStart?: boolean;
}

/**
 * Parse a positive integer env override, falling back when unset or invalid.
 * Non-positive / non-numeric values fall back rather than surprising the runner;
 * the runner still clamps whatever it receives to its own safe bounds.
 */
function envPositiveInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Whether the maintenance queue should run in this process. Enabled by default;
 * `OPEN_BRAIN_MAINTENANCE_ENABLED=0` (or `false`) turns it off so a worker that
 * must not poll (e.g. a read replica) can opt out without code changes.
 */
export function maintenanceQueueEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.OPEN_BRAIN_MAINTENANCE_ENABLED?.trim().toLowerCase();
  return raw !== "0" && raw !== "false";
}

/**
 * Construct the durable queue + runner, register the embedding-repair handler,
 * and (by default) start bounded automatic polling. Caller owns `stop()` in its
 * shutdown lifecycle.
 *
 * Env-configurable safe defaults (each clamped again by the runner):
 *  - OPEN_BRAIN_MAINTENANCE_POLL_MS         poll cadence (runner default 5000)
 *  - OPEN_BRAIN_MAINTENANCE_CONCURRENCY     max concurrent jobs (runner default 2)
 *  - OPEN_BRAIN_MAINTENANCE_LEASE_MS        job lease window (runner default 30000)
 */
export function startMaintenanceQueue(
  options: StartMaintenanceQueueOptions,
): MaintenanceRuntime {
  const queue = new MaintenanceQueue(options.pool);
  const handlers = buildEmbeddingRepairHandlers({
    db: options.pool,
    logger: options.logger,
    embedFn: options.embedFn ?? generateEmbeddingWithMetadata,
    // currentModel / embeddingUrl intentionally omitted: the handler defaults to
    // the configured EMBEDDING_MODEL and endpoint, matching the live write path.
  });

  const runner = new MaintenanceQueueRunner({
    queue,
    handlers,
    logger: options.logger,
    concurrency:
      options.concurrency ??
      envPositiveInt("OPEN_BRAIN_MAINTENANCE_CONCURRENCY"),
    pollIntervalMs:
      options.pollIntervalMs ??
      envPositiveInt("OPEN_BRAIN_MAINTENANCE_POLL_MS"),
    leaseMs:
      options.leaseMs ?? envPositiveInt("OPEN_BRAIN_MAINTENANCE_LEASE_MS"),
  });

  if (options.autoStart !== false) runner.start();

  let stopped = false;
  return {
    queue,
    runner,
    async stop(): Promise<void> {
      // runner.stop() is safe even if start() was never called (null interval,
      // null tick, empty active set). Guard only against a double shutdown call.
      if (stopped) return;
      stopped = true;
      await runner.stop();
    },
  };
}
