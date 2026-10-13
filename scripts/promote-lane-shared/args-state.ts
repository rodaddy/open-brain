// Argument parsing, validation, and the persistent cursor/receipt state for the
// lane→shared-kb promoter (issue #161). Split out of the entrypoint at issue 864
// L6; the parsing behaviour, defaults, accepted ranges, and state-file format
// are unchanged.
import { readFileSync } from "node:fs";
import {
  type ParseSpec,
  inIntRange,
  parseArgsWith,
} from "../lane-support/args-state.ts";
import { canonicalNamespace, sharedNamespaceConfig } from "../settings.ts";
import type { ShareDecision } from "../settings.ts";
import type { Args, Receipt, Source, SourceReceipt, State } from "./types.ts";

export { sanitizeError, saveState, sleep } from "../lane-support/args-state.ts";

export function usage(exitCode = 2): never {
  console.error(
    [
      "Usage: bun run scripts/promote-lane-shared.ts [--apply] [--once]",
      "       [--state-file <path>] [--batch-size 20] [--max-apply 5]",
      "       [--delay-ms 250] [--loop] [--interval-ms 60000]",
      "       [--min-content-length 24]",
      "",
      "Dry-run is the default and does not advance the persistent cursor.",
      "Apply mode is bounded by --max-apply promotions, runs as the promoter",
      "identity, and only promotes entries explicitly nominated via metadata ",
      "share_candidate + memory_lifecycle_action=nominate_shared.",
    ].join("\n"),
  );
  process.exit(exitCode);
}

/** Numeric flags, each keyed by the option name that sets it. */
const NUMERIC_FLAGS: Record<string, keyof Args | undefined> = {
  "--batch-size": "batchSize",
  "--max-apply": "maxApply",
  "--delay-ms": "delayMs",
  "--interval-ms": "intervalMs",
  "--min-content-length": "minContentLength",
};

function defaultArgs(): Args {
  const config = sharedNamespaceConfig();
  return {
    apply: false,
    targetNamespace: config.canonicalSharedNamespace,
    stateFile:
      process.env.OPENBRAIN_SHARED_PROMOTER_STATE ??
      `${process.env.HOME ?? "."}/.local/state/open-brain/shared-promoter/state.json`,
    batchSize: Number(process.env.OPENBRAIN_SHARED_PROMOTER_BATCH_SIZE ?? 20),
    maxApply: Number(process.env.OPENBRAIN_SHARED_PROMOTER_MAX_APPLY ?? 5),
    delayMs: Number(process.env.OPENBRAIN_SHARED_PROMOTER_DELAY_MS ?? 250),
    loop: false,
    intervalMs: Number(process.env.OPENBRAIN_SHARED_PROMOTER_INTERVAL_MS ?? 60000),
    minContentLength: Number(
      process.env.OPENBRAIN_SHARED_PROMOTER_MIN_CONTENT_LENGTH ?? 24,
    ),
  };
}

/** True when every numeric field sits inside the range the runner accepts. */
function argsAreValid(args: Args): boolean {
  if (!args.targetNamespace || !args.stateFile) return false;
  if (!inIntRange(args.batchSize, 1, 250)) return false;
  if (!inIntRange(args.maxApply, 0, 100)) return false;
  if (!Number.isInteger(args.delayMs) || args.delayMs < 0) return false;
  if (!Number.isInteger(args.intervalMs) || args.intervalMs < 1000) return false;
  return Number.isInteger(args.minContentLength) && args.minContentLength >= 0;
}

/** This lane's configuration of the shared parser. */
const PARSE_SPEC: ParseSpec<Args> = {
  defaults: defaultArgs,
  numericFlags: NUMERIC_FLAGS,
  validate: argsAreValid,
  usage,
};

export function parseArgs(argv: string[]): Args {
  return parseArgsWith(PARSE_SPEC, argv);
}

function defaultState(args: Args): State {
  return {
    version: 1,
    target_namespace: canonicalNamespace(args.targetNamespace),
    cursors: {},
  };
}

export function loadState(args: Args): State {
  const expectedTarget = canonicalNamespace(args.targetNamespace);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(args.stateFile, "utf8"));
  } catch {
    return defaultState(args);
  }
  if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
    const state = parsed as State;
    if (state.version === 1 && state.target_namespace === expectedTarget) {
      state.cursors ??= {};
      return state;
    }
  }
  return defaultState(args);
}

export function newSourceReceipt(): SourceReceipt {
  return {
    scanned: 0,
    shared: 0,
    would_share: 0,
    rejected_secret: 0,
    rejected_private: 0,
    rejected_noise: 0,
    manual_review: 0,
    duplicates: 0,
    failed: 0,
    clustered: 0,
  };
}

export function newReceipt(targetCanonicalNamespace: string, dryRun: boolean): Receipt {
  return {
    started_at: new Date().toISOString(),
    finished_at: "",
    dry_run: dryRun,
    target_namespace: targetCanonicalNamespace,
    ...newSourceReceipt(),
    sources: {},
    failures: [],
  };
}

export function addCount(
  receipt: Receipt,
  source: Source,
  field: keyof SourceReceipt,
): void {
  const sourceReceipt = (receipt.sources[source] ??= newSourceReceipt());
  sourceReceipt[field] += 1;
  receipt[field] += 1;
}

/** Map a non-share classification to its receipt counter. */
export function rejectionField(decision: ShareDecision): keyof SourceReceipt {
  switch (decision) {
    case "reject-secret":
      return "rejected_secret";
    case "reject-private":
      return "rejected_private";
    case "reject-noise":
      return "rejected_noise";
    // "share" never reaches here (the caller only maps non-share outcomes) and
    // "manual-review" maps to the same counter as the former default arm, so
    // naming both leaves every return value exactly as it was.
    case "share":
    case "manual-review":
      return "manual_review";
  }
}
