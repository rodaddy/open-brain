/**
 * The DREAM apply step, writing ONLY into a run schema's mirror tables.
 *
 * `_plans/1469-dream-route.md:73-79` fixes the destinations: `decision`,
 * `fact`, and `correction` take the existing promotion insert with source
 * `dream-route`; `rule` takes a `promote` lifecycle event carrying a scope
 * key; nothing is ever deleted. `docs/dream-ethereal-runs.md:144,162` fixes
 * where: the run's own `dream_run_NNN` schema, never `public`.
 *
 * WHY THE PROMOTION INSERT IS NOT REUSED DIRECTLY. The reuse route would be
 * `createReviewedCandidatePromotionRepository` with `SET LOCAL search_path`
 * pointed at the run schema, since its statements name `thoughts` unqualified
 * (`server/db/reviewed-candidate-promotion-repository.ts:105-131`). It is
 * refused for a concrete reason: that INSERT settles duplicates with
 * `ON CONFLICT (content_hash, namespace) WHERE content_hash IS NOT NULL`,
 * and the mirror is built with `CREATE TABLE ... (LIKE ...)` which copies NO
 * indexes (`scripts/dream-route-apply-store.ts:10-17`), so the arbiter index
 * does not exist there and the statement raises rather than skipping. It also
 * reads `candidate_memory` in `findHumanPromotedCandidate`, a table with no
 * mirror at all. The columns below are therefore mirrored one for one from
 * that same INSERT (repository lines 113-118), with `source` carrying
 * `dream-route` in place of `dream-reviewed-candidate`, and the duplicate is
 * settled by an explicit content-hash read instead.
 *
 * Every statement is schema-qualified with a name `assertDreamRunSchema` has
 * already accepted; every other value is a bind parameter.
 */

import type { PoolClient } from "pg";
import { assertDreamRunSchema } from "./rem-ethereal-cohort.ts";
import { ensureApplyMirrors } from "./dream-route-apply-store.ts";
import { ensureSignalTables } from "./dream-route-signals-store.ts";
import { handleRouteSignals, type SignalCounts } from "./dream-route-apply-signals.ts";
import {
  DREAM_ROUTE_SOURCE,
  DREAM_ROUTE_TIER,
  PROMOTE_EVENT_TYPE,
  RULE_CANDIDATE_TYPE,
  ruleScopeKey,
} from "../server/domain/dream-route/apply-constants.ts";

export {
  DREAM_ROUTE_SOURCE,
  DREAM_ROUTE_TIER,
  PROMOTE_EVENT_TYPE,
  RULE_CANDIDATE_TYPE,
  ruleScopeKey,
} from "../server/domain/dream-route/apply-constants.ts";

/** What `applyRouting` is pointed at. */
export interface ApplyRoutingInput {
  /** A client already checked out; the whole apply runs on it. */
  readonly client: PoolClient;
  /** A `dream_run_NNN` schema name. */
  readonly schema: string;
  /** The routing run whose `would_apply` verdicts are applied. */
  readonly runId: string;
}

/** What one call wrote, and what it declined to write. */
export interface ApplyRoutingCounts {
  /** Rows added to `<schema>.thoughts`. */
  readonly thoughts: number;
  /** Promote events added to `<schema>.ob_session_events`. */
  readonly promotes: number;
  /** Rows added to `<schema>.tier_moves`. */
  readonly tierMoves: number;
  /** Commits declined because the mirror already held the item. */
  readonly skippedExisting: number;
  /** Verdicts that were never commits (`none`, and `reinforce`). */
  readonly notApplied: number;
  /** Rows added to `<schema>.apply_flags` by the signal pass. */
  readonly applyFlags: number;
  /** `relegate` events written for operator-anchored rule reversals. */
  readonly relegates: number;
  /** Tier moves written alongside those relegations. */
  readonly reversalTierMoves: number;
  /** Candidates withheld from the apply because they contradict canon. */
  readonly canonBlocked: number;
}

/**
 * The verdict values `wouldApply` really emits.
 *
 * `scripts/dream-route-run-core.ts:219-226` and its tail: `thought`,
 * `rule_event`, `reinforce`, `none`. Only the first two are commits --
 * `reinforce` strengthens an item the batch already committed and writes no
 * second memory, and `none` is never applied.
 */
const COMMIT_ACTIONS = new Set(["thought", "rule_event"]);

interface PendingItem {
  readonly candidateId: string;
  readonly action: string;
  readonly namespace: string;
  readonly content: string;
  readonly contentHash: string;
  readonly sourceTurnIds: readonly string[];
}

