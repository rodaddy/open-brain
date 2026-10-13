/**
 * Shared machinery for the standalone DREAM route proofs
 * (`scripts/dream-route-proof-v<N>.ts`).
 *
 * A proof is not a test: the checker
 * `scripts/done-means/1469-dream-route-proofs.sh` runs each one as a plain
 * node script, reads its PASS/FAIL lines, and trusts only the exit code. So
 * everything a proof needs that a Vitest suite would get from a fixture lives
 * here instead -- the database refusal, the run-schema lifecycle, the planting
 * helpers, and the reporter.
 *
 * THE PLANTING GOES THROUGH THE REAL STORES, not hand-written DDL. The routing
 * tables come from `writeRun` (`scripts/dream-route-run-store.ts`), the mirrors
 * from `ensureApplyMirrors`, the signal tables from `ensureSignalTables`, and
 * the signals themselves from `plantSignal`. That is the whole point of a
 * proof: if the store's shape drifts, the proof drifts with it and keeps
 * proving something true. Only `cohort` is created here, because its creator
 * (`createDreamRouteTables` in `scripts/dream-route-cohort.ts`) is private to
 * the freeze path and also reads `public.candidate_memory`, which a proof must
 * not do -- the columns below are copied from that same function.
 *
 * NOTHING REAL IS EVER STORED. Every content string a proof plants is invented
 * (`synthetic rule alpha` and the like), so a schema that somehow survived a
 * crash holds no memory belonging to anyone.
 *
 * `public` is never written and is counted before and after, because "writes
 * only inside the run schema" (`docs/dream-ethereal-runs.md:44-64`) is the
 * property the whole ethereal-run design rests on.
 */

import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { createPool } from "./settings.ts";
import { nextSchema } from "./rem-ethereal-cohort.ts";
import {
  writeRun,
  type RoutedResult,
  type RoutingRunRow,
} from "./dream-route-run-store.ts";
import type { WouldApply } from "../server/domain/dream-route/run-core.ts";
import type { AuthorityTier, Destination } from "../server/domain/dream-route/types.ts";
import { ensureApplyMirrors } from "./dream-route-apply-store.ts";
import {
  ensureSignalTables,
  plantSignal,
  type RouteSignal,
} from "./dream-route-signals-store.ts";

/** The exit code a refusal uses; distinct from 1, which is an honest FAIL. */
export const REFUSED_EXIT_CODE = 2;

/** The `public` tables every proof counts before and after itself. */
export const WATCHED_PUBLIC_TABLES = [
  "thoughts",
  "ob_session_events",
  "tier_moves",
] as const;

/** One count per watched `public` table. */
export type PublicCounts = Record<string, number>;

/**
 * Refuses to run against anything but a disposable database.
 *
 * The proofs allocate schemas, write rows, and drop schemas. Pointed at the
 * dogfood database `open_brain_local_20260724` that is destructive, so the
 * name is checked rather than trusted: a copy database carries `_play_`, and
 * the isolated test runner's databases start `ob_isolated_`. Anything else
 * exits 2 with the name it was given, so the refusal is legible in a log.
 *
 * @returns The accepted database name.
 */
export function requireProofDatabase(): string {
  const name = process.env.DB_NAME ?? "";
  if (name.includes("_play_") || name.startsWith("ob_isolated_")) return name;
  process.stderr.write(
    `REFUSED a dream route proof runs only against a disposable database; ` +
      `DB_NAME was "${name || "<unset>"}", which is neither a _play_ copy ` +
      `nor an ob_isolated_ test database\n`,
  );
  process.exit(REFUSED_EXIT_CODE);
}

/** A pool for the proof database, refusing first. */
export function proofPool(): Pool {
  requireProofDatabase();
  return createPool();
}

/** The sha256 a planted candidate's `content_hash` carries. */
export function contentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Counts the `public` rows a proof must leave exactly as it found them.
 *
 * @param pool - The proof pool.
 * @returns One count per watched table.
 */
