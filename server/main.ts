/**
 * The rewrite's process entrypoint, and since the Phase 6 cutover, THE serving
 * entrypoint for the local dogfood clone.
 *
 * Startup order is config -> logger -> tokens -> pool -> migrations -> tool
 * deps -> NATS -> application -> listener, each failure fatal before the socket
 * opens; shutdown is the reverse, via `application.close()`.
 *
 * See docs/decisions/main-entrypoint-start-equivalence.md
 */
import express from "express";
import type { Server } from "node:http";
import type { Logger } from "pino";
import type pg from "pg";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createBrainServer } from "./application/brain-server.ts";
import {
  createShadowApplication,
  type ShadowApplication,
  type ShadowApplicationInput,
} from "./application/index.ts";
import {
  createNatsBridgeHealth,
  natsRuntimeBoundaryFromConfig,
  startNatsBridgeRuntime,
} from "./application/nats.ts";
import { createAuthMiddleware } from "./auth/middleware.ts";
import { createCaptureHealthRuntime } from "./capture/liveness-observer.ts";
import {
  loadServerConfig,
  natsHealthFromConfig,
  promotionKillSwitch,
  type ServerConfig,
} from "./config.ts";
import { runMigrations } from "./db/migrations.ts";
import { createDatabase, type Database } from "./db/pool.ts";
import { registerCrashHandlers } from "./logging/crash-handlers.ts";
import { withLogging } from "./logging/decorate.ts";
import { createLogger } from "./logging/logger.ts";
import { setLegacyLoggerSettingsReader } from "./logging/legacy-logger-settings.ts";
import {
  createTracingRuntime,
  installMcpTracing,
} from "./observability/langfuse-tracing.ts";
import { RecoveryWalStore } from "./realtime/recovery-wal.ts";
import { WorkingSetStore } from "./realtime/working-set.ts";
import { registerMemoryTools } from "./tools/index.ts";
import { createRestSurface, installHttpMiddleware } from "./transport/rest.ts";
import { readDeployedRevision } from "./transport/server-identity.ts";
import { installMcpAudit } from "./security/audit-log.ts";
import {
  generateEmbedding,
  generateEmbeddingWithMetadata,
} from "./embedding/provider.ts";
import {
  composeMaintenanceHandlers,
  MAINTENANCE_GRAPH_AUTH,
} from "./maintenance/maintenance-bootstrap.ts";
import { getOperatorDoctorStatus } from "./application/operator-doctor.ts";
import { setEmbeddingSettingsReader } from "./embedding/provider.ts";
import type { ToolDeps } from "./tools/tool-deps.ts";
import type { AuthInfo } from "./types.ts";

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
 * Wrap every tool handler this server registers with the logging seam.
 *
 * Installed at the composition root and NOWHERE else. A per-tool application
 * would put the same three lines in thirty files and go stale the first time
 * someone adds the thirty-first, so the wrap happens once, where registration
 * itself passes through: `server.registerTool`. `installMcpAudit` and
 * `installMcpTracing` earn their guarantee the same way and for the same
 * reason, which is why this runs beside them and BEFORE `registerMemoryTools`
 * — a tool registered before the wrapper is installed is a tool whose calls
 * are never logged.
 *
 * `withLogging` rethrows, so nothing about a handler's contract moves. The
 * errors tools convert into `isError` results are RETURNED, not thrown, so
 * they travel back to the caller byte-for-byte as before and are recorded as
 * an ordinary exit; only a genuine throw produces the failure line.
 */
export function installToolLogging(server: McpServer, logger: Logger): void {
  const original = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  server.registerTool = ((name: string, configOrDescription: unknown, cb?: unknown) => {
    if (typeof cb !== "function") {
      return original(name, configOrDescription, cb);
    }
    const callback = cb as (...args: never[]) => unknown;
    return original(
      name,
      configOrDescription,
      withLogging({ logger, name: `tool.${name}` }, callback),
    );
  }) as typeof server.registerTool;
}

/**
 * Build the per-session MCP server factory.
 *
 * Returns a FRESH `McpServer` per session. `installMcpAudit` and
 * `installMcpTracing` run BEFORE tool registration; the realtime stores are
 * built once and captured.
 *
 * See docs/decisions/main-per-session-server-and-install-order.md
 */
