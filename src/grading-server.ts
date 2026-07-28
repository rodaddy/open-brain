/**
 * The grading page's HTTP shell. Issue #394.
 *
 * A SEPARATE Bun.serve LISTENER, NOT A ROUTE ON THE EXPRESS APP. This is a
 * deliberate architectural choice with a concrete blocker behind it:
 * src/auth.ts:100-105 rejects any request without an `Authorization: Bearer`
 * header before anything else runs, and every non-/health surface is mounted
 * behind it (src/index.ts:140, :170-229). A browser navigating to a URL sends
 * no Bearer header, so `GET /grade` on the Express app would 401 on the
 * document load. Making it work means adding cookie or session auth to the
 * production auth path -- a security-boundary change to a shared surface, for a
 * single-operator local page. Standing up a second listener touches nothing.
 *
 * Bun.serve is already the repo's answer for a standalone HTTP surface
 * (scripts/run-two-worker.ts:130, scripts/run-nats-worker.ts:166) and needs no
 * dependency: package.json has 7 runtime deps and none is a UI framework or
 * bundler, so the page is one hand-written HTML string with plain fetch().
 *
 * LOOPBACK IS THE AUTH BOUNDARY. Bound to 127.0.0.1, reusing the posture
 * src/local-clone-mode.ts:1 already codifies (LOOPBACK_HOSTS) and
 * src/index.ts:341-351 already applies. An operator-only grading surface
 * reachable only from the machine it runs on needs no token ceremony, and
 * inventing one here would be the pre-prod key ceremony this project has
 * explicitly declined. The hostname is NOT configurable: making it an env var
 * is how a loopback-only service ends up on 0.0.0.0 during a debugging session
 * and stays there.
 *
 * LOGGING IS CONTENT-FREE. Candidate content is real dialogue
 * (032_raw_turns.sql content-safety note) and grading is exactly the workload
 * that would tempt a "log what was graded" line. Every log record here carries
 * ids, counts, actions, and durations -- never content, never a note body.
 */

import type pg from "pg";
import {
  clampLimit,
  clampOffset,
  fetchInconclusive,
  fetchQueue,
  fetchStats,
  gradeCandidate,
  parseGradedBy,
  parseReviewAction,
  ReviewInputError,
  ungradeCandidate,
} from "./candidate-review.ts";
import { GRADING_PAGE_HTML } from "./grading-page.ts";

/** Structured logger shape. Matches the one every other module here accepts. */
export interface GradingLogger {
  info: (message: string, extra?: Record<string, unknown>) => void;
  warn: (message: string, extra?: Record<string, unknown>) => void;
  error: (message: string, extra?: Record<string, unknown>) => void;
}

/**
 * Loopback only, and not overridable. See the module header.
 *
 * Kept as a named constant rather than an inline literal so a future reader
 * grepping for the bind address finds this comment attached to it.
 */
export const GRADING_BIND_HOST = "127.0.0.1";

/**
 * Default port.
 *
 * Distinct from the app's 3100 so both can run at once. 3400 was the first
 * choice and is NOT free on this machine -- an unrelated node process holds
 * 127.0.0.1:3400 (observed 2026-07-28), and Bun.serve fails hard with
 * EADDRINUSE rather than falling back, which would greet the operator with a
 * stack trace instead of a page. Override with --port or GRADING_PORT.
 */
export const DEFAULT_GRADING_PORT = 3417;

export interface GradingServerOptions {
  pool: Pick<pg.Pool, "query">;
  /**
   * The namespace every read and write is scoped to. Required, with no
   * default: a grading surface that silently picked a namespace could show one
   * operator's candidates under another's identity, and namespace is a security
   * boundary in this repo, not a filter.
   */
  namespace: string;
  /** Who grades here. Stamped into graded_by on every write. */
  gradedBy: string;
  port?: number;
  logger?: GradingLogger;
}

const json = (body: unknown, status = 200): Response =>
  Response.json(body, {
    status,
    // No caching: the queue changes on every grade, and a cached /api/queue is
    // how an operator re-grades an item they already handled.
    headers: { "Cache-Control": "no-store" },
  });

/**
 * Read and validate a JSON body.
 *
 * Hand-rolled rather than zod only because the shape is three optional string
 * fields and each one has a bespoke error message the operator sees; the
 * validation that matters (parseReviewAction, parseGradedBy) lives in
 * candidate-review.ts where it is unit-testable without a request.
 */
async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ReviewInputError("body must be valid JSON");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ReviewInputError("body must be a JSON object");
  }
  return raw as Record<string, unknown>;
}

function requireId(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ReviewInputError("id is required");
  }
  // Shape-check before it reaches the query: a non-uuid string makes Postgres
  // raise 22P02, which would surface as a 500 for what is a client mistake.
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(value.trim())) {
    throw new ReviewInputError("id must be a uuid");
  }
  return value.trim();
}

/**
 * Build the request handler.
 *
 * Exported separately from `startGradingServer` so a test can exercise every
 * route by calling it with a `Request` -- no socket, no port allocation, no
 * teardown race.
 */