export async function publicCounts(pool: Pool): Promise<PublicCounts> {
  const counts: PublicCounts = {};
  for (const table of WATCHED_PUBLIC_TABLES) {
    const result = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.${table}`,
    );
    counts[table] = Number(result.rows[0]?.n ?? 0);
  }
  return counts;
}

/**
 * Allocates a fresh run schema, hands it to `fn`, and always drops it.
 *
 * The allocator holds a transaction-scoped advisory lock, so the schema is
 * created inside the same transaction that picked the name
 * (`scripts/rem-ethereal-cohort.ts:196-224`), exactly as the cohort freeze
 * does. Teardown is the one `DROP SCHEMA ... CASCADE` the ethereal-run design
 * specifies, in a `finally`, so a thrown assertion still cleans up -- and it
 * can only ever drop the name THIS call allocated.
 *
 * @param pool - The proof pool.
 * @param fn - The body, given the allocated schema name.
 * @returns Whatever the body returned.
 */
export async function withProofSchema<T>(
  pool: Pool,
  fn: (schema: string) => Promise<T>,
): Promise<T> {
  const setup = await pool.connect();
  let schema: string;
  try {
    await setup.query("BEGIN");
    schema = await nextSchema(setup);
    await setup.query(`CREATE SCHEMA ${schema}`);
    await setup.query("COMMIT");
  } catch (error) {
    await setup.query("ROLLBACK");
    setup.release();
    throw error;
  }
  setup.release();
  try {
    return await fn(schema);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }
}

/** One synthetic candidate a proof plants. */
export interface PlantedCandidate {
  /** The label the proof refers to it by in its own assertions. */
  readonly label: string;
  /** Invented text; never anything drawn from real memory. */
  readonly content: string;
  /** The `would_apply` verdict the apply step will read. */
  readonly action: WouldApply["action"];
  /** The `routing_decisions.authority_tier` the signal pass reads. */
  readonly authorityTier: AuthorityTier;
  /** A route signal to plant against it, if any. */
  readonly signal?: RouteSignal;
  /** The scope key a `reverses_rule` signal targets. */
  readonly targetScopeKey?: string;
  /**
   * `routing_decisions.destination`, when the proof is about graduation.
   *
   * `graduateRecurring` filters on it (`fact`/`decision` graduate, a
   * `correction` never does), so a proof that says nothing about destination
   * leaves it null exactly as V3 and V4 do.
   */
  readonly destination?: Destination;
  /**
   * The label of the candidate this one repeats.
   *
   * Resolved to the target's candidate id and written to
   * `would_apply.reinforces`, which is the only column that links a repeat to
   * what it repeats (`scripts/dream-route-graduate.ts:9-16`).
   */
  readonly reinforces?: string;
  /**
   * The session refs this candidate was seen in.
   *
   * One frozen `ob_raw_turns` row per ref is planted IN THE RUN SCHEMA, and
   * the ids land in `snapshot.source_turn_ids`, which is the hop
   * `graduateRecurring` counts distinct sessions over. Never planted in
   * `public`: the run touching nothing outside its own schema is the property
   * these proofs exist to demonstrate.
   */
  readonly sessions?: readonly string[];
}

/** What a planted candidate turned into in the database. */
export interface PlantedRow {
  /** The label it was planted under. */
  readonly label: string;
  /** Its generated candidate id. */
  readonly candidateId: string;
  /** The sha256 of its content, which is also its rule scope key's tail. */
  readonly contentHash: string;
}

/** What `plantRun` is pointed at. */
export interface PlantRunInput {
  /** The proof pool. */
  readonly pool: Pool;
  /** The allocated run schema. */
  readonly schema: string;
  /** The routing run the planted rows belong to. */
  readonly runId: string;
  /** The candidates to plant, in the order they should be applied. */
  readonly candidates: readonly PlantedCandidate[];
}

/** The namespace every planted candidate is filed under. */
const PROOF_NAMESPACE = "dream-route-proof";

async function ensureCohortTable(pool: Pool, schema: string): Promise<void> {
  // Columns copied from `createDreamRouteTables`
  // (`scripts/dream-route-cohort.ts:258-275`); the CHECKs are omitted because
  // a proof plants `labelled` rows only and the freeze path owns the rest.
  await pool.query(`CREATE TABLE IF NOT EXISTS ${schema}.cohort (
    ordinal INTEGER PRIMARY KEY CHECK (ordinal > 0),
    candidate_id UUID NOT NULL UNIQUE,
    namespace TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('draw', 'neighbour', 'labelled')),
    neighbour_of UUID,
    snapshot JSONB NOT NULL)`);
}

/**
 * The run's own frozen `ob_raw_turns`, which is what carries a session ref.
 *
 * Two columns only, matching what `graduateRecurring` reads
 * (`turn.id`, `turn.session_ref`); the run schema's copy is preferred over
 * `public` by `turnsRelation`, so creating it here keeps every read the
 * graduation makes inside the schema the proof allocated.
 */
async function ensureFrozenTurns(pool: Pool, schema: string): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS ${schema}.ob_raw_turns (
    id UUID PRIMARY KEY,
    session_ref TEXT)`);
}

