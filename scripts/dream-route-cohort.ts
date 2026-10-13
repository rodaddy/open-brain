#!/usr/bin/env node
/**
 * DREAM route cohort freezer: a stratified, seeded sample of
 * `public.candidate_memory` frozen into a disposable `dream_run_NNN` schema.
 *
 * Sibling of `scripts/rem-ethereal-cohort.ts`, which freezes exactly 50 rows for
 * REM grading. This one freezes a FRACTION, stratified by
 * `(candidate_type, anchor_kind)`, and pulls in embedding neighbours so the
 * cohort carries the local semantic structure the DREAM route has to reason
 * over. It reuses that module's `nextSchema` allocator and
 * `assertDreamRunSchema` guard rather than restating either.
 *
 * It READS `public.candidate_memory` and WRITES only inside the new schema, in
 * ONE transaction: a failure anywhere leaves no schema behind.
 */
import type { Pool, PoolClient } from "pg";
import { createPool } from "./settings.ts";
import {
  assertNotLiveDatabase,
  resolvedDatabaseName,
} from "./dream-route-live-guard.ts";
import { assertDreamRunSchema, nextSchema } from "./rem-ethereal-cohort.ts";
import {
  DREAM_ROUTE_SELECTION_VERSION,
  cohortCounts,
  cohortDigest,
  mergeByPrecedence,
  parseDreamRouteArgs,
  stratumShare,
  type CandidateRow,
  type CandidateSnapshot,
  type CohortCounts,
  type CohortMember,
  type DreamRouteCohortOptions,
  type FrozenRow,
  type NeighboursFor,
  type StratumShare,
} from "./dream-route-selection.ts";

export * from "./dream-route-selection.ts";

export interface DreamRouteCohort {
  schema: string;
  namespace: string;
  digest: string;
  cohortCount: number;
  counts: CohortCounts;
  /** Rows the draw produced, before neighbours and labels joined them. */
  drawnCount: number;
  neighboursFor: NeighboursFor;
  teardown: string;
}

function toSnapshot(row: CandidateRow): CandidateSnapshot {
  return {
    id: row.id,
    namespace: row.namespace,
    candidate_type: row.candidate_type,
    content: row.content,
    content_hash: row.content_hash,
    operator_text: row.operator_text,
    unit_kind: row.unit_kind,
    anchor_kind: row.anchor_kind,
    first_said_at: row.first_said_at?.toISOString() ?? null,
    last_said_at: row.last_said_at?.toISOString() ?? null,
    source_turn_ids: row.source_turn_ids,
  };
}

async function readStrata(
  client: PoolClient,
  options: DreamRouteCohortOptions,
): Promise<StratumShare[]> {
  const result = await client.query<{
    candidate_type: string;
    anchor_kind: string;
    count: string;
  }>(
    `SELECT candidate_type, coalesce(anchor_kind, 'none') AS anchor_kind,
            count(*)::text AS count
       FROM public.candidate_memory
      WHERE namespace = $1 AND parent_id IS NULL AND embedding IS NOT NULL
      GROUP BY 1, 2
      ORDER BY 1, 2`,
    [options.namespace],
  );
  return result.rows.map((row) => {
    const count = Number(row.count);
    return {
      candidateType: row.candidate_type,
      anchorKind: row.anchor_kind,
      count,
      share: stratumShare(count, options.fraction),
    };
  });
}

/**
 * The SQL predicate naming operator-sourced rows, and its bind parameters.
 *
 * The same rule as `server/domain/dream-route/authority.ts`'s `decided` tier,
 * written in SQL because scripts/ never imports server/ domain code. `all`
 * yields `TRUE`, which every drawn row satisfies.
 *
 * @param mode - The parsed `--neighbours-for` value.
 * @param firstParam - The 1-based index of the first free bind parameter.
 * @returns The predicate text and the values it binds, in order.
 */
function decidedPredicate(
  mode: DreamRouteCohortOptions["neighboursFor"],
  firstParam: number,
): { sql: string; params: string[] } {
  if (mode === "all") return { sql: "TRUE", params: [] };
  return {
    sql: `unit_kind = $${firstParam} AND anchor_kind = ANY ($${firstParam + 1}::text[])`,
    params: ["exchange", "{typed,askuserquestion}"],
  };
}

/**
 * Which of the drawn rows the neighbour pass runs for.
 *
 * @param client - A client inside the freeze transaction.
 * @param options - Parsed CLI options.
 * @param drawn - Every drawn candidate id, in draw order.
 * @returns The subset to search neighbours for, in draw order.
 */
async function neighbourAnchors(
  client: PoolClient,
  options: DreamRouteCohortOptions,
  drawn: readonly string[],
): Promise<string[]> {
  if (options.neighboursFor === "all" || drawn.length === 0) return [...drawn];
  const predicate = decidedPredicate(options.neighboursFor, 2);
  const result = await client.query<{ id: string }>(
    `SELECT id FROM public.candidate_memory
      WHERE id = ANY ($1::uuid[]) AND ${predicate.sql}`,
    [drawn, ...predicate.params],
  );
  const decided = new Set(result.rows.map((row) => row.id));
  return drawn.filter((id) => decided.has(id));
}

