/**
 * The non-MCP HTTP surface: CORS, request logging, and the REST routers.
 *
 * Design authority: `_plans/463-server-rewrite-charter.md` section 3 gives
 * `server/transport/` the HTTP routes that `src/index.ts:58-253` currently owns
 * inline. This module is the transport half of that move; the entrypoint
 * (`server/main.ts`) composes it.
 *
 * WHY THE ROUTER BODIES ARE STILL IMPORTED FROM `src/`. The charter's strangler
 * rule is that behavior moves only behind a parity test that proves the moved
 * copy answers identically (§4 Phase 2/3). `server/transport/rest-api.ts` and
 * `src/rest-promotion.ts` are 990 lines of namespace-predicated SQL with no
 * rewrite-side coverage yet, so copying them here would be a 990-line unproven
 * fork of a security boundary — precisely the thing the charter's "no old
 * module is retired" gate exists to prevent. What IS wrong today is that
 * `server/` cannot serve them at all, and that is what this file fixes: the
 * COMPOSITION is owned here, the bodies are still owned by their current
 * module, and each body moves later behind its own parity test.
 *
 * The seam is deliberately narrow: both routers accept `{ pool, embedFn }` and
 * read identity from `req.auth`, which `server/auth/middleware.ts` sets in the
 * same shape the current middleware does. Nothing else crosses.
 */
import cors from "cors";
import { Router } from "express";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Logger } from "pino";
import type { Pool } from "pg";
import { createRestRouter } from "./rest-api.ts";
import { createPromotionRouter } from "./rest-promotion.ts";
import { requestAuth } from "../auth/middleware.ts";

export interface RestSurfaceInput {
  readonly pool: Pool;
  readonly embedFn: (text: string) => Promise<number[] | null>;
  readonly authenticate: RequestHandler;
  readonly logger: Logger;
  /**
   * The operator-diagnostics probe, injected rather than imported.
   *
   * `/api/v1/operator/doctor` is the one REST route whose body is genuinely
   * about THIS process — its pool, its transport choice, its bridge — so the
   * entrypoint supplies it and this module only decides who may read it and
   * what a failure looks like on the wire. Omitted means the deployment has no
   * doctor, and the route is not mounted at all rather than mounted as a
   * permanent 500.
   */
  readonly operatorDoctor?: () => Promise<{ status: string }>;
}

/**
 * Which roles may read operator diagnostics.
 *
 * Same rule as `src/operator-doctor.ts:64` — the doctor names hosts, migration
 * state, and provider reachability, which is deployment shape, not memory. It
 * is admin/ob-admin only for the same reason `/health` is deliberately thinner
 * than it is.
 */
function canReadDoctor(role: string | undefined): boolean {
  return role === "admin" || role === "ob-admin";
}

/**
 * Translate a thrown REST error into a status without leaking its text.
 *
 * A 500's body is a fixed string on purpose: a pg error message can carry a
 * table name, a constraint, or a fragment of the offending row. The 23505
 * mapping to 409 is preserved from `src/index.ts:196-198` because clients
 * depend on it to distinguish "already exists" from "broken".
 */
function restErrorStatus(error: unknown): number {
  if (typeof error !== "object" || error === null) return 500;
  const statusCode = Number((error as { statusCode?: unknown }).statusCode);
  if (Number.isFinite(statusCode) && statusCode >= 400) return statusCode;
  return String((error as { code?: unknown }).code) === "23505" ? 409 : 500;
}

/** Emit one structured line per completed request, after the response is sent. */
export function createRequestLogger(logger: Logger): RequestHandler {
  return (request: Request, response: Response, next: NextFunction): void => {
    const started = performance.now();
    response.on("finish", () => {
      const auth = requestAuth(request);
      logger.info(
        {
          method: request.method,
          path: request.path,
          status: response.statusCode,
          duration_ms: Math.round(performance.now() - started),
          consumer_id: auth?.tokenClientId ?? auth?.clientId ?? "anonymous",
          effective_namespace: auth?.clientId,
          namespace_source: auth?.namespaceSource,
          agent_id: auth?.agentId,
        },
        "request",
      );
    });
    next();
  };
}

/**
 * Parse the CORS allowlist from its configured string form.
 *
 * An unset or empty value yields an EMPTY allowlist, not a wildcard. That is
 * the behavior in `src/index.ts:78` and it is the safe direction: this server
 * answers bearer-authenticated agents, not browsers, so a missing config should
 * permit no origin rather than every origin.
 */
export function parseAllowedOrigins(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0) ?? []
  );
}

/**
 * Build the CORS and request-logging pair, in the order they must be mounted.
 *
 * Returned as an ordered array rather than mounted here, because the position
 * is the whole point: these belong ahead of EVERY route, and the app builder
 * (`createSingleWorkerTransportApp`) is what owns route order. Handing back the
 * list lets that one place stay the only thing that decides where they sit.
 */
export function installHttpMiddleware(input: {
  readonly allowedOrigins: readonly string[];
  readonly logger: Logger;
}): readonly RequestHandler[] {
  return [
    cors({ origin: [...input.allowedOrigins], credentials: false }),
    createRequestLogger(input.logger),
  ];
}

/**
 * Build the authenticated `/api/v1` surface as one mountable router.
 *
 * Returned rather than mounted so the entrypoint decides the prefix and so a
 * test can exercise the routes without a listener. Authentication is applied
 * INSIDE this router rather than left to the caller: a REST surface that can be
 * mounted without its auth middleware is a mistake waiting for one distracted
 * composition change.
 */
export function createRestSurface(input: RestSurfaceInput): Router {
  const router = Router();
  const doctor = input.operatorDoctor;
  if (doctor) {
    router.get(
      "/operator/doctor",
      input.authenticate,
      (request: Request, response: Response) => {
        const auth = requestAuth(request);
        if (!canReadDoctor(auth?.role)) {
          response.status(403).json({
            error: "Permission denied: admin or ob-admin role required",
          });
          return;
        }
        doctor()
          .then((status) => {
            // Mirror `/health`: monitoring that alarms on the status code must
            // see a non-200 whenever the body is not fully healthy.
            response.status(status.status === "healthy" ? 200 : 503).json(status);
          })
          .catch((error: unknown) => {
            input.logger.error(
              {
                route: "/api/v1/operator/doctor",
                client_id: auth?.clientId,
                error_category: error instanceof Error ? error.name : typeof error,
              },
              "doctor_route_failed",
            );
            response.status(500).json({ error: "operator doctor status unavailable" });
          });
      },
    );
  }
  const deps = { pool: input.pool, embedFn: input.embedFn };
  router.use(input.authenticate, createRestRouter(deps));
  router.use(input.authenticate, createPromotionRouter(deps));
  router.use(
    (error: unknown, _request: Request, response: Response, next: NextFunction) => {
      // Express identifies an error handler by arity, so `next` must stay in the
      // signature; delegating a headers-sent failure is the one case where the
      // default handler is the right owner (it destroys the socket).
      if (response.headersSent) {
        next(error);
        return;
      }
      const status = restErrorStatus(error);
      input.logger.error(
        {
          status,
          error_category: error instanceof Error ? error.name : typeof error,
        },
        "rest_api_error",
      );
      response.status(status).json({
        error:
          status === 500
            ? "Internal error"
            : error instanceof Error
              ? error.message
              : "Request failed",
      });
    },
  );
  return router;
}
