/**
 * The rewrite's process entrypoint, and since the Phase 6 cutover, THE serving
 * entrypoint for the local dogfood clone.
 *
 * Design authority: `_plans/463-server-rewrite-charter.md` §4 Phase 5 built this
 * file as a candidate "still not the package default"; §4 Phase 6 made it the
 * default. `package.json` `start` and the local-clone launcher's spawn target
 * now name this file, and `server/state.ts` reads `servesTraffic: true`.
 *
 * ROLLBACK IS `src/index.ts`, BYTE-UNTOUCHED. The charter's strangler rule
 * retires an old module only after the candidate is proven RUNNING, so the
 * previous server is still present and still starts. Reverting the spawn target
 * is the whole rollback; there is no code to restore.
 *
 * WHAT THIS FILE IS FOR. Every boundary under `server/` was previously reachable
 * only from a test that hand-assembled it. `createShadowApplication` takes a
 * database, a logger, an `authenticate` handler and a server factory — it binds
 * no socket, opens no pool, runs no migration, and builds no token map, so
 * every one of those steps existed ONLY inside `src/index.ts:255-437`. That is
 * the gap this closes: this file is the one place where an environment becomes
 * a running process.
 *
 * START-EQUIVALENCE IS THE ACCEPTANCE BAR. From launchd's perspective this must
 * be interchangeable with `src/index.ts`: the same env contract, the same port
 * default, the same bind-host rule, the same `/health` body, the same signals,
 * the same non-zero exit on a startup failure. Where a behavior is preserved
 * rather than improved, the receipt is named inline — the charter's frozen-
 * surface table is what makes those non-negotiable, not taste.
 *
 * ORDER IS THE CONTENT OF THIS FILE. Startup is: config (one env read) ->
 * logger -> tokens -> pool -> migrations -> tool deps -> NATS -> application ->
 * listener. Each step's failure must be fatal BEFORE the socket opens, because
 * a process that binds a port and then discovers it has no tokens has already
 * told the load balancer it is ready. Shutdown is the reverse and is delegated
 * to `application.close()`, which drains in dependency order.
 */
import express from "express";
import type { Server } from "node:http";
import type { Logger } from "pino";
import type pg from "pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createShadowApplication,
  type ShadowApplication,
} from "./application/index.ts";
import {
  createNatsBridgeHealth,
  natsRuntimeBoundaryFromConfig,
  startNatsBridgeRuntime,
} from "./application/nats.ts";
import { createAuthMiddleware } from "./auth/middleware.ts";
import {
  loadServerConfig,
  natsHealthFromConfig,
  type ServerConfig,
} from "./config.ts";
import { runMigrations } from "./db/migrations.ts";
import { createDatabase, type Database } from "./db/pool.ts";
import { createLogger } from "./logging/logger.ts";
import {
  createTracingRuntime,
  installMcpTracing,
} from "./observability/langfuse-tracing.ts";
import { RecoveryWalStore } from "./realtime/recovery-wal.ts";
import { WorkingSetStore } from "./realtime/working-set.ts";
import { registerMemoryTools } from "./tools/index.ts";
import {
  createRestSurface,
  installHttpMiddleware,
  parseAllowedOrigins,
} from "./transport/rest.ts";
import { installMcpAudit } from "../src/audit-log.ts";
import {
  generateEmbedding,
  generateEmbeddingWithMetadata,
} from "../src/embedding.ts";
import {
  composeMaintenanceHandlers,
  MAINTENANCE_GRAPH_AUTH,
} from "../src/maintenance-bootstrap.ts";
import { getOperatorDoctorStatus } from "../src/operator-doctor.ts";
import type { ToolDeps } from "../src/tools/index.ts";
import type { AuthInfo } from "../src/types.ts";

/** Default listening port, unchanged from `src/index.ts:349`. */
const DEFAULT_PORT = 3100;

export interface StartedServer {
  readonly application: ShadowApplication;
  readonly database: Database<pg.Pool>;
  readonly server: Server;
  readonly port: number;
  readonly logger: Logger;
  /** Stop the listener, drain background work, then release the pool. */
  shutdown(): Promise<void>;
}

