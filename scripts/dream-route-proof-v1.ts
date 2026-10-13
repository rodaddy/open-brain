/**
 * DREAM route proof V1: compare singleton and batched readings of the labelled
 * matrix cases through the local fake backend. The fake proves plumbing only;
 * paid-backend acceptance remains operator-gated.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { Pool } from "pg";
import { fileURLToPath } from "node:url";
import type {
  JevAnswer,
  JevClassifierRecord,
  JevConfig,
  JevFetch,
} from "../server/integrations/jev.ts";
import { buildRouteClassifierSetV2 } from "../server/domain/dream-route/questions-v2.ts";
import {
  DEFAULT_MATRIX_PATH,
  loadMatrix,
} from "../server/domain/dream-route/matrix.ts";
import { buildRouteClassifierSet } from "../server/domain/dream-route/questions.ts";
import type { RouteCandidate } from "../server/domain/dream-route/types.ts";
import { assertDreamRunSchema } from "./rem-ethereal-cohort.ts";
import { readMatrixCases } from "./dream-route-case-store.ts";
import {
  candidateOf,
  orderForBatches,
  recordOf,
  recordOfV2,
  splitPlan,
} from "../server/domain/dream-route/run-core.ts";
import {
  backendFor,
  parseRunArgs,
  planWithDrops,
  runLanes,
  type DreamRouteRunOptions,
} from "./dream-route-run.ts";
import type { CandidateSnapshot, FrozenRow } from "./dream-route-selection.ts";
import { proofPool, REFUSED_EXIT_CODE, reporter } from "./dream-route-proof-support.ts";
import { testScratchBase } from "./test-support/scratch-dir.ts";
import { PAID_MODEL, createPaidAttemptGuard } from "./dream-route-proof-budget.ts";
import {
  compareReadings,
  type CaseReading,
  type QuestionSet,
  type RoutedReading,
} from "./dream-route-proof-set.ts";
export {
  MAX_PAID_ATTEMPTS,
  createPaidAttemptGuard,
} from "./dream-route-proof-budget.ts";
export {
  compareReadings,
  normalizeNoCommit,
  type CaseReading,
} from "./dream-route-proof-set.ts";

const COPY_DATABASE = "open_brain_local_play_route_proof";

interface CohortRowShape {
  ordinal: number;
  candidate_id: string;
  namespace: string;
  content_hash: string;
  source: FrozenRow["source"];
  neighbour_of: string | null;
  snapshot: CandidateSnapshot;
}

export interface ExecuteRecordsInput {
  readonly records: readonly JevClassifierRecord[];
  readonly expectedKeys: readonly string[];
  readonly classifierSet: ReturnType<typeof buildRouteClassifierSet>;
  readonly config: JevConfig;
  readonly fetchFn: JevFetch;
  readonly inFlight: number;
}

export interface ProofOptions {
  readonly run: DreamRouteRunOptions;
  readonly ledgerPath?: string;
  readonly set: QuestionSet;
}

function refuse(message: string): never {
  process.stderr.write(`REFUSED ${message}\n`);
  process.exit(REFUSED_EXIT_CODE);
}

function validateFakeArgs(
  argv: readonly string[],
  run: DreamRouteRunOptions,
  ledgerPath: string | undefined,
  set: QuestionSet,
): ProofOptions {
  if (argv.length !== 4 || run.yes || ledgerPath !== undefined) {
    refuse("fake usage: --schema dream_run_NNN --backend fake [--set v1|v2]");
  }
  return { run, set };
}

function validatePaidArgs(
  argv: readonly string[],
  run: DreamRouteRunOptions,
  ledgerPath: string | undefined,
  set: QuestionSet,
): ProofOptions {
  const valid =
    argv.length === 7 &&
    run.schema === "dream_run_012" &&
    run.yes &&
    ledgerPath !== undefined &&
    isAbsolute(ledgerPath);
  if (!valid) {
    refuse(
      "paid usage: --schema dream_run_012 --backend jev --yes --ledger <absolute-path> [--set v1|v2]",
    );
  }
  return { run: { ...run, inFlight: 1 }, ledgerPath, set };
}

/** Reads `--set v1|v2` (default v1) and returns argv without that pair. */
function takeSet(argv: readonly string[]): { set: QuestionSet; rest: string[] } {
  const at = argv.indexOf("--set");
  if (at < 0) return { set: "v1", rest: [...argv] };
  const value = argv[at + 1];
  if (value !== "v1" && value !== "v2") refuse("--set takes v1 or v2");
  return {
    set: value,
    rest: argv.filter((_value, index) => index !== at && index !== at + 1),
  };
}

