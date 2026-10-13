/**
 * Issue 1412, State 6: does CURATION move recall at all?
 *
 * THE QUESTION. `usefulness_score` is set on 15 of 26,453 thoughts and is
 * import residue, so today every row projects the `COALESCE(..., 0.5)` fallback
 * and the vector arm's usefulness term is a CONSTANT that contributes nothing.
 * The program's open premise is that curating that column would improve recall.
 * Nobody has measured it. This script does, against the State 5 baseline.
 *
 * WHY THE SAMPLE IS THE BEST CASE, DELIBERATELY. The synthetic scores are not a
 * guess at what a curator would produce: label-2 expected rows are scored 0.95
 * and the rows that OUTRANKED them are scored 0.05. That is PERFECT curation,
 * an oracle that already knows the answer. If a ranking cannot be moved by a
 * curation signal that is exactly right, it cannot be moved by a real one
 * either -- which is the only shape of null result worth trusting.
 *
 * THREE ARMS.
 *   A -- baseline. Today's ranking at today's usefulness values. NOT RE-RUN:
 *        it is `dream_run_005`, a published measurement, and re-running it
 *        would re-embed and silently replace it. Read from that schema.
 *   B -- curated-vector. The sample's scores are visible to the vector arm's
 *        candidate ORDER BY. Fusion is unchanged. This is the ONE live path
 *        curation has into ranking today.
 *   C -- curated-fused. B, plus a curation term inside `fusedScore`, so fusion
 *        sees curation at all. C is the arm that separates "curation does not
 *        help" from "curation is discarded before it can help".
 *
 * WHY C EXISTS AT ALL, AND WHY THE CHECK DEMANDS IT. `fusedScore` is
 * `(rrf + TIER_BOOST) * TABLE_WEIGHT * recencyFactor` -- no usefulness term
 * (`server/tools/search-engine.ts:318-325`). Curation reshapes WHICH ROWS the
 * vector arm retrieves and is then DISCARDED at fusion. So a null A->B delta on
 * its own says nothing about curation; it says the vector arm's candidate order
 * did not change the fused top-10. Recording "curation is worthless" from that
 * would retire a program on a measurement that never tested it. Clause (e) of
 * `scripts/done-means/1412-curation-delta.sh` refuses exactly that.
 *
 * ONE ROW CLASS CANNOT MOVE UNDER B, BY CONSTRUCTION. The session-event arm
 * hardcodes `0.5 AS usefulness` (`search-engine-sql.ts:148`) and
 * `ob_session_events` has no `usefulness_score` column, so no score assigned to
 * a session-event row is ever read. All four `ob_session_events` fixtures miss
 * in the baseline (issue 1417). Their null under B is structural, not evidence
 * about curation, and the report says so rather than averaging it in silently.
 *
 * IT NEVER WRITES TO THE CORPUS. `public` is read-only here. The sample lives
 * in the run's own `dream_run_NNN` schema, and arm B reaches the engine by
 * SHADOWING the corpus tables with schema-local VIEWs that project the sample's
 * score in place of `usefulness_score`, then putting that schema first on the
 * connection's `search_path`. The engine's SQL names tables unqualified
 * (`FROM ${table} ${alias}`, `search-engine-sql.ts:190`), so the views resolve
 * with the engine unmodified -- no source change, no corpus write. Clause (f)
 * enforces the no-bare-table rule mechanically and re-counts the 15 curated
 * rows in `public.thoughts` afterwards.
 *
 * ARMS B AND C RE-FUSE LOCALLY. The engine exposes an internal candidate seam
 * so curation receives the same vector and hybrid lexical lists that
 * `hybridSearch` will fuse, including its over-fetch window and partial
 * coverage ordering. `fuseLocally` remains a separate transcription of
 * `accumulateRrf` + `fusedScore`, and `verifyLocalFusionMatchesEngine` PROVES
 * it against the engine's own `hybrid` output before any curated number is
 * believed. A local scorer that silently diverged from the engine would make
 * every delta below a measurement of the transcription, not of curation.
 *
 * Usage, from the repo root with the libpq vars loaded:
 *   set -a; . ./.env; set +a
 *   node eval/recall/curation.ts
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
import {
  type SearchDependencies,
  type SearchSource,
} from "../../server/tools/search-engine-types.ts";
import { fuseLocally, refKey, toRankedRow, type RankedRow } from "./fusion.ts";
import {
  runHybridCandidateArms,
  verifyLocalFusionMatchesEngine,
} from "./curation-fusion.ts";
import { aggregate, scoreRanking } from "./score.ts";
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

/** Retrieval depth. Identical to the baseline's, so the arms are comparable. */
const RETRIEVAL_LIMIT = 10;

