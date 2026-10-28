/**
 * Exact-scope checkpoint validation for `session_wrap`.
 *
 * Why this module exists (issue 864): `server/contracts/schemas-events.ts`
 * advertises agent/platform/server_id/channel_id/thread_id on `session_wrap`
 * with exact-scope checkpoint validation, and an earlier implementation of the
 * tool enforced it. The move that made `server/` the owner dropped both the
 * fields and the check, so a checkpoint could land on a lane belonging to a
 * different agent while the contract still promised otherwise. This restores
 * the deleted behavior; it is not new design.
 *
 * It lives beside `session-lifecycle.ts` rather than inside it because that file
 * is already at the per-file line rule and the wrap path needs a `FOR UPDATE`
 * read the session_start analog does not.
 */
import type { QuerySurface } from "../db/transaction.ts";
import { createSessionRepository } from "../db/session-repository.ts";

export type Queryable = QuerySurface;

type WrapScope = {
  agent?: string;
  platform?: string;
  server_id?: string;
  channel_id?: string;
  thread_id?: string;
};

const WRAP_LANE_COLUMNS =
  "id, status, project, agent, source, channel_id, thread_id, metadata, topic";

/**
 * True when the request carries every coordinate the exact-scope predicate
 * needs. `thread_id` is deliberately not required: its absence alongside a
 * `channel_id` is itself an assertion that the lane is unthreaded.
 */
export function hasCompleteExactScope(
  args: WrapScope,
): args is Required<Omit<WrapScope, "thread_id">> & { thread_id?: string } {
  return (
    args.agent !== undefined &&
    args.platform !== undefined &&
    args.server_id !== undefined &&
    args.channel_id !== undefined
  );
}

/**
 * Names of the scope coordinates the request disagrees with the lane about.
 *
 * Field NAMES only — never the stored or requested values. A rejection that
 * echoed content would turn the error path into a read channel onto lanes the
 * caller could not otherwise see (docs/decisions/contract-is-the-agent-surface.md,
 * Rule 2).
 */
function laneMetadata(lane: Record<string, unknown>): Record<string, unknown> {
  return lane.metadata && typeof lane.metadata === "object"
    ? (lane.metadata as Record<string, unknown>)
    : {};
}

/** True when every non-thread coordinate is already asserted on the lane. */
function storedScopeIsComplete(lane: Record<string, unknown>): boolean {
  return (
    lane.agent != null &&
    lane.source != null &&
    laneMetadata(lane).server_id != null &&
    lane.channel_id != null
  );
}

/** One coordinate's verdict: true when the request disagrees with the lane. */
function coordinateConflicts(
  stored: unknown,
  requested: unknown,
  unsetIsAConflict: boolean,
): boolean {
  if (requested === undefined) return false;
  if (stored == null) return unsetIsAConflict && requested !== null;
  return stored !== requested;
}

function scopeConflicts(lane: Record<string, unknown>, args: WrapScope): string[] {
  const metadata = laneMetadata(lane);
  // Supplying channel_id without thread_id asserts an unthreaded lane, so the
  // requested thread_id becomes an explicit null rather than "unspecified".
  const requestedThreadId =
    args.channel_id !== undefined ? (args.thread_id ?? null) : args.thread_id;
  const checks: Array<[string, unknown, unknown, boolean]> = [
    ["agent", lane.agent, args.agent, false],
    ["platform", lane.source, args.platform, false],
    ["server_id", metadata.server_id, args.server_id, false],
    ["channel_id", lane.channel_id, args.channel_id, false],
    // A NULL thread_id on an otherwise complete lane is an assertion of
    // unthreadedness, so a request naming a thread disagrees with it.
    ["thread_id", lane.thread_id, requestedThreadId, storedScopeIsComplete(lane)],
  ];
  return checks
    .filter(([, stored, requested, unsetIsAConflict]) =>
      coordinateConflicts(stored, requested, unsetIsAConflict),
    )
    .map(([name]) => name);
}

/**
 * Fill in the exact-scope coordinates of the lane, once, from a request that
 * supplies all of them.
 *
 * The write is a one-way fill, never a rewrite: each COALESCE only populates a
 * NULL, and the WHERE clause refuses the update when any already-set field
 * disagrees. A lane belonging to a different scope is therefore left untouched
 * and reported by field name, not silently re-pointed — the scope predicate is
 * an isolation boundary, so widening it here would be a security defect.
 *
 * Mirrors `establishExactStartScope` in session-lifecycle.ts, which is the
 * `session_start` analog of the same one-way fill.
 */
