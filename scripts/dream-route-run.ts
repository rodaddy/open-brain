#!/usr/bin/env node
/**
 * DREAM route run: reads a frozen cohort from a `dream_run_NNN` schema, routes
 * every row through Jev, and writes the results back into THAT SAME schema.
 *
 * It reads and writes nothing in `public`. The default backend is the free
 * local fake (`fakeJevFetch`), so the whole pipe can be proven without a paid
 * call; reaching the real endpoint takes `--backend jev --yes` and still
 * refuses when the projected cost is over `--cap-usd`.
 *
 * The pure parts -- candidate reading, record rendering, batching, cost,
 * splitting, the verdict, and the restatement groups -- live in
 * `dream-route-run-core.ts`. The SQL lives in `dream-route-run-store.ts`. This
 * file is the run itself: arguments, the Jev config, the failure policy, and
 * the summary.
 */

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { createPool } from "./settings.ts";
import * as liveGuard from "./dream-route-live-guard.ts";
import { assertDreamRunSchema } from "./rem-ethereal-cohort.ts";
import {
  DEFAULT_JEV_BASE_URL,
  DEFAULT_JEV_MAX_REQUEST_BYTES,
  DEFAULT_JEV_MAX_STATE_QUESTION_BYTES,
  DEFAULT_JEV_MODEL,
  type JevAnswer,
  type JevConfig,
  type JevFetch,
} from "../server/integrations/jev.ts";
import {
  DEFAULT_THRESHOLDS,
  decideRoute,
} from "../server/domain/dream-route/decide.ts";
import {
  DEFAULT_MATRIX_PATH,
  loadMatrix,
} from "../server/domain/dream-route/matrix.ts";
import { buildRouteClassifierSet } from "../server/domain/dream-route/questions.ts";
import type {
  RouteCandidate,
  RouteDecision,
  RouteMatrix,
} from "../server/domain/dream-route/types.ts";
import type { FrozenRow } from "./dream-route-selection.ts";
import {
  USD_PER_MILLION_INPUT_TOKENS,
  candidateOf,
  fakeJevFetch,
  formatRunReport,
  median,
  orderForBatches,
  projectCost,
  recordOf,
  resolveRestatementGroups,
  splitPlan,
  tally,
  wouldApply,
  type ResolvedWouldApply,
  type RoutedRow,
  type RunSummary,
} from "../server/domain/dream-route/run-core.ts";
import {
  existingRunId,
  readCohortRows,
  readManifest,
  writeRun,
  type RoutedResult,
} from "./dream-route-run-store.ts";

import {
  JEV_TIMEOUT_MS,
  SHARED_TASK,
  fakeConfig,
  noSignalDecision,
  planWithDrops,
  runLanes,
  type LaneOutcome,
} from "../server/domain/dream-route/run-execute.ts";

export { SHARED_TASK, planWithDrops, runLanes };

export type RouteBackend = "fake" | "jev";

export interface DreamRouteRunOptions {
  schema: string;
  backend: RouteBackend;
  yes: boolean;
  capUsd: number;
  inFlight: number;
  rerun: boolean;
  note: string;
  allowLiveDb: boolean; // --allow-live-db (issue 1501)
}

const KNOWN_OPTIONS = new Set([
  "--schema",
  "--backend",
  "--yes",
  "--cap-usd",
  "--in-flight",
  "--rerun",
  "--note",
  "--allow-live-db",
]);

/**
 * Reads a `--name value` pair, refusing a repeat or a missing value.
 *
 * Same reader shape as `dream-route-selection.ts`'s, kept local because this
 * script's option set is disjoint from the freezer's.
 *
 * @param argv - The raw argument vector, without the node/script prefix.
 * @param name - The option name, without leading dashes.
 * @returns The value, or undefined when the option is absent.
 * @throws {Error} When the option repeats or carries no value.
 */
function valueArg(argv: readonly string[], name: string): string | undefined {
  const indexes = argv.flatMap((value, index) =>
    value === `--${name}` ? [index] : [],
  );
  if (indexes.length > 1) throw new Error(`--${name} may be supplied only once`);
  const index = indexes[0];
  if (index === undefined) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

function parseBackend(raw: string | undefined): RouteBackend {
  if (raw === undefined) return "fake";
  if (raw !== "fake" && raw !== "jev") {
    throw new Error(`--backend must be fake or jev: ${raw}`);
  }
  return raw;
}

function parseCapUsd(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("--cap-usd must be a non-negative number");
  }
  return parsed;
}

