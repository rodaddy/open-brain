/**
 * Spool-facing half of the first-class runtime: parking a failed write,
 * draining the JSONL spool, and turning a replay report into content-free
 * receipts. Split out of `runtime.ts` so each module stays reviewable.
 *
 * These are free functions over an explicit context rather than methods, so
 * the state they touch is visible in the signature instead of implied by
 * `this`.
 */

import type { Json } from "./client.ts";
import { ValidationError } from "./policy.ts";
import {
  JsonlSpool,
  SpoolUnitRetained,
  errorClassName,
  type SpoolReplayReport,
  type SpoolRecord,
  type SpoolUnitOutcome,
} from "./spool.ts";
import {
  DrainReport,
  PARKED_NAMESPACE_KEY,
  REPLAYABLE_SET,
  ReceiptStatus,
  RuntimeCallError,
  RuntimeReceipt,
  RuntimeScope,
  safeError,
  safeText,
  spooledStartScope,
  type MemorySpoolLike,
  type ReplayableOperation,
  type RuntimeOutput,
} from "./runtime-support.ts";

/** The runtime state the spool half reads and writes. */
export interface SpoolContext {
  spool: MemorySpoolLike | null;
  jsonlSpool: JsonlSpool | null;
  namespace: string;
  conversationKey: string | null;
  startPayload(): Json;
  parked(payload: Json): Json;
  receipt(
    operation: string,
    status: string,
    durable: boolean,
    extra?: { spoolKey?: string | null; error?: string | null },
  ): RuntimeReceipt;
  setReplayScope(scope: RuntimeScope | null): void;
  directCall(operation: ReplayableOperation, payload: Json): Promise<Json>;
}

/** Queue a failed write for replay, or report it lost when there is no spool. */
export function spoolAfterFailedWrite(
  ctx: SpoolContext,
  write: {
    operation: string;
    tool: ReplayableOperation;
    built: { payload: Json; key: string };
  },
  error: unknown,
): RuntimeOutput {
  const { operation, tool, built } = write;
  if (ctx.spool === null) {
    return {
      receipt: ctx.receipt(operation, ReceiptStatus.LOST, false, {
        error: safeError(error),
      }),
    };
  }
  try {
    const spoolKey = queueWrite(ctx, tool, built);
    return {
      receipt: ctx.receipt(operation, ReceiptStatus.SPOOLED, true, {
        spoolKey,
        error: safeError(error),
      }),
    };
  } catch (spoolError) {
    return {
      receipt: ctx.receipt(operation, ReceiptStatus.LOST, false, {
        error: safeText(`${safeError(error)}; spool failed: ${safeError(spoolError)}`),
      }),
    };
  }
}

/**
 * Append the write, pairing it atomically with its lane prerequisite when the
 * lane itself never opened, so replay order is preserved.
 */
function queueWrite(
  ctx: SpoolContext,
  tool: ReplayableOperation,
  built: { payload: Json; key: string },
): string {
  const spool = ctx.spool as MemorySpoolLike;
  if (ctx.conversationKey !== null) {
    return spool.append(tool, ctx.parked(built.payload), built.key);
  }
  const appendBatch = spool.appendBatch?.bind(spool);
  if (appendBatch === undefined) {
    throw new Error("configured spool cannot atomically queue lane prerequisite");
  }
  const keys = appendBatch([
    { operation: "session_start", payload: ctx.parked(ctx.startPayload()), key: null },
    { operation: tool, payload: ctx.parked(built.payload), key: built.key },
  ]);
  return keys.at(-1) as string;
}

/**
 * Reject a record parked under another namespace, and strip the marker.
 *
 * Draining a foreign record here would silently transplant content into this
 * runtime's namespace (#314). Records without the marker are a legacy
 * carve-out and drain under the replaying runtime's namespace.
 */
function unparkPayload(ctx: SpoolContext, record: SpoolRecord): Json {
  const payload = { ...record.payload };
  const parkedNamespace = payload[PARKED_NAMESPACE_KEY];
  delete payload[PARKED_NAMESPACE_KEY];
  if (
    parkedNamespace !== undefined &&
    parkedNamespace !== null &&
    parkedNamespace !== ctx.namespace
  ) {
    throw new SpoolUnitRetained("spooled unit parked under a different namespace");
  }
  return payload;
}

