import type { Express, RequestHandler } from "express";
import type { Logger } from "pino";
import { natsHealthFromConfig, type ServerConfig } from "../config.ts";
import type { Database } from "../db/pool.ts";
import type { ServerModuleBoundary } from "../module.ts";
import { createMaintenanceRuntime } from "../maintenance/index.ts";
import type { MaintenanceJobHandler } from "../../src/maintenance-queue.ts";
import {
  createSingleWorkerTransportApp,
  createSessionTransportHandlers,
  type McpServerFactory,
  type SessionTransportFactory,
  type SessionTransportHandlers,
  type TransportNatsHealth,
} from "../transport/index.ts";

export const APPLICATION_BOUNDARY: ServerModuleBoundary = {
  name: "application",
  owns: ["composition", "startup ordering", "shutdown ordering"],
  excludes: ["HTTP routing", "SQL", "authorization policy", "tool behavior"],
};

export interface ShadowApplicationInput {
  readonly config: ServerConfig;
  readonly logger: Logger;
  readonly database: Database;
  readonly authenticate: RequestHandler;
  readonly parseRequestBody: RequestHandler;
  readonly serverFactory: McpServerFactory;
  readonly transportFactory?: SessionTransportFactory;
  readonly fetch?: typeof fetch;
  readonly natsHealth?: () => TransportNatsHealth;
  /**
   * Long-running work this application must shut down, in order, on close.
   *
   * The maintenance queue runner is the one that matters today. It is passed as
   * a PORT rather than constructed here for a specific reason: `stop()` on a
   * claim-then-dispatch runner is not a cancel, it is a DRAIN. It must await
   * the in-flight claim so rows that claim already leased land in the tracked
   * set before the drain waits on it — otherwise those rows sit `running` with
   * a live lease and no handler, stuck until the lease expires
   * (`docs/sme/domain-backend.md`, PR #350 / issue #343). That behavior belongs
   * to the runner and is already implemented there; the application's job is
   * only to CALL it, and to call it before the database goes away.
   */
  readonly backgroundRuntimes?: readonly BackgroundRuntime[];
  /**
   * Job kinds this process can dispatch. Supplying it composes the maintenance
   * queue runner from `config.maintenance` and appends it to the shutdown order.
   *
   * This is what turned the `backgroundRuntimes` port from a declared shape into
   * a wired one: before it, the port's only suppliers were test fakes, so the
   * ordered shutdown above was proven against runtimes that had no leases to
   * drain. Composing here rather than making every caller assemble a queue keeps
   * "maintenance is running" and "maintenance is in the shutdown order" the same
   * decision — they cannot disagree, which is the failure the drain exists to
   * prevent.
   *
   * Omitted means this process dispatches nothing, which is correct for a test
   * composition and for any worker deliberately not running maintenance. It is
   * NOT the same as `config.maintenance.enabled: false`, which is an operator
   * opting a process out; both end with no runtime in the shutdown order.
   */
  readonly maintenanceHandlers?: ReadonlyMap<string, MaintenanceJobHandler>;
  /**
   * Start maintenance polling immediately (default true). `false` composes the
   * runner and its shutdown wiring without a timer, for tests that drive ticks
   * deterministically.
   */
  readonly maintenanceAutoStart?: boolean;
}

/**
 * Anything the application starts and must stop before the database closes.
 *
 * Deliberately one method wide. The application orders shutdown; it does not
 * want to know whether the thing behind this is a queue runner, a NATS bridge,
 * or a sweeper.
 */
export interface BackgroundRuntime {
  readonly name: string;
  stop(): Promise<void>;
}

export interface ShadowApplication {
  readonly app: Express;
  readonly sessions: SessionTransportHandlers;
  /**
   * Everything this application will stop on close, in the order it will stop
   * it. Exposed so a caller (and a test) can see the composed shutdown order
   * rather than infer it — a runtime that is running but absent from this list
   * is the abandoned-lease bug, and it should be observable, not silent.
   */
  readonly backgroundRuntimes: readonly BackgroundRuntime[];
  close(): Promise<void>;
}

