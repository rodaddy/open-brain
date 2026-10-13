#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  loadState,
  newReceipt,
  parseArgs,
  sanitizeError,
  saveState,
  sleep,
} from "./promote-lane-shared/args-state.ts";
import { sweepLaneEvents, sweepPromoteTables } from "./promote-lane-shared/sweeps.ts";
import { PROMOTE_TABLES } from "./promote-lane-shared/types.ts";
import type { Args, Receipt } from "./promote-lane-shared/types.ts";
import {
  canonicalNamespace,
  createPool,
  logger,
  sharedNamespaceConfig,
} from "./settings.ts";
import type { AuthInfo } from "./settings.ts";

/**
 * Background runner for lane/own-durable → shared-kb promotion (Issue #161).
 *
 * Mirrors scripts/promote-legacy-shared.ts and scripts/tier-lane-durable.ts
 * (cursor/state/receipt/args, dry-run default, resumable cursor, kill-switch).
 *
 * Runs as the PROMOTER identity and sweeps THREE sources only when the client
 * has explicitly nominated the candidate:
 * `metadata->>'share_candidate' = 'true'` AND
 * `metadata->>'memory_lifecycle_action' = 'nominate_shared'`:
 *   - thoughts   → classify → promoteEntry into shared-kb.
 *   - decisions  → classify → promoteEntry into shared-kb.
 *   - ob_session_events JOIN ob_session_lanes → classify → focused
 *     event→shared-kb insert into `thoughts` (promoteEntry does not cover
 *     events), idempotent via ON CONFLICT (content_hash, namespace).
 *
 * Every secret/private candidate is hard-refused before any write. After a
 * candidate is processed the nomination flag is cleared so it is not re-swept.
 *
 * The argument/state helpers, the SQL, and the two sweeps live in the sibling
 * modules under ./promote-lane-shared/; this file is the entrypoint that wires
 * them together and keeps the public surface (parseArgs, runSharedPromoter,
 * shareEventToSharedKb) where its callers already import it from.
 */

export { parseArgs } from "./promote-lane-shared/args-state.ts";
export { shareEventToSharedKb } from "./promote-lane-shared/rows.ts";
export type { Args, Receipt } from "./promote-lane-shared/types.ts";

export async function runSharedPromoter(args: Args): Promise<Receipt> {
  if (process.env.OPENBRAIN_PROMOTION_KILL_SWITCH === "1") {
    throw new Error("OPENBRAIN_PROMOTION_KILL_SWITCH is enabled");
  }

  const config = sharedNamespaceConfig();
  const targetCanonicalNamespace = canonicalNamespace(args.targetNamespace);
  const state = loadState(args);
  const receipt = newReceipt(targetCanonicalNamespace, !args.apply);

  // Synthetic promoter identity (mirrors promote-legacy-shared.ts), but using
  // the first-class promoter role added in #159 so canWriteNamespace permits
  // shared-kb writes.
  const auth: AuthInfo = {
    role: "promoter",
    clientId: "openbrain-promoter",
    tokenClientId: "openbrain-promoter",
    namespaceSource: "token",
  };
  const pool = createPool({
    max: 2,
    statement_timeout: 30000,
    application_name: "openbrain-shared-promoter",
  });
  const ctx = {
    pool,
    args,
    state,
    receipt,
    auth,
    promotedBy: auth.tokenClientId ?? auth.clientId,
    targetPhysicalNamespace: config.physicalSharedNamespace,
    targetCanonicalNamespace,
    applied: 0,
  };

  try {
    await sweepPromoteTables(ctx, PROMOTE_TABLES);
    await sweepLaneEvents(ctx);
  } finally {
    await pool.end();
  }

  receipt.finished_at = new Date().toISOString();
  state.target_namespace = targetCanonicalNamespace;
  state.last_receipt = receipt;
  saveState(args.stateFile, state);
  return receipt;
}

async function runOnce(args: Args): Promise<void> {
  const receiptPath = resolve(
    dirname(args.stateFile),
    `receipt-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  const receipt = await runSharedPromoter(args);
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  logger.info("shared_promoter_receipt", {
    receipt_path: receiptPath,
    dry_run: receipt.dry_run,
    scanned: receipt.scanned,
    shared: receipt.shared,
    would_share: receipt.would_share,
    rejected_secret: receipt.rejected_secret,
    rejected_private: receipt.rejected_private,
    rejected_noise: receipt.rejected_noise,
    manual_review: receipt.manual_review,
    duplicates: receipt.duplicates,
    failed: receipt.failed,
    clustered: receipt.clustered,
  });
  console.log(JSON.stringify({ ...receipt, receipt_path: receiptPath }));
}

if (import.meta.main) {
  const cliArgs = parseArgs(process.argv.slice(2));
  const run = async (): Promise<void> => {
    do {
      await runOnce(cliArgs);
      if (cliArgs.loop) await sleep(cliArgs.intervalMs);
    } while (cliArgs.loop);
  };
  run().catch((err) => {
    logger.error("shared_promoter_failed", { error: sanitizeError(err) });
    process.exit(1);
  });
}