const PENDING_SQL = (schema: string): string =>
  `SELECT w.candidate_id,
          w.action,
          c.namespace,
          c.content_hash,
          c.snapshot
     FROM ${schema}.would_apply w
     JOIN ${schema}.cohort c ON c.candidate_id = w.candidate_id
    WHERE w.run_id = $1
    ORDER BY c.ordinal`;

interface PendingRowShape {
  candidate_id: string;
  action: string;
  namespace: string;
  content_hash: string;
  snapshot: {
    content: string;
    source_turn_ids?: string[] | null;
  };
}

function toPending(row: PendingRowShape): PendingItem {
  return {
    candidateId: row.candidate_id,
    action: row.action,
    namespace: row.namespace,
    content: row.snapshot.content,
    contentHash: row.content_hash,
    sourceTurnIds: row.snapshot.source_turn_ids ?? [],
  };
}

async function thoughtExists(options: {
  client: PoolClient;
  schema: string;
  contentHash: string;
  namespace: string;
}): Promise<boolean> {
  const { client, schema, contentHash, namespace } = options;
  const result = await client.query(
    `SELECT 1 FROM ${schema}.thoughts
      WHERE content_hash = $1 AND namespace = $2 LIMIT 1`,
    [contentHash, namespace],
  );
  return result.rowCount !== null && result.rowCount > 0;
}

async function promoteExists(options: {
  client: PoolClient;
  schema: string;
  scopeKey: string;
}): Promise<boolean> {
  const { client, schema, scopeKey } = options;
  const result = await client.query(
    `SELECT 1 FROM ${schema}.ob_session_events
      WHERE metadata->>'memory_lifecycle_action' = 'promote'
        AND metadata->'candidate_scope'->>'key' = $1
      LIMIT 1`,
    [scopeKey],
  );
  return result.rowCount !== null && result.rowCount > 0;
}

/**
 * Mirrors the promotion insert's column list against the run schema.
 *
 * Columns and their source line in
 * `server/db/reviewed-candidate-promotion-repository.ts`: `content`, `tags`,
 * `source`, `created_by`, `namespace`, `embedding`, `content_hash`,
 * `embedded_at`, `embedding_model`, `source_refs`, `promoted_from` (113-118).
 * `embedding` is null here because the apply step embeds nothing, matching the
 * repository's own null `embedded_at`/`embedding_model` pair; `promoted_from`
 * carries the link back to the candidate.
 */