/** Attempts per embedding call; the fleet provider shows brief 503 windows. */
const MAX_ATTEMPTS = 4;
const RETRY_DELAY_MS = 2000;

/** The synthetic score a label-2 expected row is given. Perfect curation. */
const CURATED_HIGH = 0.95;
/** The synthetic score a row that outranked an expected row is given. */
const CURATED_LOW = 0.05;

/**
 * Physical fixture table name to the singular wire label a search row carries.
 * Neither is derivable from the other by string surgery. Mirrors `score.ts`.
 */
const FIXTURE_TABLE_TO_ROW_LABEL: Readonly<Record<string, string>> = {
  thoughts: "thought",
  decisions: "decision",
  relationships: "relationship",
  projects: "project",
  sessions: "session",
  ob_session_events: "session_event",
};

/** The inverse: a wire label back to the table the sample keys on. */
const ROW_LABEL_TO_TABLE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(FIXTURE_TABLE_TO_ROW_LABEL).map(([table, label]) => [label, table]),
);

/**
 * Tables whose vector CTE actually READS `usefulness_score`.
 *
 * `ob_session_events` is absent on purpose: it has no such column and its arm
 * hardcodes `0.5 AS usefulness`, so it is not shadowable and not curatable.
 */
const CURATABLE_TABLES: readonly string[] = [...ALL_TABLES];

/** Every source the engine can read; `session_events` rides the sessions read. */
const SEARCH_SOURCES: readonly SearchSource[] = [...ALL_TABLES, "session_events"];

/** The key a fixture ref matches against, translated to the wire label. */
function fixtureRefKey(ref: FixtureRef): string {
  const label = FIXTURE_TABLE_TO_ROW_LABEL[ref.source_type] ?? ref.source_type;
  return refKey(label, ref.id);
}

/** One entry of the synthetic curation sample. */
interface SampleEntry {
  /** Physical table, as the shadow view is named. */
  readonly table: string;
  readonly id: string;
  readonly usefulnessScore: number;
  /** Why this row is in the sample, recorded so the rule is auditable. */
  readonly reason: string;
}

/** Sleeps, for the retry backoff. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Whether the provider can embed this query right now.
 *
 * Probed BEFORE the search rather than inferred from its results: `hybrid`
 * degrades to keyword-only on a null embedding by design, so a degraded run is
 * indistinguishable from a genuine ranking once it has returned.
 *
 * @param query - The fixture query to embed.
 * @returns True when the provider answered with a vector.
 */
async function embeddingIsAvailable(query: string): Promise<boolean> {
  return (await generateEmbedding(query)) !== null;
}

/**
 * Runs one arm of the engine, retrying a brief embedding outage.
 *
 * A null embedding is fatal rather than degraded: `hybrid` falls back to
 * keyword-only by design, and a degraded run recorded as a ranking result is
 * exactly how a measurement lies.
 *
 * @param dependencies - Pool, embedder and logger for this arm's connection.
 * @param fixture - The fixture whose query and namespace scope the search.
 * @param mode - `vector`, `keyword`, or `hybrid`.
 * @param limit - Rows to fetch.
 * @returns The returned rows, best first.
 * @throws {Error} `embedding_unavailable` when every attempt failed.
 */
async function runArm(
  dependencies: SearchDependencies,
  fixture: Fixture,
  mode: "vector" | "keyword" | "hybrid",
  limit: number,
): Promise<readonly RankedRow[]> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (mode !== "keyword" && !(await embeddingIsAvailable(fixture.query))) {
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
      continue;
    }
    const rows = await executeSearch(
      dependencies,
      SEARCH_SOURCES,
      fixture.query,
      limit,
      mode,
      undefined,
      0,
      fixture.namespace,
      {},
    );
    return rows.map((row) =>
      toRankedRow(row as unknown as Parameters<typeof toRankedRow>[0]),
    );
  }
  throw new Error(
    `embedding_unavailable: ${fixture.id} could not be embedded in ${String(MAX_ATTEMPTS)} attempts`,
  );
}

