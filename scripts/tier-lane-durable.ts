#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createPool, logger } from "./settings.ts";
import {
  loadState,
  newReceipt,
  parseArgs,
  sanitizeError,
  saveState,
  sleep,
} from "./tier-lane-durable/args-state.ts";
import { processEvent } from "./tier-lane-durable/graduate.ts";
import { candidateEvents, listNamespaces } from "./tier-lane-durable/rows.ts";
import type { Args, Receipt } from "./tier-lane-durable/types.ts";

/**
 * Background runner for lane → own-durable memory tiering (Issue #160).
 *
 * Mirrors scripts/promote-lane-shared.ts (cursor/state/receipt/args, dry-run
 * default, resumable cursor, kill-switch). DIFFERENCE: instead of promoting
 * between table namespaces, it reads ob_session_events joined to their lane and
 * graduates substantive events into the lane agent's OWN durable `thoughts`
 * table within the SAME namespace.
 */

export { parseArgs };
export type { Args, Receipt };

interface SweepContext {
  pool: ReturnType<typeof createPool>;
  args: Args;
  state: ReturnType<typeof loadState>;
  receipt: Receipt;
}

/** Walks one namespace's batch; returns how many graduations it applied. */
async function sweepNamespace(
  ctx: SweepContext,
  namespace: string,
  alreadyApplied: number,
): Promise<{ applied: number; stop: boolean }> {
  const { pool, args, state, receipt } = ctx;
  const events = await candidateEvents(
    pool,
    namespace,
    state.cursors[namespace],
    args.batchSize,
  );
  let applied = 0;
  for (const event of events) {
    const nextCursor = {
      created_at: new Date(event.created_at).toISOString(),
      id: event.id,
    };
    const outcome = await processEvent(
      { pool, args, state, receipt, namespace, event, nextCursor },
      alreadyApplied + applied,
    );
    if (outcome === "stop-all") return { applied, stop: true };
    if (outcome === "graduated") applied += 1;
    if (args.delayMs > 0) await sleep(args.delayMs);
  }
  return { applied, stop: false };
}

export async function runLaneTiering(args: Args): Promise<Receipt> {
  if (process.env.OPENBRAIN_PROMOTION_KILL_SWITCH === "1") {
    throw new Error("OPENBRAIN_PROMOTION_KILL_SWITCH is enabled");
  }

  const state = loadState(args);
  const receipt = newReceipt(!args.apply);
  const pool = createPool({
    max: 2,
    statement_timeout: 30000,
    application_name: "openbrain-lane-tiering",
  });
  let applied = 0;

  try {
    const ctx = { pool, args, state, receipt };
    for (const namespace of await listNamespaces(pool)) {
      const result = await sweepNamespace(ctx, namespace, applied);
      applied += result.applied;
      if (result.stop) break;
    }
  } finally {
    await pool.end();
  }

  receipt.finished_at = new Date().toISOString();
  state.last_receipt = receipt;
  saveState(args.stateFile, state);
  return receipt;
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  const runOnce = async (): Promise<void> => {
    const receiptPath = resolve(
      dirname(args.stateFile),
      `receipt-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    );
    const receipt = await runLaneTiering(args);
    mkdirSync(dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    logger.info("lane_tiering_receipt", {
      receipt_path: receiptPath,
      dry_run: receipt.dry_run,
      scanned: receipt.scanned,
      graduated: receipt.graduated,
      would_graduate: receipt.would_graduate,
      kept: receipt.kept,
      archived: receipt.archived,
      manual_review: receipt.manual_review,
      duplicates: receipt.duplicates,
      failed: receipt.failed,
    });
    console.log(JSON.stringify({ ...receipt, receipt_path: receiptPath }));
  };
  const run = async (): Promise<void> => {
    do {
      await runOnce();
      if (args.loop) await sleep(args.intervalMs);
    } while (args.loop);
  };
  run().catch((err) => {
    logger.error("lane_tiering_failed", { error: sanitizeError(err) });
    process.exit(1);
  });
}
