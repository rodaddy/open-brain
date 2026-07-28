/**
 * Build DREAM Deep review bundles and print them. Issue #394.
 *
 * READ-ONLY. This script mutates nothing -- src/dream-deep.ts issues only
 * SELECTs, and grading is the operator's act on the review page, not this
 * script's. Safe to run at any time.
 *
 * Usage:
 *   bun scripts/dream-deep-run.ts                # 20 bundles, human-readable
 *   bun scripts/dream-deep-run.ts --limit 5      # a smaller page
 *   bun scripts/dream-deep-run.ts --json         # the raw bundle payload
 *   bun scripts/dream-deep-run.ts --summary      # counts only
 *
 * --json is the shape the grading page consumes, so this doubles as a way to
 * inspect exactly what that page will receive without starting a server.
 */

import { Pool } from "pg";
import {
  buildReviewBundles,
  DEFAULT_BUNDLE_LIMIT,
  type ReviewBundle,
} from "../src/dream-deep.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(name);

const logger = {
  info: (msg: string, fields: Record<string, string | number>) =>
    console.error(msg, JSON.stringify(fields)),
  warn: (msg: string, fields: Record<string, string | number>) =>
    console.error(msg, JSON.stringify(fields)),
  error: (msg: string, fields: Record<string, string | number>) =>
    console.error(msg, JSON.stringify(fields)),
};

/** Truncate for terminal display only. The bundle itself is never truncated. */
function clip(text: string, n: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : `${flat.slice(0, n)}…`;
}

function render(bundle: ReviewBundle, index: number): void {
  const c = bundle.candidate;
  console.log(
    `\n--- [${index + 1}] ${c.candidate_type}${c.uncertain ? " (uncertain)" : ""}`,
  );
  console.log(`    id        : ${c.id}`);
  console.log(`    content   : ${clip(c.content, 300)}`);
  if (c.uncertainty_reason) {
    console.log(`    doubt     : ${clip(c.uncertainty_reason, 160)}`);
  }
  console.log(
    `    said      : ${c.first_said_at ?? "?"} -> ${c.last_said_at ?? "?"}`,
  );
  // Receipts, not a score (dream-design.md:709-712).
  console.log(
    `    evidence  : ${bundle.corroboration.session_count} session(s), ` +
      `${bundle.corroboration.occurrence_count} occurrence(s), ` +
      `${bundle.reinforcement.count} restatement(s)`,
  );
  console.log(
    `    machine   : ${bundle.machine.grade ?? "ungraded"}` +
      (bundle.machine.model ? ` (${bundle.machine.model})` : ""),
  );
  console.log(`    turns     : ${bundle.turns.length}`);
  for (const turn of bundle.turns) {
    const marker = turn.is_source ? ">>" : "  ";
    console.log(
      `      ${marker} [${turn.role ?? "?"}#${turn.session_seq ?? "?"}] ${clip(turn.content, 120)}`,
    );
  }
}

async function main(): Promise<void> {
  const pool = new Pool({
    host: process.env.DB_HOST ?? "127.0.0.1",
    port: Number(process.env.DB_PORT ?? 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || undefined,
  });

  try {
    const { bundles, summary } = await buildReviewBundles({
      pool,
      logger,
      limit: Number(arg("--limit") ?? DEFAULT_BUNDLE_LIMIT),
    });

    if (has("--json")) {
      console.log(JSON.stringify(bundles, null, 2));
      return;
    }

    if (!has("--summary")) {
      if (bundles.length === 0) {
        // The day-one state, and a legitimate one: an empty queue means every
        // candidate has been graded, not that something failed.
        console.log("review queue empty -- nothing unreviewed.");
      }
      bundles.forEach(render);
    }

    console.log("\n=== deep bundle summary ===");
    console.log("bundles       :", summary.bundles);
    console.log("queue depth   :", summary.queue_depth);
    console.log("machine graded:", summary.machine_graded);
    console.log("corroborated  :", summary.corroborated);
    console.log("reinforced    :", summary.reinforced);
    console.log("missing turns :", summary.missing_turns);
    // The attention budget is the real constraint (dream-design.md:823-827):
    // 20 is reviewable, 200 gets skipped. Say so when the queue is deep.
    if (summary.queue_depth > summary.bundles) {
      console.log(
        `\n${summary.queue_depth - summary.bundles} candidate(s) behind this page. ` +
          `Capped at ${summary.bundles} because a page nobody opens grades nothing.`,
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("dream deep run failed:", err);
  process.exit(1);
});