/**
 * Builds the synthetic curation sample from a probe of today's ranking.
 *
 * THE RULE, stated so a reader can disagree with it: every label-2 expected row
 * of every scored fixture is scored {@link CURATED_HIGH}; every row that
 * OUTRANKED that fixture's best expected row -- or every returned row, when the
 * fixture missed entirely -- is scored {@link CURATED_LOW}. Rows below an
 * expected hit are not touched: they are not contesting anything.
 *
 * A sample that omitted the contested rows could not move a ranking, so
 * including them is not padding; it is what makes the measurement capable of a
 * positive result.
 *
 * The probe is READ-ONLY and records nothing. It is not a re-run of arm A.
 *
 * @param dependencies - The un-shadowed dependencies.
 * @param fixtures - Every scored (non-isolation) fixture.
 * @returns The sample, one entry per (table, id).
 */
async function buildSample(
  dependencies: SearchDependencies,
  fixtures: readonly Fixture[],
): Promise<readonly SampleEntry[]> {
  const entries = new Map<string, SampleEntry>();
  const put = (key: string, entry: SampleEntry): void => {
    // First writer wins: a row that is expected somewhere is never demoted by
    // being a near-miss elsewhere, because scoring it low would make the
    // "perfect curation" claim false.
    if (!entries.has(key)) entries.set(key, entry);
  };

  for (const fixture of fixtures) {
    const relevant = new Set(
      fixture.expected.filter((ref) => ref.label === 2).map(fixtureRefKey),
    );
    for (const ref of fixture.expected) {
      if (ref.label !== 2) continue;
      put(fixtureRefKey(ref), {
        table: ref.source_type,
        id: ref.id,
        usefulnessScore: CURATED_HIGH,
        reason: `label-2 expected row of ${fixture.id}`,
      });
    }
    const ranked = await runArm(dependencies, fixture, "hybrid", RETRIEVAL_LIMIT);
    const firstHit = ranked.findIndex((row) => relevant.has(row.key));
    const contested = firstHit === -1 ? ranked : ranked.slice(0, firstHit);
    for (const row of contested) {
      const table = ROW_LABEL_TO_TABLE[row.source_type];
      if (table === undefined) continue;
      put(row.key, {
        table,
        id: row.id,
        usefulnessScore: CURATED_LOW,
        reason: `outranked the expected row of ${fixture.id}`,
      });
    }
  }
  return [...entries.values()];
}

const RUN_ID_PATTERN = /^\d{3}$/u;

/** Re-asserts the schema-name allowlist at every interpolation point. */
function safeSchema(identity: RunIdentity): string {
  if (!RUN_ID_PATTERN.test(identity.runId)) {
    throw new Error(`invalid_run_id: ${identity.runId} is not three digits`);
  }
  if (identity.schemaName !== `dream_run_${identity.runId}`) {
    throw new Error(`invalid_run_id: schema ${identity.schemaName} mismatched`);
  }
  return identity.schemaName;
}

/**
 * Writes the sample into the run's schema and builds the shadow views.
 *
 * The views are what let the UNMODIFIED engine see a curated corpus. Each one
 * selects every column of the public table except `usefulness_score`, and
 * projects the sample's score in its place, falling back to the real value
 * where the sample says nothing. `search_path` on arm B's connection then puts
 * the run schema first, so `FROM thoughts t` inside the engine's SQL resolves
 * to `dream_run_NNN.thoughts` with no source change and no corpus write.
 *
 * Only `ALL_TABLES` are shadowed. `ob_session_events` has no
 * `usefulness_score` column and its arm hardcodes `0.5 AS usefulness`, so a
 * view over it would change nothing and claiming otherwise would be the lie
 * this whole script exists to avoid.
 *
 * @param pool - A connected pool; writes only inside `${schemaName}`.
 * @param identity - The run that owns the schema.
 * @param sample - The synthetic scores.
 */