function parseInFlight(raw: string | undefined): number {
  if (raw === undefined) return 8;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("--in-flight must be an integer of at least 1");
  }
  return parsed;
}

/**
 * Parses the CLI argument vector, rejecting any unknown `--` token.
 *
 * `--yes` is demanded for the paid backend here, at parse time, so a run that
 * would have sent a real request is refused before a pool is even opened.
 *
 * @param argv - The raw argument vector, without the node/script prefix.
 * @returns The fully defaulted options.
 * @throws {Error} On an unknown option, an invalid value, or `jev` without `--yes`.
 */
export function parseRunArgs(argv: readonly string[]): DreamRouteRunOptions {
  for (const token of argv) {
    if (token.startsWith("--") && !KNOWN_OPTIONS.has(token)) {
      throw new Error(`unknown option: ${token}`);
    }
  }
  const schema = valueArg(argv, "schema");
  if (schema === undefined) throw new Error("--schema is required");
  assertDreamRunSchema(schema);
  const backend = parseBackend(valueArg(argv, "backend"));
  const yes = argv.includes("--yes");
  if (backend === "jev" && !yes) {
    throw new Error("--backend jev needs --yes: nothing is sent without it");
  }
  return {
    schema,
    backend,
    yes,
    capUsd: parseCapUsd(valueArg(argv, "cap-usd")),
    inFlight: parseInFlight(valueArg(argv, "in-flight")),
    rerun: argv.includes("--rerun"),
    note: valueArg(argv, "note") ?? "",
    allowLiveDb: argv.includes("--allow-live-db"),
  };
}

/** The `--backend jev` config, or a refusal naming the missing variable. */
function jevConfig(env: NodeJS.ProcessEnv): JevConfig {
  const apiKey = env.OPENBRAIN_JEV_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENBRAIN_JEV_API_KEY is unset; --backend jev cannot run without it",
    );
  }
  return {
    enabled: true,
    apiKey,
    baseUrl: env.OPENBRAIN_JEV_BASE_URL ?? DEFAULT_JEV_BASE_URL,
    model: env.OPENBRAIN_JEV_MODEL ?? DEFAULT_JEV_MODEL,
    timeoutMs: JEV_TIMEOUT_MS,
    maxRequestBytes: DEFAULT_JEV_MAX_REQUEST_BYTES,
    maxStateQuestionBytes: DEFAULT_JEV_MAX_STATE_QUESTION_BYTES,
  };
}

/**
 * Resolves the backend to a config and a fetch.
 *
 * The `jevRem` and `jevSearch` enable flags are deliberately NOT read: this is
 * a third caller of Jev with its own consent gate (`--yes`), and inheriting
 * either flag would let an unrelated feature toggle decide whether a route run
 * can spend money.
 *
 * @param options - The parsed options.
 * @param env - The environment to read, for the `jev` backend only.
 * @returns The config and the fetch to execute with.
 */
export function backendFor(
  options: DreamRouteRunOptions,
  env: NodeJS.ProcessEnv,
): { config: JevConfig; fetchFn: JevFetch } {
  if (options.backend === "fake") {
    return { config: fakeConfig(), fetchFn: fakeJevFetch() };
  }
  return { config: jevConfig(env), fetchFn: fetch };
}

interface DecidedRow {
  readonly row: FrozenRow;
  readonly candidate: RouteCandidate;
  readonly decision: RouteDecision;
  readonly servedModel: string | null;
}

function decideAll(args: {
  rows: readonly FrozenRow[];
  candidates: ReadonlyMap<string, RouteCandidate>;
  matrix: RouteMatrix;
  outcome: LaneOutcome;
  dropped: ReadonlyMap<string, string>;
}): DecidedRow[] {
  return args.rows.map((row) => {
    const candidate = args.candidates.get(row.candidateId) as RouteCandidate;
    const failure =
      args.dropped.get(row.candidateId) ?? args.outcome.failures.get(row.candidateId);
    const decided = decideRoute(
      candidate,
      args.outcome.answers.get(row.candidateId) ?? {},
      args.matrix,
      DEFAULT_THRESHOLDS,
    );
    const decision =
      failure === undefined
        ? decided
        : noSignalDecision(candidate, failure, decided.authorityTier);
    return {
      row,
      candidate,
      decision,
      servedModel: args.outcome.servedModels.get(row.candidateId) ?? null,
    };
  });
}

