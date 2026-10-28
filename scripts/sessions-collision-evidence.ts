/**
 * Evidence for the sessions content_hash collisions (issue 1612).
 *
 * WHY: `scripts/repair-embeddings.ts --global` reported collisions=1467 on
 * `sessions`, and 11,148 rows had `embedding IS NULL` (measured 2026-09-27).
 * The repair writes a row's FRESH content_hash; when another row in the same
 * namespace already stores that hash, `idx_sessions_content_hash`
 * (content_hash, namespace) rejects it with 23505 and issue 1462 skips the row.
 * The repair log does not name the row holding the hash. Dana must rule
 * between archiving the duplicates and rehashing; this script produces the
 * evidence for that ruling.
 *
 * WHAT IT DOES:
 *   1. Samples `sessions` rows with `embedding IS NULL` (ORDER BY random()),
 *      computes each row's fresh hash with the repair's own function
 *      (`getEmbeddingTarget("sessions").sourceHash`, never re-implemented),
 *      and finds the other row in the same namespace whose stored
 *      content_hash equals it (the holder). Read-only.
 *   2. Default is a dry run: counts only, no Jev call.
 *   3. `--yes` asks Jev, through the shared client's batch plan, one noul per
 *      pair: "Do these two session records describe the same session?" with
 *      both rows' full text. A refused pair records `jev_error` and the run
 *      carries on.
 *   4. Writes a TSV to `--out` (ids and numbers only) and prints a summary.
 *      Row content never reaches stdout.
 *
 * Usage:
 *   node scripts/sessions-collision-evidence.ts --sample 100
 *   node scripts/sessions-collision-evidence.ts --sample 100 --yes --out pairs.tsv
 *
 * Exit codes: 0 = completed; 1 = a fatal error.
 */
import { writeFileSync } from "node:fs";
import type pg from "pg";
import { createPool } from "./settings.ts";
import { getEmbeddingTarget } from "../server/embedding/embedding-targets.ts";
import {
  buildJevBatchPlan,
  executeJevBatchPlan,
  DEFAULT_JEV_BASE_URL,
  DEFAULT_JEV_MODEL,
  DEFAULT_JEV_MAX_REQUEST_BYTES,
  DEFAULT_JEV_MAX_STATE_QUESTION_BYTES,
  type ClassifierSet,
  type JevBatchPlan,
  type JevConfig,
  type JevFetch,
} from "../server/integrations/jev.ts";

export const DEFAULT_SAMPLE = 100;
const JEV_TIMEOUT_MS = 60_000;
const QUESTION_NAME = "same_session";

export const SAME_SESSION_SET: ClassifierSet = {
  name: "sessions-collision-evidence",
  version: "1612.1",
  classifiers: {
    [QUESTION_NAME]: {
      type: "noul",
      instructions:
        "Do these two session records describe the same session? The record's fields dup_text and holder_text hold the two sessions in full.",
    },
  },
};

interface SessionRow {
  id: string;
  namespace: string;
  summary: string | null;
  project: string | null;
  key_decisions: string[] | null;
  next_steps: string[] | null;
  blockers: string[] | null;
}

export interface CollisionPair {
  dupId: string;
  holderId: string;
  dupText: string;
  holderText: string;
}

export interface PairResult {
  dupId: string;
  holderId: string;
  dupLen: number;
  holderLen: number;
  identicalText: boolean;
  jevNoul: number | null;
  jevError: string;
}

export interface EvidenceOptions {
  sample: number;
  yes: boolean;
  /** Restrict the sample to these namespaces (tests; optional on the CLI). */
  namespaces?: string[];
  config: JevConfig;
  fetchFn?: JevFetch;
  log?: (line: string) => void;
}

export interface EvidenceSummary {
  scanned: number;
  pairs: number;
  identicalText: number;
  wouldCallJev: number;
  jevErrors: number;
  buckets: number[];
  results: PairResult[];
}

const SESSION_COLUMNS =
  "id::text AS id, namespace, summary, project, key_decisions, next_steps, blockers";

/** The full text of a session record: every text column, labelled. */
function fullText(row: SessionRow): string {
  return JSON.stringify({
    summary: row.summary,
    project: row.project,
    key_decisions: row.key_decisions,
    next_steps: row.next_steps,
    blockers: row.blockers,
  });
}