async function installSample(
  pool: Pool,
  identity: RunIdentity,
  sample: readonly SampleEntry[],
): Promise<void> {
  const schema = safeSchema(identity);
  await pool.query(
    `CREATE TABLE ${schema}.usefulness_sample (
       run_id text NOT NULL,
       source_table text NOT NULL,
       row_id uuid NOT NULL,
       usefulness_score double precision NOT NULL,
       reason text NOT NULL,
       PRIMARY KEY (source_table, row_id)
     )`,
  );
  for (const entry of sample) {
    await pool.query(
      `INSERT INTO ${schema}.usefulness_sample
         (run_id, source_table, row_id, usefulness_score, reason)
       VALUES ($1, $2, $3::uuid, $4, $5)
       ON CONFLICT (source_table, row_id) DO NOTHING`,
      [identity.runId, entry.table, entry.id, entry.usefulnessScore, entry.reason],
    );
  }
  for (const table of CURATABLE_TABLES) {
    // The table name is a compile-time literal from `ALL_TABLES`, never caller
    // input -- the same allowlist discipline the engine's own SQL uses.
    if (!ALL_TABLES.includes(table as (typeof ALL_TABLES)[number])) {
      throw new Error(`unshadowable_table: ${table}`);
    }
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [table],
    );
    const projected = columns.rows
      .map((column) =>
        column.column_name === "usefulness_score"
          ? `COALESCE(s.usefulness_score, base.usefulness_score) AS usefulness_score`
          : `base.${column.column_name}`,
      )
      .join(",\n    ");
    await pool.query(
      `CREATE VIEW ${schema}.${table} AS
       SELECT ${projected}
       FROM public.${table} base
       LEFT JOIN ${schema}.usefulness_sample s
         ON s.source_table = '${table}' AND s.row_id = base.id`,
    );
  }
}

/** One arm's per-fixture ranked keys, keyed by fixture id. */
type ArmRankings = ReadonlyMap<string, readonly string[]>;

/**
 * Runs arms B and C over every scored fixture on the SHADOWED connection.
 *
 * Both arms share one pair of retrievals: B and C differ only in whether
 * `fusedScore` carries the curation term, so re-querying for C would spend a
 * second embedding round trip to fuse the identical candidates -- and would
 * introduce embedding non-determinism between two arms that are meant to
 * differ in exactly one thing.
 *
 * @param dependencies - Dependencies whose pool resolves the shadow views.
 * @param fixtures - The scored fixtures.
 * @returns Arm B's and arm C's rankings.
 */
async function runCuratedArms(
  dependencies: SearchDependencies,
  fixtures: readonly Fixture[],
): Promise<{ armB: ArmRankings; armC: ArmRankings }> {
  const armB = new Map<string, readonly string[]>();
  const armC = new Map<string, readonly string[]>();
  for (const fixture of fixtures) {
    const { vectorRows, ftsRows } = await runHybridCandidateArms(
      dependencies,
      fixture,
      {
        sources: SEARCH_SOURCES,
        limit: RETRIEVAL_LIMIT,
        maxAttempts: MAX_ATTEMPTS,
        retryDelayMs: RETRY_DELAY_MS,
      },
    );
    armB.set(fixture.id, fuseLocally(vectorRows, ftsRows, RETRIEVAL_LIMIT, false));
    armC.set(fixture.id, fuseLocally(vectorRows, ftsRows, RETRIEVAL_LIMIT, true));
  }
  return { armB, armC };
}

/** Rounded to four places, matching the baseline's precision. */
function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** Reads arm A's published aggregate out of `dream_run_005.manifest`. */
async function readBaselineAggregate(
  pool: Pool,
): Promise<Readonly<Record<string, number>>> {
  const result = await pool.query<{ note: string }>(
    "SELECT note FROM dream_run_005.manifest LIMIT 1",
  );
  const note = result.rows[0]?.note;
  if (note === undefined)
    throw new Error("baseline_missing: dream_run_005.manifest is empty");
  const parsed = JSON.parse(note) as { aggregate?: Record<string, number> };
  if (!parsed.aggregate)
    throw new Error("baseline_missing: manifest note carries no aggregate");
  return parsed.aggregate;
}

/**
 * Arm A's per-fixture first-relevant rank, read back rather than re-measured.
 *
 * Selected by the SCORED fixture ids. `dream_run_005.fixture_result` also
 * holds the three isolation fixtures, which have no relevant set and belong to
 * no recall arm -- carrying them into arm A would give A 25 rows against B and
 * C's 22 and quietly compare three different fixture sets.
 *
 * @param pool - A connected pool.
 * @param scoredIds - The non-isolation fixture ids B and C were scored over.
 * @returns Arm A's rank per scored fixture.
 */
async function readBaselineRanks(
  pool: Pool,
  scoredIds: readonly string[],
): Promise<ReadonlyMap<string, number | null>> {
  const result = await pool.query<{
    fixture_id: string;
    first_relevant_rank: number | null;
  }>(
    "SELECT fixture_id, first_relevant_rank FROM dream_run_005.fixture_result WHERE fixture_id = ANY($1::text[])",
    [scoredIds],
  );
  return new Map(result.rows.map((row) => [row.fixture_id, row.first_relevant_rank]));
}

