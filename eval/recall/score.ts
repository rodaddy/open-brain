/**
 * The current-system recall baseline: what TODAY's ranking scores against the
 * #322 fixtures.
 *
 * WHAT THIS IS FOR. Every proposal to change retrieval ranking -- add a
 * usefulness term to fusion, reweight the vector arm, change a tier boost --
 * is an argument about a number nobody has measured. This script measures it.
 * It runs the real `executeSearch` against the real dogfood corpus with the
 * real embedding provider and reports recall@k, precision@k and MRR. A later
 * lane that changes a weight re-runs this and can say what moved; without a
 * baseline, "it feels better" is the whole evidence.
 *
 * IT MEASURES, IT NEVER TUNES. Nothing here reads or sets USEFULNESS_WEIGHT,
 * VECTOR_WEIGHT, AGE_WEIGHT, a tier boost, or the fusion score. The engine is
 * imported and called exactly as `search_brain` calls it, because a baseline
 * taken against a mock or a reimplemented ranker measures the mock.
 *
 * IT NEVER WRITES TO THE CORPUS. The fixtures name live row ids, so a run that
 * mutated `public` would invalidate the rows the next run asserts against.
 * Every write goes through `seed.ts` into a fresh `dream_run_NNN` schema under
 * the disposable-run protocol (`docs/dream-ethereal-runs.md`), and the run's
 * schema is left standing as its evidence rather than torn down.
 * `scripts/done-means/1412-baseline-scored.sh` clause (f) enforces the
 * no-bare-table rule mechanically.
 *
 * WHY THE RUN SCHEMA SURVIVES. `teardownRunSchema` exists and is deliberately
 * not called on the success path: the measured numbers ARE the deliverable, and
 * dropping them at exit would leave only stdout, which nothing can re-query.
 * A run that fails BEFORE recording anything drops its empty schema so a retry
 * gets a clean number.
 *
 * Usage, from the repo root with the libpq vars loaded:
 *   set -a; . ./.env; set +a
 *   node eval/recall/score.ts
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import pino from "pino";
import { z } from "zod";
import {
  consumerEnvironmentFields,
  embeddingGroup,
} from "../../server/config/consumer-env-fields.ts";
import {
  generateEmbedding,
  setEmbeddingSettingsReader,
} from "../../server/embedding/provider.ts";
import { ALL_TABLES } from "../../server/tools/search-constants.ts";
import { executeSearch } from "../../server/tools/search-engine.ts";
import type {
  SearchDependencies,
  SearchSource,
} from "../../server/tools/search-engine-types.ts";
import {
  closeManifest,
  createRunSchema,
  recordFixtureResult,
  recordManifest,
  runIdentity,
  teardownRunSchema,
  type RunIdentity,
} from "./seed.ts";

/** One expected or forbidden row, as `fixtures.json` names it. */
interface FixtureRef {
  readonly source_type: string;
  readonly id: string;
  readonly label?: number;
}

interface Fixture {
  readonly id: string;
  readonly query: string;
  readonly namespace: string;
  readonly expected: readonly FixtureRef[];
  readonly forbidden?: readonly FixtureRef[];
  readonly isolation?: boolean;
  readonly note: string;
}

interface FixtureFile {
  readonly version: number;
  readonly fixtures: readonly Fixture[];
}

/** The cut-offs the baseline reports. `k = 10` is also the retrieval depth. */
const K_VALUES = [1, 3, 5, 10] as const;

/** Rows fetched per fixture. Equal to the largest k, so no k is truncated. */
const RETRIEVAL_LIMIT = 10;

/**
 * Attempts per fixture when the embedding provider fails.
 *
 * The provider is a fleet service and shows brief `503 no available server`
 * windows. A failed embedding degrades hybrid search to keyword-only, which
 * would be recorded as a genuine ranking result and silently drag the baseline
 * down -- the exact way a measurement lies. Retrying is cheaper than a number
 * nobody can trust.
 */
const MAX_ATTEMPTS = 4;

/** Backoff between embedding retries. */
const RETRY_DELAY_MS = 2000;

/**
 * The fixture file names PHYSICAL tables; a search row carries a SINGULAR wire
 * label. Neither is derivable from the other by string surgery
 * (`ob_session_events` -> `session_event`), so the mapping is written out.
 * Source: `SOURCE_LABELS` and `SESSION_EVENTS_LABEL` in the search engine.
 */