/** Re-reads a verdict with the restates flag forced off. */
function withoutRestates(entry: RoutedRow, matrix: RouteMatrix) {
  return wouldApply({ ...entry.decision, restates: false }, entry.row, matrix);
}

export interface RunDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly log: (line: string) => void;
  readonly now: () => number;
}

/** What the preflight reads and checks before any request is planned. */
interface Preflight {
  readonly rows: readonly FrozenRow[];
  readonly matrix: RouteMatrix;
  readonly classifierSet: ReturnType<typeof buildRouteClassifierSet>;
}

/**
 * Reads the cohort and refuses every reason this run must not proceed.
 *
 * Everything here happens before a plan exists, so a refusal costs nothing and
 * sends nothing.
 *
 * @param pool - A pool for the run's database.
 * @param options - The parsed options.
 * @param deps - Environment, logger, and clock.
 * @returns The cohort rows, the matrix, and the question set.
 * @throws {Error} On an empty cohort or a prior run without `--rerun`.
 */
async function preflight(
  pool: Pool,
  options: DreamRouteRunOptions,
  deps: RunDeps,
): Promise<Preflight> {
  // The manifest is read first: a schema with no manifest is not a frozen
  // cohort, and routing whatever tables it does hold would be a guess.
  const manifest = await readManifest(pool, options.schema);
  deps.log(
    `cohort        : ${manifest.runId}, namespace ${manifest.namespace}, ` +
      `${manifest.cohortCount} rows, digest ${manifest.cohortDigest.slice(0, 12)}`,
  );
  const rows = await readCohortRows(pool, options.schema);
  if (rows.length === 0) {
    throw new Error(`${options.schema}.cohort is empty: there is nothing to route`);
  }
  const matrix = loadMatrix(DEFAULT_MATRIX_PATH);
  const prior = await existingRunId(
    pool,
    options.schema,
    matrix.fingerprint,
    options.backend,
  );
  if (prior !== null && !options.rerun) {
    throw new Error(
      `${options.schema} already holds run ${prior} for matrix ${matrix.fingerprint} ` +
        `on backend ${options.backend}; pass --rerun to add another`,
    );
  }
  return { rows, matrix, classifierSet: buildRouteClassifierSet(matrix) };
}

/**
 * Turns the decided rows into the rows that get stored.
 *
 * The restatement groups resolve here, between deciding and writing, because
 * a survivor can only be chosen once every member's verdict is known.
 *
 * @param decided - One entry per cohort row.
 * @param matrix - The matrix the decisions were made against.
 * @returns One storable result per cohort row.
 */
function assembleResults(
  decided: readonly DecidedRow[],
  matrix: RouteMatrix,
): RoutedResult[] {
  const routed: RoutedRow[] = decided.map((entry) => ({
    row: entry.row,
    decision: entry.decision,
    wouldApply: wouldApply(entry.decision, entry.row, matrix),
  }));
  const resolved = resolveRestatementGroups(routed, (entry) =>
    withoutRestates(entry, matrix),
  );
  return decided.map((entry) => ({
    candidateId: entry.row.candidateId,
    namespace: entry.row.namespace,
    decision: entry.decision,
    resolved: resolved.get(entry.row.candidateId) as ResolvedWouldApply,
    servedModel: entry.servedModel,
  }));
}

/**
 * Runs the route over one frozen cohort and writes the results into its schema.
 *
 * @param pool - A pool for the run's database. Never the dogfood one.
 * @param options - The parsed options.
 * @param deps - Environment, logger, and clock.
 * @param fetchOverride - A fetch to use instead of the backend's own. For
 *   tests that need a failing endpoint; production passes nothing.
 * @returns The finished run's summary.
 * @throws {Error} On an empty cohort, a projected spend the operator refused,
 *   or a prior run without `--rerun`.
 */