/** The delta between two aggregates, metric by metric. */
function deltaOf(
  from: Readonly<Record<string, number>>,
  to: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(to))
    out[key] = round((to[key] ?? 0) - (from[key] ?? 0));
  return out;
}

/** Picks the next free run number; 1-5 are taken by earlier runs. */
async function nextRunIdentity(pool: Pool): Promise<RunIdentity> {
  const taken = await pool.query<{ nspname: string }>(
    "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'dream_run_%'",
  );
  const used = new Set(taken.rows.map((row) => row.nspname));
  for (let number = 6; number <= 999; number += 1) {
    const identity = runIdentity(number);
    if (!used.has(identity.schemaName)) return identity;
  }
  throw new Error("no_free_run_number: dream_run_006..999 are all taken");
}

/**
 * Builds retrieval dependencies, optionally pinned to the run's shadow views.
 *
 * `search_path` is set per CONNECTION rather than per query, because the engine
 * owns its own SQL and never offers a hook to qualify a table name. Every
 * connection this pool hands out runs the same `SET search_path`, so an arm
 * cannot silently read the un-shadowed corpus from a second pooled connection.
 *
 * @param schemaName - The run schema to put first, or undefined for public.
 * @returns A pool and the dependencies wrapping it.
 */
function buildPool(schemaName?: string): {
  pool: Pool;
  dependencies: SearchDependencies;
} {
  const pool = new Pool({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT ?? "5432"),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    ...(process.env.PGPASSWORD === undefined
      ? {}
      : { password: process.env.PGPASSWORD }),
  });
  if (schemaName !== undefined) {
    const schema = schemaName;
    if (!/^dream_run_\d{3}$/u.test(schema)) {
      throw new Error(`invalid_search_path_schema: ${schema}`);
    }
    pool.on("connect", (client) => {
      void client.query(`SET search_path TO ${schema}, public`);
    });
  }
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
    ...(apiKey ? { apiKey } : {}),
  }));
  return {
    pool,
    dependencies: {
      pool,
      embedFn: (text: string) => generateEmbedding(text),
      logger: pino({ level: "silent" }),
    },
  };
}

/** The per-fixture outcome any arm records, whether measured here or read back. */
interface ArmOutcome {
  readonly fixtureId: string;
  readonly firstRelevantRank: number | null;
  readonly returnedCount: number;
}

/**
 * Records one arm's per-fixture outcomes, tagged with the arm letter.
 *
 * The `arm` tag in `detail` is what makes the three arms separable in one
 * table, which is what clause (c) of the done-means check reads.
 *
 * @param pool - A connected pool; writes only inside the run schema.
 * @param identity - The run that owns the rows.
 * @param arm - "A", "B" or "C".
 * @param outcomes - One entry per scored fixture.
 */
async function recordArm(
  pool: Pool,
  identity: RunIdentity,
  arm: "A" | "B" | "C",
  outcomes: readonly ArmOutcome[],
): Promise<void> {
  for (const outcome of outcomes) {
    await recordFixtureResult(pool, identity, {
      fixtureId: outcome.fixtureId,
      firstRelevantRank: outcome.firstRelevantRank,
      returnedCount: outcome.returnedCount,
      isolationBreach: false,
      detail: JSON.stringify({ arm }),
    });
  }
}

/** Formats one arm's headline for stdout. */
function armLine(name: string, agg: Readonly<Record<string, number>>): string {
  return `  ${name.padEnd(22)} r@1=${(agg["recall@1"] ?? 0).toFixed(4)}  r@5=${(agg["recall@5"] ?? 0).toFixed(4)}  r@10=${(agg["recall@10"] ?? 0).toFixed(4)}  p@10=${(agg["precision@10"] ?? 0).toFixed(4)}  MRR=${(agg.mrr ?? 0).toFixed(4)}`;
}