export interface StartServerOptions {
  /**
   * Environment-derived configuration. Defaults to the composition-root read.
   *
   * Injected so a test can start a REAL process stack against an isolated
   * database on an ephemeral port without mutating `process.env` — which is
   * global, survives the test, and makes concurrent suites race.
   */
  readonly config?: ServerConfig;
  /** Listening port. `0` asks the kernel for an ephemeral one. */
  readonly port?: number;
  readonly bindHost?: string;
  readonly logger?: Logger;
  /** Skip migrations, matching `OPEN_BRAIN_RUN_MIGRATIONS=0` for extra workers. */
  readonly runMigrations?: boolean;
  /** CORS allowlist. Defaults to the `ALLOWED_ORIGINS` env contract. */
  readonly allowedOrigins?: readonly string[];
}

/**
 * Build the per-session MCP server factory.
 *
 * A FRESH `McpServer` per session, not one shared instance: the SDK binds a
 * server to a single transport, so a shared one throws "Already connected to a
 * transport" the moment two clients overlap. `src/index.ts:214-221` makes the
 * same choice for the same reason.
 *
 * `installMcpAudit` runs BEFORE tool registration, because it works by wrapping
 * `registerTool` and `validateToolInput` — a tool registered before the wrapper
 * is installed is a tool whose calls are never audited. Ordering here is the
 * whole of the audit guarantee.
 *
 * `installMcpTracing` (#530) is installed alongside it, under the same ordering
 * rule and for the same reason. THE TWO ARE NOT ALTERNATIVES: audit is the
 * content-FREE durable Postgres record and is on by default; tracing is the
 * content-FUL Langfuse export and is off unless the operator configures it.
 * Both wrap `registerTool`, so both see every call; `tracingSink` is undefined
 * whenever tracing is off, which makes the install a no-op.
 *
 * The realtime stores are built ONCE and captured, not per session: the working
 * set is the process's scratch for the active turn and the recovery WAL holds a
 * crashed session's trace, so rebuilding them per connection would make both
 * report a permanent and very convincing zero.
 */
function createServerFactory(input: {
  pool: pg.Pool;
  logger: Logger;
  config: ServerConfig;
  tracing: ReturnType<typeof createTracingRuntime>;
}): () => McpServer {
  const { pool, logger, config } = input;
  const realtime = {
    workingSetStore: new WorkingSetStore(),
    recoveryWalStore: new RecoveryWalStore({
      walPath: process.env.OPENBRAIN_RECOVERY_WAL_PATH ?? null,
    }),
  };
  const toolLogger = logger.child({ component: "tools" });
  return () => {
    const server = new McpServer({ name: "open-brain", version: "1.0.0" });
    installMcpAudit(server, { pool });
    // `sink` undefined means tracing is off for this process; the install then
    // never wraps `registerTool` and costs nothing.
    if (input.tracing.sink) {
      installMcpTracing(server, {
        config: input.tracing.config,
        sink: input.tracing.sink,
      });
    }
    registerMemoryTools(server, {
      pool,
      embedFn: generateEmbedding,
      logger: toolLogger,
      ...(config.transport.embeddingBaseUrl
        ? { embeddingModel: config.transport.embeddingBaseUrl }
        : {}),
      ...realtime,
    });
    return server;
  };
}

/**
 * Adapt a pino logger to the maintenance handlers' content-free logger shape.
 *
 * Those handlers log `(message, fields)` where every value is already a string
 * or number; pino takes the object first. Nothing is added, renamed, or
 * dropped, because the field names are what operator greps are written against.
 */
function handlerLogger(logger: Logger): {
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
} {
  return {
    info: (message, fields) => logger.info(fields ?? {}, message),
    warn: (message, fields) => logger.warn(fields ?? {}, message),
    error: (message, fields) => logger.error(fields ?? {}, message),
  };
}

/**
 * Compose and start the whole process. Throws on any fatal startup failure.
 *
 * Returns the handle rather than installing signal handlers, so a test can
 * start and stop it without touching process-global state; `main()` below is
 * the part that owns signals and exit codes.
 */