/** Compose the phase-4 shadow implementation without binding a network socket. */
export function createShadowApplication(
  input: ShadowApplicationInput,
): ShadowApplication {
  const transportLogger = input.logger.child({ component: "transport" });
  const sessions = createSessionTransportHandlers({
    config: input.config.transport,
    logger: transportLogger,
    serverFactory: input.serverFactory,
    ...(input.transportFactory ? { transportFactory: input.transportFactory } : {}),
  });
  const health = {
    databaseHealth: input.database.health,
    serverIp: input.config.transport.serverIp,
    probeTimeoutMs: input.config.transport.healthProbeTimeoutMs,
    logger: transportLogger,
    ...(input.config.transport.embeddingBaseUrl
      ? { embeddingBaseUrl: input.config.transport.embeddingBaseUrl }
      : {}),
    ...(input.config.transport.embeddingApiKey
      ? { embeddingApiKey: input.config.transport.embeddingApiKey }
      : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
    // Config is the DEFAULT source of the `nats` health block, not an optional
    // extra. `server/transport/health.ts` falls back to a hardcoded
    // http/available literal when nothing supplies one, which is correct only
    // for a worker that genuinely runs HTTP -- so a worker configured with
    // `OPENBRAIN_TRANSPORT=nats` and a broken bridge would report itself
    // `healthy` on the strength of a constant. Deriving it from the parsed
    // config makes the degraded case reachable; an explicit `natsHealth` still
    // wins, because a LIVE bridge knows its own failure counters and config
    // cannot.
    natsHealth:
      input.natsHealth ?? (() => natsHealthFromConfig(input.config.nats)),
  };
  const app = createSingleWorkerTransportApp({
    authenticate: input.authenticate,
    parseRequestBody: input.parseRequestBody,
    sessions,
    health,
    logger: transportLogger,
  });
  // Compose maintenance BEFORE returning, so the runner and its place in the
  // shutdown order are created together. `createMaintenanceRuntime` returns
  // undefined when the operator disabled maintenance for this process, and a
  // process that dispatches no job kinds composes none at all.
  //
  // Caller-supplied runtimes stop first, then maintenance. The queue runner is
  // the drain that needs the database longest -- it must finish jobs it has
  // already leased -- so it sits closest to the database in the ordering.
  const maintenance = input.maintenanceHandlers
    ? createMaintenanceRuntime({
        config: input.config.maintenance,
        logger: input.logger.child({ component: "maintenance" }),
        pool: input.database.pool,
        handlers: input.maintenanceHandlers,
        ...(input.maintenanceAutoStart !== undefined
          ? { autoStart: input.maintenanceAutoStart }
          : {}),
      })
    : undefined;
  const backgroundRuntimes: readonly BackgroundRuntime[] = [
    ...(input.backgroundRuntimes ?? []),
    ...(maintenance ? [maintenance] : []),
  ];

  return {
    app,
    sessions,
    backgroundRuntimes,
    close: () => closeInOrder(input.logger, sessions, backgroundRuntimes),
  };
}

/**
 * Shut down in dependency order: stop accepting work, then drain, then release.
 *
 * SESSIONS FIRST. While a session is live an MCP handler can still enqueue
 * maintenance work, so draining the runner before closing sessions would let a
 * late request refill the queue after the drain had already passed it.
 *
 * BACKGROUND RUNTIMES SECOND, and they are drained BEFORE the caller closes the
 * database, because a claim-then-dispatch runner needs its pool to finish the
 * jobs it has already leased. Killing the pool first turns an orderly drain
 * into the exact abandoned-lease failure the drain exists to prevent. The
 * composed maintenance runner is last in this list for that reason: it is the
 * runtime that needs the database for the longest.
 *
 * EVERY runtime is stopped even if an earlier one throws. A shutdown path that
 * abandons the remaining runtimes on the first failure leaks precisely when
 * something is already going wrong, which is the worst moment to also lose the
 * drain. Failures are logged with an error CATEGORY, never the error object,
 * and the first one is rethrown so a caller cannot read a partial shutdown as a
 * clean one.
 */
async function closeInOrder(
  logger: Logger,
  sessions: SessionTransportHandlers,
  backgroundRuntimes: readonly BackgroundRuntime[],
): Promise<void> {
  await sessions.close();
  let firstFailure: unknown;
  for (const runtime of backgroundRuntimes) {
    try {
      await runtime.stop();
      logger.info({ runtime: runtime.name }, "background_runtime_stopped");
    } catch (error: unknown) {
      firstFailure ??= error;
      logger.error(
        {
          runtime: runtime.name,
          error_category: error instanceof Error ? error.name : typeof error,
        },
        "background_runtime_stop_failed",
      );
    }
  }
  if (firstFailure !== undefined) throw firstFailure;
}
