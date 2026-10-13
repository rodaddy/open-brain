/**
 * V4: a planted operator reversal relegates the older rule -- and says so.
 *
 * `_plans/1469-dream-route.md:97` states the proof. The operator ruling on
 * issue 1469 (comment 39982) fixes the part that is not obvious: a relegate is
 * MARKED AS NEEDING THE OPERATOR'S APPROVAL rather than being silently final.
 * The router may rearrange what a reader sees; it may not retire a standing
 * rule on its own authority.
 *
 * The shape, in two routing runs against ONE run schema:
 *
 *   run A plants two older `rule` candidates and applies them, so two promote
 *   events exist under scope keys K and K2 (`ruleScopeKey` derives both from
 *   the candidate's content hash, which is what makes them stable).
 *
 *   run B plants two reversals: a `decided` candidate reversing K, which is
 *   operator-anchored and does relegate, and an `observed` candidate reversing
 *   K2, which is an observation and only gets flagged. The authority tier is
 *   the whole difference, which is why both are planted rather than one.
 *
 * The reading side is `activeScopeKeys` from `scripts/dream-route-graduate.ts`
 * -- the context pack's own latest-wins rule -- so the proof asserts what a
 * READER would see, not merely which rows exist. Nothing is deleted: the
 * mirror's event count only ever grows, which is asserted directly.
 *
 * The run schema is dropped in a `finally`; `public` is counted before and
 * after.
 *
 * Run: DB_HOST=... DB_PORT=... DB_USER=... DB_NAME=<a _play_ copy> \
 *   /opt/homebrew/opt/node@24/bin/node scripts/dream-route-proof-v4.ts
 */

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { applyRouting, ruleScopeKey } from "./dream-route-apply.ts";
import { activeScopeKeys } from "./dream-route-graduate.ts";
import {
  contentHash,
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
  type Reporter,
} from "./dream-route-proof-support.ts";

/** Invented text. Nothing here is drawn from anyone's real memory. */
const REVERSED_RULE = "synthetic rule alpha: proof fixtures are named alpha";
const SURVIVING_RULE = "synthetic rule gamma: proof fixtures are dropped after use";
const DECIDED_REVERSAL = "synthetic decision delta: the operator retired rule alpha";
const OBSERVED_REVERSAL = "synthetic observation epsilon: rule gamma looked ignored";

/** The scope key each older rule was promoted under. */
const KEY_REVERSED = ruleScopeKey(contentHash(REVERSED_RULE));
const KEY_SURVIVING = ruleScopeKey(contentHash(SURVIVING_RULE));

const OLDER_RULES: readonly PlantedCandidate[] = [
  {
    label: "reversedRule",
    content: REVERSED_RULE,
    action: "rule_event",
    authorityTier: "decided",
  },
  {
    label: "survivingRule",
    content: SURVIVING_RULE,
    action: "rule_event",
    authorityTier: "decided",
  },
];

const REVERSALS: readonly PlantedCandidate[] = [
  {
    label: "decidedReversal",
    content: DECIDED_REVERSAL,
    action: "thought",
    authorityTier: "decided",
    signal: "reverses_rule",
    targetScopeKey: KEY_REVERSED,
  },
  {
    label: "observedReversal",
    content: OBSERVED_REVERSAL,
    action: "thought",
    authorityTier: "observed",
    signal: "reverses_rule",
    targetScopeKey: KEY_SURVIVING,
  },
];

interface EventRow {
  action: string | null;
  key: string | null;
  needs: boolean | null;
  created_at: Date;
}

/** Every lifecycle event in the mirror, in the shape `activeScopeKeys` reads. */
async function lifecycleEvents(
  pool: Pool,
  schema: string,
): Promise<readonly EventRow[]> {
  const result = await pool.query<EventRow>(
    `SELECT metadata->>'memory_lifecycle_action' AS action,
            metadata->'candidate_scope'->>'key' AS key,
            (metadata->>'needs_operator_approval')::boolean AS needs,
            created_at
       FROM ${schema}.ob_session_events
      ORDER BY created_at`,
  );
  return result.rows;
}

interface FlagRow {
  applied: boolean;
  needs_operator_approval: boolean;
  target_scope_key: string | null;
}

