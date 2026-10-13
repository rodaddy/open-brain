// The two source sweeps the lane→shared-kb promoter runs (issue #161): the
// promoteEntry-backed tables, and lane events inserted directly. Split out of
// the entrypoint at issue 864 L6. Cursor advance, kill-on-failure, dry-run
// behaviour, and the nomination clearing rules are unchanged; each loop body is
// now a named step so no block nests more than three deep.
import { clusterPromotedThought } from "../cluster-promoted-thought.ts";
import {
  classifyShareCandidate,
  type createPool,
  generateEmbedding,
  logger,
  physicalNamespace,
  promoteEntry,
} from "../settings.ts";
import { addCount, rejectionField, sanitizeError, sleep } from "./args-state.ts";
import {
  clearNomination,
  nominatedEventRows,
  nominatedTableRows,
  shareEventToSharedKb,
} from "./rows.ts";
import type {
  Args,
  Cursor,
  NominatedEventRow,
  NominatedRow,
  PromoteTable,
  Receipt,
  Source,
  State,
} from "./types.ts";
import type { AuthInfo } from "../settings.ts";

type Pool = ReturnType<typeof createPool>;

/** Everything a sweep needs beyond its own rows, gathered once by the runner. */
export interface SweepContext {
  pool: Pool;
  args: Args;
  state: State;
  receipt: Receipt;
  auth: AuthInfo;
  promotedBy: string;
  targetPhysicalNamespace: string;
  targetCanonicalNamespace: string;
  /** Promotions written so far this run, shared across both sweeps. */
  applied: number;
}

/** What the caller should do with the loop after one row has been handled. */
type StepOutcome = "continue" | "stop";

function cursorOf(row: { created_at: string; id: string }): Cursor {
  return { created_at: new Date(row.created_at).toISOString(), id: row.id };
}

/** True once apply mode has written as many promotions as the run allows. */
function applyExhausted(ctx: SweepContext): boolean {
  return ctx.args.apply && ctx.applied >= ctx.args.maxApply;
}

/**
 * Record a non-share classification, clear a terminal rejection's nomination,
 * and advance the cursor.
 *
 * The cursor advances for EVERY processed row, manual-review included —
 * otherwise a trailing manual-review row pins the cursor and the runner
 * re-scans it forever (stuck-loop). manual-review keeps its nomination flag so
 * a human can still resolve it.
 */
async function recordRejection(
  ctx: SweepContext,
  source: Source,
  location: { table: string; column: string },
  row: {
    id: string;
    cursor: Cursor;
    decision: ReturnType<typeof classifyShareCandidate>;
  },
): Promise<void> {
  addCount(ctx.receipt, source, rejectionField(row.decision));
  if (!ctx.args.apply) return;
  if (row.decision !== "manual-review") {
    await clearNomination(ctx.pool, location, row.id, new Date().toISOString());
  }
  ctx.state.cursors[source] = row.cursor;
}

/**
 * Record a row that threw. The cursor advances past it in apply mode before the
 * sweep stops, so a deterministically-failing row cannot pin the cursor and
 * block every row behind it on the next run (poison-pill loop). The nomination
 * flag is intentionally left set and the failure is recorded for follow-up.
 */
function recordFailure(
  ctx: SweepContext,
  source: Source,
  row: { id: string; cursor: Cursor },
  err: unknown,
): void {
  addCount(ctx.receipt, source, "failed");
  ctx.receipt.failures.push({ source, id: row.id, error: sanitizeError(err) });
  if (ctx.args.apply) ctx.state.cursors[source] = row.cursor;
}

/** Cluster-supplement (#173): link a freshly shared thought into a cluster. */
async function clusterShared(
  ctx: SweepContext,
  source: Source,
  newId: string,
  namespace: string,
): Promise<void> {
  const clustered = await clusterPromotedThought(
    ctx.pool,
    newId,
    namespace,
    ctx.promotedBy,
  );
  if (clustered) addCount(ctx.receipt, source, "clustered");
}

/** Promote one nominated table row and fold its result into the receipt. */
async function promoteTableRow(
  ctx: SweepContext,
  table: PromoteTable,
  row: NominatedRow,
): Promise<void> {
  const result = await promoteEntry(
    ctx.pool,
    table,
    row.id,
    ctx.args.targetNamespace,
    "lane-shared promoter nomination",
    ctx.auth,
    { dryRun: !ctx.args.apply },
  );
  if (result.status === "duplicate") {
    addCount(ctx.receipt, table, "duplicates");
    return;
  }
  if (result.status === "dry_run") {
    addCount(ctx.receipt, table, "would_share");
    return;
  }
  if (result.status !== "promoted") return;
  ctx.applied += 1;
  addCount(ctx.receipt, table, "shared");
  logger.info("shared_promoter_promoted", {
    actor: ctx.promotedBy,
    source: table,
    id: row.id,
    new_id: result.new_id,
  });
  // thoughts only: decisions land in their own table, so there is nothing in
  // the thought clusters to link them to.
  if (table === "thoughts" && result.new_id) {
    await clusterShared(
      ctx,
      table,
      result.new_id,
      physicalNamespace(ctx.args.targetNamespace),
    );
  }
}