function createServerFactory(input: {
  pool: pg.Pool;
  logger: Logger;
  config: ServerConfig;
  tracing: ReturnType<typeof createTracingRuntime>;
  nats: NatsPhase;
}): () => McpServer {
  const { pool, logger, config, nats } = input;
  const realtime = {
    workingSetStore: new WorkingSetStore(),
    recoveryWalStore: new RecoveryWalStore({
      walPath: config.recovery.walPath,
    }),
  };
  const toolLogger = logger.child({ component: "tools" });
  return () => {
    // Through createBrainServer, not a hand-built McpServer: the shared builder
    // also installs the validation-summary formatter, which is what produces
    // the `input_validation_failed` envelope the parity contracts assert.
    const server = createBrainServer();
    installToolLogging(server, toolLogger);
    installMcpAudit(server, { pool, config: config.mcpAudit });
    // `sink` undefined means tracing is off for this process; the install then
    // never wraps `registerTool` and costs nothing.
    if (input.tracing.sink) {
      installMcpTracing(server, {
        config: input.tracing.config,
        sink: input.tracing.sink,
        logger: input.logger,
      });
    }
    registerMemoryTools(server, {
      pool,
      embedFn: generateEmbedding,
      logger: toolLogger,
      // The model NAME, never the provider URL (#1463): `embedding_model` is
      // what `model_drift` repair compares against `embeddingModel()`.
      embeddingModel: config.embedding.model,
      // The values the tool layer used to read from `process.env` itself, now
      // handed down from the ONE validated parse (#778 typed them;
      // `_plans/463-server-rewrite-charter.md:108,119` puts the parsing here).
      // The NATS boundary is the one the NATS phase already built, not a second
      // `natsRuntimeBoundaryFromConfig(config.nats)` call: rebuilding it here
      // would give the doctor a boundary object that can drift from the one the
      // bridge and `/health` actually run on.
      searchEmbeddingTimeoutMs: config.search.embeddingTimeoutMs,
      jev: { config: config.search.jevSearch },
      // Issue 1618 B3: the promote_shared screen; off unless the flag is on.
      jevShareScreen: { config: config.search.jevShareScreen },
      ftsCorpusConfig: config.fts.corpusConfig,
      promotionKillSwitch: config.promotion.killSwitch,
      // The DROP_COLLECTOR_* overrides the L5 move lifted out of the collector.
      // Without this fill the server runtime would silently run on
      // DEFAULT_DROP_COLLECTOR_BOUNDS no matter what the deployment set.
      dropCollectorBounds: config.dropCollector,
      // `config.qmd.path` is the validated parse of QMD_PATH (blank reads as
      // absent, `server/config/env-groups.ts:188,304`), so the handler no longer
      // needs an env record at all. Spread rather than assigned because the key
      // is optional and must stay ABSENT, not present-and-undefined.
      ...(config.qmd.path ? { qmdPath: config.qmd.path } : {}),
      sharedNamespaceNames: config.sharedNamespaceNames,
      recoveryWalPath: config.recovery.walPath,
      natsRuntimeBoundary: nats.boundary,
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
 * The live pieces a started process owns, in the order startup produced them.
 *
 * Named as one type because shutdown needs exactly this set and nothing else,
 * and because a five-argument `shutdown(application, database, server, logger,
 * tracing)` is a struct that has not been named yet — every caller has to
 * remember the order, and the compiler cannot help when two of the five are
 * transposed.
 */
interface RunningProcess {
  readonly application: ShadowApplication;
  readonly database: Database<pg.Pool>;
  readonly server: Server;
  readonly logger: Logger;
  readonly tracing: ReturnType<typeof createTracingRuntime>;
}

/**
 * Apply migrations, or record that they were deliberately skipped.
 *
 * The skip is `OPEN_BRAIN_RUN_MIGRATIONS=0`'s shape for extra workers: exactly
 * one process in a multi-worker deployment applies schema, and the others say
 * so in the log rather than staying silent, because a worker that ran no
 * migrations and never mentioned it is indistinguishable from one whose
 * migration step failed to be reached.
 */
async function applyMigrations(input: {
  database: Database<pg.Pool>;
  config: ServerConfig;
  logger: Logger;
  enabled: boolean;
}): Promise<void> {
  const { database, config, logger } = input;
  if (!input.enabled) {
    logger.info({}, "migrations_skipped");
    return;
  }
  const applied = await runMigrations(
    database.pool,
    config.database.migrationsDirectory,
    logger,
  );
  logger.info({ applied: applied.length }, "migrations_complete");
}

/** The NATS phase's outputs, all of which the composition step consumes. */
interface NatsPhase {
  readonly boundary: ReturnType<typeof natsRuntimeBoundaryFromConfig>;
  readonly health: ReturnType<typeof createNatsBridgeHealth>;
  readonly bridge: Awaited<ReturnType<typeof startNatsBridgeRuntime>>;
}

/**
 * Bring up the NATS ingress: boundary, health counters, and the bridge runtime.
 *
 * The token map the bridge needs is the legacy shape. It is derived from the
 * SAME parsed config the HTTP middleware uses, not from a second env read, so
 * the two ingresses cannot end up honoring different tokens.
 */
async function startNatsPhase(input: {
  database: Database<pg.Pool>;
  config: ServerConfig;
  logger: Logger;
  tracing: ReturnType<typeof createTracingRuntime>;
}): Promise<NatsPhase> {
  const { database, config, logger, tracing } = input;
  const boundary = natsRuntimeBoundaryFromConfig(config.nats);
  const health = createNatsBridgeHealth(config.nats.availability);
  const deps: ToolDeps = {
    pool: database.pool,
    embedFn: generateEmbedding,
    natsRuntimeBoundary: boundary,
    natsBridgeHealth: health,
  };

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
    deps,
    health,
    ...(tracing.background ? { tracing: tracing.background } : {}),
  });

  return { boundary, health, bridge };
}

/**
 * The background runtimes the application shuts down in order.
 *
 * The capture observer owns a refresh interval, which makes it a background
 * runtime and not a value: `server/application/index.ts` already owns ordered
 * shutdown through this port, so the timer stops on the same path as the NATS
 * bridge and the maintenance runner rather than through a second hand-rolled
 * teardown. A runtime that is running but absent from `backgroundRuntimes` is
 * the abandoned-lease bug (index.ts:127-131).
 */
function backgroundRuntimesFor(input: {
  bridge: NatsPhase["bridge"];
  captureHealth: ReturnType<typeof createCaptureHealthRuntime>;
}): ShadowApplicationInput["backgroundRuntimes"] {
  const { bridge, captureHealth } = input;
  return [
    ...(bridge.runtime ? [bridge.runtime] : []),
    ...(captureHealth.captureObserver
      ? [
          {
            name: "capture-health-observer",
            stop: async (): Promise<void> => captureHealth.stop(),
          },
        ]
      : []),
  ];
}

/**
 * Compose the application: auth, REST, MCP sessions, health, and the shutdown
 * order. Binds no socket — the listener is the caller's next step.
 */
function composeApplication(input: {
  options: StartServerOptions;
  config: ServerConfig;
  logger: Logger;
  database: Database<pg.Pool>;
  tracing: ReturnType<typeof createTracingRuntime>;
  nats: NatsPhase;
  captureHealth: ReturnType<typeof createCaptureHealthRuntime>;
}): ShadowApplication {
  const { options, config, logger, database, tracing, nats, captureHealth } = input;
  const authenticate = createAuthMiddleware(config.authTokens);
  const restSurface = createRestSurface({
    pool: database.pool,
    embedFn: generateEmbedding,
    authenticate,
    logger: logger.child({ component: "rest" }),
    searchEmbeddingTimeoutMs: config.search.embeddingTimeoutMs,
    jev: { config: config.search.jevSearch },
    sharedNamespaceNames: config.sharedNamespaceNames,
    promotionKillSwitch,
    operatorDoctor: () =>
      getOperatorDoctorStatus(database.pool, nats.boundary, nats.health, {
        serviceVersionFallback: config.doctor.serviceVersionFallback,
        nodeEnvironment: config.doctor.nodeEnvironment,
        fileLogConfigured: Boolean(config.logging.file?.trim()),
        rotationConfigured: config.doctor.rotationConfigured,
        rawTurnTtlSeconds: config.doctor.rawTurnTtlSeconds,
        ...(config.qmd.path !== undefined ? { qmdPath: config.qmd.path } : {}),
        ...(config.doctor.qmdIndexPath !== undefined
          ? { qmdIndexPath: config.doctor.qmdIndexPath }
          : {}),
      }),
  });

  return createShadowApplication({
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
      nats,
    }),
    // CORS and request logging run ahead of EVERY route, `/health` included:
    // an unauthenticated probe is still traffic, and a deployment that cannot
    // see its own health requests cannot tell a dead monitor from a healthy
    // service.
    beforeRoutes: installHttpMiddleware({
      allowedOrigins: options.allowedOrigins ?? config.http.allowedOrigins,
      logger: logger.child({ component: "http" }),
    }),
    routers: [{ path: "/api/v1", handler: restSurface }],
    // Absent when no namespace is configured, and absence is the composition
    // publishing NOTHING rather than a neutral value: a deployment that runs
    // no capture lane must not report itself broken for a job it was never
    // given (`docs/lane-contract.md` Tightenings rounds 8 and 13).
    ...(captureHealth.captureObserver
      ? { captureObserver: captureHealth.captureObserver }
      : {}),
    backgroundRuntimes: backgroundRuntimesFor({
      bridge: nats.bridge,
      captureHealth,
    }),
    // The maintenance handler map is what makes the runner exist at all; the
    // application composes it from `config.maintenance` and puts it last in
    // the shutdown order, so "maintenance runs" and "maintenance drains"
    // remain one decision rather than two that can disagree.
    maintenanceHandlers: composeMaintenanceHandlers({
      pool: database.pool,
      logger: handlerLogger(logger.child({ component: "maintenance" })),
      embedFn: generateEmbeddingWithMetadata,
      graphAuth: MAINTENANCE_GRAPH_AUTH,
      jevRem: { config: config.search.jevRem },
      jevDistillType: { config: config.search.jevDistillType },
      ...(config.maintenance.route ? { route: config.maintenance.route } : {}),
      ...(tracing.background ? { tracing: tracing.background } : {}),
    }),
    // A LIVE bridge knows its own failure counters; config cannot. Health
    // therefore reads the running health object, falling back to the parsed
    // config for the static half of the block.
    natsHealth: () =>
      natsHealthFromConfig(config.nats, {
        consecutiveFailures: nats.health.consecutiveFailures,
        lastError: Boolean(nats.health.lastError),
      }),
  });
}