async function establishWrapScope(options: {
  db: Queryable;
  lane: Record<string, unknown>;
  namespace: string;
  sessionKey: string;
  args: Required<Omit<WrapScope, "thread_id">> & { thread_id?: string };
}): Promise<Record<string, unknown> | undefined> {
  const { db, lane, namespace, sessionKey, args } = options;
  const repository = createSessionRepository(db);
  return repository.establishWrapScope({
    wrapLaneColumns: WRAP_LANE_COLUMNS,
    values: [
      lane.id,
      namespace,
      sessionKey,
      args.agent,
      args.platform,
      args.server_id,
      args.channel_id,
      args.thread_id ?? null,
    ],
  });
}

/**
 * The rejection body for a checkpoint whose scope disagrees with the lane.
 *
 * Field NAMES only — echoing the stored or requested values would turn the
 * error path into a read channel onto a lane the caller cannot otherwise see
 * (docs/decisions/contract-is-the-agent-surface.md, Rule 2).
 */
/**
 * Fill in the exact-scope coordinates of an EXISTING lane, once, from a
 * session_start that supplies all of them.
 *
 * Why this exists (#646): that handler used to return an existing lane
 * verbatim, so a lane created without full scope — which is every lane a head
 * session opens, `agent` set and source/server_id/channel_id NULL — could never
 * afterwards prove the exact-scope predicate
 * (docs/agent-context-pack-contract.md:99-105). The client's own scope proof
 * then failed permanently, so EVERY capture into that lane was lost. 2009 such
 * lanes existed on the dogfood database when this was measured.
 *
 * Same one-way fill as `establishWrapScope` above: each COALESCE only populates
 * a NULL, and the WHERE clause refuses the update when any already-set field
 * disagrees. The two live together (issue 864) because they are one rule read
 * from two entrypoints, and a divergence between them is a scope-isolation bug.
 */
export async function establishExactStartScope(options: {
  db: Queryable;
  namespace: string;
  sessionKey: string;
  args: WrapScope;
  returningFields: string;
}): Promise<Record<string, unknown> | null> {
  const { db, namespace, sessionKey, args, returningFields } = options;
  if (!hasCompleteExactScope(args)) return null;
  const repository = createSessionRepository(db);
  const row = await repository.establishStartScope({
    returningFields,
    values: [
      namespace,
      sessionKey,
      args.agent,
      args.platform,
      args.server_id,
      args.channel_id,
      args.thread_id ?? null,
    ],
  });
  return row ?? null;
}

/** A lane's `project`, narrowed to the string the wrap payload expects. */
export function laneProject(lane: Record<string, unknown>): string | null {
  return typeof lane.project === "string" ? lane.project : null;
}

export function scopeRejectionText(conflicts: string[]): string {
  return JSON.stringify({
    error: "scope_validation",
    message: "Existing lane scope does not match session_wrap request",
    retryable: false,
    conflicts,
  });
}

type WrapLaneResult =
  | { lane: null; conflicts: string[] }
  | { lane: Record<string, unknown>; conflicts: string[] };

/**
 * Read the lane a `session_wrap` names, and establish its exact scope when the
 * request carries the complete predicate and the lane has room for it.
 *
 * Returns the lane with an empty `conflicts` list when the checkpoint may
 * proceed, `lane: null` when no such lane exists, and a populated `conflicts`
 * list of field names when the request disagrees with what is already asserted.
 */
export async function loadAndEstablishWrapLane(
  db: Queryable,
  namespace: string,
  sessionKey: string,
  args: WrapScope,
): Promise<WrapLaneResult> {
  const repository = createSessionRepository(db);
  const lane = await repository.selectWrapLane({
    wrapLaneColumns: WRAP_LANE_COLUMNS,
    namespace,
    sessionKey,
  });
  if (!lane) return { lane: null, conflicts: [] };

  const conflicts = scopeConflicts(lane, args);
  if (conflicts.length > 0) return { lane, conflicts };
  if (!hasCompleteExactScope(args)) return { lane, conflicts: [] };

  const scopedLane = await establishWrapScope({
    db,
    lane,
    namespace,
    sessionKey,
    args,
  });
  return scopedLane
    ? { lane: scopedLane, conflicts: [] }
    : { lane, conflicts: scopeConflicts(lane, args) };
}