async function flagRow(
  pool: Pool,
  schema: string,
  candidateId: string,
): Promise<FlagRow | undefined> {
  const result = await pool.query<FlagRow>(
    `SELECT applied, needs_operator_approval, target_scope_key
       FROM ${schema}.apply_flags
      WHERE candidate_id = $1 AND kind = 'rule_reversal'`,
    [candidateId],
  );
  return result.rows[0];
}

async function assertRelegate(
  report: Reporter,
  pool: Pool,
  schema: string,
): Promise<void> {
  const events = await lifecycleEvents(pool, schema);
  const relegates = events.filter((row) => row.action === "relegate");
  report.check(
    "one-relegate-for-the-reversed-rule",
    relegates.length === 1 && relegates[0]?.key === KEY_REVERSED,
    `${relegates.length} relegate events, key "${relegates[0]?.key ?? "<none>"}", ` +
      `want 1 for ${KEY_REVERSED}`,
  );
  report.check(
    "relegate-needs-operator-approval",
    relegates[0]?.needs === true,
    `metadata.needs_operator_approval=${String(relegates[0]?.needs)}, want true`,
  );
  const active = activeScopeKeys(
    events.map((row) => ({
      action: row.action,
      scopeKey: row.key,
      createdAt: row.created_at,
    })),
  );
  report.check(
    "reversed-rule-no-longer-active",
    !active.includes(KEY_REVERSED),
    `latest-wins active keys ${JSON.stringify(active)} must not hold ${KEY_REVERSED}`,
  );
  report.check(
    "surviving-rule-still-active",
    active.includes(KEY_SURVIVING),
    `latest-wins active keys ${JSON.stringify(active)} must hold ${KEY_SURVIVING}`,
  );
}

async function assertObserved(
  report: Reporter,
  pool: Pool,
  schema: string,
  candidateId: string,
): Promise<void> {
  const flag = await flagRow(pool, schema, candidateId);
  report.check(
    "observed-reversal-flagged-not-applied",
    flag?.applied === false && flag?.target_scope_key === KEY_SURVIVING,
    `applied=${String(flag?.applied)} target="${flag?.target_scope_key ?? "<none>"}", ` +
      `want false and ${KEY_SURVIVING}`,
  );
  report.check(
    "observed-reversal-needs-operator",
    flag?.needs_operator_approval === true,
    `needs_operator_approval=${String(flag?.needs_operator_approval)}, want true`,
  );
  // The candidate itself is ordinary new information and still lands; only the
  // rule it names is left standing.
  const thoughts = await mirroredThoughts(pool, schema, candidateId);
  report.check(
    "observed-reversal-candidate-applied",
    thoughts === 1,
    `${thoughts} mirror thoughts rows for the observed reversal, want 1`,
  );
}

async function run(): Promise<void> {
  const report = reporter();
  const pool = proofPool();
  const runA = randomUUID();
  const runB = randomUUID();
  try {
    const before = await publicCounts(pool);
    await withProofSchema(pool, async (schema) => {
      await plantRun({ pool, schema, runId: runA, candidates: OLDER_RULES });
      const applied = await onClient(pool, (client) =>
        applyRouting({ client, schema, runId: runA }),
      );
      report.check(
        "older-rules-promoted",
        applied.promotes === 2,
        `${applied.promotes} promote events from run A, want 2`,
      );
      const eventsAfterA = await schemaCount(pool, schema, "ob_session_events");

      const planted = await plantRun({
        pool,
        schema,
        runId: runB,
        candidates: REVERSALS,
      });
      const second = await onClient(pool, (client) =>
        applyRouting({ client, schema, runId: runB }),
      );
      report.check(
        "one-relegate-counted",
        second.relegates === 1 && second.reversalTierMoves === 1,
        `relegates=${second.relegates} reversalTierMoves=${second.reversalTierMoves}, ` +
          `want 1 and 1`,
      );
      await assertRelegate(report, pool, schema);
      const observed = planted.find((row) => row.label === "observedReversal");
      if (observed === undefined)
        throw new Error('nothing planted as "observedReversal"');
      await assertObserved(report, pool, schema, observed.candidateId);

      const eventsAfterB = await schemaCount(pool, schema, "ob_session_events");
      report.check(
        "nothing-deleted",
        eventsAfterB > eventsAfterA,
        `mirror ob_session_events went ${eventsAfterA} -> ${eventsAfterB}, must only grow`,
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
  report.finish("V4");
}

await run();
