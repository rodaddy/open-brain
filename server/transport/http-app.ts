import express from "express";
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import type { Logger } from "pino";
import { withCorrelation } from "../logging/context.ts";
import type { SessionTransportHandlers } from "./session-manager.ts";
import type { SingleWorkerHealthInput } from "./health.ts";
import { getSingleWorkerHealth } from "./health.ts";

export interface SingleWorkerTransportAppInput {
  readonly authenticate: RequestHandler;
  readonly parseRequestBody: RequestHandler;
  readonly sessions: SessionTransportHandlers;
  readonly health: SingleWorkerHealthInput;
  readonly logger: Logger;
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
  for (const router of input.routers ?? []) app.use(router.path, router.handler);
  app.post(
    "/mcp",
    input.authenticate,
    routeHandler(input.logger, "POST", "/mcp", input.sessions.handlePost),
  );
  app.get(
    "/mcp",
    input.authenticate,
    routeHandler(input.logger, "GET", "/mcp", input.sessions.handleGet),
  );
  app.delete(
    "/mcp",
    input.authenticate,
    routeHandler(input.logger, "DELETE", "/mcp", input.sessions.handleDelete),
  );
  return app;
}