function parseArgs(fullArgv: readonly string[]): ProofOptions {
  const { set, rest } = takeSet(fullArgv);
  return parseCore(rest, set);
}

function parseCore(argv: readonly string[], set: QuestionSet): ProofOptions {
  if (argv.length === 0) refuse("V1 requires an explicit --schema and --backend mode");
  if (!argv.includes("--schema") || !argv.includes("--backend")) {
    refuse("V1 requires literal --schema and --backend options");
  }
  const supported = new Set(["--schema", "--backend", "--yes", "--ledger", "--set"]);
  const unknown = argv.find((value) => value.startsWith("--") && !supported.has(value));
  if (unknown !== undefined) refuse(`V1 does not support option ${unknown}`);
  const ledgerAt = argv.indexOf("--ledger");
  const ledgerPath = ledgerAt >= 0 ? argv[ledgerAt + 1] : undefined;
  const core =
    ledgerAt < 0
      ? [...argv]
      : argv.filter((_value, index) => index !== ledgerAt && index !== ledgerAt + 1);
  const run = parseRunArgs(core);
  return run.backend === "fake"
    ? validateFakeArgs(argv, run, ledgerPath, set)
    : validatePaidArgs(argv, run, ledgerPath, set);
}

async function assertCopyDatabase(pool: Pool): Promise<void> {
  const result = await pool.query<{ name: string }>(
    "SELECT current_database() AS name",
  );
  const actual = result.rows[0]?.name ?? "<unknown>";
  if (actual !== COPY_DATABASE) {
    throw new Error(
      `REFUSED current database was ${actual}; expected ${COPY_DATABASE}`,
    );
  }
}

async function readLabelledRows(
  pool: Pool,
  schema: string,
  ids: readonly string[],
): Promise<FrozenRow[]> {
  assertDreamRunSchema(schema);
  const result = await pool.query<CohortRowShape>(
    `SELECT ordinal, candidate_id, namespace, content_hash, source, neighbour_of,
            snapshot
       FROM ${schema}.cohort
      WHERE candidate_id = ANY ($1::uuid[])
      ORDER BY ordinal`,
    [ids],
  );
  return result.rows.map((row) => ({
    ordinal: row.ordinal,
    candidateId: row.candidate_id,
    namespace: row.namespace,
    contentHash: row.content_hash,
    source: row.source,
    neighbourOf: row.neighbour_of,
    snapshot: row.snapshot,
  }));
}

export async function executeRecords(
  input: ExecuteRecordsInput,
): Promise<Map<string, Record<string, JevAnswer>>> {
  const { plan, dropped } = planWithDrops(
    input.records,
    input.classifierSet,
    input.config,
    () => undefined,
  );
  if (dropped.length > 0) {
    throw new Error(`planner dropped ${dropped.length} labelled record(s)`);
  }
  const outcome = await runLanes(
    input.config,
    splitPlan(plan, input.inFlight),
    input.fetchFn,
  );
  if (outcome.failures.size > 0) {
    const reasons = [...new Set(outcome.failures.values())].join("; ");
    throw new Error(
      `${input.config.model} failed ${outcome.failures.size} labelled record(s): ${reasons}`,
    );
  }
  const actualKeys = [...outcome.answers.keys()].sort();
  const wantedKeys = [...input.expectedKeys].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(wantedKeys)) {
    throw new Error(
      `${input.config.model} returned ${actualKeys.length} keys; expected ${wantedKeys.length}`,
    );
  }
  return outcome.answers;
}

interface CollectReadingsInput {
  readonly rows: readonly FrozenRow[];
  readonly classifierSet: ReturnType<typeof buildRouteClassifierSet>;
  readonly options: DreamRouteRunOptions;
  readonly config: JevConfig;
  readonly fetchFn: JevFetch;
  readonly set: QuestionSet;
}