/** Plants one frozen turn per session ref and returns their ids. */
async function plantTurns(
  pool: Pool,
  schema: string,
  sessions: readonly string[],
): Promise<readonly string[]> {
  const ids: string[] = [];
  for (const session of sessions) {
    const turnId = randomUUID();
    await pool.query(
      `INSERT INTO ${schema}.ob_raw_turns (id, session_ref) VALUES ($1, $2)`,
      [turnId, session],
    );
    ids.push(turnId);
  }
  return ids;
}

function routingRunHeader(runId: string, records: number): RoutingRunRow {
  return {
    matrixFingerprint: `proof-${runId}`,
    classifierVersion: "proof",
    thresholds: {},
    backend: "fake",
    servedModels: ["proof"] as readonly string[],
    records,
    requests: 0,
    inputTokens: 0,
    estimatedUsd: 0,
    actualUsd: 0,
    ms: 0,
    note: "planted by a dream route proof",
  };
}

/**
 * Plants one whole routing run: cohort rows, decisions, verdicts, and signals.
 *
 * `writeRun` owns `routing_runs`, `routing_decisions`, and `would_apply`, so
 * the proof never writes those shapes itself. The cohort rows go in first
 * because the apply step joins them, and the signals last because they name
 * candidate ids.
 *
 * @param input - The pool, the run schema, the run id, and the candidates.
 * @returns One row per candidate, in planting order.
 */
export async function plantRun(input: PlantRunInput): Promise<readonly PlantedRow[]> {
  const { pool, schema, runId, candidates } = input;
  await ensureCohortTable(pool, schema);
  await ensureFrozenTurns(pool, schema);
  const planted: PlantedRow[] = [];
  // Ordinals continue from whatever the schema already holds: V4 plants two
  // routing runs into one schema, and `cohort.ordinal` is its primary key.
  const highest = await pool.query<{ n: number | null }>(
    `SELECT max(ordinal) AS n FROM ${schema}.cohort`,
  );
  let ordinal = (highest.rows[0]?.n ?? 0) + 1;
  for (const candidate of candidates) {
    const candidateId = randomUUID();
    const hash = contentHash(candidate.content);
    // A candidate with no sessions keeps the opaque placeholder V3 and V4
    // already use; one with sessions gets real turn ids it can be joined on.
    const turnIds =
      candidate.sessions === undefined
        ? [`proof-turn-${ordinal}`]
        : await plantTurns(pool, schema, candidate.sessions);
    await pool.query(
      `INSERT INTO ${schema}.cohort
         (ordinal, candidate_id, namespace, content_hash, source, neighbour_of,
          snapshot)
       VALUES ($1, $2, $3, $4, 'labelled', NULL, $5::jsonb)`,
      [
        ordinal,
        candidateId,
        PROOF_NAMESPACE,
        hash,
        JSON.stringify({
          id: candidateId,
          namespace: PROOF_NAMESPACE,
          content: candidate.content,
          content_hash: hash,
          source_turn_ids: turnIds,
        }),
      ],
    );
    planted.push({ label: candidate.label, candidateId, contentHash: hash });
    ordinal += 1;
  }
  const idByLabel = new Map(planted.map((row) => [row.label, row.candidateId]));
  const results: readonly RoutedResult[] = candidates.map((candidate, index) => {
    const candidateId = planted[index]?.candidateId ?? "";
    const reinforces =
      candidate.reinforces === undefined
        ? null
        : (idByLabel.get(candidate.reinforces) ?? null);
    return {
      candidateId,
      namespace: PROOF_NAMESPACE,
      decision: {
        candidateId,
        destination: candidate.destination ?? null,
        agreement: "none",
        authorityTier: candidate.authorityTier,
        restates: reinforces !== null,
        droveDecision: false,
        reasons: ["planted by a dream route proof"],
        raw: {},
      },
      resolved: {
        action: candidate.action,
        reinforces,
        reason: "planted by a dream route proof",
      },
      servedModel: "proof",
    };
  });
  await writeRun(pool, {
    schema,
    runId,
    run: routingRunHeader(runId, candidates.length),
    results,
  });
  const client = await pool.connect();
  try {
    await ensureApplyMirrors({ client, schema });
    await ensureSignalTables({ client, schema });
  } finally {
    client.release();
  }
  for (const [index, candidate] of candidates.entries()) {
    if (candidate.signal === undefined) continue;
    await plantSignal({
      client: pool,
      schema,
      runId,
      candidateId: planted[index]?.candidateId ?? "",
      signal: candidate.signal,
      targetScopeKey: candidate.targetScopeKey,
    });
  }
  return planted;
}