/**
 * Open the socket and report the port that was actually bound.
 *
 * `address()` rather than the requested port, because `0` asks the kernel for
 * an ephemeral one and the requested value is then a lie in the log and in the
 * returned handle.
 */
async function openListener(input: {
  application: ShadowApplication;
  options: StartServerOptions;
  configuredPort: number;
  configuredBindHost?: string;
  logger: Logger;
}): Promise<{ server: Server; boundPort: number }> {
  const { application, options, configuredPort, configuredBindHost, logger } = input;
  const port = options.port ?? configuredPort;
  const bindHost = options.bindHost ?? configuredBindHost;
  const server = await new Promise<Server>((resolve, reject) => {
    const listener = bindHost
      ? application.app.listen(port, bindHost, () => resolve(listener))
      : application.app.listen(port, () => resolve(listener));
    listener.once("error", reject);
  });
  const address = server.address();
  const boundPort =
    typeof address === "object" && address !== null ? address.port : port;
  logger.info({ port: boundPort, bind_host: bindHost ?? "all" }, "server_started");
  return { server, boundPort };
}

/**
 * Release everything a partial startup allocated, so the CAUSE can be rethrown.
 *
 * The application may or may not have been composed; both it and the pool are
 * released here. The tracing client owns a background flush timer, so leaving
 * it running after a failed start keeps the process alive with nothing to
 * serve. Every failure in here is swallowed deliberately: the startup error is
 * the one the operator needs, and a cleanup error that replaced it would hide
 * the reason the process could not start.
 */
