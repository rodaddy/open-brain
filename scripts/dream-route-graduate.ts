/**
 * Graduation and undo for the DREAM route, inside a run schema's mirrors only.
 *
 * THE RULE (operator ruling 2026-09-21, issue 1469 comment 39982;
 * `_plans/1469-dream-route.md:75-76,95,98-99`; `docs/dream-design.md:265`,
 * `1325-1327`): a `decided` item graduates to always-known when it recurs in
 * THREE OR MORE DISTINCT SESSIONS, counting only operator-anchored repeats.
 *
 * WHICH COLUMN CARRIES A REPEAT. Two columns could plausibly link a repeat to
 * the item it repeats, and they are not interchangeable.
 * `routing_decisions.restates` is a BOOLEAN -- it says a row restated
 * something, never what. `would_apply.reinforces` is the UUID of the target
 * (`scripts/dream-route-run-store.ts:170-176` writes it;
 * `scripts/dream-route-run-core.ts:376` sets it to the survivor's candidate
 * id). Only the second can build a repeat SET, so `reinforces` is the link and
 * `restates` is used only as corroboration of tier on the repeat's own row.
 *
 * WHICH COLUMN CARRIES A SESSION. Neither the run schema's `cohort`
 * (`scripts/dream-route-cohort.ts:268-275`) nor `public.candidate_memory`
 * (`server/db/migrations/033_candidate_memory.sql:59-101`) has a session
 * column. The identifier exists one hop away: a candidate carries
 * `source_turn_ids`, and `ob_raw_turns.session_ref` is the
 * "opaque client-side session identifier"
 * (`server/db/migrations/032_raw_turns.sql:79-81`). The cohort's frozen
 * `snapshot.source_turn_ids` is therefore joined against `ob_raw_turns` to
 * resolve sessions: the run schema's own frozen copy when the run made one,
 * and `public.ob_raw_turns` READ-ONLY otherwise. A run that froze its turns
 * stays reproducible after `public` moves on, which is the same reason the
 * cohort is frozen at all. Nothing is ever written to `public`.
 *
 * WHY ONLY `fact` AND `decision`. The ruling names corrections and
 * preferences as items that never graduate, so `destination` is filtered to
 * the two graduating kinds rather than the tier alone.
 *
 * Every statement is schema-qualified with a name `assertDreamRunSchema` has
 * accepted; every other value is a bind parameter.
 */

import type { PoolClient } from "pg";
import { assertDreamRunSchema } from "./rem-ethereal-cohort.ts";
import { ensureApplyMirrors } from "./dream-route-apply-store.ts";
import {
  DREAM_ROUTE_SOURCE,
  DREAM_ROUTE_TIER,
  PROMOTE_EVENT_TYPE,
  RULE_CANDIDATE_TYPE,
} from "./dream-route-apply.ts";

/** How many distinct sessions a `decided` item must recur in, by default. */
export const DEFAULT_GRADUATION_SESSIONS = 3;

/** The tier a graduation moves an item into: always-known. */
export const GRADUATED_TIER = "hot";

/** `tier_moves.cause` for a graduation. */
export const GRADUATE_CAUSE = "dream-route-graduation";

/** `tier_moves.cause` for an undo. */
export const UNDO_CAUSE = "dream-route-undo";

/** The authority tier that can graduate; nothing weaker ever does. */
const GRADUATING_TIER = "decided";

/** The destinations that can graduate; corrections and preferences cannot. */
const GRADUATING_DESTINATIONS = ["fact", "decision"];

/**
 * The scope key a graduation is filed under.
 *
 * Same stability argument as `ruleScopeKey` in
 * `scripts/dream-route-apply.ts`: the content hash is the identity both the
 * thought path and the rule path already deduplicate on, so a re-run cannot
 * resurrect a graduation the operator undid.
 *
 * @param contentHash - The target's frozen content hash.
 * @returns The string stored at `metadata.candidate_scope.key`.
 */