export async function startServer(
  options: StartServerOptions = {},
): Promise<StartedServer> {
  const config = options.config ?? loadServerConfig();
  const logger = options.logger ?? createLogger(config.logging);

  // TOKENS FIRST, before anything is allocated. A process with no configured
  // tokens can authenticate nobody, so every request it could ever serve is a
  // 401. `src/index.ts:343-346` checks this only after the pool and the bridge
  // are already up; checking it first means a misconfigured deploy fails
  // without having opened a connection or a broker subscription.
  if (config.authTokens.length === 0) {
    throw new Error("server_start_failed: no auth tokens configured");
  }

  const database = createDatabase(config.database, logger);
  // ONE tracing client for the process (#530), built before any session can
  // exist and shared by every per-session MCP server. Off unless the operator
  // set all four OPENBRAIN_TRACING_* variables; `createTracingRuntime` never
  // throws, so a misconfigured or unreachable Langfuse can never keep the
  // service from starting.
  const tracing = createTracingRuntime();
  logger.info({ enabled: tracing.sink !== undefined }, "mcp_tracing_configured");
  let application: ShadowApplication | undefined;
  try {
    if (options.runMigrations !== false) {
      const applied = await runMigrations(
        database.pool,
        config.database.migrationsDirectory,
        logger,
      );
      logger.info({ applied: applied.length }, "migrations_complete");
    } else {
      logger.info({}, "migrations_skipped");
    }

    const natsBoundary = natsRuntimeBoundaryFromConfig(config.nats);
    const natsHealth = createNatsBridgeHealth(config.nats.availability);
    const toolDeps: ToolDeps = {
      pool: database.pool,
      embedFn: generateEmbedding,
      natsRuntimeBoundary: natsBoundary,
      natsBridgeHealth: natsHealth,
    };

    // The token map the NATS bridge needs is the `src/` shape. It is derived
    // from the SAME parsed config the HTTP middleware uses, not from a second
    // env read, so the two ingresses cannot end up honoring different tokens.
    const tokenMap = new Map<string, AuthInfo>(
      config.authTokens.map((entry) => [
        entry.token,
        { role: entry.role, clientId: entry.clientId },
      ]),
    );

    const bridge = await startNatsBridgeRuntime({
      config: config.nats,
      logger: logger.child({ component: "nats" }),
      tokenMap,
      deps: toolDeps,
      health: natsHealth,
    });

    const authenticate = createAuthMiddleware(config.authTokens);
    const restSurface = createRestSurface({
      pool: database.pool,
      embedFn: generateEmbedding,
      authenticate,
      logger: logger.child({ component: "rest" }),
      operatorDoctor: () =>
        getOperatorDoctorStatus(database.pool, natsBoundary, natsHealth),
    });

    application = createShadowApplication({
      config,
      logger,
      database,
      authenticate,
      parseRequestBody: express.json({ limit: "1mb" }),
      serverFactory: createServerFactory({
        pool: database.pool,
        logger,
        config,
        tracing,
      }),
      // CORS and request logging run ahead of EVERY route, `/health` included:
      // an unauthenticated probe is still traffic, and a deployment that cannot
      // see its own health requests cannot tell a dead monitor from a healthy
      // service.
      beforeRoutes: installHttpMiddleware({
        allowedOrigins:
          options.allowedOrigins ??
          parseAllowedOrigins(process.env.ALLOWED_ORIGINS),
        logger: logger.child({ component: "http" }),
      }),
      routers: [{ path: "/api/v1", handler: restSurface }],
      ...(bridge.runtime ? { backgroundRuntimes: [bridge.runtime] } : {}),
      // The maintenance handler map is what makes the runner exist at all; the
      // application composes it from `config.maintenance` and puts it last in
      // the shutdown order, so "maintenance runs" and "maintenance drains"
      // remain one decision rather than two that can disagree.
      maintenanceHandlers: composeMaintenanceHandlers({
        pool: database.pool,
        logger: handlerLogger(logger.child({ component: "maintenance" })),
        embedFn: generateEmbeddingWithMetadata,
        graphAuth: MAINTENANCE_GRAPH_AUTH,
      }),
      // A LIVE bridge knows its own failure counters; config cannot. Health
      // therefore reads the running health object, falling back to the parsed
      // config for the static half of the block.
      natsHealth: () =>
        natsHealthFromConfig(config.nats, {
          consecutiveFailures: natsHealth.consecutiveFailures,
          lastError: Boolean(natsHealth.lastError),
        }),
    });

    const port = options.port ?? Number(process.env.PORT ?? DEFAULT_PORT);
    const bindHost =
      options.bindHost ?? process.env.OPEN_BRAIN_BIND_HOST?.trim();
    const composed = application;
    const server = await new Promise<Server>((resolve, reject) => {
      const listener = bindHost
        ? composed.app.listen(port, bindHost, () => resolve(listener))
        : composed.app.listen(port, () => resolve(listener));
      listener.once("error", reject);
    });
    const address = server.address();
    const boundPort =
      typeof address === "object" && address !== null ? address.port : port;
    logger.info(
      { port: boundPort, bind_host: bindHost ?? "all" },
      "server_started",
    );

    return {
      application: composed,
      database,
      server,
      port: boundPort,
      logger,
      shutdown: () => shutdown(composed, database, server, logger, tracing),
    };
  } catch (error: unknown) {
    // A failure anywhere after the pool exists must not leak it. The
    // application may or may not have been composed; both are released here,
    // and the original failure is rethrown so the caller sees the CAUSE rather
    // than a cleanup error.
    try {
      await application?.close();
    } catch {
      // Already reported by closeInOrder's own logging; the startup failure is
      // the one the operator needs, so it wins.
    }
    // The tracing client owns a background flush timer; leaving it running
    // after a failed start keeps the process alive with nothing to serve.
    await tracing.shutdown().catch(() => undefined);
    await database.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Stop serving, then drain, then release — the reverse of startup.
 *
 * The LISTENER CLOSES FIRST and is awaited, so no new request can enter while
 * background work drains. `application.close()` then closes MCP sessions and
 * stops every background runtime in order (the NATS bridge, then the
 * maintenance runner, which needs the database longest). Only after that does
 * the pool go away, because a maintenance drain that loses its pool mid-job
 * strands exactly the rows it had already leased.
 *
 * EVERY stage runs even when an earlier one throws, and the first failure is
 * rethrown: a partial shutdown must not be readable as a clean one, or a
 * supervisor restarts on top of leases that are still live.
 */
async function shutdown(
  application: ShadowApplication,
  database: Database<pg.Pool>,
  server: Server,
  logger: Logger,
  tracing: ReturnType<typeof createTracingRuntime>,
): Promise<void> {
  logger.info({}, "server_shutdown_started");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  let firstFailure: unknown;
  try {
    await application.close();
  } catch (error: unknown) {
    firstFailure = error;
    logger.error(
      { error_category: error instanceof Error ? error.name : typeof error },
      "application_close_failed",
    );
  }
  // AFTER the MCP sessions are closed, so no further call can enqueue, and
  // before the pool goes. `tracing.shutdown()` swallows its own failures by
  // contract (#530: a tracing fault must never alter the outcome of anything),
  // so it deliberately does NOT participate in `firstFailure` — a dropped batch
  // of diagnostics must not make a clean drain exit non-zero.
  await tracing.shutdown();
  try {
    await database.close();
  } catch (error: unknown) {
    firstFailure ??= error;
    logger.error(
      { error_category: error instanceof Error ? error.name : typeof error },
      "database_close_failed",
    );
  }
  logger.info({}, "server_shutdown_complete");
  if (firstFailure !== undefined) throw firstFailure;
}

/**
 * The launchd-facing process wrapper: signals, exit codes, nothing else.
 *
 * Separate from `startServer` so the startup path is testable without a test
 * being able to kill the runner. SIGTERM and SIGINT both drain; a shutdown that
 * throws exits non-zero, for the reason named above.
 */
export async function main(): Promise<void> {
  const started = await startServer();
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    started
      .shutdown()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

// Guarded so importing this module for a test never starts a process. The
// charter's Phase 5 rule is that the candidate entrypoint EXISTS and is not the
// package default; `package.json` still references `src/index.ts`.
if (import.meta.main) {
  await main();
}