async function drawStratum(
  client: PoolClient,
  options: DreamRouteCohortOptions,
  stratum: StratumShare,
): Promise<string[]> {
  if (stratum.share === 0) return [];
  const result = await client.query<{ id: string }>(
    `SELECT id
       FROM public.candidate_memory
      WHERE namespace = $1 AND parent_id IS NULL AND embedding IS NOT NULL
        AND candidate_type = $2 AND coalesce(anchor_kind, 'none') = $3
      ORDER BY md5(id::text || $4), id
      LIMIT $5`,
    [
      options.namespace,
      stratum.candidateType,
      stratum.anchorKind,
      options.seed,
      stratum.share,
    ],
  );
  return result.rows.map((row) => row.id);
}

async function readNeighbours(
  client: PoolClient,
  options: DreamRouteCohortOptions,
  drawnId: string,
  excluded: readonly string[],
): Promise<string[]> {
  if (options.neighbours === 0) return [];
  const result = await client.query<{ id: string }>(
    `SELECT candidate.id
       FROM public.candidate_memory AS candidate,
            (SELECT embedding FROM public.candidate_memory WHERE id = $1) AS anchor
      WHERE candidate.namespace = $2
        AND candidate.parent_id IS NULL
        AND candidate.embedding IS NOT NULL
        AND candidate.id <> $1
        AND NOT (candidate.id = ANY ($3::uuid[]))
        AND (candidate.embedding <=> anchor.embedding) <= $4
      ORDER BY candidate.embedding <=> anchor.embedding, candidate.id
      LIMIT $5`,
    [drawnId, options.namespace, excluded, options.maxDistance, options.neighbours],
  );
  return result.rows.map((row) => row.id);
}

async function readLabelled(
  client: PoolClient,
  options: DreamRouteCohortOptions,
): Promise<string[]> {
  if (options.labels === undefined) return [];
  assertDreamRunSchema(options.labels);
  const result = await client.query<{ candidate_id: string }>(
    `SELECT labelled.candidate_id
       FROM ${options.labels}.cohort AS labelled
       JOIN public.candidate_memory AS candidate
         ON candidate.id = labelled.candidate_id
      WHERE candidate.namespace = $1
        AND candidate.parent_id IS NULL
        AND candidate.embedding IS NOT NULL
      ORDER BY labelled.candidate_id`,
    [options.namespace],
  );
  return result.rows.map((row) => row.candidate_id);
}

interface CollectedMembers {
  members: CohortMember[];
  drawnCount: number;
  neighbourAnchorCount: number;
}

async function collectMembers(
  client: PoolClient,
  options: DreamRouteCohortOptions,
  strata: readonly StratumShare[],
): Promise<CollectedMembers> {
  const members: CohortMember[] = [];
  const drawn: string[] = [];
  for (const stratum of strata) {
    for (const id of await drawStratum(client, options, stratum)) {
      drawn.push(id);
      members.push({ candidateId: id, source: "draw", neighbourOf: null });
    }
  }
  const anchors = await neighbourAnchors(client, options, drawn);
  const seen = new Set(drawn);
  for (const drawnId of anchors) {
    const neighbours = await readNeighbours(client, options, drawnId, [...seen]);
    for (const id of neighbours) {
      seen.add(id);
      members.push({ candidateId: id, source: "neighbour", neighbourOf: drawnId });
    }
  }
  for (const id of await readLabelled(client, options)) {
    members.push({ candidateId: id, source: "labelled", neighbourOf: null });
  }
  return { members, drawnCount: drawn.length, neighbourAnchorCount: anchors.length };
}

async function readSnapshots(
  client: PoolClient,
  namespace: string,
  ids: readonly string[],
): Promise<Map<string, CandidateSnapshot>> {
  if (ids.length === 0) return new Map();
  const result = await client.query<CandidateRow>(
    `SELECT id, namespace, candidate_type, content, content_hash, operator_text,
            unit_kind, anchor_kind, first_said_at, last_said_at, source_turn_ids
       FROM public.candidate_memory
      WHERE namespace = $1 AND id = ANY ($2::uuid[])`,
    [namespace, ids],
  );
  return new Map(result.rows.map((row) => [row.id, toSnapshot(row)]));
}

