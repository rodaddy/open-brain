/**
 * Run the whole DREAM cycle in order and print counts per stage.
 *
 * Distill (#382) -> Light (#390) -> REM (#391/#392/#398) -> Deep (#394).
 *
 * WHY ONE SCRIPT WHEN EACH STAGE ALREADY HAS ONE. The per-stage scripts prove a
 * stage. This one proves the PIPELINE, which is a different claim: that a turn
 * captured at one end reaches the operator's review queue at the other, with
 * its provenance intact. That end-to-end path is what #382/#390/#391/#394
 * collectively exist to produce and it is the thing that was never demonstrated
 * -- 3,795 turns captured, 0 reviewed.
 *
 * ORDER IS LOAD-BEARING, not cosmetic:
 *
 *   1. DISTILL turns into candidates. Nothing downstream has input without it.
 *   2. LIGHT counts occurrences. It must run before REM grades, because
 *      corroboration is REM's strongest signal and a candidate graded before
 *      its evidence was counted is graded permanently (grading is idempotent on
 *      machine_grade IS NULL).
 *   3. REM merges near-dupes, grades, re-warms. Dedupe before grading, for the
 *      same reason -- see src/dream-rem.ts runRemPass.
 *   4. DEEP builds the review page. Read-only; it commits nothing.
 *
 * NO STAGE SUPPRESSES ANYTHING. That is the 2026-07-28 governing decision and
 * it is checkable from this script's own output: the Deep queue depth should
 * equal the number of candidates written minus the number the operator has
 * graded, with the merge count as the only other subtraction -- and a merge is
 * reversible and keeps the claim (037:59-63, src/candidate-dedupe.ts).
 *
 * Usage:
 *   bun scripts/dream-cycle.ts                 # one bounded pass of each stage
 *   bun scripts/dream-cycle.ts --drain         # loop distill+light until empty
 *   bun scripts/dream-cycle.ts --no-distill    # skip distillation
 *   bun scripts/dream-cycle.ts --no-embeddings # distill without the embed call
 *   bun scripts/dream-cycle.ts --dry           # counts before/after only, no writes
 */

import type { Pool } from "pg";
import { runDistillSweep } from "../server/maintenance/distill-handler.ts";
import {
  runLightSweep,
  readLightQueueDepth,
} from "../server/maintenance/dream-light.ts";
import { runRemPass } from "../server/maintenance/dream-rem.ts";
import { createDreamRemRepository } from "../server/db/dream-rem-repository.ts";
import { createDreamRemGradingRepository } from "../server/db/dream-rem-grading-repository.ts";
import { createDreamDeepRepository } from "../server/db/dream-deep-repository.ts";
import {
  buildReviewBundles,
  DEFAULT_BUNDLE_LIMIT,
} from "../server/maintenance/dream-deep.ts";
import { createPool } from "./settings.ts";
import { arg, createConsoleLogger, has } from "./run-support/argv.ts";

// Stage output is indented and marked so it reads beneath its stage heading.
const logger = createConsoleLogger({
  prefix: { info: "  · ", warn: "  ! ", error: "  ✗ " },
});

interface Snapshot {
  turns: number;
  undistilled: number;
  unswept: number;
  occurrences: number;
  corroborated: number;
  candidates: number;
  unreviewed: number;
  machine_graded: number;
  reinforcements: number;
  hot_thoughts: number;
}

