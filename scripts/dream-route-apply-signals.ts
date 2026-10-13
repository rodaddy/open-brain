/**
 * What the DREAM apply step does when a candidate carries a route signal.
 *
 * Two signals, two different answers, and the difference is who has authority.
 *
 * A `contradicts_canon` candidate is NOT applied. Canon is the settled layer;
 * a dream run that quietly wrote a memory contradicting it would make the
 * contradiction invisible exactly where it matters most. So the apply step
 * writes no thought, no promote, and no tier move for it, and leaves one
 * `apply_flags` row saying an operator has to decide.
 *
 * A `reverses_rule` candidate IS applied -- it is new information, and the
 * question is only what happens to the rule it reverses. That depends on the
 * candidate's `routing_decisions.authority_tier`: `decided` means the
 * candidate is operator-anchored, so the standing rule is relegated (one
 * `relegate` lifecycle event carrying `needs_operator_approval`, plus its tier
 * move), while anything else -- `observed` and below -- is an observation that
 * does not get to overturn a rule on its own, so only the flag is written.
 * Either way the flag records `needs_operator_approval`, because a reversal is
 * never silent.
 *
 * Idempotence is the primary keys, not a read-then-write: every insert here is
 * `ON CONFLICT ... DO NOTHING` on `apply_flags (run_id, candidate_id, kind)`,
 * and the relegate event is written only when its flag insert actually claimed
 * the row. A second apply over the same run therefore writes nothing new even
 * though the relegate event's own table has no uniqueness of its own.
 *
 * Every statement is schema-qualified with a name `assertDreamRunSchema` has
 * already accepted; every other value is a bind parameter.
 */

import type { PoolClient } from "pg";
import type { ApplyFlagKind } from "./dream-route-signals-store.ts";

/** The `authority_tier` that makes a candidate operator-anchored. */
export const DECIDED_AUTHORITY_TIER = "decided";

/** The `cause` a relegation's tier move is filed under. */
export const REVERSAL_TIER_MOVE_CAUSE = "dream-route-reversal";

/**
 * The tier a relegated rule lands in.
 *
 * `server/db/migrations/050_tier_moves.sql:42` declares `to_tier` NOT NULL, so
 * a relegation names its destination rather than leaving it open, and `cold`
 * is the coldest of the three the resource CHECK allows. Nothing is deleted:
 * the rule is still there and an operator can move it back.
 */
export const RELEGATED_TIER = "cold";

/** One signal row joined to the authority tier its candidate was routed at. */
export interface SignalRow {
  readonly candidateId: string;
  readonly signal: string;
  readonly targetScopeKey: string | null;
  readonly authorityTier: string | null;
}

/** What handling one run's signals wrote. */
export interface SignalCounts {
  /** Rows added to `<schema>.apply_flags`. */
  readonly applyFlags: number;
  /** `relegate` events added to `<schema>.ob_session_events`. */
  readonly relegates: number;
  /** Tier moves added for those relegations. */
  readonly reversalTierMoves: number;
  /** Candidates withheld from the apply because they contradict canon. */
  readonly canonBlocked: number;
}

interface SignalRowShape {
  candidate_id: string;
  signal: string;
  target_scope_key: string | null;
  authority_tier: string | null;
}

/**
 * Reads this run's signals with the authority tier each candidate was routed at.
 *
 * A LEFT JOIN, not an inner one: `routing_decisions` is written by the routing
 * stage and a proof may plant a signal without one. A missing tier is simply
 * not `decided`, which is the conservative answer -- it withholds the
 * relegation rather than performing one on no evidence.
 *
 * `hasDecisions` selects between the joined form and a tier-less one, because
 * an apply over a schema that never ran the routing stage has no
 * `routing_decisions` table at all and the join would raise rather than
 * return no tier. A run with no decisions has no candidate at `decided`, which
 * is the same conservative answer the LEFT JOIN gives for a missing row.
 */