export function makeGradingHandler(
  options: GradingServerOptions,
): (req: Request) => Promise<Response> {
  const { pool, namespace, gradedBy } = options;
  const log = options.logger;

  // Validated ONCE at construction, not per request. A machine-shaped
  // gradedBy is a misconfiguration of the whole process, and discovering it on
  // the first grade -- after the operator has already read the item and made
  // the call -- wastes the only scarce resource here (dream-design.md:825-827).
  const grader = parseGradedBy(gradedBy);

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const started = performance.now();

    try {
      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        return new Response(GRADING_PAGE_HTML, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }

      if (req.method === "GET" && path === "/health") {
        return json({ status: "ok", namespace, graded_by: grader });
      }

      if (req.method === "GET" && path === "/api/queue") {
        const limit = clampLimit(url.searchParams.get("limit"));
        const offset = clampOffset(url.searchParams.get("offset"));
        const result = await fetchQueue(pool, { namespace, limit, offset });
        log?.info("grading queue read", {
          namespace,
          limit,
          offset,
          returned: result.items.length,
          ungraded_total: result.total,
          // An item with no context cannot be judged (see ReviewItem.context).
          // Counted on every read so the gap is visible rather than something
          // the operator discovers one card at a time.
          without_context: result.items.filter((i) => i.context.length === 0)
            .length,
          duration_ms: Math.round(performance.now() - started),
        });
        return json(result);
      }

      if (req.method === "GET" && path === "/api/inconclusive") {
        const limit = clampLimit(url.searchParams.get("limit"));
        const offset = clampOffset(url.searchParams.get("offset"));
        const result = await fetchInconclusive(pool, {
          namespace,
          limit,
          offset,
        });
        log?.info("grading inconclusive read", {
          namespace,
          returned: result.items.length,
          total: result.total,
          duration_ms: Math.round(performance.now() - started),
        });
        return json(result);
      }

      if (req.method === "GET" && path === "/api/stats") {
        const stats = await fetchStats(pool, { namespace });
        return json(stats);
      }

      if (req.method === "POST" && path === "/api/grade") {
        const body = await readJsonBody(req);
        // A body carrying machine_grade is rejected, not ignored. Ignoring it
        // would let a caller believe it had recorded a machine opinion here;
        // 037:43-57 makes that path REM's alone, and a silent no-op is how a
        // wrong assumption survives.
        if ("machine_grade" in body || "machine_grade_model" in body) {
          throw new ReviewInputError(
            "machine_grade is not writable through the grading API -- it is REM's column (037:43-57); this endpoint writes only the human review_action",
            403,
          );
        }
        const id = requireId(body.id);
        const action = parseReviewAction(body.action);
        const note = typeof body.note === "string" ? body.note : null;
        const result = await gradeCandidate(pool, {
          namespace,
          id,
          action,
          gradedBy: grader,
          note,
        });
        if (!result) {
          log?.warn("grade target not found", { namespace, candidate_id: id });
          return json({ error: "candidate not found in this namespace" }, 404);
        }
        log?.info("candidate graded", {
          namespace,
          candidate_id: result.id,
          action: result.review_action,
          graded_by: result.graded_by,
          machine_grade: result.machine_grade,
          agreed: result.agreed,
          has_note: note !== null && note.trim() !== "",
          duration_ms: Math.round(performance.now() - started),
        });
        return json(result);
      }

      if (req.method === "POST" && path === "/api/ungrade") {
        const body = await readJsonBody(req);
        const id = requireId(body.id);
        const result = await ungradeCandidate(pool, { namespace, id });
        if (!result) {
          return json(
            { error: "candidate not found, or was never graded" },
            404,
          );
        }
        log?.info("candidate ungraded", { namespace, candidate_id: result.id });
        return json(result);
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      if (err instanceof ReviewInputError) {
        log?.warn("grading request rejected", {
          namespace,
          path,
          status: err.status,
          reason: err.message,
        });
        return json({ error: err.message }, err.status);
      }
      // Message only, never the stack or the query: a pg error can echo
      // parameter values, and those parameters are dialogue content.
      log?.error("grading request failed", {
        namespace,
        path,
        error: err instanceof Error ? err.message : String(err),
      });
      return json({ error: "internal error" }, 500);
    }
  };
}

export interface RunningGradingServer {
  url: string;
  port: number;
  stop: () => Promise<void>;
}

/** Start the listener. Loopback only; see GRADING_BIND_HOST. */
export function startGradingServer(
  options: GradingServerOptions,
): RunningGradingServer {
  const handler = makeGradingHandler(options);
  const server = Bun.serve({
    hostname: GRADING_BIND_HOST,
    port: options.port ?? DEFAULT_GRADING_PORT,
    fetch: handler,
  });
  // Read back from the listener rather than echoing the requested port: port 0
  // means "any free port", and a test that binds 0 must learn the real one.
  const boundPort = Number(server.port);
  const url = `http://${GRADING_BIND_HOST}:${boundPort}/`;
  options.logger?.info("grading server listening", {
    url,
    namespace: options.namespace,
    graded_by: options.gradedBy,
  });
  return {
    url,
    port: boundPort,
    stop: async () => {
      await server.stop(true);
    },
  };
}