/** Sampled null-embedding rows paired with the row holding their fresh hash. */
export async function findPairs(
  pool: pg.Pool,
  sample: number,
  namespaces?: string[],
): Promise<{ scanned: number; pairs: CollisionPair[] }> {
  const target = getEmbeddingTarget("sessions");
  const { rows } = await pool.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM sessions
     WHERE embedding IS NULL AND ($2::text[] IS NULL OR namespace = ANY($2::text[]))
     ORDER BY random() LIMIT $1`,
    [sample, namespaces ?? null],
  );
  const pairs: CollisionPair[] = [];
  for (const row of rows) {
    const fresh = target.sourceHash(row as unknown as Record<string, unknown>);
    const { rows: holders } = await pool.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM sessions
       WHERE content_hash = $1 AND namespace = $2 AND id::text <> $3 LIMIT 1`,
      [fresh, row.namespace, row.id],
    );
    const [holder] = holders;
    if (!holder) continue;
    pairs.push({
      dupId: row.id,
      holderId: holder.id,
      dupText: fullText(row),
      holderText: fullText(holder),
    });
  }
  return { scanned: rows.length, pairs };
}

function planFor(pair: CollisionPair, config: JevConfig): JevBatchPlan {
  return buildJevBatchPlan({
    sharedState: {},
    records: [
      {
        key: pair.dupId,
        content: "Two session records whose content_hash collides.",
        fields: { dup_text: pair.dupText, holder_text: pair.holderText },
      },
    ],
    classifierSet: SAME_SESSION_SET,
    limits: config,
  });
}

function oneLine(message: string): string {
  return message.replace(/[\t\r\n]+/g, " ");
}

function errorMessage(error: unknown): string {
  return oneLine(error instanceof Error ? error.message : String(error));
}

/** One pair's row: lengths, identity, and (under --yes) the Jev verdict. */
async function evaluatePair(
  pair: CollisionPair,
  options: EvidenceOptions,
): Promise<{ result: PairResult; calls: number }> {
  const result: PairResult = {
    dupId: pair.dupId,
    holderId: pair.holderId,
    dupLen: pair.dupText.length,
    holderLen: pair.holderText.length,
    identicalText: pair.dupText === pair.holderText,
    jevNoul: null,
    jevError: "",
  };
  let plan: JevBatchPlan;
  try {
    plan = planFor(pair, options.config);
  } catch (error: unknown) {
    result.jevError = errorMessage(error);
    return { result, calls: 0 };
  }
  if (!options.yes) return { result, calls: plan.batches.length };
  try {
    const { answers } = await executeJevBatchPlan(
      options.config,
      plan,
      options.fetchFn,
    );
    const answer = answers.get(pair.dupId)?.[QUESTION_NAME];
    if (answer?.type === "noul") result.jevNoul = answer.noul;
    else result.jevError = "Jev returned no noul for this pair";
  } catch (error: unknown) {
    result.jevError = errorMessage(error);
  }
  return { result, calls: plan.batches.length };
}

/** Counts of jev_noul values in 0.1 buckets; 1.0 lands in the last bucket. */
function noulBuckets(results: readonly PairResult[]): number[] {
  const buckets = Array.from({ length: 10 }, () => 0);
  for (const r of results) {
    if (r.jevNoul === null) continue;
    const index = Math.min(9, Math.floor(r.jevNoul * 10));
    buckets[index] = (buckets[index] ?? 0) + 1;
  }
  return buckets;
}