const SIGNAL_SQL = (schema: string, hasDecisions: boolean): string =>
  hasDecisions
    ? `SELECT s.candidate_id,
              s.signal,
              s.target_scope_key,
              d.authority_tier
         FROM ${schema}.route_signals s
         LEFT JOIN ${schema}.routing_decisions d
           ON d.run_id = s.run_id AND d.candidate_id = s.candidate_id
        WHERE s.run_id = $1
        ORDER BY s.candidate_id, s.signal`
    : `SELECT s.candidate_id,
              s.signal,
              s.target_scope_key,
              NULL::text AS authority_tier
         FROM ${schema}.route_signals s
        WHERE s.run_id = $1
        ORDER BY s.candidate_id, s.signal`;

/**
 * Reads one run's signal rows.
 *
 * @param options - The client, the run schema, and the run id.
 * @returns One row per planted or detected signal, tier attached.
 */
export async function readSignals(options: {
  client: PoolClient;
  schema: string;
  runId: string;
}): Promise<readonly SignalRow[]> {
  const { client, schema, runId } = options;
  const present = await client.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [
    `${schema}.routing_decisions`,
  ]);
  const hasDecisions = present.rows[0]?.ok === true;
  const result = await client.query<SignalRowShape>(SIGNAL_SQL(schema, hasDecisions), [
    runId,
  ]);
  return result.rows.map((row) => ({
    candidateId: row.candidate_id,
    signal: row.signal,
    targetScopeKey: row.target_scope_key,
    authorityTier: row.authority_tier,
  }));
}

/**
 * Inserts one flag, and says whether THIS call is the one that wrote it.
 *
 * The boolean is what carries idempotence for everything downstream: a caller
 * writes the relegate event only when it owns the flag.
 */
async function insertFlag(options: {
  client: PoolClient;
  schema: string;
  runId: string;
  candidateId: string;
  kind: ApplyFlagKind;
  targetScopeKey: string | null;
  needsOperatorApproval: boolean;
  applied: boolean;
  reason: string;
}): Promise<boolean> {
  const { client, schema, runId, candidateId, kind } = options;
  const result = await client.query(
    `INSERT INTO ${schema}.apply_flags
       (run_id, candidate_id, kind, target_scope_key, needs_operator_approval,
        applied, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (run_id, candidate_id, kind) DO NOTHING`,
    [
      runId,
      candidateId,
      kind,
      options.targetScopeKey,
      options.needsOperatorApproval,
      options.applied,
      options.reason,
    ],
  );
  return result.rowCount === 1;
}

/**
 * Writes the `relegate` lifecycle event against the rule being reversed.
 *
 * Deliberately the SAME metadata shape as the promote event
 * `scripts/dream-route-apply.ts` writes -- `memory_lifecycle_action`,
 * `candidate_type`, `candidate_scope.key` -- because the reader that selects
 * standing rules filters on exactly those three fields
 * (`server/db/context-pack-repository.ts:146-157`). Only the action differs,
 * plus `needs_operator_approval`, so the relegation is legible to the same
 * reader rather than being a shape it has never seen.
 */