async function collectReadings(input: CollectReadingsInput): Promise<{
  singleton: Map<string, RoutedReading>;
  batchAnswers: Map<string, Record<string, JevAnswer>>;
}> {
  const ordered = orderForBatches(input.rows);
  const candidates = new Map(
    ordered.map((row) => [row.candidateId, candidateOf(row)] as const),
  );
  const render = input.set === "v2" ? recordOfV2 : recordOf;
  const singleton = new Map<string, RoutedReading>();
  for (const row of ordered) {
    const candidate = candidates.get(row.candidateId) as RouteCandidate;
    const answers = await executeRecords({
      records: [render(candidate)],
      expectedKeys: [row.candidateId],
      classifierSet: input.classifierSet,
      config: input.config,
      fetchFn: input.fetchFn,
      inFlight: 1,
    });
    singleton.set(row.candidateId, {
      answers: answers.get(row.candidateId) as Record<string, JevAnswer>,
      candidate,
    });
  }
  if (input.set === "v2") {
    process.stdout.write(
      "ADJUSTED: --set v2 runs the singleton arm only; batch_answers copy the singleton answers; why: V2 has no shared state (_plans/1469-jev-matrix.md section 4)\n",
    );
    const batchAnswers = new Map(
      [...singleton].map(([id, one]) => [id, { ...one.answers }] as const),
    );
    return { singleton, batchAnswers };
  }
  const batchAnswers = await executeRecords({
    records: ordered.map((row) =>
      render(candidates.get(row.candidateId) as RouteCandidate),
    ),
    expectedKeys: ordered.map((row) => row.candidateId),
    classifierSet: input.classifierSet,
    config: input.config,
    fetchFn: input.fetchFn,
    inFlight: input.options.inFlight,
  });
  return { singleton, batchAnswers };
}

/**
 * Writes every case both readings produced, so a failing run leaves the ANSWERS
 * behind rather than only a count, and names each mismatching case on stderr
 * while the run is still on screen. Paid runs land beside their ledger; the
 * fake run has no ledger, so it lands under the test scratch base.
 */