export async function runDreamRoute(
  pool: Pool,
  options: DreamRouteRunOptions,
  deps: RunDeps,
  fetchOverride?: JevFetch,
): Promise<RunSummary> {
  const started = deps.now();
  const { rows, matrix, classifierSet } = await preflight(pool, options, deps);

  const ordered = orderForBatches(rows);
  const candidates = new Map(ordered.map((row) => [row.candidateId, candidateOf(row)]));
  const records = ordered.map((row) =>
    recordOf(candidates.get(row.candidateId) as RouteCandidate),
  );

  const { config, fetchFn: defaultFetch } = backendFor(options, deps.env);
  const fetchFn = fetchOverride ?? defaultFetch;
  const { plan, dropped } = planWithDrops(records, classifierSet, config, deps.log);
  const cost = projectCost(plan);
  deps.log(
    `plan          : ${cost.requests} requests, ${cost.bytes} bytes, ` +
      `~${cost.estimatedTokens} tokens, ~$${cost.estimatedUsd.toFixed(6)}`,
  );
  if (cost.estimatedUsd > options.capUsd) {
    throw new Error(
      `projected $${cost.estimatedUsd.toFixed(6)} is over the --cap-usd of ` +
        `$${options.capUsd.toFixed(6)}; nothing was sent`,
    );
  }

  const outcome =
    plan.batches.length === 0
      ? {
          answers: new Map<string, Record<string, JevAnswer>>(),
          servedModels: new Map<string, string>(),
          inputTokens: 0,
          failures: new Map<string, string>(),
        }
      : await runLanes(config, splitPlan(plan, options.inFlight), fetchFn);

  const droppedByKey = new Map(dropped.map((entry) => [entry.key, entry.reason]));
  const decided = decideAll({
    rows: ordered,
    candidates,
    matrix,
    outcome,
    dropped: droppedByKey,
  });
  const results = assembleResults(decided, matrix);

  const runId = randomUUID();
  const ms = deps.now() - started;
  const actualUsd = (outcome.inputTokens * USD_PER_MILLION_INPUT_TOKENS) / 1_000_000;
  await writeRun(pool, {
    schema: options.schema,
    runId,
    run: {
      matrixFingerprint: matrix.fingerprint,
      classifierVersion: classifierSet.version,
      thresholds: DEFAULT_THRESHOLDS,
      backend: options.backend,
      servedModels: [...new Set(outcome.servedModels.values())].sort(),
      records: results.length,
      requests: plan.batches.length,
      inputTokens: outcome.inputTokens,
      estimatedUsd: cost.estimatedUsd,
      actualUsd,
      ms,
      note: options.note,
    },
    results,
  });

  const perRequest = plan.batches.map((batch) => batch.records.length);
  return {
    runId,
    byDestinationAgreement: tally(
      results,
      (result) =>
        `${result.decision.destination ?? "none"}/${result.decision.agreement}`,
    ),
    byAction: tally(results, (result) => result.resolved.action),
    noSignal: results.filter((result) =>
      result.decision.reasons.some((reason) => reason.startsWith("no signal:")),
    ).length,
    recordsPerRequest: {
      min: perRequest.length === 0 ? 0 : Math.min(...perRequest),
      median: median(perRequest),
      max: perRequest.length === 0 ? 0 : Math.max(...perRequest),
    },
    inputTokens: outcome.inputTokens,
    estimatedUsd: cost.estimatedUsd,
    actualUsd,
    ms,
  };
}

export interface MainDeps {
  createPool: () => Pool;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  deps: MainDeps = { createPool },
): Promise<void> {
  // Every argument is validated before a pool is constructed.
  const options = parseRunArgs(argv);
  const databaseName = liveGuard.resolvedDatabaseName(process.env);
  liveGuard.assertNotLiveDatabase({ databaseName, allowLive: options.allowLiveDb });
  const pool = deps.createPool();
  try {
    const summary = await runDreamRoute(pool, options, {
      env: process.env,
      log: (line) => console.log(line),
      now: () => Date.now(),
    });
    for (const line of formatRunReport(summary)) console.log(line);
  } finally {
    await pool.end();
  }
}

if (import.meta.main) await main();
