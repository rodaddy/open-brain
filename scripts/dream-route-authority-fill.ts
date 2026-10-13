#!/usr/bin/env node
/**
 * Fills `public.candidate_memory.authority_tier` from the SOURCE, no model.
 *
 * R3 authority is a provenance lookup, not a judgement
 * (`docs/code-brain-design.md:125-150`, `_plans/1469-dream-route.md:62-63`):
 * an operator-anchored exchange is `decided`, everything else is `observed`.
 * Nothing here ever writes `canon` -- canon comes from an epic, an issue, or a
 * ratified decision doc, none of which this table's provenance can name.
 *
 * The rule itself is `server/domain/dream-route/authority.ts`. It takes a
 * `RouteCandidate` object, so applying it row-by-row would mean reading
 * 287,471 rows into the process to write a two-value column back. The same
 * rule is therefore expressed once in SQL, exactly as
 * `scripts/dream-route-cohort.ts:decidedPredicate` already does for the cohort
 * draw, and `authority.test.ts` plus this script's pg test hold the two forms
 * to the same answers.
 *
 * Only rows where `authority_tier IS NULL` are touched: NULL means
 * unclassified (033:98-101), and a row that already carries a tier was set by
 * someone with more information than a backfill has. That is also what makes a
 * second run a no-op.
 */
import type { Pool, PoolClient } from "pg";
import { createPool } from "./settings.ts";

/**
 * The SQL predicate naming an operator-anchored exchange.
 *
 * The `decided` half of `authorityTierOf`
 * (`server/domain/dream-route/authority.ts:13-16`): `unit_kind = 'exchange'`
 * (041:70-77) AND `anchor_kind` in the two operator-authored values
 * (043:34-42). `orphan` and NULL are not the operator, so they fall through to
 * `observed`.
 */
const DECIDED_PREDICATE =
  "unit_kind = 'exchange' AND anchor_kind = ANY (ARRAY['typed','askuserquestion']::text[])";

export interface AuthorityFillCounts {
  /** Rows set to `decided` by this run. */
  decided: number;
  /** Rows set to `observed` by this run. */
  observed: number;
  /** Rows left alone because they already carried a tier. */
  alreadySet: number;
}

interface FillScope {
  /** One namespace to fill. `null` fills every namespace. */
  namespace: string | null;
}

/**
 * Counts rows that already carry a tier, so the report can say what it skipped.
 *
 * @param client - A client inside the fill transaction.
 * @param scope - Which namespace the fill covers.
 * @returns The tally of non-NULL `authority_tier` rows in scope.
 */
async function countAlreadySet(client: PoolClient, scope: FillScope): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM public.candidate_memory
      WHERE authority_tier IS NOT NULL
        AND ($1::text IS NULL OR namespace = $1)`,
    [scope.namespace],
  );
  return Number(result.rows[0]?.count ?? "0");
}

/**
 * Sets one tier over the unclassified rows the predicate selects.
 *
 * @param client - A client inside the fill transaction.
 * @param scope - Which namespace the fill covers.
 * @param tier - The value to write: `decided` or `observed`.
 * @param predicate - The SQL naming which unclassified rows get that value.
 * @returns The tally of rows the update changed.
 */
async function setTier(
  client: PoolClient,
  scope: FillScope,
  tier: "decided" | "observed",
  predicate: string,
): Promise<number> {
  const result = await client.query(
    `UPDATE public.candidate_memory
        SET authority_tier = $1
      WHERE authority_tier IS NULL
        AND ($2::text IS NULL OR namespace = $2)
        AND (${predicate})`,
    [tier, scope.namespace],
  );
  return result.rowCount ?? 0;
}

/**
 * Fills every unclassified `authority_tier` in one transaction.
 *
 * Reads and writes `public.candidate_memory` and nothing else. Re-running it
 * changes no rows, because the first run leaves no NULL tier behind in scope.
 *
 * @param pool - A pool for the target database. Never the dogfood one.
 * @param scope - Which namespace the fill covers; `null` covers all of them.
 * @returns What the run set and what it left alone.
 */
export async function fillAuthorityTiers(
  pool: Pool,
  scope: FillScope = { namespace: null },
): Promise<AuthorityFillCounts> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const alreadySet = await countAlreadySet(client, scope);
    const decided = await setTier(client, scope, "decided", DECIDED_PREDICATE);
    const observed = await setTier(
      client,
      scope,
      "observed",
      `NOT (${DECIDED_PREDICATE})`,
    );
    await client.query("COMMIT");
    return { decided, observed, alreadySet };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Parses the one optional argument this script takes.
 *
 * @param argv - Arguments after the script path.
 * @returns The namespace scope the fill runs under.
 * @throws {Error} When an unknown flag or a bare argument is given.
 */
export function parseAuthorityFillArgs(argv: readonly string[]): FillScope {
  let namespace: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--namespace") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--namespace needs a value");
      }
      namespace = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { namespace };
}

/**
 * Renders the run as the operator-facing report.
 *
 * @param database - The database the fill ran against.
 * @param counts - What the fill did.
 * @returns The report lines, database first.
 */
export function formatFillReport(
  database: string,
  counts: AuthorityFillCounts,
): string[] {
  return [
    `database      : ${database}`,
    `decided       : ${counts.decided}`,
    `observed      : ${counts.observed}`,
    `already set   : ${counts.alreadySet}`,
  ];
}

export interface MainDeps {
  createPool: () => Pool;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  deps: MainDeps = { createPool },
): Promise<void> {
  // Arguments are validated before a pool is constructed.
  const scope = parseAuthorityFillArgs(argv);
  const pool = deps.createPool();
  try {
    const named = await pool.query<{ database: string }>(
      "SELECT current_database() AS database",
    );
    const database = named.rows[0]?.database ?? "<unknown>";
    console.log(`database      : ${database}`);
    const counts = await fillAuthorityTiers(pool, scope);
    for (const line of formatFillReport(database, counts).slice(1)) {
      console.log(line);
    }
  } finally {
    await pool.end();
  }
}

if (import.meta.main) await main();