export function emitReadings(readings: CaseReading[], options: ProofOptions): void {
  const path = `${
    options.ledgerPath?.replace(/\.jsonl$/, "") ??
    `${testScratchBase()}/dream-route-proof-v1/${options.run.schema}${
      options.set === "v2" ? "-v2" : ""
    }-fake`
  }.readings.json`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(readings, null, 2)}\n`);
  for (const one of readings) {
    if (one.stable && one.dest_match && one.golden_match) continue;
    process.stderr.write(
      `MISMATCH ${one.candidate_id.slice(0, 8)} golden=${one.golden_dest} ` +
        `single=${one.singleton_dest} batch=${one.batch_dest} ` +
        `diff=${one.differing_keys.join(",") || "-"}\n`,
    );
  }
  process.stdout.write(`READINGS ${readings.length} cases -> ${path}\n`);
}

function proofBackend(options: ProofOptions): {
  config: JevConfig;
  fetchFn: JevFetch;
  paid: ReturnType<typeof createPaidAttemptGuard> | undefined;
} {
  const backend = backendFor(options.run, process.env);
  const isPaid = options.run.backend === "jev";
  if (isPaid && backend.config.model !== PAID_MODEL) {
    process.stdout.write(
      `ADJUSTED paid model: ${backend.config.model} -> ${PAID_MODEL}; why: pinned billing and acceptance\n`,
    );
  }
  const paid =
    options.ledgerPath === undefined
      ? undefined
      : createPaidAttemptGuard(options.ledgerPath, backend.fetchFn);
  return {
    config: isPaid ? { ...backend.config, model: PAID_MODEL } : backend.config,
    fetchFn: paid?.fetch ?? backend.fetchFn,
    paid,
  };
}

function closePaid(paid: ReturnType<typeof createPaidAttemptGuard> | undefined): void {
  if (paid === undefined) return;
  const totals = paid.totals();
  process.stdout.write(
    `PAID TOTALS attempts=${totals.attempts} ` +
      `reported_input_tokens=${totals.reportedInputTokens} ` +
      `actual_reported_usd=${totals.actualReportedUsd.toFixed(6)} ` +
      `reserved_maximum_usd=${totals.reservedMaximumUsd.toFixed(6)} ` +
      `stopped=${String(totals.stopped)}\n`,
  );
  paid.close();
}

async function runProof(
  pool: Pool,
  options: ProofOptions,
  report: ReturnType<typeof reporter>,
): Promise<void> {
  await assertCopyDatabase(pool);
  const matrix = loadMatrix(DEFAULT_MATRIX_PATH);
  const labels = await readMatrixCases(pool, options.run.schema, matrix.fingerprint);
  if (labels.length === 0) throw new Error("no labelled matrix cases exist");
  const ids = labels.map((label) => label.candidate_id);
  const rows = await readLabelledRows(pool, options.run.schema, ids);
  const uniqueIds = new Set(ids);
  const matched = uniqueIds.size === labels.length && rows.length === labels.length;
  report.check(
    "v1 labelled rows",
    matched,
    `${labels.length} labels, ${rows.length} matched cohort rows`,
  );
  if (!matched) return;
  const backend = proofBackend(options);
  let readings: Awaited<ReturnType<typeof collectReadings>>;
  try {
    readings = await collectReadings({
      rows,
      classifierSet:
        options.set === "v2"
          ? buildRouteClassifierSetV2(matrix)
          : buildRouteClassifierSet(matrix),
      options: options.run,
      config: backend.config,
      fetchFn: backend.fetchFn,
      set: options.set,
    });
  } finally {
    closePaid(backend.paid);
  }
  const singletonKeys = [...readings.singleton.keys()].sort();
  const batchKeys = [...readings.batchAnswers.keys()].sort();
  report.check(
    "v1 returned key sets",
    JSON.stringify(singletonKeys) === JSON.stringify(batchKeys) &&
      batchKeys.length === labels.length,
    `${singletonKeys.length} singleton keys, ${batchKeys.length} batch keys`,
  );

  const compare = compareReadings({
    rows,
    labels,
    matrix,
    singleton: readings.singleton,
    batchAnswers: readings.batchAnswers,
    set: options.set,
  });
  const compared = compare.counts;
  emitReadings(compare.readings, options);
  report.check(
    "v1 expected answers present",
    compared.missing === 0,
    `${compared.missing} incomplete cases across ${labels.length} cases`,
  );
  report.check(
    "v1 stable singleton-batch answers",
    compared.stable === 0,
    `${compared.stable} mismatches across ${labels.length} cases`,
  );
  report.check(
    "v1 normalized singleton-batch destinations",
    compared.destinations === 0,
    `${compared.destinations} mismatches across ${labels.length} cases`,
  );
  process.stdout.write(
    `DIAGNOSTIC contextual restates: ${compared.restates} singleton-batch differences\n`,
  );
  process.stdout.write(
    `DIAGNOSTIC ${options.run.backend} golden score: ${compared.golden}/${labels.length} normalized destinations false_commit=${compared.false_commit} lost_commit=${compared.lost_commit}\n`,
  );
  process.stdout.write(
    options.run.backend === "jev"
      ? "JEV V1 — paid acceptance evidence\n"
      : "FAKE ONLY — paid acceptance pending\n",
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.run.backend === "jev") {
    process.stdout.write(
      "ADJUSTED paid in-flight: 8 -> 1; why: sequential physical-attempt accounting\n",
    );
  }
  process.stdout.write(
    `CONFIG backend=${options.run.backend}, model=${
      options.run.backend === "jev" ? PAID_MODEL : "local-fake"
    }, in-flight=${options.run.inFlight}; R5 normalization steering/null -> none\n`,
  );
  const pool = proofPool();
  const report = reporter();
  try {
    await runProof(pool, options, report);
  } finally {
    await pool.end();
  }
  report.finish(
    options.run.backend === "jev"
      ? "V1 JEV — paid acceptance"
      : "V1 FAKE ONLY — paid acceptance pending",
  );
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  await main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`FAIL V1: ${message}\n`);
    process.exitCode = 1;
  });
}
