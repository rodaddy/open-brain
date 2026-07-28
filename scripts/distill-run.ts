/**
 * Run DISTILL sweeps against the configured database. Issue #382.
 *
 * Operator entrypoint for the stage that turns raw turns into candidate_memory
 * proposals. Exists for the same reason scripts/dream-light-run.ts does: the
 * standing rule in this repo is that a stage is not proven until it has run
 * bottom-to-top against the REAL database, not fixtures.
 *
 * Usage:
 *   bun scripts/distill-run.ts --stats             # read-only report
 *   bun scripts/distill-run.ts                     # one bounded sweep
 *   bun scripts/distill-run.ts --all               # drain the backlog
 *   bun scripts/distill-run.ts --all --no-embed    # drain without the provider
 *   bun scripts/distill-run.ts --sessions 2        # smaller bounded sweep
 *   bun scripts/distill-run.ts --sample 20         # print 20 written candidates
 *
 * --stats and --sample are read-only and safe at any time. Everything else
 * writes to candidate_memory and stamps ob_raw_turns.distilled_at.
 *
 * --no-embed exists because the embedding provider is a local MLX daemon that
 * is not always up, and a candidate written with a NULL embedding is a normal,
 * repairable state (embedding.repair, #345) -- not a reason to refuse to
 * distill. Without the flag the sweep still tolerates a provider outage; the
 * flag just skips the per-candidate 8s timeout when the outage is known.
 */

import { Pool } from "pg";
import { runDistillSweep } from "../src/distill-handler.ts";
import { RULE_BASED_DISTILLER_NAME } from "../src/distiller.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(name);

// The maintenance-queue logger shape: info/warn/error with structured fields.
const logger = {
  info: (msg: string, fields: Record<string, string | number>) =>
    console.log(msg, JSON.stringify(fields)),
  warn: (msg: string, fields: Record<string, string | number>) =>
    console.warn(msg, JSON.stringify(fields)),
  error: (msg: string, fields: Record<string, string | number>) =>
    console.error(msg, JSON.stringify(fields)),
};

async function stats(pool: Pool): Promise<void> {
  const q = await pool.query(
    `SELECT
       (SELECT count(*) FROM ob_raw_turns) AS turns_total,
       (SELECT count(*) FROM ob_raw_turns WHERE distilled_at IS NULL) AS turns_undistilled,
       (SELECT count(*) FROM ob_raw_turns WHERE session_seq IS NULL) AS turns_no_seq,
       (SELECT count(*) FROM candidate_memory) AS candidates,
       (SELECT count(*) FROM candidate_memory WHERE reviewed_at IS NULL) AS unreviewed,
       (SELECT count(*) FROM candidate_memory WHERE uncertain) AS uncertain,
       (SELECT count(*) FROM candidate_memory WHERE embedding IS NULL) AS no_embedding`,
  );
  const r = q.rows[0];
  console.log("turns total        :", r.turns_total);
  console.log("turns undistilled  :", r.turns_undistilled);
  console.log("turns w/o session_seq:", r.turns_no_seq);
  console.log("candidates         :", r.candidates);
  console.log("  unreviewed       :", r.unreviewed);
  console.log("  uncertain        :", r.uncertain);
  console.log("  NULL embedding   :", r.no_embedding);

  const byType = await pool.query(
    `SELECT candidate_type, count(*) AS n,
            count(*) FILTER (WHERE uncertain) AS uncertain
       FROM candidate_memory GROUP BY 1 ORDER BY 2 DESC`,
  );
  for (const row of byType.rows) {
    console.log(
      `  ${row.candidate_type.padEnd(11)}: ${row.n} (${row.uncertain} uncertain)`,
    );
  }
}

/** Print candidates for the human read-through that closes #382's acceptance. */
async function sample(pool: Pool, n: number): Promise<void> {
  const q = await pool.query(
    `SELECT candidate_type, uncertain, left(content, 400) AS content,
            cardinality(source_turn_ids) AS sources, model
       FROM candidate_memory
      ORDER BY random() LIMIT $1`,
    [n],
  );
  for (const row of q.rows) {
    console.log(
      `\n--- ${row.candidate_type}${row.uncertain ? " (uncertain)" : ""} | ${row.sources} source turn(s) | ${row.model}`,
    );
    console.log(row.content);
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
    if (has("--stats")) return await stats(pool);
    if (has("--sample"))
      return await sample(pool, Number(arg("--sample") ?? 20));

    const maxSessions = Number(arg("--sessions") ?? 4);
    const totals = {
      sweeps: 0,
      units: 0,
      turns_stamped: 0,
      candidates_extracted: 0,
      candidates_written: 0,
      candidates_duplicate: 0,
      candidates_uncertain: 0,
      embeddings_missing: 0,
      missing_session_seq: 0,
    };

    // --all drains the backlog; a bare run does exactly one bounded sweep. The
    // loop exits on a sweep that stamped nothing, which is also the natural
    // no-op when everything is already distilled.
    for (;;) {
      const s = await runDistillSweep({
        pool,
        logger,
        maxSessions,
        ...(has("--no-embed") ? { skipEmbeddings: true } : {}),
      });
      totals.sweeps++;
      totals.units += s.units;
      totals.turns_stamped += s.turns_stamped;
      totals.candidates_extracted += s.candidates_extracted;
      totals.candidates_written += s.candidates_written;
      totals.candidates_duplicate += s.candidates_duplicate;
      totals.candidates_uncertain += s.candidates_uncertain;
      totals.embeddings_missing += s.embeddings_missing;
      totals.missing_session_seq += s.missing_session_seq;
      if (s.turns_stamped === 0 || !has("--all")) break;
    }

    console.log("\n=== distill totals ===");
    console.log("model                :", RULE_BASED_DISTILLER_NAME);
    for (const [k, v] of Object.entries(totals)) {
      console.log(k.padEnd(21), ":", v);
    }
    console.log();
    await stats(pool);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("distill run failed:", err);
  process.exit(1);
});