async function stepTableRow(
  ctx: SweepContext,
  table: PromoteTable,
  row: NominatedRow,
): Promise<StepOutcome> {
  addCount(ctx.receipt, table, "scanned");
  const cursor = cursorOf(row);
  const location = { table, column: "extracted_metadata" };
  const decision = classifyShareCandidate(
    {
      content: row.content,
      tags: row.tags ?? undefined,
      metadata: row.metadata ?? undefined,
    },
    { minLen: ctx.args.minContentLength },
  );
  if (decision !== "share") {
    await recordRejection(ctx, table, location, { id: row.id, cursor, decision });
    return "continue";
  }
  if (applyExhausted(ctx)) return "stop";

  try {
    await promoteTableRow(ctx, table, row);
    if (ctx.args.apply) {
      await clearNomination(ctx.pool, location, row.id, new Date().toISOString());
      ctx.state.cursors[table] = cursor;
    }
  } catch (err) {
    recordFailure(ctx, table, { id: row.id, cursor }, err);
    return "stop";
  }
  if (ctx.args.delayMs > 0) await sleep(ctx.args.delayMs);
  return "continue";
}

/** Sweep the promoteEntry-backed tables, in their declared order. */
export async function sweepPromoteTables(
  ctx: SweepContext,
  tables: readonly PromoteTable[],
): Promise<void> {
  for (const table of tables) {
    const rows = await nominatedTableRows(
      ctx.pool,
      table,
      ctx.state.cursors[table],
      ctx.args.batchSize,
    );
    for (const row of rows) {
      if ((await stepTableRow(ctx, table, row)) === "stop") return;
    }
  }
}

const EVENTS: Source = "ob_session_events";
const EVENT_LOCATION = { table: "ob_session_events", column: "metadata" };

/** Embed the event, insert it, and fold the outcome into the receipt. */
async function shareEvent(ctx: SweepContext, event: NominatedEventRow): Promise<void> {
  let embedding: number[] | null = null;
  try {
    embedding = await generateEmbedding(event.content);
  } catch {
    embedding = null;
  }

  const insertedId = await shareEventToSharedKb(ctx.pool, event, {
    targetPhysicalNamespace: ctx.targetPhysicalNamespace,
    targetCanonicalNamespace: ctx.targetCanonicalNamespace,
    embedding,
    reason: "lane-shared promoter nomination",
    promotedBy: ctx.promotedBy,
  });
  if (!insertedId) {
    addCount(ctx.receipt, EVENTS, "duplicates");
    return;
  }
  ctx.applied += 1;
  addCount(ctx.receipt, EVENTS, "shared");
  logger.info("shared_promoter_promoted", {
    actor: ctx.promotedBy,
    source: EVENTS,
    id: event.id,
  });
  // Cluster-supplement (#173): APPLY-only, post-insert, never dry-run.
  await clusterShared(ctx, EVENTS, insertedId, ctx.targetPhysicalNamespace);
}

async function stepEvent(
  ctx: SweepContext,
  event: NominatedEventRow,
): Promise<StepOutcome> {
  addCount(ctx.receipt, EVENTS, "scanned");
  const cursor = cursorOf(event);
  const decision = classifyShareCandidate(
    {
      event_type: event.event_type,
      importance: event.importance,
      content: event.content,
      metadata: event.metadata ?? undefined,
    },
    { minLen: ctx.args.minContentLength },
  );
  if (decision !== "share") {
    await recordRejection(ctx, EVENTS, EVENT_LOCATION, {
      id: event.id,
      cursor,
      decision,
    });
    return "continue";
  }
  if (applyExhausted(ctx)) return "stop";

  try {
    // Dry-run must not call the embedding endpoint (no write, no vector needed,
    // and it is the expensive part of a sweep). Count and skip.
    if (!ctx.args.apply) {
      addCount(ctx.receipt, EVENTS, "would_share");
      return "continue";
    }
    await shareEvent(ctx, event);
    await clearNomination(ctx.pool, EVENT_LOCATION, event.id, new Date().toISOString());
    ctx.state.cursors[EVENTS] = cursor;
  } catch (err) {
    recordFailure(ctx, EVENTS, { id: event.id, cursor }, err);
    return "stop";
  }
  if (ctx.args.delayMs > 0) await sleep(ctx.args.delayMs);
  return "continue";
}

/** Sweep nominated lane events into shared-kb. */
export async function sweepLaneEvents(ctx: SweepContext): Promise<void> {
  if (applyExhausted(ctx)) return;
  const events = await nominatedEventRows(
    ctx.pool,
    ctx.state.cursors.ob_session_events,
    ctx.args.batchSize,
  );
  for (const event of events) {
    if ((await stepEvent(ctx, event)) === "stop") return;
  }
}
