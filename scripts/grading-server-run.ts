/**
 * Start the candidate grading page. Issue #394.
 *
 * The operator entrypoint. A thin shell over src/grading-server.ts, exactly as
 * scripts/dream-light-run.ts is a thin shell over src/dream-light.ts -- the
 * logic and the SQL live in src/ where a test can reach them without a socket.
 *
 * Usage:
 *   bun scripts/grading-server-run.ts
 *   bun scripts/grading-server-run.ts --namespace rico --port 3400
 *   GRADED_BY="rico" bun scripts/grading-server-run.ts
 *
 * Database credentials come from the environment the same way every other
 * script here reads them (DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD). For the
 * dogfood clone:
 *   set -a; . /path/to/open-brain/open-brain-local/local-clone.env; set +a
 *
 * The listener is loopback-only and not configurable (see GRADING_BIND_HOST).
 */

import { Pool } from "pg";
import { logger } from "../src/logger.ts";
import {
  DEFAULT_GRADING_PORT,
  startGradingServer,
} from "../src/grading-server.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * The namespace to grade in. Required by value, never inferred from the
 * database: picking "whichever namespace has the most rows" would silently
 * change which operator's candidates are on screen when a second namespace
 * starts producing. Defaults only from an explicit env var.
 */
const namespace =
  arg("--namespace") ?? process.env.OB_GRADING_NAMESPACE ?? "rico";

/**
 * Who is grading. Lands in candidate_memory.graded_by, which 037:83-86 defines
 * as the HUMAN label -- the ground truth a future automated promoter is
 * measured against. src/candidate-review.ts rejects a machine-shaped value at
 * server construction rather than on the first grade.
 */
const gradedBy = arg("--graded-by") ?? process.env.GRADED_BY ?? "rico";

const port = Number(
  arg("--port") ?? process.env.GRADING_PORT ?? DEFAULT_GRADING_PORT,
);

const pool = new Pool({
  host: process.env.DB_HOST ?? "127.0.0.1",
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD || undefined,
});

// Fail before binding a port if the database is unreachable or the table is
// missing. A listener that serves an empty page because the query throws is
// indistinguishable from a genuinely empty queue, and the operator would grade
// nothing while believing there was nothing to grade.
const probe = await pool.query<{ ungraded: string; total: string }>(
  `SELECT count(*) AS total, count(*) FILTER (WHERE reviewed_at IS NULL) AS ungraded
     FROM candidate_memory WHERE namespace = $1`,
  [namespace],
);

// Bun.serve throws EADDRINUSE with a stack trace when the port is taken, which
// is a poor greeting for the one person this page exists for -- and it happens
// in practice: an unrelated process already holds 3400 on this machine. Turn it
// into an instruction.
let server;
try {
  server = startGradingServer({ pool, namespace, gradedBy, port, logger });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("EADDRINUSE") || msg.includes("in use")) {
    console.error(`\n  Port ${port} is already in use.`);
    console.error(
      `  Pick another:  bun scripts/grading-server-run.ts --port ${port + 1}\n`,
    );
    await pool.end();
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
console.log(
  "  ungraded    ",
  probe.rows[0]?.ungraded ?? "0",
  "of",
  probe.rows[0]?.total ?? "0",
);
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