const FIXTURE_TABLE_TO_ROW_LABEL: Readonly<Record<string, string>> = {
  thoughts: "thought",
  decisions: "decision",
  relationships: "relationship",
  projects: "project",
  sessions: "session",
  ob_session_events: "session_event",
};

/**
 * Every source the engine can read.
 *
 * `session_events` is not in `ALL_TABLES` -- it is a read-only retrieval source
 * outside the `ResourceTable` write union -- but four fixtures name rows in it,
 * so a baseline that omitted it would report those as misses the ranking could
 * never fix.
 */
const SEARCH_SOURCES: readonly SearchSource[] = [...ALL_TABLES, "session_events"];

/** A row's identity for set comparison: label and id together. */
function refKey(sourceLabel: string, id: string): string {
  return `${sourceLabel}:${id}`;
}

/** The key a fixture ref matches against, translated to the wire label. */
function fixtureRefKey(ref: FixtureRef): string {
  const label = FIXTURE_TABLE_TO_ROW_LABEL[ref.source_type] ?? ref.source_type;
  return refKey(label, ref.id);
}

/** The metrics one non-isolation fixture contributed. */
interface FixtureScore {
  readonly fixtureId: string;
  /** recall@k, keyed by k. */
  readonly recall: Readonly<Record<number, number>>;
  /** precision@k, keyed by k. */
  readonly precision: Readonly<Record<number, number>>;
  /** Reciprocal rank of the first label-2 hit; 0 when none was returned. */
  readonly reciprocalRank: number;
  /** 1-based rank of the first label-2 hit, or null when absent. */
  readonly firstRelevantRank: number | null;
  readonly returnedCount: number;
  readonly relevantCount: number;
}

/**
 * Scores one fixture's ranking.
 *
 * ONLY LABEL 2 COUNTS AS RELEVANT. The fixture file grades 2/1/0, and label 1
 * means "same subject area, does not answer the question" -- crediting it would
 * report a ranking as correct for surfacing a near-miss, which is precisely the
 * failure the eval is meant to catch. Labels 1 and 0 are recorded but never
 * scored as hits.
 *
 * @param fixture - The fixture, with its graded expectations.
 * @param rankedKeys - The returned rows' keys, best first.
 * @returns The fixture's recall@k, precision@k and reciprocal rank.
 */
export function scoreRanking(
  fixture: Fixture,
  rankedKeys: readonly string[],
): FixtureScore {
  const relevant = new Set(
    fixture.expected.filter((ref) => ref.label === 2).map(fixtureRefKey),
  );
  const recall: Record<number, number> = {};
  const precision: Record<number, number> = {};
  for (const k of K_VALUES) {
    const window = rankedKeys.slice(0, k);
    const hits = window.filter((key) => relevant.has(key)).length;
    // An empty relevant set would make recall 0/0. No non-isolation fixture has
    // one (the fixtures suite asserts it), but 1 is the honest value for
    // "every relevant row was found" rather than a NaN that poisons the mean.
    recall[k] = relevant.size === 0 ? 1 : hits / relevant.size;
    // precision@k divides by k, not by the window length: a fixture that
    // returned 3 rows for k=10 has 7 empty slots, and calling that "precision
    // over 3" would score a short result set as though it were a dense one.
    precision[k] = hits / k;
  }
  const zeroBased = rankedKeys.findIndex((key) => relevant.has(key));
  const firstRelevantRank = zeroBased === -1 ? null : zeroBased + 1;
  return {
    fixtureId: fixture.id,
    recall,
    precision,
    reciprocalRank: firstRelevantRank === null ? 0 : 1 / firstRelevantRank,
    firstRelevantRank,
    returnedCount: rankedKeys.length,
    relevantCount: relevant.size,
  };
}

/** What an isolation fixture observed. */
interface IsolationOutcome {
  readonly fixtureId: string;
  /** Forbidden keys that appeared anywhere in the results. Empty is the pass. */
  readonly leaked: readonly string[];
  readonly returnedCount: number;
}

/**
 * Checks one isolation fixture for a namespace leak.
 *
 * A leak is a FAILURE, not a low score: it means the namespace predicate did
 * not hold, which is a security boundary in this repo, so it is reported by id
 * and never folded into an average where a good mean could hide it.
 *
 * @param fixture - An isolation fixture, carrying `forbidden` and no expected.
 * @param rankedKeys - Every returned row's key, at any rank.
 * @returns The forbidden keys that appeared.
 */