export function graduateScopeKey(contentHash: string): string {
  return `dream-route:graduate:${contentHash}`;
}

/** One lifecycle event, as `activeScopeKeys` needs to see it. */
export interface ScopedLifecycleEvent {
  /** `promote`, `relegate`, or anything else (ignored). */
  readonly action: string | null;
  /** The key at `metadata.candidate_scope.key`, or null when absent. */
  readonly scopeKey: string | null;
  /** When it was written; ordering is by this, ascending. */
  readonly createdAt: Date | string;
}

/**
 * The scope keys still standing, by the context pack's own latest-wins rule.
 *
 * `server/tools/context-pack-guidance.ts:15-55` and `99-108`: the stream is
 * append-only and carries no link from a `relegate` back to the `promote` it
 * supersedes, so supersession is reconciled ONLY through the explicit
 * `candidate_scope.key`, and the NEWEST decisive action for a key is the
 * standing one. A key promoted, undone, then promoted again is standing --
 * which is why this collects the last action per key rather than collecting
 * every relegate.
 *
 * Pure: it sorts a copy and reads nothing else.
 *
 * @param events - Lifecycle events in any order; keyless ones are ignored.
 * @returns The keys whose newest decisive action is `promote`, sorted.
 */
export function activeScopeKeys(
  events: readonly ScopedLifecycleEvent[],
): readonly string[] {
  const time = (value: Date | string): number => new Date(value).getTime();
  const latest = new Map<string, string>();
  const ordered = [...events].sort((a, b) => time(a.createdAt) - time(b.createdAt));
  for (const event of ordered) {
    if (event.scopeKey === null || event.scopeKey.length === 0) continue;
    if (event.action !== "promote" && event.action !== "relegate") continue;
    latest.set(event.scopeKey, event.action);
  }
  return [...latest.entries()]
    .filter(([, action]) => action === "promote")
    .map(([key]) => key)
    .sort();
}

/** What `graduateRecurring` is pointed at. */
export interface GraduateRecurringInput {
  /** A client already checked out; the whole graduation runs on it. */
  readonly client: PoolClient;
  /** A `dream_run_NNN` schema name. */
  readonly schema: string;
  /** The routing run whose decisions are examined. */
  readonly runId: string;
  /** Distinct-session threshold; defaults to `DEFAULT_GRADUATION_SESSIONS`. */
  readonly graduationSessions?: number;
}

/** What one graduation call wrote. */
export interface GraduateRecurringCounts {
  /** `promote` events added to `<schema>.ob_session_events`. */
  readonly graduated: number;
  /** Targets declined because the mirror already holds their promote. */
  readonly skippedExisting: number;
  /** Rows added to `<schema>.tier_moves`. */
  readonly tierMoves: number;
  /** The threshold actually used. */
  readonly graduationSessions: number;
  /** Where the threshold was recorded, or why it was not. */
  readonly parameterRecordedAt: string;
  /** The candidate ids that graduated, in the order they were written. */
  readonly graduatedCandidateIds: readonly string[];
}

/** One graduation target plus the session count that qualified it. */
interface Target {
  readonly candidateId: string;
  readonly contentHash: string;
  readonly namespace: string;
  readonly content: string;
  readonly sessions: number;
}

interface TargetRowShape {
  candidate_id: string;
  content_hash: string;
  namespace: string;
  content: string;
  sessions: string;
}

/**
 * The one query that finds every qualifying target, with its session count.
 *
 * `repeats` is the target itself UNION its `decided` reinforcers; `sessions`
 * resolves each member's frozen `source_turn_ids` against
 * `public.ob_raw_turns.session_ref` (read-only) and counts the distinct ones.
 */
