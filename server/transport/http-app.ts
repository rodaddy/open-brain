import express from "express";
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import type { Logger } from "pino";
import { withCorrelation } from "../logging/context.ts";
import type { SessionTransportHandlers } from "./session-manager.ts";
import type { SingleWorkerHealth, SingleWorkerHealthInput } from "./health.ts";
import { getSingleWorkerHealth } from "./health.ts";

export interface SingleWorkerTransportAppInput {
  readonly authenticate: RequestHandler;
  readonly parseRequestBody: RequestHandler;
  readonly sessions: SessionTransportHandlers;
  readonly health: SingleWorkerHealthInput;
  readonly logger: Logger;
  /** Called after Express accepts and authenticates an MCP route. */
  readonly observeMcpRequest?: () => void;
  /**
   * Middleware mounted ahead of EVERY route, including `/health`.
   *
   * CORS and request logging belong here rather than at the caller, because
   * their correctness is entirely positional: a request logger mounted after
   * the routes never sees a response, and a CORS handler mounted after them
   * never gets to answer the preflight. Making the position a parameter of the
   * app builder is what stops a future composition from getting the order
   * wrong silently.
   *
   * `/health` is deliberately INSIDE this: an unauthenticated probe is still a
   * request, and a deployment that cannot see its own health traffic cannot
   * tell a dead monitor from a healthy service.
   */
  readonly beforeRoutes?: readonly RequestHandler[];
  /**
   * Additional routers, mounted at their own prefixes after `/health`.
   *
   * Mounted after health and before `/mcp` so that neither an authenticated
   * REST router nor its error handler can intercept the liveness probe or the
   * MCP session routes. Each entry owns its own authentication; this builder
   * does not apply `authenticate` to them, because the REST surface applies it
   * per-router already and applying it twice would run token resolution twice
   * per request.
   */
  readonly routers?: ReadonlyArray<{
    readonly path: string;
    readonly handler: RequestHandler;
  }>;
}

type AsyncRoute = (request: Request, response: Response) => Promise<void>;

function observeMcpRequest(
  input: SingleWorkerTransportAppInput,
  work: () => Promise<void>,
): Promise<void> {
  input.observeMcpRequest?.();
  return work();
}

function routeHandler(
  logger: Logger,
  method: string,
  path: string,
  route: AsyncRoute,
): RequestHandler {
  return (request, response, _next: NextFunction) => {
    void withCorrelation(async () => {
      const started = performance.now();
      logger.debug({ method, path }, "transport_request_entry");
      try {
        await route(request, response);
        logger.info(
          {
            method,
            path,
            status: response.statusCode,
            duration_ms: Math.round(performance.now() - started),
          },
          "transport_request_result",
        );
      } catch (error: unknown) {
        logger.error(
          {
            method,
            path,
            error_category: error instanceof Error ? error.name : typeof error,
            duration_ms: Math.round(performance.now() - started),
          },
          "transport_request_failure",
        );
        if (!response.headersSent) {
          response.status(500).json({ error: "Internal error" });
        }
      }
    });
  };
}

/**
 * The dependency checks that are currently failing, by name.
 *
 * Derived from the same `SingleWorkerHealth` that `/health` returns rather than
 * re-probing, so readiness and `/health` cannot disagree about the same
 * dependencies. The names are the health document's own field names, so a
 * reader of a 503 can go straight to that block in `/health` instead of
 * translating a probe-specific vocabulary.
 */
function failedReadinessChecks(health: SingleWorkerHealth): string[] {
  const failed: string[] = [];
  if (!health.database.connected) failed.push("database");
  if (
    health.nats.requested_transport === "nats" &&
    health.nats.availability !== "available"
  ) {
    failed.push("nats");
  }
  if (health.maintenance_producer?.stale === true) {
    failed.push("maintenance_producer");
  }
  if (health.capture?.stale === true) failed.push("capture");
  // A degraded status with no individually-named cause is still not ready.
  // Reporting it under its own name beats returning an empty list, which would
  // read as "ready" to both a human and to the caller's emptiness check.
  if (failed.length === 0 && health.status !== "healthy") failed.push("status");
  return failed;
}

/** Build the non-serving single-worker HTTP/MCP shadow application. */
export function createSingleWorkerTransportApp(
  input: SingleWorkerTransportAppInput,
): Express {
  const app = express();
  for (const middleware of input.beforeRoutes ?? []) app.use(middleware);
  app.use(input.parseRequestBody);
  app.get(
    "/health",
    routeHandler(input.logger, "GET", "/health", async (_request, response) => {
      const health = await getSingleWorkerHealth(input.health);
      response.status(health.status === "healthy" ? 200 : 503).json(health);
    }),
  );
  // `/healthz` is LIVENESS, and it does NO dependency I/O -- it is deliberately
  // not `/health` under a shorter name. The k3s rail RESTARTS a pod whose
  // liveness probe fails, so a liveness probe that dials Postgres turns one
  // database blip into a rolling restart of every replica at once, which is
  // strictly worse than the blip it was reporting. This answers only "is this
  // process still serving its event loop?" -- the one question a restart can
  // actually fix.
  app.get(
    "/healthz",
    routeHandler(input.logger, "GET", "/healthz", async (_request, response) => {
      response.status(200).type("text/plain").send("ok");
    }),
  );
  // `/readyz` is READINESS and owns the dependency checks: it decides whether
  // traffic should be routed here, and failing it removes the pod from the
  // service instead of restarting it. The 503 body NAMES the failing checks so
  // an operator reading a probe failure learns which dependency is down without
  // opening a shell; a bare "not ready" costs a debugging round trip every time.
  app.get(
    "/readyz",
    routeHandler(input.logger, "GET", "/readyz", async (_request, response) => {
      const health = await getSingleWorkerHealth(input.health);
      const failed = failedReadinessChecks(health);
      if (failed.length === 0) {
        response.status(200).json({ status: "ready" });
        return;
      }
      response.status(503).json({ status: "not_ready", failed });
    }),
  );
  for (const router of input.routers ?? []) app.use(router.path, router.handler);
  // The three `/mcp` handlers are called through `input.sessions` rather than
  // passed as bare references. `SessionTransportHandlers` declares them as
  // interface methods, so detaching one from its object would drop the receiver
  // if any implementation ever needed `this` -- calling through keeps the
  // binding correct regardless of how the handlers happen to be built today.
  app.post(
    "/mcp",
    input.authenticate,
    routeHandler(input.logger, "POST", "/mcp", (request, response) =>
      observeMcpRequest(input, () => input.sessions.handlePost(request, response)),
    ),
  );
  app.get(
    "/mcp",
    input.authenticate,
    routeHandler(input.logger, "GET", "/mcp", (request, response) =>
      observeMcpRequest(input, () => input.sessions.handleGet(request, response)),
    ),
  );
  app.delete(
    "/mcp",
    input.authenticate,
    routeHandler(input.logger, "DELETE", "/mcp", (request, response) =>
      observeMcpRequest(input, () => input.sessions.handleDelete(request, response)),
    ),
  );
  return app;
}
