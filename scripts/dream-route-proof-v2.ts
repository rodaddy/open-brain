/**
 * V2: only an operator-anchored repeat across three or more sessions graduates.
 *
 * `_plans/1469-dream-route.md:95` states the proof and the operator ruling on
 * issue 1469 (comment 39982) fixes both halves of the threshold: THREE OR MORE
 * DISTINCT SESSIONS, counting OPERATOR-ANCHORED repeats only. Those are two
 * separate ways to fail, so the proof plants one fixture for each and a
 * control that must succeed:
 *
 *   T1 spans five distinct sessions, but every repeat is `observed` -- the
 *   agent noticing its own output five times is not the operator saying it
 *   once, so it must not graduate however loud it gets.
 *
 *   T3 has `decided` repeats but spans only two sessions, one short.
 *
 *   T2 has `decided` repeats across three sessions and DOES graduate. Without
 *   it, "nothing graduated" would also be satisfied by a graduation step that
 *   is simply broken, and the two refusals would prove nothing.
 *
 * Sessions are resolved the way the graduation resolves them: frozen
 * `ob_raw_turns` rows inside the run schema, joined from the cohort's
 * `snapshot.source_turn_ids` (`scripts/dream-route-graduate.ts:18-29`).
 * Nothing is planted in `public`, which is counted before and after.
 *
 * Run: DB_HOST=... DB_PORT=... DB_USER=... DB_NAME=<a _play_ copy> \
 *   /opt/homebrew/opt/node@24/bin/node scripts/dream-route-proof-v2.ts
 */

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { applyRouting } from "./dream-route-apply.ts";
import {
  DEFAULT_GRADUATION_SESSIONS,
  graduateRecurring,
  graduateScopeKey,
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
  withProofSchema,
  type PlantedCandidate,
  type Reporter,
} from "./dream-route-proof-support.ts";

/** Invented text. Nothing here is drawn from anyone's real memory. */
const T1 = "synthetic fact zeta: the proof fixture was observed five times";
const T2 = "synthetic decision eta: the proof fixture graduates at three";
const T3 = "synthetic fact theta: the proof fixture was decided twice";

/**
 * Nine planted rows: three targets and their repeats.
 *
 * A target carries its own first session; each repeat carries one more and
 * points back through `reinforces`, which is the only column that links a
 * repeat to what it repeats.
 */
const CANDIDATES: readonly PlantedCandidate[] = [
  {
    label: "t1",
    content: T1,
    action: "thought",
    authorityTier: "decided",
    destination: "fact",
    sessions: ["v2-s1"],
  },
  ...["v2-s2", "v2-s3", "v2-s4", "v2-s5"].map((session, index): PlantedCandidate => ({
    label: `t1r${index + 1}`,
    content: `synthetic observation zeta-${index + 1}: the fixture again`,
    action: "thought",
    authorityTier: "observed",
    destination: "fact",
    reinforces: "t1",
    sessions: [session],
  })),
  {
    label: "t2",
    content: T2,
    action: "thought",
    authorityTier: "decided",
    destination: "decision",
    sessions: ["v2-s1"],
  },
  ...["v2-s2", "v2-s3"].map((session, index): PlantedCandidate => ({
    label: `t2r${index + 1}`,
    content: `synthetic decision eta-${index + 1}: the operator said it again`,
    action: "thought",
    authorityTier: "decided",
    destination: "decision",
    reinforces: "t2",
    sessions: [session],
  })),
  {
    label: "t3",
    content: T3,
    action: "thought",
    authorityTier: "decided",
    destination: "fact",
    sessions: ["v2-s1"],
  },
  {
    label: "t3r1",
    content: "synthetic decision theta-1: the operator said it a second time",
    action: "thought",
    authorityTier: "decided",
    destination: "fact",
    reinforces: "t3",
    sessions: ["v2-s2"],
  },
];

const KEY_T1 = graduateScopeKey(contentHash(T1));
const KEY_T2 = graduateScopeKey(contentHash(T2));
const KEY_T3 = graduateScopeKey(contentHash(T3));

/** The graduation scope keys the mirror holds a `promote` for. */
async function graduatedKeys(pool: Pool, schema: string): Promise<readonly string[]> {
  const result = await pool.query<{ key: string }>(
    `SELECT metadata->'candidate_scope'->>'key' AS key
       FROM ${schema}.ob_session_events
      WHERE metadata->>'memory_lifecycle_action' = 'promote'
        AND metadata ? 'graduated_from_sessions'
      ORDER BY created_at`,
  );
  return result.rows.map((row) => row.key);
}

/** The run header's note, which is where the threshold is recorded. */
async function runNote(pool: Pool, schema: string, runId: string): Promise<string> {
  const result = await pool.query<{ note: string }>(
    `SELECT note FROM ${schema}.routing_runs WHERE run_id = $1`,
    [runId],
  );
  return result.rows[0]?.note ?? "";
}

async function assertGraduation(
  report: Reporter,
  pool: Pool,
  schema: string,
  runId: string,
): Promise<void> {
  const keys = await graduatedKeys(pool, schema);
  const rendered = JSON.stringify(keys);
  report.check(
    "observed-repeats-never-graduate",
    !keys.includes(KEY_T1),
    `T1 spans 5 sessions with observed repeats; graduated keys ${rendered} ` +
      `must not hold ${KEY_T1}`,
  );
  report.check(
    "two-sessions-is-not-enough",
    !keys.includes(KEY_T3),
    `T3 spans 2 decided sessions; graduated keys ${rendered} must not hold ${KEY_T3}`,
  );
  report.check(
    "three-decided-sessions-graduate",
    keys.includes(KEY_T2),
    `T2 spans 3 decided sessions; graduated keys ${rendered} must hold ${KEY_T2}`,
  );
  report.check(
    "exactly-one-graduate",
    keys.length === 1 && keys[0] === KEY_T2,
    `graduated keys ${rendered}, want exactly [${KEY_T2}]`,
  );
  const note = await runNote(pool, schema, runId);
  const marker = `graduationSessions=${DEFAULT_GRADUATION_SESSIONS}`;
  report.check(
    "threshold-recorded-on-the-run",
    note.includes(marker),
    `routing_runs.note "${note}" must record ${marker}`,
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
      await onClient(pool, (client) => applyRouting({ client, schema, runId }));
      const counts = await onClient(pool, (client) =>
        graduateRecurring({ client, schema, runId }),
      );
      report.check(
        "one-graduation-counted",
        counts.graduated === 1 && counts.tierMoves === 1,
        `graduated=${counts.graduated} tierMoves=${counts.tierMoves}, want 1 and 1`,
      );
      report.check(
        "default-threshold-used",
        counts.graduationSessions === DEFAULT_GRADUATION_SESSIONS,
        `graduationSessions=${counts.graduationSessions}, ` +
          `want the default ${DEFAULT_GRADUATION_SESSIONS}`,
      );
      await assertGraduation(report, pool, schema, runId);
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
  report.finish("V2");
}

await run();