/** Replay one spooled record under the scope it was parked with. */
async function dispatchRecord(ctx: SpoolContext, record: SpoolRecord): Promise<Json> {
  // Reset per record so no later record or unit can inherit a stale scope.
  ctx.setReplayScope(null);
  if (!REPLAYABLE_SET.has(record.operation)) {
    throw new ValidationError(`Unsupported spooled operation: ${record.operation}`);
  }
  const payload = unparkPayload(ctx, record);
  if (record.operation === "session_start") {
    // Validate the replayed lane against the scope the unit was parked under,
    // not the runtime's current scope (#310). The namespace stays bound to
    // this runtime's auth config.
    try {
      ctx.setReplayScope(spooledStartScope(payload));
    } catch (error) {
      throw new SpoolUnitRetained(safeError(error));
    }
  }
  return ctx.directCall(record.operation as ReplayableOperation, payload);
}

/** Drain pending spooled units. Best-effort: never breaks the triggering call. */
export async function drainSpool(ctx: SpoolContext): Promise<DrainReport | null> {
  try {
    const spool = ctx.jsonlSpool;
    if (spool === null || spool.status().pending_count <= 0) {
      return null;
    }
    let report: SpoolReplayReport;
    try {
      report = await spool.replayWithReport((record) => dispatchRecord(ctx, record));
    } finally {
      ctx.setReplayScope(null);
    }
    return buildDrainReport(report);
  } catch {
    return null;
  }
}

/** A direct client that refuses every call, used when setup failed. */
export class UnavailableClient {
  timeout = 0;
  private fail(): never {
    throw new RuntimeCallError("direct client unavailable");
  }
  get_contract(): Json {
    this.fail();
  }
  session_start(): Json {
    this.fail();
  }
  append_session_event(): Json {
    this.fail();
  }
  lane_upsert(): Json {
    this.fail();
  }
  upsert_repo_fact(): Json {
    this.fail();
  }
  log_thought(): Json {
    this.fail();
  }
  log_decision(): Json {
    this.fail();
  }
  session_wrap(): Json {
    this.fail();
  }
  agent_context_pack(): Json {
    this.fail();
  }
  close(): void {}
}

export function failedWrite(operation: string, error: unknown): RuntimeOutput {
  return {
    receipt: new RuntimeReceipt({
      operation,
      status: ReceiptStatus.FAILED,
      durable: false,
      directAttempted: false,
      fallbackAttempted: false,
      error: safeError(error),
    }),
  };
}

export function buildDrainReport(report: SpoolReplayReport): DrainReport {
  const counts: Record<string, number> = {
    replayed: 0,
    failed: 0,
    quarantined: 0,
    retained: 0,
  };
  let replayedRecords = 0;
  const receipts: RuntimeReceipt[] = [];
  for (const outcome of report.outcomes) {
    counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
    if (outcome.status === "replayed") {
      replayedRecords += outcome.record_keys.length;
      receipts.push(...replayedReceipts(outcome));
    } else if (outcome.status === "quarantined") {
      receipts.push(quarantinedReceipt(outcome));
    }
  }
  return new DrainReport({
    attemptedUnits: report.outcomes.length,
    replayedUnits: counts["replayed"] ?? 0,
    replayedRecords,
    failedUnits: counts["failed"] ?? 0,
    quarantinedUnits: counts["quarantined"] ?? 0,
    retainedUnits: counts["retained"] ?? 0,
    receipts,
  });
}

export function replayedReceipts(outcome: SpoolUnitOutcome): RuntimeReceipt[] {
  return outcome.operations.map(
    (operation, index) =>
      new RuntimeReceipt({
        operation,
        status: ReceiptStatus.REPLAYED,
        durable: true,
        directAttempted: true,
        fallbackAttempted: false,
        spoolKey: outcome.record_keys[index] as string,
      }),
  );
}

export function quarantinedReceipt(outcome: SpoolUnitOutcome): RuntimeReceipt {
  return new RuntimeReceipt({
    operation: outcome.operations[0] as string,
    status: ReceiptStatus.QUARANTINED,
    durable: true,
    directAttempted: true,
    fallbackAttempted: false,
    spoolKey: outcome.record_keys[0] as string,
    // Error CLASS/category only, never message bodies.
    error: outcome.error_category ?? errorClassName(null),
  });
}