export async function collectEvidence(
  pool: pg.Pool,
  options: EvidenceOptions,
): Promise<EvidenceSummary> {
  const log = options.log ?? ((line: string) => console.log(line));
  const { scanned, pairs } = await findPairs(pool, options.sample, options.namespaces);
  const results: PairResult[] = [];
  let wouldCallJev = 0;
  for (const pair of pairs) {
    const { result, calls } = await evaluatePair(pair, options);
    results.push(result);
    wouldCallJev += calls;
  }
  const buckets = noulBuckets(results);
  const summary: EvidenceSummary = {
    scanned,
    pairs: results.length,
    identicalText: results.filter((r) => r.identicalText).length,
    wouldCallJev,
    jevErrors: results.filter((r) => r.jevError !== "").length,
    buckets,
    results,
  };
  log(
    `sessions-collision-evidence ${options.yes ? "yes" : "dry-run"}: scanned=${summary.scanned} pairs=${summary.pairs} identical_text=${summary.identicalText} would_call_jev=${summary.wouldCallJev} jev_errors=${summary.jevErrors}`,
  );
  if (options.yes) {
    log(
      `jev_noul buckets: ${buckets
        .map((n, i) => `${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}=${n}`)
        .join(" ")}`,
    );
  }
  return summary;
}

export function toTsv(results: readonly PairResult[]): string {
  const header =
    "dup_id\tholder_id\tdup_len\tholder_len\tidentical_text\tjev_noul\tjev_error";
  const lines = results.map((r) =>
    [
      r.dupId,
      r.holderId,
      String(r.dupLen),
      String(r.holderLen),
      String(r.identicalText),
      r.jevNoul === null ? "" : String(r.jevNoul),
      r.jevError,
    ].join("\t"),
  );
  return `${[header, ...lines].join("\n")}\n`;
}

/** The Jev config, read from the same env keys the server's Jev groups use. */
export function jevConfigFromEnv(
  env: NodeJS.ProcessEnv,
  requireKey: boolean,
): JevConfig {
  const apiKey = env.OPENBRAIN_JEV_API_KEY;
  if (requireKey && !apiKey) {
    throw new Error("OPENBRAIN_JEV_API_KEY is unset; --yes cannot run without it");
  }
  return {
    enabled: true,
    ...(apiKey ? { apiKey } : {}),
    baseUrl: env.OPENBRAIN_JEV_BASE_URL || DEFAULT_JEV_BASE_URL,
    model: env.OPENBRAIN_JEV_MODEL || DEFAULT_JEV_MODEL,
    timeoutMs: JEV_TIMEOUT_MS,
    maxRequestBytes: DEFAULT_JEV_MAX_REQUEST_BYTES,
    maxStateQuestionBytes: DEFAULT_JEV_MAX_STATE_QUESTION_BYTES,
  };
}

export interface CliOptions {
  sample: number;
  yes: boolean;
  out?: string;
  namespaces: string[];
}

const VALUE_FLAGS = new Set(["--sample", "--out", "--namespace"]);

function applyValueFlag(
  options: CliOptions,
  flag: string,
  value: string | undefined,
): void {
  if (value == null || value.startsWith("--"))
    throw new Error(`${flag} requires a value`);
  if (flag === "--out") {
    options.out = value;
    return;
  }
  if (flag === "--namespace") {
    options.namespaces.push(value);
    return;
  }
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1)
    throw new Error("--sample must be a positive integer");
  options.sample = n;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { sample: DEFAULT_SAMPLE, yes: false, namespaces: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? "";
    if (flag === "--yes") options.yes = true;
    else if (flag === "--dry-run") options.yes = false;
    else if (VALUE_FLAGS.has(flag)) {
      applyValueFlag(options, flag, argv[i + 1]);
      i += 1;
    } else throw new Error(`unknown argument ${flag}`);
  }
  return options;
}

if (import.meta.main) {
  let cli: CliOptions;
  let config: JevConfig;
  try {
    cli = parseArgs(process.argv.slice(2));
    config = jevConfigFromEnv(process.env, cli.yes);
  } catch (err) {
    console.error(`sessions-collision-evidence: ${errorMessage(err)}`);
    process.exit(1);
  }
  const pool = createPool();
  try {
    if (cli.yes) console.log("calling Jev: one noul per pair");
    const summary = await collectEvidence(pool, {
      sample: cli.sample,
      yes: cli.yes,
      config,
      ...(cli.namespaces.length > 0 ? { namespaces: cli.namespaces } : {}),
    });
    if (cli.out) {
      writeFileSync(cli.out, toTsv(summary.results));
      console.log(`wrote ${summary.results.length} pairs to ${cli.out}`);
    }
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error(`sessions-collision-evidence: ${errorMessage(err)}`);
    await pool.end().catch(() => {});
    process.exit(1);
  }
}
