/**
 * V5: the whole route is replayable, and an undo takes nothing away.
 *
 * `_plans/1469-dream-route.md:98-99` states both halves, and they are one
 * property seen twice: every write the route makes is decided by what is
 * already in the mirror, never by how many times it has been asked.
 *
 *   REPLAY. A mixed cohort -- a fact, a correction, a rule, a `none`, and a
 *   `decided` fact repeated across three sessions -- is applied and graduated,
 *   then applied and graduated AGAIN. The second pass must report zero new
 *   writes AND leave every table in the run schema at the count it had. The
 *   reported zero alone would not be enough: a step could report nothing while
 *   still writing, so the counts are read from the database independently, and
 *   over EVERY table rather than a named few.
 *
 *   UNDO. The graduate is retired by scope key. A reader applying the context
 *   pack's latest-wins rule stops seeing it, the rule promoted earlier is
 *   untouched, and NO ROW ANYWHERE IS DELETED: the undo is an appended
 *   `relegate`, so every table's count may only grow. A second undo finds the
 *   key already retired and writes nothing.
 *
 * The run schema is dropped in a `finally`; `public` is counted before and
 * after and is never written.
 *
 * Run: DB_HOST=... DB_PORT=... DB_USER=... DB_NAME=<a _play_ copy> \
 *   /opt/homebrew/opt/node@24/bin/node scripts/dream-route-proof-v5.ts
 */

import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { applyRouting, ruleScopeKey } from "./dream-route-apply.ts";
import {
  activeScopeKeys,
  graduateRecurring,
  graduateScopeKey,
  undoGraduate,
} from "./dream-route-graduate.ts";
import {
  contentHash,
  countsEqual,
  onClient,
  plantRun,
  proofPool,
  publicCounts,
  renderCounts,
  reporter,
  schemaCounts,
  withProofSchema,
  type PlantedCandidate,
  type Reporter,
} from "./dream-route-proof-support.ts";

/** Invented text. Nothing here is drawn from anyone's real memory. */
const RULE = "synthetic rule iota: proof fixtures are replayed twice";
const GRADUATING = "synthetic fact kappa: the proof fixture recurs three times";

/** The scope keys the two standing items are filed under. */
const KEY_RULE = ruleScopeKey(contentHash(RULE));
const KEY_GRADUATE = graduateScopeKey(contentHash(GRADUATING));

const CANDIDATES: readonly PlantedCandidate[] = [
  {
    label: "plainFact",
    content: "synthetic fact lambda: the proof fixture is ordinary",
    action: "thought",
    authorityTier: "observed",
    destination: "fact",
  },
  {
    label: "correction",
    content: "synthetic correction mu: the proof fixture was misread",
    action: "thought",
    authorityTier: "decided",
    destination: "correction",
  },
  {
    label: "rule",
    content: RULE,
    action: "rule_event",
    authorityTier: "decided",
    destination: "rule",
  },
  {
    label: "none",
    content: "synthetic chatter nu: the proof fixture said nothing useful",
    action: "none",
    authorityTier: "observed",
  },
  {
    label: "graduating",
    content: GRADUATING,
    action: "thought",
    authorityTier: "decided",
    destination: "fact",
    sessions: ["v5-s1"],
  },
  ...["v5-s2", "v5-s3"].map((session, index): PlantedCandidate => ({
    label: `graduatingR${index + 1}`,
    content: `synthetic fact kappa-${index + 1}: the operator said it again`,
    action: "thought",
    authorityTier: "decided",
    destination: "fact",
    reinforces: "graduating",
    sessions: [session],
  })),
];

/** Every lifecycle event, in the shape `activeScopeKeys` reads. */
async function standingKeys(pool: Pool, schema: string): Promise<readonly string[]> {
  const result = await pool.query<{
    action: string | null;
    key: string | null;
    created_at: Date;
  }>(
    `SELECT metadata->>'memory_lifecycle_action' AS action,
            metadata->'candidate_scope'->>'key' AS key,
            created_at
       FROM ${schema}.ob_session_events`,
  );
  return activeScopeKeys(
    result.rows.map((row) => ({
      action: row.action,
      scopeKey: row.key,
      createdAt: row.created_at,
    })),
  );
}

/** Whether every table in `after` is at least as full as it was in `before`. */
function nothingShrank(
  before: Record<string, number>,
  after: Record<string, number>,
): boolean {
  return Object.entries(before).every(
    ([table, count]) => (after[table] ?? -1) >= count,
  );
}