async function main(): Promise<void> {
  const fixturesPath = join(dirname(fileURLToPath(import.meta.url)), "fixtures.json");
  const raw = readFileSync(fixturesPath, "utf8");
  const doc = JSON.parse(raw) as FixtureFile;
  const fixturesSha256 = createHash("sha256").update(raw).digest("hex");
  const scored = doc.fixtures.filter((fixture) => fixture.isolation !== true);

  const plain = buildPool();
  const identity = await nextRunIdentity(plain.pool);
  let shadowed: { pool: Pool; dependencies: SearchDependencies } | undefined;
  let recorded = false;
  try {
    // 0. Prove the local fusion IS the engine's, before trusting any delta.
    const witness = scored[0];
    if (witness === undefined) throw new Error("no_scored_fixtures");
    await verifyLocalFusionMatchesEngine(plain.dependencies, witness, {
      sources: SEARCH_SOURCES,
      limit: RETRIEVAL_LIMIT,
      maxAttempts: MAX_ATTEMPTS,
      retryDelayMs: RETRY_DELAY_MS,
    });
    process.stdout.write("local fusion verified against the engine's hybrid output\n");

    // 1. Build the sample from a read-only probe of today's ranking.
    const sample = await buildSample(plain.dependencies, scored);
    process.stdout.write(`sample: ${String(sample.length)} rows\n`);

    // 2. Install it in the run's own schema, behind shadow views.
    await createRunSchema(plain.pool, identity);
    await installSample(plain.pool, identity, sample);

    // 3. Arms B and C, on the shadowed connection.
    shadowed = buildPool(identity.schemaName);
    const { armB, armC } = await runCuratedArms(shadowed.dependencies, scored);

    // 4. Score. Arm A is READ, never re-run.
    const aggA = await readBaselineAggregate(plain.pool);
    const ranksA = await readBaselineRanks(
      plain.pool,
      scored.map((fixture) => fixture.id),
    );
    const scoresB = scored.map((fixture) =>
      scoreRanking(fixture, armB.get(fixture.id) ?? []),
    );
    const scoresC = scored.map((fixture) =>
      scoreRanking(fixture, armC.get(fixture.id) ?? []),
    );
    const aggB = aggregate(scoresB);
    const aggC = aggregate(scoresC);
    const deltaAB = deltaOf(aggA, aggB);
    const deltaAC = deltaOf(aggA, aggC);

    // 5. Record every arm's per-fixture outcome, distinguished by `arm`.
    await recordArm(
      plain.pool,
      identity,
      "A",
      [...ranksA].map(([fixtureId, rank]) => ({
        fixtureId,
        firstRelevantRank: rank,
        returnedCount: RETRIEVAL_LIMIT,
      })),
    );
    await recordArm(plain.pool, identity, "B", scoresB);
    await recordArm(plain.pool, identity, "C", scoresC);

    await recordManifest(plain.pool, identity, {
      fixturesSha256,
      fixtureCount: doc.fixtures.length,
      note: JSON.stringify({
        purpose: "issue 1412 State 6: does curation move recall",
        baseline_run: "dream_run_005",
        sample_rule: `label-2 expected rows -> ${String(CURATED_HIGH)}; rows that outranked them -> ${String(CURATED_LOW)}`,
        sample_size: sample.length,
        scored_fixtures: scored.length,
        arms: { A: aggA, B: aggB, C: aggC },
        delta_a_to_b: deltaAB,
        delta_a_to_c: deltaAC,
        session_event_note:
          "session_event rows cannot move under arm B: the arm hardcodes 0.5 AS usefulness and ob_session_events has no usefulness_score column (search-engine-sql.ts:148, issue 1417)",
      }),
    });
    recorded = true;
    await closeManifest(plain.pool, identity);

    process.stdout.write(`\ncuration delta -- ${identity.schemaName}\n\n`);
    process.stdout.write(`${armLine("A baseline", aggA)}\n`);
    process.stdout.write(`${armLine("B curated-vector", aggB)}\n`);
    process.stdout.write(`${armLine("C curated-fused", aggC)}\n\n`);
    process.stdout.write(
      `  A->B  r@10 ${(deltaAB["recall@10"] ?? 0).toFixed(4)}  MRR ${(deltaAB.mrr ?? 0).toFixed(4)}\n`,
    );
    process.stdout.write(
      `  A->C  r@10 ${(deltaAC["recall@10"] ?? 0).toFixed(4)}  MRR ${(deltaAC.mrr ?? 0).toFixed(4)}\n`,
    );
  } catch (error) {
    if (!recorded) await teardownRunSchema(plain.pool, identity);
    throw error;
  } finally {
    if (shadowed !== undefined) await shadowed.pool.end();
    await plain.pool.end();
  }
}

await main();