async function insertRelegate(options: {
  client: PoolClient;
  schema: string;
  runId: string;
  candidateId: string;
  scopeKey: string;
  eventType: string;
  candidateType: string;
  source: string;
  tier: string;
}): Promise<string> {
  const { client, schema, runId, candidateId, scopeKey } = options;
  const content = `dream-route reversal of ${scopeKey}`;
  const result = await client.query<{ id: string }>(
    `INSERT INTO ${schema}.ob_session_events
       (lane_id, event_type, content, source, importance, metadata,
        content_hash, created_by, run_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, NULL, $7, $1)
     RETURNING id`,
    [
      runId,
      options.eventType,
      content,
      options.source,
      options.tier,
      JSON.stringify({
        memory_lifecycle_action: "relegate",
        candidate_type: options.candidateType,
        candidate_scope: { key: scopeKey },
        candidate_id: candidateId,
        routing_run_id: runId,
        needs_operator_approval: true,
      }),
      options.source,
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("relegate insert returned no id");
  return id;
}

/** The constants `applyRouting` owns and this module writes rows with. */
export interface SignalWriteContext {
  /** The `event_type` a lifecycle event is stored as. */
  readonly eventType: string;
  /** The `candidate_type` a rule event is filed under. */
  readonly candidateType: string;
  /** The `source`/`created_by` string every router row carries. */
  readonly source: string;
  /** The tier the router commits at. */
  readonly tier: string;
}

async function handleReversal(options: {
  client: PoolClient;
  schema: string;
  runId: string;
  row: SignalRow;
  context: SignalWriteContext;
}): Promise<{ relegates: number; tierMoves: number; flags: number }> {
  const { client, schema, runId, row, context } = options;
  const scopeKey = row.targetScopeKey;
  if (scopeKey === null) throw new Error("a reverses_rule signal carried no target");
  const decided = row.authorityTier === DECIDED_AUTHORITY_TIER;
  const claimed = await insertFlag({
    client,
    schema,
    runId,
    candidateId: row.candidateId,
    kind: "rule_reversal",
    targetScopeKey: scopeKey,
    needsOperatorApproval: true,
    applied: decided,
    reason: decided
      ? `operator-anchored candidate reverses ${scopeKey}; rule relegated pending approval`
      : `observed candidate reverses ${scopeKey}; not authoritative enough to relegate`,
  });
  if (!claimed || !decided)
    return { relegates: 0, tierMoves: 0, flags: claimed ? 1 : 0 };

  const entryId = await insertRelegate({
    client,
    schema,
    runId,
    candidateId: row.candidateId,
    scopeKey,
    eventType: context.eventType,
    candidateType: context.candidateType,
    source: context.source,
    tier: context.tier,
  });
  await client.query(
    `INSERT INTO ${schema}.tier_moves
       (entry_id, source_table, from_tier, to_tier, cause, routing_run_id, run_id)
     VALUES ($1, 'ob_session_events', $2, $3, $4, $5, $5)`,
    [entryId, context.tier, RELEGATED_TIER, REVERSAL_TIER_MOVE_CAUSE, runId],
  );
  return { relegates: 1, tierMoves: 1, flags: 1 };
}

/**
 * Handles every signal on one run, inside the caller's open transaction.
 *
 * Runs BEFORE the commit loop so the canon-blocked set is known when each
 * verdict is considered; the caller withholds those candidates itself.
 *
 * @param options - The client, run schema, run id, and the row constants.
 * @returns The counts written, and the candidate ids the apply must skip.
 */
export async function handleRouteSignals(options: {
  client: PoolClient;
  schema: string;
  runId: string;
  context: SignalWriteContext;
}): Promise<{ counts: SignalCounts; blocked: ReadonlySet<string> }> {
  const { client, schema, runId, context } = options;
  const blocked = new Set<string>();
  let applyFlags = 0;
  let relegates = 0;
  let reversalTierMoves = 0;

  for (const row of await readSignals({ client, schema, runId })) {
    if (row.signal === "contradicts_canon") {
      blocked.add(row.candidateId);
      const claimed = await insertFlag({
        client,
        schema,
        runId,
        candidateId: row.candidateId,
        kind: "canon_contradiction",
        targetScopeKey: row.targetScopeKey,
        needsOperatorApproval: true,
        applied: false,
        reason: "candidate contradicts canon; withheld from the apply",
      });
      if (claimed) applyFlags += 1;
      continue;
    }
    const written = await handleReversal({ client, schema, runId, row, context });
    applyFlags += written.flags;
    relegates += written.relegates;
    reversalTierMoves += written.tierMoves;
  }

  return {
    counts: { applyFlags, relegates, reversalTierMoves, canonBlocked: blocked.size },
    blocked,
  };
}