/** The running tally a proof's `check` calls build up. */
export interface Reporter {
  /** Records one assertion and prints its line. */
  readonly check: (name: string, ok: boolean, measured: string) => void;
  /** Prints `RESULT PASS|FAIL V<N>` and exits 0 or 1. */
  readonly finish: (proof: string) => never;
}

/**
 * The PASS/FAIL reporter every proof prints through.
 *
 * One line per assertion and one final `RESULT` line, because that is the
 * whole interface the checker reads; the exit code is 1 the moment anything
 * failed, so a proof cannot pass by printing well.
 *
 * @returns A `check` to call per assertion and a `finish` that exits.
 */
export function reporter(): Reporter {
  let failed = 0;
  return {
    check(name: string, ok: boolean, measured: string): void {
      if (!ok) failed += 1;
      process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}: ${measured}\n`);
    },
    finish(proof: string): never {
      process.stdout.write(`RESULT ${failed === 0 ? "PASS" : "FAIL"} ${proof}\n`);
      process.exit(failed === 0 ? 0 : 1);
    },
  };
}

/** Runs `applyRouting` on a checked-out client, releasing it either way. */
export async function onClient<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/** Counts rows in one run-schema table. */
export async function schemaCount(
  pool: Pool,
  schema: string,
  table: string,
): Promise<number> {
  const result = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${schema}.${table}`,
  );
  return Number(result.rows[0]?.n ?? 0);
}

/**
 * Row counts for EVERY table in a run schema, keyed by table name.
 *
 * V5 asserts idempotence over the whole schema rather than a named list,
 * because a list would silently stop covering a table added later -- the
 * assertion has to notice a write wherever it lands.
 *
 * @param pool - The proof pool.
 * @param schema - The allocated run schema.
 * @returns One count per base table, in name order.
 */
export async function schemaCounts(
  pool: Pool,
  schema: string,
): Promise<Record<string, number>> {
  const tables = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
    [schema],
  );
  const counts: Record<string, number> = {};
  for (const row of tables.rows) {
    counts[row.table_name] = await schemaCount(pool, schema, row.table_name);
  }
  return counts;
}

/** Counts the mirror thoughts one planted candidate produced. */
export async function mirroredThoughts(
  pool: Pool,
  schema: string,
  candidateId: string,
): Promise<number> {
  const result = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${schema}.thoughts
      WHERE promoted_from->>'candidate_id' = $1`,
    [candidateId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

/** Whether two public-count snapshots agree. */
export function countsEqual(before: PublicCounts, after: PublicCounts): boolean {
  return WATCHED_PUBLIC_TABLES.every((table) => before[table] === after[table]);
}

/** A one-line rendering of a public-count snapshot, for the measured column. */
export function renderCounts(counts: PublicCounts): string {
  return WATCHED_PUBLIC_TABLES.map((table) => `${table}=${counts[table]}`).join(" ");
}
