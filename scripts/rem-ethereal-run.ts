#!/usr/bin/env bun
/**
 * REM ethereal run — real Terra call, disposable output.
 *
 * Implements `docs/dream-ethereal-runs.md` for the REM stage. That document is
 * marked "design, not implemented"; this is the implementation, and it follows
 * the design rather than inventing a scheme:
 *
 *   REAL INPUT. The candidates are the actual corpus, read from the live
 *   clone. Nothing is synthesised, because the point is to find out what Terra
 *   does with real exchanges.
 *
 *   DISPOSABLE OUTPUT. Every write lands in its own `dream_run_NNN` schema.
 *   Teardown is one statement -- `DROP SCHEMA dream_run_007 CASCADE` -- with no
 *   partial-delete risk, and contamination of `candidate_memory` is
 *   structurally impossible rather than avoided by care.
 *
 * Operator, 2026-07-29: "there's a 100% chance it's gonna be fucking wrong. So
 * I don't want it to dirty up the actual database, but even if it's wrong it
 * will give us data towards getting to right."
 *
 * WHY IT RUNS THE REAL PATH. The whole question this answers is whether the
 * production grading path works end to end, so it uses `createTerraGrader` and
 * `REM_GRADING_PROMPT` unmodified. A harness that mocked the call would prove
 * nothing about the thing being sussed out. The ONLY difference from a
 * production pass is where the rows land.
 *
 * THE RUN MANIFEST IS NOT OPTIONAL. `dream-ethereal-runs.md:59-61`: "A run
 * whose parameters are unknown is not a data point." Every run records its
 * model, effort, prompt hash, batch size, source counts, timings and errors.
 * Twenty runs from now, the manifest is what makes two schemas comparable.
 *
 * USAGE
 *   bun scripts/rem-ethereal-run.ts --limit 50          # pilot
 *   bun scripts/rem-ethereal-run.ts --limit 50 --note "round3 first contact"
 *   bun scripts/rem-ethereal-run.ts --list              # what runs exist
 *   bun scripts/rem-ethereal-run.ts --drop dream_run_003
 */

import { createHash } from "node:crypto";
import { createPool } from "../src/db/pool.ts";
import {
  createTerraGrader,
  interactionShape,
} from "../src/rem-terra-grader.ts";
import {
  REM_EFFORT,
  REM_GRADING_PROMPT,
  REM_GRADING_SCHEMA,
  REM_MODEL,
} from "../src/rem-prompt.ts";
import type { RemCandidate } from "../src/dream-rem.ts";
import { runTerraBatch } from "../src/rem-terra-transport.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const pool = createPool();