async function snapshot(pool: Pool): Promise<Snapshot> {
  const q = await pool.query<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM ob_raw_turns) AS turns,
       (SELECT count(*) FROM ob_raw_turns WHERE distilled_at IS NULL) AS undistilled,
       (SELECT count(*) FROM ob_raw_turns WHERE light_swept_at IS NULL) AS unswept,
       (SELECT count(*) FROM content_occurrences) AS occurrences,
       (SELECT count(*) FROM content_occurrences WHERE session_count > 1) AS corroborated,
       (SELECT count(*) FROM candidate_memory) AS candidates,
       (SELECT count(*) FROM candidate_memory WHERE reviewed_at IS NULL) AS unreviewed,
       (SELECT count(*) FROM candidate_memory WHERE machine_grade IS NOT NULL) AS machine_graded,
       (SELECT count(*) FROM candidate_reinforcement) AS reinforcements,
       (SELECT count(*) FROM thoughts WHERE tier = 'hot') AS hot_thoughts`,
  );
  const r = q.rows[0] ?? {};
  return {
    turns: Number(r.turns),
    undistilled: Number(r.undistilled),
    unswept: Number(r.unswept),
    occurrences: Number(r.occurrences),
    corroborated: Number(r.corroborated),
    candidates: Number(r.candidates),
    unreviewed: Number(r.unreviewed),
    machine_graded: Number(r.machine_graded),
    reinforcements: Number(r.reinforcements),
    hot_thoughts: Number(r.hot_thoughts),
  };
}

function delta(before: number, after: number): string {
  const d = after - before;
  return d === 0 ? `${after}` : `${after} (${d > 0 ? "+" : ""}${d})`;
}

/** Every snapshot row printed, in display order, with its indented label. */
const SNAPSHOT_ROWS: ReadonlyArray<readonly [string, keyof Snapshot]> = [
  ["raw turns        ", "turns"],
  ["  undistilled    ", "undistilled"],
  ["  unswept (light)", "unswept"],
  ["occurrence rows  ", "occurrences"],
  ["  cross-session  ", "corroborated"],
  ["candidates       ", "candidates"],
  ["  unreviewed     ", "unreviewed"],
  ["  machine graded ", "machine_graded"],
  ["reinforcements   ", "reinforcements"],
  ["hot thoughts     ", "hot_thoughts"],
];

function printSnapshot(label: string, s: Snapshot, prev?: Snapshot): void {
  console.log(`\n=== ${label} ===`);
  for (const [rowLabel, key] of SNAPSHOT_ROWS) {
    const value = prev ? delta(prev[key], s[key]) : s[key];
    console.log(`${rowLabel}:`, value);
  }
}

/** Stage 0: DISTILL (#382). Turns into candidates. */
async function runDistillStage(pool: Pool): Promise<void> {
  console.log("\n### distill (#382)");
  let sweeps = 0;
  const totals = { units: 0, stamped: 0, extracted: 0, written: 0, dup: 0 };
  for (;;) {
    const s = await runDistillSweep({
      pool,
      logger,
      ...(has("--no-embeddings") ? { skipEmbeddings: true } : {}),
    });
    sweeps++;
    totals.units += s.units;
    totals.stamped += s.turns_stamped;
    totals.extracted += s.candidates_extracted;
    totals.written += s.candidates_written;
    totals.dup += s.candidates_duplicate;
    if (s.turns_stamped === 0 || !has("--drain")) break;
  }
  console.log(
    `  sweeps=${sweeps} units=${totals.units} turns_stamped=${totals.stamped} ` +
      `extracted=${totals.extracted} written=${totals.written} duplicate=${totals.dup}`,
  );
}

/**
 * Stage 1: LIGHT (#390). Counts occurrences.
 *
 * It does NOT gate what REM sees -- see the measured delta at
 * src/dream-light.ts (readLightQueueDepth's doc comment): exactly one piece of
 * content in 3,558 turns had cross-session support, so using the count as a
 * gate would suppress 99.9% of the corpus.
 */
async function runLightStage(pool: Pool): Promise<void> {
  console.log("\n### light (#390)");
  let sweeps = 0;
  const totals = { scanned: 0, noise: 0, created: 0, updated: 0, corrob: 0 };
  for (;;) {
    const s = await runLightSweep({ pool, logger });
    sweeps++;
    totals.scanned += s.scanned;
    totals.noise += s.skipped_noise;
    totals.created += s.created;
    totals.updated += s.updated;
    totals.corrob += s.corroborated;
    if (s.scanned === 0 || !has("--drain")) break;
  }
  console.log(
    `  sweeps=${sweeps} scanned=${totals.scanned} skipped_noise=${totals.noise} ` +
      `created=${totals.created} updated=${totals.updated} corroborated=${totals.corrob}`,
  );
  const depth = await readLightQueueDepth(pool);
  console.log(
    `  queue: unswept=${depth.unswept} deferred_missing_timestamp=${depth.deferred_missing_timestamp} ` +
      `undistilled=${depth.undistilled} ` +
      `occurrence_rows=${depth.occurrence_rows} corroborated_rows=${depth.corroborated_rows}`,
  );
}

/** Stage 2: REM (#391/#392/#398). Dedupe, grade, re-warm. */
async function runRemStage(pool: Pool): Promise<void> {
  console.log("\n### rem (#391/#392/#398)");
  const rem = await runRemPass({
    pool,
    rem: createDreamRemRepository(pool),
    grading: createDreamRemGradingRepository(pool),
    logger,
  });
  console.log(
    `  dedupe: examined=${rem.dedupe.examined} merged=${rem.dedupe.merged} ` +
      `reinforced=${rem.dedupe.reinforced} no_embedding=${rem.dedupe.skipped_no_embedding}`,
  );
  console.log(
    `  grading: examined=${rem.grading.examined} graded=${rem.grading.graded} ` +
      `corroborated=${rem.grading.corroborated} ` +
      `[promoted=${rem.grading.by_grade.promoted} rejected=${rem.grading.by_grade.rejected} ` +
      `duplicate=${rem.grading.by_grade.duplicate} inconclusive=${rem.grading.by_grade.inconclusive}]`,
  );
  console.log(
    `  rewarm: projects=${rem.rewarm.projects_seen} noticed_only=${rem.rewarm.noticed_only} ` +
      `warmed=${rem.rewarm.warmed}`,
  );
}

/**
 * Stage 3: DEEP (#394). Builds the review page.
 *
 * Read-only. Produces the page; commits nothing (dream-design.md:116).
 */
async function runDeepStage(pool: Pool): Promise<void> {
  console.log("\n### deep (#394)");
  const deep = await buildReviewBundles({
    pool,
    deep: createDreamDeepRepository(pool),
    logger,
    limit: Number(arg("--limit") ?? DEFAULT_BUNDLE_LIMIT),
  });
  console.log(
    `  bundles=${deep.summary.bundles} queue_depth=${deep.summary.queue_depth} ` +
      `machine_graded=${deep.summary.machine_graded} corroborated=${deep.summary.corroborated} ` +
      `reinforced=${deep.summary.reinforced} missing_turns=${deep.summary.missing_turns}`,
  );
  const turnCounts = deep.bundles.map((b) => b.turns.length);
  if (turnCounts.length > 0) {
    const total = turnCounts.reduce((a, b) => a + b, 0);
    console.log(
      `  context: ${total} turns across ${turnCounts.length} bundles ` +
        `(min=${Math.min(...turnCounts)} max=${Math.max(...turnCounts)})`,
    );
  }
}

async function main(): Promise<void> {
  const pool = createPool();

  const started = Date.now();
  try {
    const before = await snapshot(pool);
    printSnapshot("before", before);

    if (has("--dry")) {
      console.log("\n--dry: no stage was run.");
      return;
    }

    if (!has("--no-distill")) await runDistillStage(pool);
    await runLightStage(pool);
    await runRemStage(pool);
    await runDeepStage(pool);

    const after = await snapshot(pool);
    printSnapshot("after", after, before);
    console.log(`\ncycle wall time: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("dream cycle failed:", err);
  process.exit(1);
});
