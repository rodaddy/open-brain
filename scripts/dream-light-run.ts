/**
 * Run DREAM Light sweeps against the configured database. Issue #390.
 *
 * Operator entrypoint for the always-on, model-free stage. Exists so Light can
 * be exercised and measured against the REAL corpus rather than fixtures --
 * the standing rule for this repo is that a stage is not proven until it has
 * run bottom-to-top against the real database.
 *
 * Usage:
 *   bun scripts/dream-light-run.ts                # one sweep, default batch
 *   bun scripts/dream-light-run.ts --batch 100    # one sweep, bounded
 *   bun scripts/dream-light-run.ts --all          # sweep until the queue drains
 *   bun scripts/dream-light-run.ts --stats        # report only, no writes
 *
 * --stats is read-only and safe at any time. Everything else writes to
 * content_occurrences and stamps ob_raw_turns.light_swept_at.
 */

import { Pool } from "pg";
import { runLightSweep, DEFAULT_LIGHT_BATCH_SIZE } from "../src/dream-light.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(name);

const logger = {
  info: (msg: string, meta?: Record<string, unknown>) =>
    console.log(msg, meta ? JSON.stringify(meta) : ""),
  warn: (msg: string, meta?: Record<string, unknown>) =>
    console.warn(msg, meta ? JSON.stringify(meta) : ""),
};

async function stats(pool: Pool): Promise<void> {
  const q = await pool.query<{
    total: string;
    unswept: string;
    occurrences: string;
    corroborated: string;
    max_sessions: string;
  }>(
    `SELECT
       (SELECT count(*) FROM ob_raw_turns) AS total,
       (SELECT count(*) FROM ob_raw_turns WHERE light_swept_at IS NULL) AS unswept,
       (SELECT count(*) FROM content_occurrences) AS occurrences,
       (SELECT count(*) FROM content_occurrences WHERE session_count > 1) AS corroborated,
       (SELECT coalesce(max(session_count), 0) FROM content_occurrences) AS max_sessions`,
  );
  const r = q.rows[0]!;
  console.log("turns total       :", r.total);
  console.log("turns unswept     :", r.unswept);
  console.log("occurrence rows   :", r.occurrences);
  console.log("cross-session (>1):", r.corroborated);
  console.log("max session_count :", r.max_sessions);
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

    const batchSize = Number(arg("--batch") ?? DEFAULT_LIGHT_BATCH_SIZE);
    const totals = {
      scanned: 0,
      skipped_noise: 0,
      created: 0,
      updated: 0,
      corroborated: 0,
    };
    let sweeps = 0;

    // --all drains the queue; a bare run does exactly one bounded sweep. The
    // loop exits on a zero-scan sweep, which is also the natural no-op when
    // everything is already swept.
    for (;;) {
      const s = await runLightSweep({ pool, logger, batchSize });
      sweeps++;
      totals.scanned += s.scanned;
      totals.skipped_noise += s.skipped_noise;
      totals.created += s.created;
      totals.updated += s.updated;
      totals.corroborated += s.corroborated;
      if (s.scanned === 0 || !has("--all")) break;
    }

    console.log("\n=== light sweep totals ===");
    console.log("sweeps       :", sweeps);
    console.log("scanned      :", totals.scanned);
    console.log("skipped noise:", totals.skipped_noise);
    console.log("created      :", totals.created);
    console.log("updated      :", totals.updated);
    console.log("corroborated :", totals.corroborated);
    console.log();
    await stats(pool);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("dream light run failed:", err);
  process.exit(1);
});
