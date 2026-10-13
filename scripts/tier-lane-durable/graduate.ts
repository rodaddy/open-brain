// Per-event classification and graduation for the lane → own-durable tiering
// runner (issue #160). Split out of the entrypoint at issue 864 L6; the
// classification order, dedup behaviour, and cursor advancement are unchanged.
import {
  classifyLaneEvent,
  normalizedContentHash,
  createPool,
  findDurableDuplicate,
  generateEmbedding,
  graduateLaneEvent,
  type LaneEventRow,
} from "../settings.ts";
import { writeThoughtChunks } from "../../server/capture/chunk-write.ts";
import { createTieringRepository } from "../../server/db/tiering-repository.ts";
import { addCount, sanitizeError } from "./args-state.ts";
import type { Args, Cursor, NamespaceReceipt, Receipt, State } from "./types.ts";

type Pool = ReturnType<typeof createPool>;

/** What the caller should do next with the surrounding namespace loop. */
export type EventOutcome = "continue" | "stop-all" | "graduated";

interface EventContext {
  pool: Pool;
  args: Args;
  state: State;
  receipt: Receipt;
  namespace: string;
  event: LaneEventRow;
  nextCursor: Cursor;
}

/** Non-graduating classifications, each mapped to the receipt field it counts. */
const TERMINAL_FIELDS: Record<string, keyof NamespaceReceipt | undefined> = {
  keep: "kept",
  archive: "archived",
  "manual-review": "manual_review",
};

function record(ctx: EventContext, field: keyof NamespaceReceipt): EventOutcome {
  addCount(ctx.receipt, ctx.namespace, field);
  if (ctx.args.apply) ctx.state.cursors[ctx.namespace] = ctx.nextCursor;
  return "continue";
}

async function embedOrNull(content: string): Promise<number[] | null> {
  try {
    return await generateEmbedding(content);
  } catch {
    return null;
  }
}

/**
 * Runs the graduate path for one already-classified event.
 *
 * Split from the classification switch so neither half carries the other's
 * branching; the caller still owns the try/catch that records failures.
 */
async function graduateOne(ctx: EventContext): Promise<EventOutcome> {
  const { args, event, namespace, pool, receipt } = ctx;
  const repository = createTieringRepository(pool);
  const embedding = await embedOrNull(event.content);

  // Recompute the hash when the event row has none, matching the tool path —
  // otherwise a null-hash event skips exact dedup and gets mis-reported as
  // graduated/would_graduate.
  const dedupHash = event.content_hash ?? normalizedContentHash(event.content);
  const duplicate = await findDurableDuplicate(repository, namespace, {
    hash: dedupHash,
    embedding,
    threshold: args.dupThreshold,
  });
  if (duplicate) return record(ctx, "duplicates");

  if (!args.apply) {
    addCount(receipt, namespace, "would_graduate");
    return "continue";
  }

  await graduateLaneEvent(repository, event, namespace, {
    createdBy: "openbrain-lane-tiering",
    embedding,
    reason: `lane tiering: ${event.event_type}/${event.importance}`,
    embedFn: generateEmbedding,
    writeChunks: writeThoughtChunks,
  });
  addCount(receipt, namespace, "graduated");
  ctx.state.cursors[namespace] = ctx.nextCursor;
  return "graduated";
}

/**
 * Classifies one event and applies the resulting action.
 *
 * Returns "stop-all" when the whole run should end: either the apply allowance
 * is spent, or graduation threw and the cursor must not advance past it.
 */
export async function processEvent(
  ctx: EventContext,
  applied: number,
): Promise<EventOutcome> {
  const { args, event, namespace, receipt } = ctx;
  addCount(receipt, namespace, "scanned");

  const classification = classifyLaneEvent(event, args.minContentLength);
  const terminal = TERMINAL_FIELDS[classification];
  if (terminal) return record(ctx, terminal);

  // classification === "graduate"
  if (args.apply && applied >= args.maxApply) return "stop-all";

  try {
    return await graduateOne(ctx);
  } catch (err) {
    addCount(receipt, namespace, "failed");
    receipt.failures.push({
      namespace,
      id: event.id,
      error: sanitizeError(err),
    });
    return "stop-all";
  }
}

export type { EventContext };