async function releaseAfterFailedStart(input: {
  application: ShadowApplication | undefined;
  database: Database<pg.Pool>;
  tracing: ReturnType<typeof createTracingRuntime>;
}): Promise<void> {
  try {
    await input.application?.close();
  } catch {
    // Deliberate fail-open: already logged by closeInOrder's own logging; the
    // startup failure is the one the operator needs, so it wins.
  }
  await input.tracing.shutdown().catch(() => {
    // Deliberate fail-open, per the doc comment at :507-510: this is teardown
    // of a failed start, so a shutdown error must not replace the startup one.
    return undefined;
  });
  await input.database.close().catch(() => {
    // Deliberate fail-open, per the doc comment at :507-510: the startup error
    // is the operator's answer and a close error would hide it.
    return undefined;
  });
}

/**
 * Compose and start the whole process. Throws on any fatal startup failure.
 *
 * Returns the handle rather than installing signal handlers, so a test can
 * start and stop it without touching process-global state; `main()` below is
 * the part that owns signals and exit codes.
 *
 * THE PHASES ARE THE HELPERS ABOVE, CALLED IN STARTUP ORDER. This function is
 * deliberately a sequence rather than a place where work happens: the file's
 * header says order is its content, so the order has to be readable on one
 * screen instead of inferred from interleaved composition.
 */
