/**
 * Run one DREAM REM pass against the configured database. Issues #391/#392/#398.
 *
 * Operator entrypoint, same shape as scripts/dream-light-run.ts: a thin shell
 * over src/dream-rem.ts that opens its own pool. Exists so REM can be measured
 * against the REAL corpus, which is this repo's standing bar for calling a
 * stage proven.
 *
 * Usage:
 *   bun scripts/dream-rem-run.ts                 # full pass: dedupe, grade, re-warm
 *   bun scripts/dream-rem-run.ts --batch 100     # bound the grading batch
 *   bun scripts/dream-rem-run.ts --no-dedupe     # skip the #398 merge
 *   bun scripts/dream-rem-run.ts --no-rewarm     # skip the #392 tier flips
 *   bun scripts/dream-rem-run.ts --stats         # report only, no writes
 *
 * WHAT THIS WRITES, exhaustively: candidate_memory.machine_grade +
 * machine_grade_model, candidate_reinforcement rows, candidate_memory
 * last_said_at, thoughts.tier -> 'hot'. It never writes review_action,
 * reviewed_at, or graded_by -- those are the operator's, and a machine writing
 * them would drop the item out of the human queue (037:43-57).
 */

import { Pool } from "pg";
import { runRemPass, DEFAULT_REM_BATCH } from "../src/dream-rem.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(name);

const logger = {
  info: (msg: string, fields: Record<string, string | number>) =>
    console.log(msg, JSON.stringify(fields)),
  warn: (msg: string, fields: Record<string, string | number>) =>
    console.warn(msg, JSON.stringify(fields)),
  error: (msg: string, fields: Record<string, string | number>) =>
    console.error(msg, JSON.stringify(fields)),
};

async function stats(pool: Pool): Promise<void> {
  const q = await pool.query<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM candidate_memory) AS candidates,
       (SELECT count(*) FROM candidate_memory WHERE reviewed_at IS NULL) AS unreviewed,
       (SELECT count(*) FROM candidate_memory WHERE machine_grade IS NOT NULL) AS machine_graded,
       (SELECT count(*) FROM candidate_memory WHERE uncertain) AS uncertain,
       (SELECT count(*) FROM candidate_memory WHERE embedding IS NULL) AS no_embedding,
       (SELECT count(*) FROM candidate_reinforcement) AS reinforcements,
       (SELECT count(*) FROM thoughts WHERE tier = 'hot') AS hot_thoughts`,
  );
  const r = q.rows[0]!;
  console.log("candidates      :", r.candidates);
  console.log("unreviewed      :", r.unreviewed);
  console.log("machine graded  :", r.machine_graded);
  console.log("uncertain       :", r.uncertain);
  console.log("no embedding    :", r.no_embedding);
  console.log("reinforcements  :", r.reinforcements);
  console.log("hot thoughts    :", r.hot_thoughts);
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
    if (has("--stats")) {
      await stats(pool);
      return;
    }

    const summary = await runRemPass({
      pool,
      logger,
      batchSize: Number(arg("--batch") ?? DEFAULT_REM_BATCH),
      ...(has("--no-dedupe") ? { skipDedupe: true } : {}),
      ...(has("--no-rewarm") ? { skipRewarm: true } : {}),
    });

    console.log("\n=== REM pass ===");
    console.log("-- dedupe (#398)");
    console.log("  examined       :", summary.dedupe.examined);
    console.log("  merged         :", summary.dedupe.merged);
    console.log("  reinforced     :", summary.dedupe.reinforced);
    console.log("  no embedding   :", summary.dedupe.skipped_no_embedding);
    console.log("-- grading");
    console.log("  examined       :", summary.grading.examined);
    console.log("  graded         :", summary.grading.graded);
    console.log("  corroborated   :", summary.grading.corroborated);
    console.log("  -> promoted    :", summary.grading.by_grade.promoted);
    console.log("  -> rejected    :", summary.grading.by_grade.rejected);
    console.log("  -> duplicate   :", summary.grading.by_grade.duplicate);
    console.log("  -> inconclusive:", summary.grading.by_grade.inconclusive);
    console.log("-- re-warming (#392)");
    console.log("  projects seen  :", summary.rewarm.projects_seen);
    console.log("  noticed only   :", summary.rewarm.noticed_only);
    console.log("  warmed         :", summary.rewarm.warmed);
    console.log();
    await stats(pool);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("dream rem run failed:", err);
  process.exit(1);
});
