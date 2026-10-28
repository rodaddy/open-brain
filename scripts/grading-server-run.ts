/**
 * Start the candidate grading page. Issue #394.
 *
 * The operator entrypoint. A thin shell over
 * server/application/grading-server.ts, exactly as scripts/dream-light-run.ts is
 * a thin shell over src/dream-light.ts -- the logic and the SQL live in a module
 * a test can reach without a socket.
 *
 * Usage:
 *   node scripts/grading-server-run.ts
 *   node scripts/grading-server-run.ts --namespace dana --port 3400
 *   GRADED_BY="dana" node scripts/grading-server-run.ts
 *
 * Database credentials come from the environment the same way every other
 * script here reads them (DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD). For the
 * dogfood clone:
 *   set -a; . /opt/open-brain-local/local-clone.env; set +a
 *
 * The listener is loopback-only and not configurable (see GRADING_BIND_HOST).
 */

import { createPool, logger } from "./settings.ts";
import { loadFrozenCohort } from "./rem-ethereal-cohort.ts";
import { createFrozenReviewHandler } from "./rem-frozen-grading-handler.ts";
import {
  parseGradingServerRunConfig,
  startWithPoolCleanup,
} from "./grading-server-run-config.ts";
import { startGradingServer } from "../server/application/grading-server.ts";

/**
 * The namespace to grade in. Required by value, never inferred from the
 * database: picking "whichever namespace has the most rows" would silently
 * change which operator's candidates are on screen when a second namespace
 * starts producing. Defaults only from an explicit env var.
 */
const { namespace, gradedBy, port, frozenSchema } = parseGradingServerRunConfig();

/**
 * Who is grading. Lands in candidate_memory.graded_by, which 037:83-86 defines
 * as the HUMAN label -- the ground truth a future automated promoter is
 * measured against. src/candidate-review.ts rejects a machine-shaped value at
 * server construction rather than on the first grade.
 */
const pool = createPool();

let probe: { rows: Array<{ ungraded: string; total: string }> } | undefined;
let frozenReviewHandler: ((request: Request) => Promise<Response>) | undefined;
try {
  if (frozenSchema) {
    // Validate count, ordering, namespace, and digest before the port exists.
    await loadFrozenCohort(pool, frozenSchema, namespace);
    frozenReviewHandler = createFrozenReviewHandler({
      pool,
      schema: frozenSchema,
      namespace,
      gradedBy,
    });
  } else {
    // Fail before binding a port if the database is unreachable or the table is
    // missing. An empty page after a query failure looks like an empty queue.
    probe = await pool.query<{ ungraded: string; total: string }>(
      `SELECT count(*) AS total, count(*) FILTER (WHERE reviewed_at IS NULL) AS ungraded
         FROM candidate_memory WHERE namespace = $1`,
      [namespace],
    );
  }
} catch (error: unknown) {
  await pool.end();
  throw error;
}

// The listener fails hard with EADDRINUSE and a stack trace when the port is
// taken, which is a poor greeting for the one person this page exists for --
// and it happens in practice: an unrelated process already holds 3400 on this
// machine. Turn it into an instruction. Since #751 the bind is node:http, whose
// clash arrives on an asynchronous 'error' event; startGradingServer surfaces
// it as a REJECTION, so this catch needs the await and nothing else changes.
let server;
try {
  server = await startWithPoolCleanup(
    () =>
      startGradingServer({
        pool,
        namespace,
        gradedBy,
        port,
        logger,
        frozenReviewHandler,
      }),
    () => pool.end(),
  );
} catch (err) {
  // `code` first: node and bun's node:http shim word the SAME clash
  // differently ("listen EADDRINUSE: address already in use" vs "Failed to
  // start server. Is port N in use?"), and both set code EADDRINUSE. The
  // message tests stay as a fallback for anything that loses the code.
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "EADDRINUSE" || msg.includes("EADDRINUSE") || msg.includes("in use")) {
    console.error(`\n  Port ${port} is already in use.`);
    console.error(
      `  Pick another:  node scripts/grading-server-run.ts --port ${port + 1}\n`,
    );
    process.exit(1);
  }
  throw err;
}

console.log("");
console.log("  Open Brain -- candidate grading");
console.log("  ------------------------------------------------------------");
console.log("  URL         ", server.url);
console.log("  namespace   ", namespace);
console.log("  graded_by   ", gradedBy);
if (probe) {
  console.log(
    "  ungraded    ",
    probe.rows[0]?.ungraded ?? "0",
    "of",
    probe.rows[0]?.total ?? "0",
  );
}
// Only bindings the page actually has. It used to advertise "u undo", which was
// bound to nothing -- undo is a button behind a confirm dialog, deliberately, so
// a single keystroke cannot retract a committed batch. A banner that names a key
// that does nothing teaches the operator to distrust the whole line.
console.log("  keys         1 pass · 2 fail · 3 inconclusive · 4 duplicate");
console.log(
  "               enter stage · ctrl+enter SEND · esc reset · n note · ←/→ move",
);
// Both new axes get a line, for the same reason the "u undo" line was removed:
// the banner is the operator's only map of what the keys do, so an accelerator
// that exists but is unnamed is as useless as a name bound to nothing.
console.log(
  "  reasons      q/w/e/r fill the note with a canned reason (editable, code kept)",
);
console.log(
  "  agent axis   g good · b bad · v neutral -- SEPARATE from the grade, optional",
);
console.log("  undo/change  buttons on the page (nothing is sent until SEND)");
console.log("  ------------------------------------------------------------");
console.log("");

const shutdown = async (signal: string): Promise<void> => {
  logger.info("grading server stopping", { signal });
  await server.stop();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