async function createDreamRouteTables(
  client: PoolClient,
  schema: string,
): Promise<void> {
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`CREATE TABLE ${schema}.manifest (
    run_id TEXT PRIMARY KEY, namespace TEXT NOT NULL, selection_version TEXT NOT NULL,
    source_identity JSONB NOT NULL, cohort_count INTEGER NOT NULL,
    counts JSONB NOT NULL, cohort_digest TEXT NOT NULL, note TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await client.query(`CREATE TABLE ${schema}.cohort (
    ordinal INTEGER PRIMARY KEY CHECK (ordinal > 0),
    candidate_id UUID NOT NULL UNIQUE, namespace TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('draw', 'neighbour', 'labelled')),
    neighbour_of UUID,
    CHECK ((source = 'neighbour') = (neighbour_of IS NOT NULL)),
    snapshot JSONB NOT NULL)`);
}

/**
 * Freezes a DREAM route cohort into a fresh `dream_run_NNN` schema.
 *
 * Reads `public.candidate_memory` within the one namespace and writes only
 * inside the new schema, in a single transaction. On any error the transaction
 * rolls back and no schema is left behind.
 *
 * @param pool - A pool for the test or target database. Never the dogfood one.
 * @param options - Parsed CLI options.
 * @returns The schema name, counts, digest, and the exact teardown command.
 */
export async function freezeDreamRouteCohort(
  pool: Pool,
  options: DreamRouteCohortOptions,
): Promise<DreamRouteCohort> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const schema = await nextSchema(client);
    const strata = await readStrata(client, options);
    const collected = await collectMembers(client, options, strata);
    const merged = mergeByPrecedence(collected.members);
    const snapshots = await readSnapshots(
      client,
      options.namespace,
      merged.map((member) => member.candidateId),
    );
    const rows: FrozenRow[] = merged.map((member, index) => {
      const snapshot = snapshots.get(member.candidateId);
      if (snapshot === undefined) {
        throw new Error(`cohort member vanished before freeze: ${member.candidateId}`);
      }
      return {
        ordinal: index + 1,
        candidateId: member.candidateId,
        namespace: snapshot.namespace,
        contentHash: snapshot.content_hash,
        source: member.source,
        neighbourOf: member.neighbourOf,
        snapshot,
      };
    });
    const digest = cohortDigest(rows);
    const counts = cohortCounts(rows, strata, collected.neighbourAnchorCount);
    const database = await client.query<{ database: string }>(
      "SELECT current_database() AS database",
    );
    const sourceIdentity = {
      database: database.rows[0]?.database ?? null,
      table: "public.candidate_memory",
      namespace: options.namespace,
      fraction: options.fraction,
      seed: options.seed,
      neighbours: options.neighbours,
      neighbours_for: options.neighboursFor,
      max_distance: options.maxDistance,
      labels: options.labels ?? null,
    };

    await createDreamRouteTables(client, schema);
    for (const row of rows) {
      await client.query(
        `INSERT INTO ${schema}.cohort
           (ordinal, candidate_id, namespace, content_hash, source, neighbour_of, snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [
          row.ordinal,
          row.candidateId,
          row.namespace,
          row.contentHash,
          row.source,
          row.neighbourOf,
          JSON.stringify(row.snapshot),
        ],
      );
    }
    await client.query(
      `INSERT INTO ${schema}.manifest
         (run_id, namespace, selection_version, source_identity, cohort_count,
          counts, cohort_digest, note)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,$8)`,
      [
        schema,
        options.namespace,
        DREAM_ROUTE_SELECTION_VERSION,
        JSON.stringify(sourceIdentity),
        rows.length,
        JSON.stringify(counts),
        digest,
        options.note,
      ],
    );
    await client.query("COMMIT");
    return {
      schema,
      namespace: options.namespace,
      digest,
      cohortCount: rows.length,
      counts,
      drawnCount: collected.drawnCount,
      neighboursFor: options.neighboursFor,
      teardown: teardownCommand(schema),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The exact teardown line for a frozen cohort.
 *
 * @param schema - A `dream_run_NNN` schema name.
 * @returns The command to paste, using the existing `--drop` path.
 */
export function teardownCommand(schema: string): string {
  assertDreamRunSchema(schema);
  return `node --env-file=.env scripts/rem-ethereal-run.ts --drop ${schema}`;
}

/**
 * Renders the frozen cohort as the operator-facing report.
 *
 * @param cohort - The result of `freezeDreamRouteCohort`.
 * @returns The report lines, ending with the exact teardown command.
 */
export function formatCohortReport(cohort: DreamRouteCohort): string[] {
  return [
    `schema        : ${cohort.schema}`,
    `namespace     : ${cohort.namespace}`,
    `cohort count  : ${cohort.cohortCount}`,
    `draw          : ${cohort.counts.draw}`,
    `neighbour     : ${cohort.counts.neighbour}`,
    `labelled      : ${cohort.counts.labelled}`,
    `neighbours searched for: ${cohort.counts.neighbour_anchors} of ` +
      `${cohort.drawnCount} drawn rows (${cohort.neighboursFor})`,
    ...Object.entries(cohort.counts.strata).map(
      ([stratum, drawn]) => `stratum ${stratum} : ${drawn}`,
    ),
    `cohort digest : ${cohort.digest}`,
    `teardown      : ${cohort.teardown}`,
  ];
}

export interface MainDeps {
  createPool: () => Pool;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  deps: MainDeps = { createPool },
): Promise<void> {
  // Every argument is validated before a pool is constructed.
  const options = parseDreamRouteArgs(argv);
  const databaseName = resolvedDatabaseName(process.env);
  assertNotLiveDatabase({ databaseName, allowLive: options.allowLiveDb });
  const pool = deps.createPool();
  try {
    const cohort = await freezeDreamRouteCohort(pool, options);
    for (const line of formatCohortReport(cohort)) console.log(line);
  } finally {
    await pool.end();
  }
}

if (import.meta.main) await main();
