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
  type ServerConfig,
} from "./config.ts";
import { runMigrations } from "./db/migrations.ts";
import { createDatabase, type Database } from "./db/pool.ts";
import { withLogging } from "./logging/decorate.ts";
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
import type { AuthInfo } from "./types.ts";

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
  const original = server.registerTool.bind(server) as (
    ...args: unknown[]
  ) => unknown;
  server.registerTool = ((
    name: string,
    configOrDescription: unknown,
    cb?: unknown,
  ) => {
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
    const server = new McpServer({ name: "open-brain", version: "1.0.0" });
    installToolLogging(server, toolLogger);
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
      // The values the tool layer used to read from `process.env` itself, now
      // handed down from the ONE validated parse (#778 typed them;
      // `_plans/463-server-rewrite-charter.md:108,119` puts the parsing here).
      // The NATS boundary is the one the NATS phase already built, not a second
      // `natsRuntimeBoundaryFromConfig(config.nats)` call: rebuilding it here
      // would give the doctor a boundary object that can drift from the one the
      // bridge and `/health` actually run on.
      searchEmbeddingTimeoutMs: config.search.embeddingTimeoutMs,
      ftsCorpusConfig: config.fts.corpusConfig,
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
 * The token map the bridge needs is the `src/` shape. It is derived from the
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
  const { options, config, logger, database, tracing, nats, captureHealth } =
    input;
  const authenticate = createAuthMiddleware(config.authTokens);
  const restSurface = createRestSurface({
    pool: database.pool,
    embedFn: generateEmbedding,
    authenticate,
    logger: logger.child({ component: "rest" }),
    operatorDoctor: () =>
      getOperatorDoctorStatus(database.pool, nats.boundary, nats.health),
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
      allowedOrigins:
        options.allowedOrigins ??
        parseAllowedOrigins(process.env.ALLOWED_ORIGINS),
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
  logger: Logger;
}): Promise<{ server: Server; boundPort: number }> {
  const { application, options, logger } = input;
  const port = options.port ?? Number(process.env.PORT ?? DEFAULT_PORT);
  const bindHost = options.bindHost ?? process.env.OPEN_BRAIN_BIND_HOST?.trim();
  const server = await new Promise<Server>((resolve, reject) => {
    const listener = bindHost
      ? application.app.listen(port, bindHost, () => resolve(listener))
      : application.app.listen(port, () => resolve(listener));
    listener.once("error", reject);
  });
  const address = server.address();
  const boundPort =
    typeof address === "object" && address !== null ? address.port : port;
  logger.info(
    { port: boundPort, bind_host: bindHost ?? "all" },
    "server_started",
  );
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
    // Already reported by closeInOrder's own logging; the startup failure is
    // the one the operator needs, so it wins.
  }
  await input.tracing.shutdown().catch(() => undefined);
  await input.database.close().catch(() => undefined);
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
  const tracing = createTracingRuntime({ config: config.tracing });
  logger.info(
    { enabled: tracing.sink !== undefined },
    "mcp_tracing_configured",
  );
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
      logger,
    });

    return {
      application: composed,
      database,
      server,
      port: boundPort,
      logger,
      shutdown: () =>
        shutdown({ application: composed, database, server, logger, tracing }),
    };
  } catch (error: unknown) {
    // A failure anywhere after the pool exists must not leak it. Everything
    // allocated so far is released, and the original failure is rethrown so the
    // caller sees the CAUSE rather than a cleanup error.
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