/** Whether two whole-schema snapshots agree table for table. */
function snapshotsEqual(
  before: Record<string, number>,
  after: Record<string, number>,
): boolean {
  const tables = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...tables].every((table) => before[table] === after[table]);
}

/** A snapshot rendered for the measured column. */
function render(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([table, count]) => `${table}=${count}`)
    .join(" ");
}

async function assertReplay(
  report: Reporter,
  pool: Pool,
  schema: string,
  runId: string,
): Promise<void> {
  const before = await schemaCounts(pool, schema);
  const apply = await onClient(pool, (client) =>
    applyRouting({ client, schema, runId }),
  );
  const graduate = await onClient(pool, (client) =>
    graduateRecurring({ client, schema, runId }),
  );
  const wroteApply =
    apply.thoughts + apply.promotes + apply.tierMoves + apply.applyFlags;
  report.check(
    "second-apply-writes-nothing",
    wroteApply === 0,
    `second applyRouting reported ${wroteApply} new rows, want 0`,
  );
  report.check(
    "second-graduate-writes-nothing",
    graduate.graduated === 0 && graduate.tierMoves === 0,
    `second graduateRecurring reported graduated=${graduate.graduated} ` +
      `tierMoves=${graduate.tierMoves}, want 0 and 0`,
  );
  const after = await schemaCounts(pool, schema);
  report.check(
    "replay-leaves-every-table-identical",
    snapshotsEqual(before, after),
    `${Object.keys(before).length} tables [${render(before)}] -> [${render(after)}]`,
  );
}

async function assertUndo(
  report: Reporter,
  pool: Pool,
  schema: string,
  runId: string,
): Promise<void> {
  const before = await schemaCounts(pool, schema);
  const undoOnce = (client: PoolClient) =>
    undoGraduate({ client, schema, runId, scopeKey: KEY_GRADUATE });
  const first = await onClient(pool, undoOnce);
  report.check(
    "undo-relegates-once",
    first.relegated === 1 && first.tierMoves === 1,
    `relegated=${first.relegated} tierMoves=${first.tierMoves}, want 1 and 1`,
  );
  const standing = await standingKeys(pool, schema);
  report.check(
    "undone-graduate-no-longer-standing",
    !standing.includes(KEY_GRADUATE),
    `latest-wins keys ${JSON.stringify(standing)} must not hold ${KEY_GRADUATE}`,
  );
  report.check(
    "the-other-rule-still-standing",
    standing.includes(KEY_RULE),
    `latest-wins keys ${JSON.stringify(standing)} must hold ${KEY_RULE}`,
  );
  const afterUndo = await schemaCounts(pool, schema);
  report.check(
    "undo-deleted-nothing",
    nothingShrank(before, afterUndo),
    `every table must be >= its earlier count: [${render(before)}] -> ` +
      `[${render(afterUndo)}]`,
  );
  const second = await onClient(pool, undoOnce);
  const afterSecond = await schemaCounts(pool, schema);
  report.check(
    "second-undo-writes-nothing",
    second.relegated === 0 && snapshotsEqual(afterUndo, afterSecond),
    `second undo reported relegated=${second.relegated} and left ` +
      `[${render(afterSecond)}], want 0 and no change`,
  );
}

async function run(): Promise<void> {
  const report = reporter();
  const pool = proofPool();
  const runId = randomUUID();
  try {
    const before = await publicCounts(pool);
    await withProofSchema(pool, async (schema) => {
      await plantRun({ pool, schema, runId, candidates: CANDIDATES });
      const apply = await onClient(pool, (client) =>
        applyRouting({ client, schema, runId }),
      );
      report.check(
        "mixed-cohort-applied",
        apply.promotes === 1 && apply.thoughts > 0 && apply.notApplied > 0,
        `promotes=${apply.promotes} thoughts=${apply.thoughts} ` +
          `notApplied=${apply.notApplied}, want 1 promote and both others non-zero`,
      );
      const graduate = await onClient(pool, (client) =>
        graduateRecurring({ client, schema, runId }),
      );
      report.check(
        "one-item-graduated",
        graduate.graduated === 1,
        `graduated=${graduate.graduated}, want 1`,
      );
      await assertReplay(report, pool, schema, runId);
      await assertUndo(report, pool, schema, runId);
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
  report.finish("V5");
}

await run();