export function checkIsolation(
  fixture: Fixture,
  rankedKeys: readonly string[],
): IsolationOutcome {
  const forbidden = new Set((fixture.forbidden ?? []).map(fixtureRefKey));
  const returned = new Set(rankedKeys);
  return {
    fixtureId: fixture.id,
    leaked: [...forbidden].filter((key) => returned.has(key)),
    returnedCount: rankedKeys.length,
  };
}

/** Mean of a list; 0 for an empty list, which only occurs with no fixtures. */
function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Rounded to four places: the noise floor of a 22-fixture set is well above this. */
function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** The aggregate the run records and prints. */
interface Aggregate {
  readonly [metric: string]: number;
}

/**
 * Aggregates per-fixture scores into the run's headline numbers.
 *
 * A MACRO average -- every fixture weighs the same regardless of how many
 * relevant rows it has. The alternative (pooling hits across fixtures) would
 * let the four multi-expectation fixtures dominate, and the question this
 * baseline answers is "how often does the stack answer a question well", one
 * question at a time.
 *
 * @param scores - One entry per non-isolation fixture.
 * @returns Flat metric names to values, all in [0,1].
 */
export function aggregate(scores: readonly FixtureScore[]): Aggregate {
  const out: Record<string, number> = {};
  for (const k of K_VALUES) {
    out[`recall@${k}`] = round(mean(scores.map((s) => s.recall[k] ?? 0)));
    out[`precision@${k}`] = round(mean(scores.map((s) => s.precision[k] ?? 0)));
  }
  out.mrr = round(mean(scores.map((s) => s.reciprocalRank)));
  return out;
}

/** Sleeps, for the retry backoff. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Runs one fixture's query through the real retrieval stack, retrying when the
 * embedding provider is briefly unavailable.
 *
 * @param dependencies - The live pool, real embed function, and logger.
 * @param fixture - The fixture whose query and namespace scope the search.
 * @returns The returned rows' keys, best first.
 * @throws {Error} `embedding_unavailable` when every attempt failed to embed.
 */
async function retrieve(
  dependencies: SearchDependencies,
  fixture: Fixture,
): Promise<readonly string[]> {
  let lastFailure = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    // Prove the embedding first. `hybrid` degrades to keyword-only on a null
    // embedding by design, and a degraded run is not a measurement of hybrid.
    const embedding = await generateEmbedding(fixture.query);
    if (embedding === null) {
      lastFailure = `attempt ${String(attempt)} returned no embedding`;
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
      continue;
    }
    const rows = await executeSearch(
      dependencies,
      SEARCH_SOURCES,
      fixture.query,
      RETRIEVAL_LIMIT,
      "hybrid",
      undefined,
      0,
      fixture.namespace,
      {},
    );
    return rows.map((row) => refKey(row.source_type, row.id));
  }
  throw new Error(
    `embedding_unavailable: ${fixture.id} could not be embedded in ${String(MAX_ATTEMPTS)} attempts (${lastFailure})`,
  );
}

/**
 * Picks the next free run number.
 *
 * Runs 1-4 are taken by earlier, differently-shaped runs, so the search starts
 * at 5 and skips any schema that already exists rather than adopting it: two
 * runs sharing a schema is the ambiguity the per-run protocol exists to remove.
 *
 * @param pool - A connected pool.
 * @returns An identity whose schema does not yet exist.
 * @throws {Error} `no_free_run_number` when 5..999 are all taken.
 */
async function nextRunIdentity(pool: Pool): Promise<RunIdentity> {
  const taken = await pool.query<{ nspname: string }>(
    "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'dream_run_%'",
  );
  const used = new Set(taken.rows.map((row) => row.nspname));
  for (let number = 5; number <= 999; number += 1) {
    const identity = runIdentity(number);
    if (!used.has(identity.schemaName)) return identity;
  }
  throw new Error("no_free_run_number: dream_run_005..999 are all taken");
}

/** Renders the aggregate as a fixed-width table for stdout. */
function formatAggregate(agg: Aggregate): string {
  const lines = ["  k    recall@k   precision@k"];
  for (const k of K_VALUES) {
    const recall = (agg[`recall@${k}`] ?? 0).toFixed(4);
    const precision = (agg[`precision@${k}`] ?? 0).toFixed(4);
    lines.push(`  ${String(k).padStart(2)}   ${recall}     ${precision}`);
  }
  lines.push(`  MRR  ${(agg.mrr ?? 0).toFixed(4)}`);
  return lines.join("\n");
}