const TARGET_SQL = (schema: string, turns: string): string => `
WITH decided AS (
  SELECT d.candidate_id, c.content_hash, c.namespace, c.snapshot, d.destination
    FROM ${schema}.routing_decisions d
    JOIN ${schema}.cohort c ON c.candidate_id = d.candidate_id
   WHERE d.run_id = $1 AND d.authority_tier = $2
),
targets AS (
  SELECT * FROM decided WHERE destination = ANY ($3::text[])
),
repeats AS (
  SELECT t.candidate_id AS target_id, t.candidate_id AS member_id, t.snapshot
    FROM targets t
  UNION
  SELECT w.reinforces AS target_id, r.candidate_id AS member_id, r.snapshot
    FROM ${schema}.would_apply w
    JOIN decided r ON r.candidate_id = w.candidate_id
    JOIN targets t ON t.candidate_id = w.reinforces
   WHERE w.run_id = $1 AND w.reinforces IS NOT NULL
),
sessions AS (
  SELECT r.target_id, count(DISTINCT turn.session_ref) AS sessions
    FROM repeats r
    CROSS JOIN LATERAL jsonb_array_elements_text(
      COALESCE(r.snapshot->'source_turn_ids', '[]'::jsonb)) AS ids(turn_id)
    JOIN ${turns} turn ON turn.id = ids.turn_id::uuid
   WHERE turn.session_ref IS NOT NULL
   GROUP BY r.target_id
)
SELECT t.candidate_id,
       t.content_hash,
       t.namespace,
       t.snapshot->>'content' AS content,
       s.sessions::text AS sessions
  FROM targets t
  JOIN sessions s ON s.target_id = t.candidate_id
 WHERE s.sessions >= $4
 ORDER BY t.content_hash`;

/**
 * The `ob_raw_turns` relation to resolve sessions against.
 *
 * The run's own frozen copy wins when it exists; `public` is the read-only
 * fallback. Announced in the returned counts rather than chosen silently.
 *
 * @param client - A client inside the transaction.
 * @param schema - The run schema, already asserted.
 * @returns A schema-qualified relation name.
 */
