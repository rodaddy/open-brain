/**
 * The monitor's read-only HTTP surface.
 *
 * WHY `node:http` AND NOT EXPRESS/FASTIFY/HONO
 *
 * Three routes, all GET, no body parsing, no middleware, no auth. A framework
 * earns its dependency when you need routing depth, validation plumbing, and a
 * middleware chain -- none of which is true here. The rule from
 * `## LAW: do not hand-roll a solved problem` cuts BOTH ways: do not rewrite a
 * framework, and do not import one to replace fifteen lines of `switch`.
 *
 * If this grows auth, POST bodies, or a dozen routes, Hono becomes correct.
 * Saying so here is the point -- the next person can see it was decided.
 */

import { createServer, type Server } from "node:http";

import type { Logger } from "pino";

import type { MonitorService } from "./service.ts";
import { describe } from "./evaluator.ts";

/** What the API needs to answer questions. */
export interface ApiDeps {
  service: MonitorService;
  logger: Logger;
  port: number;
}

/** A route handler: takes deps, returns a status and a JSON body. */
type Route = (deps: ApiDeps) => { status: number; body: unknown };

/**
 * The routing table.
 *
 * A `Record` keyed by path rather than an if/else ladder over `req.url`
 * (`STANDARDS-typescript.md ## Control flow`). Adding a route is one row;
 * complexity stays constant, and the table can be asserted in a test without
 * standing up a server.
 */
const ROUTES: Record<string, Route> = {
  "/health": () => ({ status: 200, body: { status: "ok" } }),

  "/targets": ({ service }) => ({
    status: 200,
    body: service.snapshot().map((state) => ({
      ...state,
      description: describe(state.status),
    })),
  }),

  "/ready": ({ service }) => {
    // Ready means "has completed at least one round", which is different from
    // "the process is alive". Conflating the two is why a load balancer sends
    // traffic to an instance that has not checked anything yet.
    const checked = service.snapshot().some((state) => state.lastCheckedAt !== null);
    return checked
      ? { status: 200, body: { ready: true } }
      : { status: 503, body: { ready: false, reason: "no completed round yet" } };
  },
};

/**
 * Build the HTTP server. Does not listen -- the caller decides when.
 *
 * @param deps - Service, logger, port.
 * @returns A server ready for `.listen()`.
 */
export function createApi(deps: ApiDeps): Server {
  return createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const route = ROUTES[path];

    const { status, body } =
      route === undefined
        ? { status: 404, body: { error: "not found", path } }
        : route(deps);

    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);

    deps.logger.debug({ method: req.method, path, status }, "http request");
  });
}
