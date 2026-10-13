// The argument-parsing, state-file, and error-shaping bodies that the lane
// runners share (issue 841, Class H). `scripts/tier-lane-durable/args-state.ts`
// and `scripts/promote-lane-shared/args-state.ts` each held their own byte-wise
// copy of the flag table, the option-application step, the parse loop, the
// state writer, `sleep`, and `sanitizeError`; this module is the one body and
// both lanes are now configured adapters over it.
//
// What deliberately stays with each lane: its `usage` text, its env-var prefix
// and default arg record, its receipt shapes, and its `loadState` (the promoter
// additionally matches the persisted target namespace, the tiering runner does
// not). Those are behaviour differences, not duplication.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The arg fields every lane runner parses. Each lane widens this with its own. */
export interface CommonArgs {
  apply: boolean;
  stateFile: string;
  batchSize: number;
  maxApply: number;
  delayMs: number;
  loop: boolean;
  intervalMs: number;
  minContentLength: number;
}

/** Exits the process with the lane's usage text; never returns. */
export type UsageFn = (exitCode?: number) => never;

/**
 * How one lane's flags map onto its own `Args` record.
 *
 * `numericFlags` is per-lane because the tiering runner accepts one option the
 * promoter does not (`--dup-threshold`), and `validate` is per-lane because the
 * accepted ranges are a lane decision rather than a parsing one.
 */
export interface ParseSpec<A extends CommonArgs> {
  defaults: () => A;
  numericFlags: Record<string, keyof A | undefined>;
  validate: (args: A) => boolean;
  usage: UsageFn;
}

/** True when `value` is a whole number inside [low, high]. */
export function inIntRange(value: number, low: number, high: number): boolean {
  return Number.isInteger(value) && value >= low && value <= high;
}

/** Value-free flags, each keyed by the option name that sets it. */
function booleanFlags<A extends CommonArgs>(
  usage: UsageFn,
): Record<string, ((args: A) => void) | undefined> {
  return {
    "--apply": (args) => {
      args.apply = true;
    },
    "--loop": (args) => {
      args.loop = true;
    },
    "--once": (args) => {
      args.loop = false;
    },
    "--help": () => usage(0),
    "-h": () => usage(0),
  };
}

/**
 * Applies one option and returns the index of the last token it consumed.
 *
 * A value-taking option consumes the token after it, which is why the caller
 * takes the returned index back rather than always stepping by one.
 */
function applyFlag<A extends CommonArgs>(
  spec: ParseSpec<A>,
  args: A,
  argv: string[],
  index: number,
): number {
  const arg = argv[index] ?? "";
  const toggle = booleanFlags<A>(spec.usage)[arg];
  if (toggle) {
    toggle(args);
    return index;
  }
  if (arg === "--state-file") {
    args.stateFile = argv[index + 1] ?? "";
    return index + 1;
  }
  const numeric = spec.numericFlags[arg];
  if (numeric) {
    (args[numeric] as number) = Number(argv[index + 1] ?? 0);
    return index + 1;
  }
  console.error(`Unknown argument: ${arg}`);
  spec.usage();
}

/** Parses `argv` against one lane's spec, exiting via its usage on any refusal. */
export function parseArgsWith<A extends CommonArgs>(
  spec: ParseSpec<A>,
  argv: string[],
): A {
  const args = spec.defaults();
  for (let i = 0; i < argv.length; i += 1) {
    i = applyFlag(spec, args, argv, i);
  }
  if (!spec.validate(args)) spec.usage();
  return args;
}

/** Writes the lane's state file, creating its directory when missing. */
export function saveState(path: string, state: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** First line of an error, shortened to a fixed width so receipts stay small. */
export function sanitizeError(err: unknown): string {
  if (err instanceof Error) {
    return (err.message.split("\n")[0] ?? err.name).slice(0, 240);
  }
  return String(err).slice(0, 240);
}