/** Everything one run observed, before it is aggregated or printed. */
interface RunObservations {
  readonly scores: readonly FixtureScore[];
  readonly isolationOutcomes: readonly IsolationOutcome[];
}

/**
 * Runs every fixture through retrieval and records each one in the run schema.
 *
 * Split out of `main` so the loop that reads the corpus is one readable unit
 * and the process wiring around it is another.
 *
 * @param pool - A connected pool; written only inside the run's schema.
 * @param identity - The run that owns the rows this writes.
 * @param dependencies - The live retrieval dependencies.
 * @param fixtures - Every fixture, isolation cases included.
 * @returns The per-fixture scores and the isolation outcomes.
 */
async function observeFixtures(
  pool: Pool,
  identity: RunIdentity,
  dependencies: SearchDependencies,
  fixtures: readonly Fixture[],
): Promise<RunObservations> {
  const scores: FixtureScore[] = [];
  const isolationOutcomes: IsolationOutcome[] = [];
  for (const fixture of fixtures) {
    const rankedKeys = await retrieve(dependencies, fixture);
    if (fixture.isolation === true) {
      const outcome = checkIsolation(fixture, rankedKeys);
      isolationOutcomes.push(outcome);
      const forbiddenCount = String((fixture.forbidden ?? []).length);
      await recordFixtureResult(pool, identity, {
        fixtureId: fixture.id,
        firstRelevantRank: null,
        returnedCount: outcome.returnedCount,
        isolationBreach: outcome.leaked.length > 0,
        detail:
          outcome.leaked.length === 0
            ? `isolation clean: 0 of ${forbiddenCount} forbidden rows returned`
            : `isolation BREACH: ${outcome.leaked.join(", ")}`,
      });
      continue;
    }
    const score = scoreRanking(fixture, rankedKeys);
    scores.push(score);
    await recordFixtureResult(pool, identity, {
      fixtureId: fixture.id,
      firstRelevantRank: score.firstRelevantRank,
      returnedCount: score.returnedCount,
      isolationBreach: false,
      detail: JSON.stringify({
        namespace: fixture.namespace,
        relevant: score.relevantCount,
        recall: score.recall,
        precision: score.precision,
        reciprocal_rank: round(score.reciprocalRank),
      }),
    });
  }
  return { scores, isolationOutcomes };
}

/**
 * Prints the run to stdout: the aggregate table, one line per scored fixture,
 * and the isolation verdict.
 *
 * @param identity - The run whose schema holds the same numbers.
 * @param observations - What the run measured.
 * @param agg - The aggregate over the scored fixtures.
 */
function report(
  identity: RunIdentity,
  observations: RunObservations,
  agg: Aggregate,
): void {
  const { scores, isolationOutcomes } = observations;
  const breaches = isolationOutcomes.filter((outcome) => outcome.leaked.length > 0);
  const counts = `${String(scores.length)} scored fixtures, ${String(isolationOutcomes.length)} isolation fixtures`;
  process.stdout.write(`\nrecall baseline -- ${identity.schemaName}\n`);
  process.stdout.write(`${counts}, hybrid mode, limit ${String(RETRIEVAL_LIMIT)}\n\n`);
  process.stdout.write(`${formatAggregate(agg)}\n\n`);
  for (const score of scores) {
    const rank =
      score.firstRelevantRank === null
        ? "MISS"
        : `rank ${String(score.firstRelevantRank)}`;
    const recallAtTen = (score.recall[10] ?? 0).toFixed(2);
    process.stdout.write(
      `  ${score.fixtureId.padEnd(38)} ${rank.padEnd(8)} r@10=${recallAtTen}\n`,
    );
  }
  process.stdout.write("\n");
  if (breaches.length === 0) {
    process.stdout.write(
      `isolation: PASS -- ${String(isolationOutcomes.length)} fixtures, no forbidden row returned\n`,
    );
    return;
  }
  // Loud, and never averaged in: a namespace leak is a boundary failure, not a
  // low score, so it is named by fixture and by row.
  process.stdout.write(`isolation: FAIL -- ${String(breaches.length)} breach(es)\n`);
  for (const breach of breaches) {
    process.stdout.write(`  ${breach.fixtureId}: ${breach.leaked.join(", ")}\n`);
  }
}