async function insertMirrorThought(options: {
  client: PoolClient;
  schema: string;
  runId: string;
  item: PendingItem;
}): Promise<string> {
  const { client, schema, runId, item } = options;
  const result = await client.query<{ id: string }>(
    `INSERT INTO ${schema}.thoughts
       (content, tags, source, created_by, namespace, embedding, content_hash,
        embedded_at, embedding_model, source_refs, promoted_from, tier, run_id)
     VALUES ($1, $2, $3, $4, $5, NULL, $6, NULL, NULL, $7::jsonb, $8::jsonb,
             $9, $10)
     RETURNING id`,
    [
      item.content,
      [DREAM_ROUTE_SOURCE],
      DREAM_ROUTE_SOURCE,
      DREAM_ROUTE_SOURCE,
      item.namespace,
      item.contentHash,
      JSON.stringify(item.sourceTurnIds),
      JSON.stringify({
        source: DREAM_ROUTE_SOURCE,
        candidate_id: item.candidateId,
        routing_run_id: runId,
      }),
      DREAM_ROUTE_TIER,
      runId,
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("mirror thought insert returned no id");
  return id;
}

/**
 * Writes the `promote` lifecycle event in the shape the context pack reads.
 *
 * The three metadata fields the reader filters on are
 * `memory_lifecycle_action`, `candidate_type`, and `candidate_scope.key`
 * (`server/db/context-pack-repository.ts:146-157`).
 */
async function insertMirrorPromote(options: {
  client: PoolClient;
  schema: string;
  runId: string;
  item: PendingItem;
}): Promise<string> {
  const { client, schema, runId, item } = options;
  const result = await client.query<{ id: string }>(
    `INSERT INTO ${schema}.ob_session_events
       (lane_id, event_type, content, source, importance, metadata,
        content_hash, created_by, run_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
     RETURNING id`,
    [
      runId,
      PROMOTE_EVENT_TYPE,
      item.content,
      DREAM_ROUTE_SOURCE,
      DREAM_ROUTE_TIER,
      JSON.stringify({
        memory_lifecycle_action: "promote",
        candidate_type: RULE_CANDIDATE_TYPE,
        candidate_scope: { key: ruleScopeKey(item.contentHash) },
        candidate_id: item.candidateId,
        routing_run_id: runId,
      }),
      item.contentHash,
      DREAM_ROUTE_SOURCE,
      runId,
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("mirror promote insert returned no id");
  return id;
}

async function insertTierMove(options: {
  client: PoolClient;
  schema: string;
  runId: string;
  entryId: string;
  sourceTable: "thoughts" | "ob_session_events";
}): Promise<void> {
  const { client, schema, runId, entryId, sourceTable } = options;
  await client.query(
    `INSERT INTO ${schema}.tier_moves
       (entry_id, source_table, from_tier, to_tier, cause, routing_run_id, run_id)
     VALUES ($1, $2, NULL, $3, $4, $5, $5)`,
    [entryId, sourceTable, DREAM_ROUTE_TIER, DREAM_ROUTE_SOURCE, runId],
  );
}

/** What applying one item did: the destination it landed in, or a skip. */
type ItemOutcome = "thought" | "promote" | "skipped" | "not-applied";

/**
 * Applies ONE verdict, writing at most one mirror row plus its tier move.
 *
 * Separated from the loop so the per-destination branch reads on its own and
 * the caller stays a tally: the counting and the deciding are different jobs.
 *
 * @param options - The client, run schema, run id, and the item.
 * @returns Which destination the item landed in, or why it did not.
 */
async function applyItem(options: {
  client: PoolClient;
  schema: string;
  runId: string;
  item: PendingItem;
}): Promise<ItemOutcome> {
  const { client, schema, runId, item } = options;
  if (!COMMIT_ACTIONS.has(item.action)) return "not-applied";

  if (item.action === "rule_event") {
    const scopeKey = ruleScopeKey(item.contentHash);
    if (await promoteExists({ client, schema, scopeKey })) return "skipped";
    const entryId = await insertMirrorPromote({ client, schema, runId, item });
    await insertTierMove({
      client,
      schema,
      runId,
      entryId,
      sourceTable: "ob_session_events",
    });
    return "promote";
  }

  const duplicate = await thoughtExists({
    client,
    schema,
    contentHash: item.contentHash,
    namespace: item.namespace,
  });
  if (duplicate) return "skipped";
  const entryId = await insertMirrorThought({ client, schema, runId, item });
  await insertTierMove({ client, schema, runId, entryId, sourceTable: "thoughts" });
  return "thought";
}

/**
 * Applies one routing run's commit verdicts into its own run schema.
 *
 * Everything happens in ONE transaction, so a failure anywhere leaves the
 * mirror exactly as it was. Nothing is updated and nothing is deleted: a
 * second call over the same run finds every item already present and returns
 * zero for all three write counts.
 *
 * @param input - The pool, the run schema, and the run id.
 * @returns What was written, and what was declined.
 * @throws {Error} When the schema is not a `dream_run_NNN` name.
 */
export async function applyRouting(
  input: ApplyRoutingInput,
): Promise<ApplyRoutingCounts> {
  const { client, schema, runId } = input;
  assertDreamRunSchema(schema);

  let thoughts = 0;
  let promotes = 0;
  let tierMoves = 0;
  let skippedExisting = 0;
  let notApplied = 0;
  let signalCounts: SignalCounts = {
    applyFlags: 0,
    relegates: 0,
    reversalTierMoves: 0,
    canonBlocked: 0,
  };

  await client.query("BEGIN");
  try {
    await ensureApplyMirrors({ client, schema });
    await ensureSignalTables({ client, schema });
    // Before the commit loop, so the canon-blocked set is already known when
    // each verdict is considered: a contradiction withholds the candidate,
    // which is a decision the loop cannot make on its own.
    const signals = await handleRouteSignals({
      client,
      schema,
      runId,
      context: {
        eventType: PROMOTE_EVENT_TYPE,
        candidateType: RULE_CANDIDATE_TYPE,
        source: DREAM_ROUTE_SOURCE,
        tier: DREAM_ROUTE_TIER,
      },
    });
    signalCounts = signals.counts;
    const pending = await client.query<PendingRowShape>(PENDING_SQL(schema), [runId]);

    for (const row of pending.rows) {
      if (signals.blocked.has(row.candidate_id)) continue;
      const outcome = await applyItem({
        client,
        schema,
        runId,
        item: toPending(row),
      });
      if (outcome === "not-applied") notApplied += 1;
      if (outcome === "skipped") skippedExisting += 1;
      if (outcome === "thought") {
        thoughts += 1;
        tierMoves += 1;
      }
      if (outcome === "promote") {
        promotes += 1;
        tierMoves += 1;
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  return {
    thoughts,
    promotes,
    tierMoves,
    skippedExisting,
    notApplied,
    ...signalCounts,
  };
}
