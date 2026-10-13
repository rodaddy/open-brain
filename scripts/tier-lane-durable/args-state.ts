// Argument parsing, validation, and the persistent cursor/receipt state for the
// lane → own-durable tiering runner (issue #160). Split out of the entrypoint at
// issue 864 L6; the parsing behaviour, defaults, accepted ranges, and state-file
// format are unchanged.
import { readFileSync } from "node:fs";
import {
  type ParseSpec,
  inIntRange,
  parseArgsWith,
} from "../lane-support/args-state.ts";
import type { Args, NamespaceReceipt, Receipt, State } from "./types.ts";

export { sanitizeError, saveState, sleep } from "../lane-support/args-state.ts";

export function usage(exitCode = 2): never {
  console.error(
    [
      "Usage: node scripts/tier-lane-durable.ts [--apply] [--once]",
      "       [--state-file <path>] [--batch-size 20] [--max-apply 5]",
      "       [--delay-ms 250] [--loop] [--interval-ms 60000]",
      "       [--min-content-length 24] [--dup-threshold 0.08]",
      "",
      "Dry-run is the default and does not advance the persistent cursor.",
      "Apply mode stops after --max-apply graduations and graduates lane",
      "events into the lane agent's OWN durable thoughts namespace.",
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
  "--dup-threshold": "dupThreshold",
};

function defaultArgs(): Args {
  return {
    apply: false,
    stateFile:
      process.env.OPENBRAIN_LANE_TIERING_STATE ??
      `${process.env.HOME ?? "."}/.local/state/open-brain/lane-tiering/state.json`,
    batchSize: Number(process.env.OPENBRAIN_LANE_TIERING_BATCH_SIZE ?? 20),
    maxApply: Number(process.env.OPENBRAIN_LANE_TIERING_MAX_APPLY ?? 5),
    delayMs: Number(process.env.OPENBRAIN_LANE_TIERING_DELAY_MS ?? 250),
    loop: false,
    intervalMs: Number(process.env.OPENBRAIN_LANE_TIERING_INTERVAL_MS ?? 60000),
    minContentLength: Number(
      process.env.OPENBRAIN_LANE_TIERING_MIN_CONTENT_LENGTH ?? 24,
    ),
    dupThreshold: Number(process.env.OPENBRAIN_LANE_TIERING_DUP_THRESHOLD ?? 0.08),
  };
}

/** Accepted ranges per numeric option, as [low, high] inclusive integers. */
const INT_RANGES: Array<[keyof Args, number, number]> = [
  ["batchSize", 1, 250],
  ["maxApply", 0, 100],
  ["delayMs", 0, Number.MAX_SAFE_INTEGER],
  ["intervalMs", 1000, Number.MAX_SAFE_INTEGER],
  ["minContentLength", 0, Number.MAX_SAFE_INTEGER],
];

function argsAreValid(args: Args): boolean {
  if (!args.stateFile) return false;
  for (const [field, low, high] of INT_RANGES) {
    if (!inIntRange(args[field] as number, low, high)) return false;
  }
  return (
    Number.isFinite(args.dupThreshold) &&
    args.dupThreshold >= 0 &&
    args.dupThreshold <= 1
  );
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

function defaultState(): State {
  return { version: 1, cursors: {} };
}

export function loadState(args: Args): State {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(args.stateFile, "utf8"));
  } catch {
    // First run or corrupt state: start conservatively from the beginning.
    return defaultState();
  }
  if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
    const state = parsed as State;
    if (state.version === 1) {
      state.cursors ??= {};
      return state;
    }
  }
  return defaultState();
}

function newNamespaceReceipt(): NamespaceReceipt {
  return {
    scanned: 0,
    graduated: 0,
    would_graduate: 0,
    kept: 0,
    archived: 0,
    manual_review: 0,
    duplicates: 0,
    failed: 0,
  };
}

export function newReceipt(dryRun: boolean): Receipt {
  return {
    started_at: new Date().toISOString(),
    finished_at: "",
    dry_run: dryRun,
    scanned: 0,
    graduated: 0,
    would_graduate: 0,
    kept: 0,
    archived: 0,
    manual_review: 0,
    duplicates: 0,
    failed: 0,
    namespaces: {},
    failures: [],
  };
}

export function addCount(
  receipt: Receipt,
  namespace: string,
  field: keyof NamespaceReceipt,
): void {
  const nsReceipt = (receipt.namespaces[namespace] ??= newNamespaceReceipt());
  nsReceipt[field] += 1;
  receipt[field] += 1;
}
