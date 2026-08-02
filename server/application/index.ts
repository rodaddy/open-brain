import type { Express, RequestHandler } from "express";
import type { Logger } from "pino";
import { natsHealthFromConfig, type ServerConfig } from "../config.ts";
import type { Database } from "../db/pool.ts";
import type { ServerModuleBoundary } from "../module.ts";
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
  return {
    app,
    sessions,
    close: () => closeInOrder(input, sessions),
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
 * into the exact abandoned-lease failure the drain exists to prevent.
 *
 * EVERY runtime is stopped even if an earlier one throws. A shutdown path that
 * abandons the remaining runtimes on the first failure leaks precisely when
 * something is already going wrong, which is the worst moment to also lose the
 * drain. Failures are logged with an error CATEGORY, never the error object,
 * and the first one is rethrown so a caller cannot read a partial shutdown as a
 * clean one.
 */
async function closeInOrder(
  input: ShadowApplicationInput,
  sessions: SessionTransportHandlers,
): Promise<void> {
  await sessions.close();
  let firstFailure: unknown;
  for (const runtime of input.backgroundRuntimes ?? []) {
    try {
      await runtime.stop();
      input.logger.info({ runtime: runtime.name }, "background_runtime_stopped");
    } catch (error: unknown) {
      firstFailure ??= error;
      input.logger.error(
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