/**
 * Builds the retrieval dependencies with the embedding settings the server
 * registers at startup, read from the same environment variables.
 *
 * WHY NOT `loadServerConfig()`. That parses the WHOLE server environment and
 * rejects anything missing a field a serving process needs -- it fails here on
 * `LOG_FILE`, which an eval script has no reason to set and which has nothing
 * to do with retrieval. So this reads the narrow, exported embedding seam
 * (`consumerEnvironmentFields` + `embeddingGroup`, the same functions
 * `parseServerConfig` calls) and layers the base URL and API key on top in the
 * same precedence `server/main.ts:565-573` uses.
 *
 * Without this registration the provider has no base URL, every embedding call
 * returns null, and hybrid degrades to keyword-only -- so the run would report
 * a keyword baseline while labelling it hybrid. That failure is silent, which
 * is why the retry path below treats a null embedding as fatal rather than
 * scoring the degraded ranking.
 *
 * @param pool - The pool the engine reads through.
 * @returns Dependencies wired to the real provider.
 * @throws {Error} `embedding_environment_invalid` when the embedding variables
 * do not parse.
 */
function buildDependencies(pool: Pool): SearchDependencies {
  const parsed = z.object(consumerEnvironmentFields).safeParse(process.env);
  if (!parsed.success) {
    const summary = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`embedding_environment_invalid: ${summary}`);
  }
  const group = embeddingGroup(parsed.data);
  const baseUrl = process.env.EMBEDDING_BASE_URL;
  const apiKey = process.env.EMBEDDING_API_KEY;
  setEmbeddingSettingsReader(() => ({
    ...group,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    // Truthiness, not presence: `.env` sets an empty key for a provider that
    // needs none, and an empty string is not a credential.
    ...(apiKey ? { apiKey } : {}),
  }));
  return {
    pool,
    embedFn: (text: string) => generateEmbedding(text),
    logger: pino({ level: "silent" }),
  };
}

async function main(): Promise<void> {
  const fixturesPath = join(dirname(fileURLToPath(import.meta.url)), "fixtures.json");
  const raw = readFileSync(fixturesPath, "utf8");
  const doc = JSON.parse(raw) as FixtureFile;
  const fixturesSha256 = createHash("sha256").update(raw).digest("hex");

  const pool = new Pool({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT ?? "5432"),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    ...(process.env.PGPASSWORD === undefined
      ? {}
      : { password: process.env.PGPASSWORD }),
  });
  const dependencies = buildDependencies(pool);

  const identity = await nextRunIdentity(pool);
  let recorded = false;
  try {
    await createRunSchema(pool, identity);
    const observations = await observeFixtures(
      pool,
      identity,
      dependencies,
      doc.fixtures,
    );
    const agg = aggregate(observations.scores);
    const breachCount = observations.isolationOutcomes.filter(
      (outcome) => outcome.leaked.length > 0,
    ).length;
    // The manifest note is the run's machine-readable summary; the done-means
    // check reads `aggregate` back out of it.
    await recordManifest(pool, identity, {
      fixturesSha256,
      fixtureCount: doc.fixtures.length,
      note: JSON.stringify({
        purpose: "issue 1412 baseline: today's ranking, unmodified",
        mode: "hybrid",
        limit: RETRIEVAL_LIMIT,
        sources: SEARCH_SOURCES,
        scored_fixtures: observations.scores.length,
        isolation_fixtures: observations.isolationOutcomes.length,
        isolation_breaches: breachCount,
        aggregate: agg,
      }),
    });
    recorded = true;
    await closeManifest(pool, identity);
    report(identity, observations, agg);
  } catch (error) {
    // A run that recorded nothing leaves no evidence worth keeping, and its
    // empty schema would push the next run to a higher number for no reason.
    if (!recorded) await teardownRunSchema(pool, identity);
    throw error;
  } finally {
    await pool.end();
  }
}

// Guarded so `curation.ts` (issue 1412 State 6) can import `scoreRanking` and
// `aggregate` rather than reimplementing the metrics. An unguarded top-level
// `await main()` would run a FULL baseline scoring pass -- new embeddings, a
// new `dream_run_NNN` schema -- as a side effect of the import, which is how a
// published measurement gets silently replaced by whoever imports the module.
if (import.meta.main) await main();