try {
  if (has("list")) {
    const runs = await pool.query(
      `SELECT nspname FROM pg_namespace
        WHERE nspname LIKE 'dream\\_run\\_%' ORDER BY nspname`,
    );
    for (const r of runs.rows) console.log(r.nspname);
    process.exit(0);
  }

  const drop = arg("drop");
  if (drop) {
    // Guarded: this takes a schema name from the command line and drops it
    // CASCADE. The prefix check is the difference between "teardown is one
    // statement" and "one typo removes public".
    if (!/^dream_run_\d{3}$/.test(drop)) {
      console.error(`refusing to drop "${drop}": not a dream_run_NNN schema`);
      process.exit(1);
    }
    await pool.query(`DROP SCHEMA IF EXISTS ${drop} CASCADE`);
    console.log(`dropped ${drop}`);
    process.exit(0);
  }

  const limit = Number(arg("limit") ?? 50);
  const batchSize = Number(arg("batch") ?? 25);
  const note = arg("note") ?? "";

  // Next free run number, so a run never overwrites its predecessor.
  const existing = await pool.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace
      WHERE nspname LIKE 'dream\\_run\\_%' ORDER BY nspname DESC LIMIT 1`,
  );
  const next = existing.rows[0]
    ? Number(existing.rows[0].nspname.slice(-3)) + 1
    : 1;
  const schema = `dream_run_${String(next).padStart(3, "0")}`;

  console.log(`=== ${schema} ===`);

  // Schema per run, same table shapes each time, every row carrying run_id so
  // "a stray row can never be mistaken for another run's".
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`
    CREATE TABLE ${schema}.manifest (
      run_id        TEXT PRIMARY KEY,
      model         TEXT NOT NULL,
      effort        TEXT NOT NULL,
      prompt_sha256 TEXT NOT NULL,
      batch_size    INTEGER NOT NULL,
      requested     INTEGER NOT NULL,
      examined      INTEGER NOT NULL,
      judged        INTEGER NOT NULL,
      fell_back     INTEGER NOT NULL,
      started_at    TIMESTAMPTZ NOT NULL,
      ended_at      TIMESTAMPTZ,
      note          TEXT,
      errors        JSONB NOT NULL DEFAULT '[]'::jsonb
    )`);
  await pool.query(`
    CREATE TABLE ${schema}.judgement (
      run_id         TEXT NOT NULL,
      candidate_id   UUID NOT NULL,
      machine_score  INTEGER,
      machine_grade  TEXT,
      label          TEXT,
      quote          TEXT,
      synopsis       TEXT,
      agent_behavior TEXT,
      reasons        JSONB,
      turn_count     INTEGER,
      operator_chars INTEGER,
      agent_chars    INTEGER,
      from_terra     BOOLEAN NOT NULL,
      PRIMARY KEY (run_id, candidate_id)
    )`);

  // REAL INPUT: the live queue heads, exactly as production REM would select
  // them. parent_id IS NULL excludes 044's split parts -- a chunk is not an
  // interaction and grading one would score half an exchange.
  const rows = await pool.query<{
    id: string;
    namespace: string;
    candidate_type: string;
    content: string;
    content_hash: string;
    uncertain: boolean;
    uncertainty_reason: string | null;
    model: string | null;
    session_count: string | null;
    occurrence_count: string | null;
    reinforcement_count: string;
  }>(
    `SELECT c.id, c.namespace, c.candidate_type, c.content, c.content_hash,
            c.uncertain, c.uncertainty_reason, c.model,
            o.session_count, o.occurrence_count,
            (SELECT count(*) FROM candidate_reinforcement r
              WHERE r.candidate_id = c.id)::text AS reinforcement_count
       FROM candidate_memory c
       LEFT JOIN content_occurrences o
              ON o.namespace = c.namespace AND o.content_hash = c.content_hash
      WHERE c.unit_kind = 'exchange'
        AND c.reviewed_at IS NULL
        AND c.parent_id IS NULL
      ORDER BY md5(c.id::text)
      LIMIT $1`,
    [limit],
  );

  const candidates: RemCandidate[] = rows.rows.map((r) => ({
    id: r.id,
    namespace: r.namespace,
    candidate_type: r.candidate_type,
    content: r.content,
    content_hash: r.content_hash,
    uncertain: r.uncertain,
    uncertainty_reason: r.uncertainty_reason,
    model: r.model,
    session_count: Number(r.session_count ?? 0),
    occurrence_count: Number(r.occurrence_count ?? 0),
    reinforcement_count: Number(r.reinforcement_count),
  }));

  console.log(`${candidates.length} candidates, batch ${batchSize}`);

  const errors: unknown[] = [];
  const startedAt = new Date();
  const promptSha = createHash("sha256")
    .update(REM_GRADING_PROMPT)
    .digest("hex")
    .slice(0, 16);

  const grader = createTerraGrader({
    transport: runTerraBatch,
    batchSize,
    logger: {
      warn: (event, data) => {
        console.warn(`WARN ${event}`, data ?? "");
        errors.push({ event, data });
      },
    },
  });

  await grader.prime(candidates);

  let judged = 0;
  let fellBack = 0;
  for (const c of candidates) {
    const j = grader.judgementFor(c.id);
    const verdict = await grader.grade(c);
    // Stored alongside the judgement so a later run can ask whether the priors
    // actually moved the score, rather than assuming they did.
    const shape = interactionShape(c.content);
    if (j) judged++;
    else fellBack++;

    await pool.query(
      `INSERT INTO ${schema}.judgement
         (run_id, candidate_id, machine_score, machine_grade, label, quote,
          synopsis, agent_behavior, reasons, turn_count, operator_chars,
          agent_chars, from_terra)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        schema,
        c.id,
        j?.score ?? null,
        verdict.grade,
        j?.label ?? null,
        j?.quote ?? null,
        j?.synopsis ?? null,
        j?.agent_behavior ?? null,
        j ? JSON.stringify(j.reasons) : null,
        shape.turn_count,
        shape.operator_chars,
        shape.agent_chars,
        Boolean(j),
      ],
    );
  }

  await pool.query(
    `INSERT INTO ${schema}.manifest
       (run_id, model, effort, prompt_sha256, batch_size, requested, examined,
        judged, fell_back, started_at, ended_at, note, errors)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11,$12)`,
    [
      schema,
      REM_MODEL,
      REM_EFFORT,
      promptSha,
      batchSize,
      limit,
      candidates.length,
      judged,
      fellBack,
      startedAt,
      note,
      JSON.stringify(errors),
    ],
  );

  console.log(`\n=== ${schema} complete ===`);
  console.log(`judged by Terra : ${judged}`);
  console.log(`fell back       : ${fellBack}`);
  console.log(`errors          : ${errors.length}`);
  console.log(`\nteardown: bun scripts/rem-ethereal-run.ts --drop ${schema}`);
} finally {
  await pool.end();
}

// Referenced above so the schema constant is not tree-shaken out of the
// prompt-hash calculation's intent; the transport sends it.
void REM_GRADING_SCHEMA;