async function turnsRelation(client: PoolClient, schema: string): Promise<string> {
  const result = await client.query<{ present: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS present`,
    [`${schema}.ob_raw_turns`],
  );
  return result.rows[0]?.present === true
    ? `${schema}.ob_raw_turns`
    : "public.ob_raw_turns";
}

async function readTargets(
  client: PoolClient,
  schema: string,
  runId: string,
  threshold: number,
): Promise<readonly Target[]> {
  const turns = await turnsRelation(client, schema);
  const result = await client.query<TargetRowShape>(TARGET_SQL(schema, turns), [
    runId,
    GRADUATING_TIER,
    GRADUATING_DESTINATIONS,
    threshold,
  ]);
  return result.rows.map((row) => ({
    candidateId: row.candidate_id,
    contentHash: row.content_hash,
    namespace: row.namespace,
    content: row.content,
    sessions: Number(row.sessions),
  }));
}

/** Whether the mirror already holds a lifecycle event for this scope key. */
async function eventExists(options: {
  client: PoolClient;
  schema: string;
  scopeKey: string;
  action: string;
}): Promise<boolean> {
  const { client, schema, scopeKey, action } = options;
  const result = await client.query(
    `SELECT 1 FROM ${schema}.ob_session_events
      WHERE metadata->>'memory_lifecycle_action' = $1
        AND metadata->'candidate_scope'->>'key' = $2
      LIMIT 1`,
    [action, scopeKey],
  );
  return result.rowCount !== null && result.rowCount > 0;
}

/**
 * Writes one lifecycle event in exactly the shape the apply step uses.
 *
 * The column list and the three filtered metadata fields are mirrored from
 * `insertMirrorPromote` in `scripts/dream-route-apply.ts`, so a graduation and
 * a rule promote are the same row shape to the reader
 * (`server/db/context-pack-repository.ts:146-157`); only the extra metadata
 * and the action differ.
 */
async function insertLifecycleEvent(options: {
  client: PoolClient;
  schema: string;
  runId: string;
  event: {
    readonly action: string;
    readonly content: string;
    readonly contentHash: string;
    readonly scopeKey: string;
    readonly extra: Record<string, unknown>;
  };
}): Promise<string> {
  const { client, schema, runId, event } = options;
  const result = await client.query<{ id: string }>(
    `INSERT INTO ${schema}.ob_session_events
       (lane_id, event_type, content, source, importance, metadata,
        content_hash, created_by, run_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
     RETURNING id`,
    [
      runId,
      PROMOTE_EVENT_TYPE,
      event.content,
      DREAM_ROUTE_SOURCE,
      DREAM_ROUTE_TIER,
      JSON.stringify({
        memory_lifecycle_action: event.action,
        candidate_type: RULE_CANDIDATE_TYPE,
        candidate_scope: { key: event.scopeKey },
        routing_run_id: runId,
        ...event.extra,
      }),
      event.contentHash,
      DREAM_ROUTE_SOURCE,
      runId,
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("graduate lifecycle insert returned no id");
  return id;
}

async function insertTierMove(options: {
  client: PoolClient;
  schema: string;
  runId: string;
  entryId: string;
  cause: string;
}): Promise<void> {
  const { client, schema, runId, entryId, cause } = options;
  const fromTier = cause === GRADUATE_CAUSE ? DREAM_ROUTE_TIER : GRADUATED_TIER;
  const toTier = cause === GRADUATE_CAUSE ? GRADUATED_TIER : DREAM_ROUTE_TIER;
  await client.query(
    `INSERT INTO ${schema}.tier_moves
       (entry_id, source_table, from_tier, to_tier, cause, routing_run_id, run_id)
     VALUES ($1, 'ob_session_events', $2, $3, $4, $5, $5)`,
    [entryId, fromTier, toTier, cause, runId],
  );
}

/**
 * Records the threshold used, in `<schema>.routing_runs.note`.
 *
 * `routing_runs` has no parameters column
 * (`scripts/dream-route-run-store.ts:131-145`); `note` is the one free-text
 * field on the run header, so the value is appended there rather than
 * inferred later from the row count. Appending, never replacing: the note is
 * the operator's, and overwriting it would lose why the run was made.
 * Nothing is adjusted silently -- the returned counts name this location too.
 *
 * @returns Where the value landed, for the caller's receipt.
 */
async function recordParameter(options: {
  client: PoolClient;
  schema: string;
  runId: string;
  graduationSessions: number;
}): Promise<string> {
  const { client, schema, runId, graduationSessions } = options;
  const marker = `graduationSessions=${graduationSessions}`;
  const result = await client.query(
    `UPDATE ${schema}.routing_runs
        SET note = CASE WHEN note = '' THEN $2 ELSE note || ' ' || $2 END
      WHERE run_id = $1 AND position($2 in note) = 0`,
    [runId, marker],
  );
  const written = result.rowCount !== null && result.rowCount > 0;
  return written
    ? `${schema}.routing_runs.note (${marker})`
    : `${schema}.routing_runs.note already carried ${marker}`;
}

/**
 * Graduates every `decided` target that recurs across enough distinct sessions.
 *
 * ONE transaction. Nothing is updated except the run header's note, and
 * nothing is ever deleted: a second call finds every scope key already
 * promoted in the mirror and writes nothing.
 *
 * @param input - The client, the run schema, the run id, and the threshold.
 * @returns What was written, and the candidate ids that graduated.
 * @throws {Error} When the schema is not a `dream_run_NNN` name.
 */
export async function graduateRecurring(
  input: GraduateRecurringInput,
): Promise<GraduateRecurringCounts> {
  const { client, schema, runId } = input;
  const graduationSessions = input.graduationSessions ?? DEFAULT_GRADUATION_SESSIONS;
  assertDreamRunSchema(schema);

  const graduatedCandidateIds: string[] = [];
  let skippedExisting = 0;
  let parameterRecordedAt = "";

  await client.query("BEGIN");
  try {
    await ensureApplyMirrors({ client, schema });
    parameterRecordedAt = await recordParameter({
      client,
      schema,
      runId,
      graduationSessions,
    });
    const targets = await readTargets(client, schema, runId, graduationSessions);
    for (const target of targets) {
      const scopeKey = graduateScopeKey(target.contentHash);
      if (await eventExists({ client, schema, scopeKey, action: "promote" })) {
        skippedExisting += 1;
        continue;
      }
      const entryId = await insertLifecycleEvent({
        client,
        schema,
        runId,
        event: {
          action: "promote",
          content: target.content,
          contentHash: target.contentHash,
          scopeKey,
          extra: {
            candidate_id: target.candidateId,
            graduated_from_sessions: target.sessions,
          },
        },
      });
      await insertTierMove({ client, schema, runId, entryId, cause: GRADUATE_CAUSE });
      graduatedCandidateIds.push(target.candidateId);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  return {
    graduated: graduatedCandidateIds.length,
    skippedExisting,
    tierMoves: graduatedCandidateIds.length,
    graduationSessions,
    parameterRecordedAt,
    graduatedCandidateIds,
  };
}

/** What `undoGraduate` is pointed at. */
export interface UndoGraduateInput {
  /** A client already checked out. */
  readonly client: PoolClient;
  /** A `dream_run_NNN` schema name. */
  readonly schema: string;
  /** The routing run the undo is attributed to. */
  readonly runId: string;
  /** The graduation scope key to retire. */
  readonly scopeKey: string;
}

/** What one undo call wrote. */
export interface UndoGraduateCounts {
  /** `relegate` events written: 1, or 0 when there was nothing to retire. */
  readonly relegated: number;
  /** Rows added to `<schema>.tier_moves`. */
  readonly tierMoves: number;
}

/**
 * Retires one graduation by APPENDING a `relegate`; nothing is deleted.
 *
 * The append is the whole mechanism: a reader applying `activeScopeKeys` sees
 * the newer `relegate` as the standing action and stops surfacing the
 * graduate, while the `promote` stays on the record as the fact it is. A
 * second call finds the key already relegated and writes nothing.
 *
 * @param input - The client, the run schema, the run id, and the scope key.
 * @returns What was written.
 * @throws {Error} When the schema is not a `dream_run_NNN` name.
 */
export async function undoGraduate(
  input: UndoGraduateInput,
): Promise<UndoGraduateCounts> {
  const { client, schema, runId, scopeKey } = input;
  assertDreamRunSchema(schema);

  await client.query("BEGIN");
  try {
    await ensureApplyMirrors({ client, schema });
    const standing = await client.query<{ content: string; content_hash: string }>(
      `SELECT content, content_hash FROM ${schema}.ob_session_events
        WHERE metadata->'candidate_scope'->>'key' = $1
          AND metadata->>'memory_lifecycle_action' = 'promote'
        ORDER BY created_at DESC LIMIT 1`,
      [scopeKey],
    );
    const promote = standing.rows[0];
    const already = await eventExists({
      client,
      schema,
      scopeKey,
      action: "relegate",
    });
    if (promote === undefined || already) {
      await client.query("COMMIT");
      return { relegated: 0, tierMoves: 0 };
    }
    const entryId = await insertLifecycleEvent({
      client,
      schema,
      runId,
      event: {
        action: "relegate",
        content: promote.content,
        contentHash: promote.content_hash,
        scopeKey,
        extra: { undo_of: scopeKey },
      },
    });
    await insertTierMove({ client, schema, runId, entryId, cause: UNDO_CAUSE });
    await client.query("COMMIT");
    return { relegated: 1, tierMoves: 1 };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