/**
 * Point the two legacy reader slots at this process's config, and hand back the
 * undo.
 *
 * Both slots are module-level and process-wide, so a started-and-stopped server
 * that left its readers installed would keep answering from a dead server's
 * config for everything that ran afterwards — in a test process, the next test
 * file. The restore closure is the same shape `setEmbeddingSettingsReader`
 * already uses at shutdown and on a failed start.
 */
export function registerConfigReaders(config: ServerConfig): () => void {
  // The legacy logger singleton still emits from every tool this
  // process loads, and under issue 864 it reads no environment of its own.
  // Registering here — before the first line can be emitted — makes this
  // process's own configuration the source of its envelope, rather than a
  // second parse of the same variables. Fields config does not carry stay
  // undefined, which is exactly the value the module defaults on.
  //
  // `hostName` prefers the `HOSTNAME`/`HOST` identity the legacy reader used
  // and falls back to the transport identity only when neither is set. Those
  // are DIFFERENT names: the transport one resolves from `OPEN_BRAIN_BIND_HOST`
  // or `os.hostname` (`server/transport/server-identity.ts`) and is the
  // `/health` identity, so preferring it unconditionally — which is what this
  // did before L6 — relabelled the envelope of a deployment that sets
  // `HOSTNAME`.
  const previousLoggerSettingsReader = setLegacyLoggerSettingsReader(() => ({
    logLevel: config.logging.level,
    hostName: config.loggerIdentity.hostName ?? config.transport.hostname,
    logFile: config.logging.file,
    logMaxBytes: undefined,
    logMaxFiles: undefined,
    serviceName: config.logging.service,
    workerName: config.logging.workerName,
  }));

  return () => {
    setLegacyLoggerSettingsReader(previousLoggerSettingsReader);
  };
}

