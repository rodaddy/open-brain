/**
 * Run EXCHANGE distillation against the configured database. Migration 041.
 *
 * Operator entrypoint for the re-cut unit, alongside scripts/distill-run.ts for
 * the original fragment unit. Exists for the standing reason in this repo: a
 * stage is not proven until it has run bottom-to-top against the REAL database,
 * not fixtures.
 *
 * Usage:
 *   bun scripts/distill-exchange-run.ts --stats           # read-only report
 *   bun scripts/distill-exchange-run.ts --dry-run         # cut, print, write nothing
 *   bun scripts/distill-exchange-run.ts --no-embed        # write without the provider
 *   bun scripts/distill-exchange-run.ts                   # write, with embeddings
 *   bun scripts/distill-exchange-run.ts --sample 5        # print written exchanges
 *   bun scripts/distill-exchange-run.ts --backfill-embeddings  # fill NULL vectors
 *
 * --stats, --dry-run and --sample are read-only. Only a bare run or --no-embed
 * writes, and both write ONLY new candidate_memory rows: nothing here deletes or
 * updates an existing candidate, and ob_raw_turns is never modified at all.
 */

import { Pool } from "pg";
import {
  runExchangeSweep,
  backfillExchangeEmbeddings,
} from "../src/distill-exchange-run.ts";
import {
  buildExchanges,
  prepareExchange,
  EXCHANGE_DISTILLER_NAME,
} from "../src/distill-exchange.ts";
import { DISTILL_ORDER_BY, type DistillTurn } from "../src/distill-window.ts";

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

/**
 * The measurement that motivated 041, recomputed live.
 *
 * Prints the by-speaker breakdown per unit_kind, so the defect (612 agent facts,
 * 0 operator) and the fix are visible in the same table rather than asserted.
 */
async function stats(pool: Pool): Promise<void> {
  const totals = await pool.query(
    `SELECT unit_kind,
            count(*) AS n,
            count(*) FILTER (WHERE anchor_turn_id IS NOT NULL) AS anchored,
            count(*) FILTER (WHERE reviewed_at IS NULL) AS ungraded,
            count(*) FILTER (WHERE uncertain) AS uncertain,
            count(*) FILTER (WHERE embedding IS NULL) AS no_embedding
       FROM candidate_memory
      GROUP BY 1 ORDER BY 1`,
  );
  console.log("=== candidate_memory by unit_kind ===");
  for (const r of totals.rows) {
    console.log(
      `  ${String(r.unit_kind).padEnd(9)}: ${String(r.n).padStart(5)} ` +
        `(anchored ${r.anchored}, ungraded ${r.ungraded}, uncertain ${r.uncertain}, no-embedding ${r.no_embedding})`,
    );
  }

  const bySpeaker = await pool.query(
    `SELECT c.unit_kind, c.candidate_type,
            count(*) FILTER (WHERE t.is_human_prompt) AS from_operator,
            count(*) FILTER (WHERE NOT t.is_human_prompt) AS from_agent
       FROM candidate_memory c
       JOIN ob_raw_turns t ON t.id = c.source_turn_ids[1]
      GROUP BY 1, 2 ORDER BY 1, 2`,
  );
  console.log("\n=== who heads the unit (source_turn_ids[1]) ===");
  console.log("  unit_kind | type       | from operator | from agent");
  for (const r of bySpeaker.rows) {
    console.log(
      `  ${String(r.unit_kind).padEnd(9)} | ${String(r.candidate_type).padEnd(10)} | ` +
        `${String(r.from_operator).padStart(13)} | ${String(r.from_agent).padStart(10)}`,
    );
  }

  const grades = await pool.query(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE superseded_at IS NULL) AS live
       FROM candidate_grade`,
  );
  console.log(
    `\ncandidate_grade: ${grades.rows[0].total} total, ${grades.rows[0].live} live`,
  );
}

async function readTurns(pool: Pool, limit: number): Promise<DistillTurn[]> {
  const { rows } = await pool.query(
    `SELECT id, namespace, session_ref, session_seq, role, content, repo,
            occurred_at, is_human_prompt
       FROM ob_raw_turns
      WHERE retention_tier = 'live'
      ORDER BY ${DISTILL_ORDER_BY}
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id as string,
    namespace: r.namespace as string,
    session_ref: (r.session_ref as string | null) ?? null,
    session_seq: (r.session_seq as number | null) ?? null,
    role: r.role as string,
    content: r.content as string,
    repo: (r.repo as string | null) ?? null,
    occurred_at: (r.occurred_at as Date | null) ?? null,
    is_human_prompt: Boolean(r.is_human_prompt),
  }));
}

