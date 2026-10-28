/**
 * V3: a planted contradiction of canon is RECORDED, not applied.
 *
 * `_plans/1469-dream-route.md:96` states the proof and
 * `docs/code-brain-design.md:146-148` states why it matters: canon is the
 * settled layer, so a dream run that quietly committed a memory contradicting
 * it would bury the contradiction exactly where an operator needs to see it.
 * The apply step's answer is to write nothing for that candidate and leave one
 * `apply_flags` row saying a human has to decide.
 *
 * Two synthetic facts are planted, identical in every way that matters except
 * that one carries a `contradicts_canon` signal. The clean one landing is half
 * the proof: without it, "nothing was written" would also be satisfied by an
 * apply step that is simply broken.
 *
 * Everything happens inside one freshly allocated `dream_run_NNN` schema which
 * is dropped in a `finally`; `public` is counted before and after.
 *
 * Run: DB_HOST=... DB_PORT=... DB_USER=... DB_NAME=<a _play_ copy> \
 *   /opt/homebrew/opt/node@24/bin/node scripts/dream-route-proof-v3.ts
 */

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { applyRouting } from "./dream-route-apply.ts";
import {
  countsEqual,
  mirroredThoughts,
  onClient,
  plantRun,
  proofPool,
  publicCounts,
  renderCounts,
  reporter,
  schemaCount,
  withProofSchema,
  type PlantedCandidate,
  type PlantedRow,
  type Reporter,
} from "./dream-route-proof-support.ts";

/** Invented text. Nothing here is drawn from anyone's real memory. */
const CANDIDATES: readonly PlantedCandidate[] = [
  {
    label: "clean",
    content: "synthetic fact alpha: the proof fixture counts to three",
    action: "thought",
    authorityTier: "observed",
  },
  {
    label: "contradicting",
    content: "synthetic fact beta: the proof fixture contradicts settled canon",
    action: "thought",
    authorityTier: "observed",
    signal: "contradicts_canon",
  },
];

interface FlagRow {
  kind: string;
  applied: boolean;
  needs_operator_approval: boolean;
}

/** Every flag row one candidate carries. */
async function flagsFor(
  pool: Pool,
  schema: string,
  candidateId: string,
): Promise<readonly FlagRow[]> {
  const result = await pool.query<FlagRow>(
    `SELECT kind, applied, needs_operator_approval
       FROM ${schema}.apply_flags WHERE candidate_id = $1 ORDER BY kind`,
    [candidateId],
  );
  return result.rows;
}

/** The tier moves attributable to one mirrored candidate's own entries. */
async function tierMovesFor(
  pool: Pool,
  schema: string,
  candidateId: string,
): Promise<number> {
  const result = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${schema}.tier_moves m
      WHERE m.entry_id IN (
        SELECT id FROM ${schema}.thoughts
         WHERE promoted_from->>'candidate_id' = $1
        UNION ALL
        SELECT id FROM ${schema}.ob_session_events
         WHERE metadata->>'candidate_id' = $1)`,
    [candidateId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

function idOf(planted: readonly PlantedRow[], label: string): string {
  const row = planted.find((item) => item.label === label);
  if (row === undefined) throw new Error(`nothing planted under "${label}"`);
  return row.candidateId;
}

async function assertClean(
  report: Reporter,
  pool: Pool,
  schema: string,
  cleanId: string,
): Promise<void> {
  const thoughts = await mirroredThoughts(pool, schema, cleanId);
  report.check(
    "clean-fact-mirrored",
    thoughts === 1,
    `${thoughts} mirror thoughts rows for the clean fact, want 1`,
  );
  const flags = await flagsFor(pool, schema, cleanId);
  report.check(
    "clean-fact-unflagged",
    flags.length === 0,
    `${flags.length} apply_flags rows for the clean fact, want 0`,
  );
}

async function assertContradiction(
  report: Reporter,
  pool: Pool,
  schema: string,
  badId: string,
): Promise<void> {
  const thoughts = await mirroredThoughts(pool, schema, badId);
  report.check(
    "contradiction-not-applied",
    thoughts === 0,
    `${thoughts} mirror thoughts rows for the contradicting fact, want 0`,
  );
  const moves = await tierMovesFor(pool, schema, badId);
  report.check(
    "contradiction-no-tier-move",
    moves === 0,
    `${moves} tier_moves rows for the contradicting fact, want 0`,
  );
  const flags = await flagsFor(pool, schema, badId);
  const flag = flags[0];
  report.check(
    "contradiction-flagged-once",
    flags.length === 1 && flag?.kind === "canon_contradiction",
    `${flags.length} apply_flags rows, kind "${flag?.kind ?? "<none>"}", ` +
      `want 1 of kind canon_contradiction`,
  );
  report.check(
    "contradiction-flag-not-applied",
    flag?.applied === false,
    `applied=${String(flag?.applied)}, want false`,
  );
  report.check(
    "contradiction-flag-needs-operator",
    flag?.needs_operator_approval === true,
    `needs_operator_approval=${String(flag?.needs_operator_approval)}, want true`,
  );
}

async function run(): Promise<void> {
  const report = reporter();
  const pool = proofPool();
  const runId = randomUUID();
  try {
    const before = await publicCounts(pool);
    await withProofSchema(pool, async (schema) => {
      const planted = await plantRun({ pool, schema, runId, candidates: CANDIDATES });
      const first = await onClient(pool, (client) =>
        applyRouting({ client, schema, runId }),
      );
      report.check(
        "canon-blocked-counted",
        first.canonBlocked === 1,
        `canonBlocked=${first.canonBlocked}, want 1`,
      );
      await assertClean(report, pool, schema, idOf(planted, "clean"));
      await assertContradiction(report, pool, schema, idOf(planted, "contradicting"));

      const thoughtsBefore = await schemaCount(pool, schema, "thoughts");
      const flagsBefore = await schemaCount(pool, schema, "apply_flags");
      const movesBefore = await schemaCount(pool, schema, "tier_moves");
      const second = await onClient(pool, (client) =>
        applyRouting({ client, schema, runId }),
      );
      const wrote =
        second.thoughts + second.promotes + second.tierMoves + second.applyFlags;
      report.check(
        "second-apply-writes-nothing",
        wrote === 0,
        `second call reported ${wrote} new rows, want 0`,
      );
      const stable =
        (await schemaCount(pool, schema, "thoughts")) === thoughtsBefore &&
        (await schemaCount(pool, schema, "apply_flags")) === flagsBefore &&
        (await schemaCount(pool, schema, "tier_moves")) === movesBefore;
      report.check(
        "second-apply-tables-unchanged",
        stable,
        `thoughts/apply_flags/tier_moves held at ` +
          `${thoughtsBefore}/${flagsBefore}/${movesBefore}: ${String(stable)}`,
      );
    });
    const after = await publicCounts(pool);
    report.check(
      "public-untouched",
      countsEqual(before, after),
      `before [${renderCounts(before)}] after [${renderCounts(after)}]`,
    );
  } finally {
    await pool.end();
  }
  report.finish("V3");
}

await run();