export async function startServer(
  options: StartServerOptions = {},
): Promise<StartedServer> {
  const config = options.config ?? loadServerConfig();
  const restoreConfigReaders = registerConfigReaders(config);
  const logger = options.logger ?? createLogger(config.logging);
  // The embedding provider reads no environment of its own (issue 864); in the
  // server runtime its values come from the config this function already holds.
  // Registered here rather than at module scope because `config` is what the
  // reader answers from, and the retired adapter's env reader is what it
  // replaces.
  //
  // The replaced reader is kept and restored at shutdown. The provider is one
  // module-level slot in the process, so a started-and-stopped server that left
  // its own reader installed would keep answering from a dead server's config
  // for everything that ran afterwards — which in a test process is the next
  // test file.
  const previousEmbeddingSettingsReader = setEmbeddingSettingsReader(() => ({
    ...config.embedding,
    ...(config.transport.embeddingBaseUrl === undefined
      ? {}
      : { baseUrl: config.transport.embeddingBaseUrl }),
    ...(config.transport.embeddingApiKey === undefined
      ? {}
      : { apiKey: config.transport.embeddingApiKey }),
  }));

  // TOKENS FIRST, before anything is allocated. A process with no configured
  // tokens can authenticate nobody, so every request it could ever serve is a
  // 401. The previous entrypoint checks this only after the pool and the bridge
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
  // The deploy-stamp parser is handed DOWN from here (#1210): observability is
  // a leaf tier and must not import the transport tier that owns the format.
  const tracing = createTracingRuntime({
    config: config.tracing,
    logger,
    parseDeployStamp: readDeployedRevision,
  });
  logger.info({ enabled: tracing.sink !== undefined }, "mcp_tracing_configured");
  let application: ShadowApplication | undefined;
  try {
    await applyMigrations({
      database,
      config,
      logger,
      enabled: options.runMigrations !== false,
    });

    const nats = await startNatsPhase({ database, config, logger, tracing });

    // The capture-health observer this process runs, from REQUIRED config
    // (operator ruling 2026-08-08, ledger item 28 in `docs/issue-graph.md`).
    // `OPENBRAIN_CAPTURE_HEALTH_NAMESPACE` has no fallback: unset means NO
    // observer, no capture block on `/health`, and a WARN naming the variable.
    // A guessed namespace would be this process reporting on another tenant's
    // rows and calling the answer its own health — the namespace is the
    // auth-derived security boundary, not a convenience label.
    const captureHealth = createCaptureHealthRuntime({
      env: process.env,
      pool: database.pool,
      logger: logger.child({ component: "capture-health" }),
    });

    application = composeApplication({
      options,
      config,
      logger,
      database,
      tracing,
      nats,
      captureHealth,
    });

    const composed = application;
    const { server, boundPort } = await openListener({
      application: composed,
      options,
      configuredPort: config.http.port,
      configuredBindHost: config.http.bindHost,
      logger,
    });

    return {
      application: composed,
      database,
      server,
      port: boundPort,
      logger,
      shutdown: async () => {
        try {
          await shutdown({
            application: composed,
            database,
            server,
            logger,
            tracing,
          });
        } finally {
          setEmbeddingSettingsReader(previousEmbeddingSettingsReader);
          restoreConfigReaders();
        }
      },
    };
  } catch (error: unknown) {
    // A failure anywhere after the pool exists must not leak it. Everything
    // allocated so far is released, and the original failure is rethrown so the
    // caller sees the CAUSE rather than a cleanup error.
    setEmbeddingSettingsReader(previousEmbeddingSettingsReader);
    restoreConfigReaders();
    await releaseAfterFailedStart({ application, database, tracing });
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
async function shutdown(running: RunningProcess): Promise<void> {
  const { application, database, server, logger, tracing } = running;
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
  //
  // Caught here as well as inside the lane because THIS line owning an
  // unhandled rejection would skip `database.close()` below and leak the pool.
  // The lane bounds its own drain against a deadline (measured: an unreachable
  // Langfuse made an unbounded drain take 28.0 s, past launchd's 20 s
  // `ExitTimeOut`, so the process was SIGKILLed mid-shutdown). Two layers,
  // because the ordering here is what makes the database close reachable at
  // all.
  try {
    await tracing.shutdown();
  } catch (error: unknown) {
    logger.error(
      { error_category: error instanceof Error ? error.name : typeof error },
      "tracing_shutdown_failed",
    );
  }
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
  // Installed only here, in the process entrypoint, after startup has
  // succeeded: a startServer() that throws must not leave process listeners
  // behind, and a test that starts and stops the server in-process must never
  // own them (main.pg.test.ts:318 asserts a rejecting startServer; the isolated
  // suite died on a leaked handler when this sat inside startServer).
  const crashHandlers = registerCrashHandlers(started.logger);
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    // From here the process is deliberately going away.
    crashHandlers.unregister();
    started
      .shutdown()
      .then(() => process.exit(0))
      .catch(() => {
        // Deliberate: the non-zero exit IS the report, per the doc comment at
        // :767-768. This is the signal handler's last statement, so the
        // application and its logger are already shutting down.
        return process.exit(1);
      });
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

// Guarded so importing this module for a test never starts a process: only a
// direct execution of this file boots the server.
if (import.meta.main) {
  await main();
}