/** Cut the corpus and report what WOULD be written, touching nothing. */
async function dryRun(pool: Pool, show: number): Promise<void> {
  const turns = await readTurns(pool, 200_000);
  const exchanges = buildExchanges(turns);
  const prepared = exchanges
    .map(prepareExchange)
    .filter((c): c is NonNullable<typeof c> => c !== null);

  const anchored = prepared.filter((c) => c.anchor_turn_id !== null).length;
  console.log("turns read        :", turns.length);
  console.log(
    "sessions          :",
    new Set(turns.map((t) => t.session_ref)).size,
  );
  console.log("exchanges cut     :", exchanges.length);
  console.log("candidates        :", prepared.length);
  console.log("  operator-anchored:", anchored);
  // 043. Called out separately because before it, ALL SIX AskUserQuestion turns
  // on the live corpus headed nothing -- each swept into the agent body of
  // whatever preceded it. A run reporting 0 here against a corpus that contains
  // them is the regression, and it is invisible in every other line.
  console.log(
    "    of which AUQ   :",
    prepared.filter((c) => c.anchor_kind === "askuserquestion").length,
  );
  console.log("  orphans          :", prepared.length - anchored);
  console.log(
    "  uncertain        :",
    prepared.filter((c) => c.uncertain).length,
  );

  const byType = new Map<string, number>();
  for (const c of prepared) {
    byType.set(c.candidate_type, (byType.get(c.candidate_type) ?? 0) + 1);
  }
  console.log("by type:");
  for (const [t, n] of [...byType].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t.padEnd(11)}: ${n}`);
  }

  for (const c of prepared
    .filter((x) => x.anchor_turn_id !== null)
    .slice(0, show)) {
    console.log(
      `\n--- ${c.candidate_type}${c.uncertain ? " (uncertain)" : ""} | ${c.source_turn_ids.length} turns`,
    );
    console.log(c.content.slice(0, 1200));
  }
}

/** Print written exchange rows, for the human read-through that closes the change. */
async function sample(pool: Pool, n: number): Promise<void> {
  const { rows } = await pool.query(
    `SELECT candidate_type, uncertain, content,
            cardinality(source_turn_ids) AS turns, left(operator_text, 300) AS head
       FROM candidate_memory
      WHERE unit_kind = 'exchange' AND anchor_turn_id IS NOT NULL
      ORDER BY random() LIMIT $1`,
    [n],
  );
  for (const r of rows) {
    console.log(
      `\n--- ${r.candidate_type}${r.uncertain ? " (uncertain)" : ""} | ${r.turns} source turns`,
    );
    console.log(r.content.slice(0, 1500));
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
      return await sample(pool, Number(arg("--sample") ?? 5));
    if (has("--dry-run"))
      return await dryRun(pool, Number(arg("--dry-run") ?? 3));

    if (has("--backfill-embeddings")) {
      const s = await backfillExchangeEmbeddings({ pool, logger });
      console.log("=== embedding backfill ===");
      for (const [k, v] of Object.entries(s)) console.log(k.padEnd(12), ":", v);
      return;
    }

    const summary = await runExchangeSweep({
      pool,
      logger,
      ...(has("--no-embed") ? { skipEmbeddings: true } : {}),
    });

    console.log("\n=== exchange sweep ===");
    console.log("model                :", EXCHANGE_DISTILLER_NAME);
    for (const [k, v] of Object.entries(summary)) {
      console.log(k.padEnd(21), ":", v);
    }
    console.log();
    await stats(pool);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("exchange run failed:", err);
  process.exit(1);
});
