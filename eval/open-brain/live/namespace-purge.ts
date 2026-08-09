import type { Pool } from "pg";

/**
 * Prefix-guarded purge of a per-run throwaway eval namespace.
 *
 * WHY THIS EXISTS (issue #655)
 * ----------------------------
 * The scenario runner already tore down its RECORDS by exact id, but a record
 * teardown cannot remove a NAMESPACE, for two independent reasons observed live
 * in the dogfood database on 2026-08-08:
 *
 *   1. `archive_entry` is a SOFT delete -- it sets `archived_at` and leaves the
 *      row (src/tools/archive-entry.ts:54). Twenty-one `eval-live-recall-*`
 *      namespaces in the dogfood database hold nothing but archived rows: the
 *      teardown "succeeded" and the namespace is still there, permanently.
 *   2. When the archive call THROWS, the tally records `failed` and the row is
 *      left fully LIVE. Six `eval-live-recall-scenario-*` namespaces are in
 *      exactly that state (`archived_at IS NULL`), from receipts showing
 *      `attempted=1 archived=0 already_absent=0 failed=1`.
 *
 * A namespace in this schema is not a registry row -- there is no namespaces
 * table. It exists precisely as long as some row carries it. So removing the
 * namespace means removing its rows, which is a DELETE, not an archive.
 *
 * THE AUTHORITY THIS OPERATES UNDER, AND ITS EXACT BOUNDS
 * ------------------------------------------------------
 * `docs/issue-graph.md` ledger item 20 (operator ruling, 2026-08-08) permits a
 * process to auto-remove a resource on exit ONLY when all three hold. This
 * function is written so that each one is a structural property, not a promise:
 *
 *   (1) SELF-CREATED THIS RUN -- the namespace is derived from a per-invocation
 *       crypto nonce (`makeRunId`, eval/open-brain/live/config.ts), so no other
 *       run and no human namespace can collide with it.
 *   (2) PREFIX-GUARDED -- `assertPurgeableNamespace` REFUSES any name outside
 *       the eval prefix, before a single statement runs. The guard is the first
 *       thing this module does and it throws rather than returning a tally, so
 *       a caller cannot mistake a refusal for a clean purge.
 *   (3) SESSION-SCOPED THROWAWAY -- the content is fixture text seeded by the
 *       scenario suite seconds earlier.
 *
 * Everywhere outside those bounds, the repo's printed-never-executed teardown
 * rule stands unchanged. Nothing here reads an operator-supplied namespace, and
 * nothing here can widen its own scope: the prefix is a module constant, not a
 * parameter.
 */

/**
 * The one prefix this module may ever touch. A constant, deliberately NOT a
 * parameter: a caller-supplied prefix would make the guard a formality the
 * caller could dial open, which is the failure mode ledger item 20 was ratified
 * to prevent. `runNamespaces` (config.ts) builds every eval namespace from this
 * same literal, so widening one without the other breaks the tests in
 * `__tests__/namespace-purge.test.ts` rather than silently unguarding a purge.
 */
export const EVAL_NAMESPACE_PREFIX = "eval-live-recall-";

/**
 * Tables whose rows carry a `namespace` column and are seeded by the live eval
 * suites. Ordered children-before-parents so a delete never trips a foreign key.
 * Enumerated explicitly rather than discovered from `information_schema`: a
 * discovered list would silently grow to cover tables this module was never
 * reviewed against, which is the same class of quiet scope-widening the prefix
 * guard exists to stop.
 */
const PURGE_TABLES = [
  "ob_session_lanes",
  "thoughts",
  "decisions",
  "sessions",
  "relationships",
  "projects",
  "candidate_memory",
  "candidate_grade",
  "candidate_reinforcement",
  "content_occurrences",
  "discarded_entries",
  "ob_entities",
  "ob_links",
  "ob_raw_turns",
] as const;

export interface NamespacePurgeResult {
  namespace: string;
  /** Rows removed, per table, for tables that actually had any. */
  deleted_by_table: Record<string, number>;
  /** Total rows removed across every table. */
  deleted: number;
  /** Tables that could not be purged, by name, with a content-free reason. */
  failed_tables: Record<string, string>;
}

export class NamespacePurgeRefused extends Error {
  constructor(readonly namespace: string) {
    // Content-free: names the rule and the length of the offending value, never
    // the value itself, which may be an operator's real namespace.
    super(
      `namespace purge REFUSED: a name of length ${namespace.length} does not start with the required "${EVAL_NAMESPACE_PREFIX}" prefix; this purge may only remove namespaces it created`,
    );
    this.name = "NamespacePurgeRefused";
  }
}

/**
 * The guard. Throws `NamespacePurgeRefused` for anything outside the eval
 * prefix. Exported so the mutation proof can call it directly: a guard that is
 * only reachable behind a live database connection cannot be tested cheaply,
 * and an untested guard is the one that is wrong.
 *
 * Rejects the bare prefix itself (`eval-live-recall-`) as well: that is not a
 * name any run produces (`runNamespaces` always appends a nonce), so accepting
 * it would mean accepting a name this process did not create.
 */
export function assertPurgeableNamespace(namespace: string): void {
  if (
    typeof namespace !== "string" ||
    !namespace.startsWith(EVAL_NAMESPACE_PREFIX) ||
    namespace.length <= EVAL_NAMESPACE_PREFIX.length
  ) {
    throw new NamespacePurgeRefused(String(namespace));
  }
}

/**
 * Remove every row carrying `namespace`, after the prefix guard passes.
 *
 * The guard runs BEFORE any statement, so a refused call is provably a no-op
 * against the database. Each table is attempted independently and a failure is
 * recorded rather than thrown, because a partially-purged namespace still needs
 * its tally reported -- silently swallowing the rest would rebuild the exact
 * defect #655 is about.
 *
 * Session events are removed via their lane: `ob_session_events` has no
 * `namespace` column, and `ob_session_lanes` cascades. The lane delete is
 * therefore listed first and does that work.
 */
export async function purgeNamespace(
  pool: Pool,
  namespace: string,
): Promise<NamespacePurgeResult> {
  assertPurgeableNamespace(namespace);

  const deletedByTable: Record<string, number> = {};
  const failedTables: Record<string, string> = {};
  let deleted = 0;

  for (const table of PURGE_TABLES) {
    try {
      // Table name comes from the module-local const tuple above -- never from
      // a caller, a request, or the database -- so interpolating it introduces
      // no injection surface. The namespace is parameterized.
      const result = await pool.query(
        `DELETE FROM ${table} WHERE namespace = $1`,
        [namespace],
      );
      const count = result.rowCount ?? 0;
      if (count > 0) {
        deletedByTable[table] = count;
        deleted += count;
      }
    } catch (error: unknown) {
      // Content-free: the error class, never the driver's message, which can
      // echo row content back into a receipt.
      failedTables[table] =
        error instanceof Error ? error.constructor.name : "unknown";
    }
  }

  return { namespace, deleted_by_table: deletedByTable, deleted, failed_tables: failedTables };
}

/**
 * Count rows still carrying `namespace`, per table -- the DB-queryable truth a
 * teardown verdict is allowed to rest on (issue #671).
 *
 * WHY THIS LIVES HERE AND NOT IN THE TRANSPORT
 * --------------------------------------------
 * It reads the SAME `PURGE_TABLES` tuple the purge writes. A separately
 * maintained residue table list would drift the moment either side gained a
 * table, and the drift's failure mode is silent and green: a table the purge
 * stopped clearing would also stop being counted, so the residue verdict would
 * report clean over exactly the rows it exists to find. One list, two readers.
 *
 * NOT prefix-guarded, deliberately: this only ever runs `SELECT count(*)`, so
 * there is nothing for a guard to protect. Guarding it would also make it
 * useless for the one job it has -- proving, from outside, that a name was
 * cleaned.
 *
 * A table that cannot be read is recorded in `unreadable_tables` and is NOT
 * silently treated as zero: a residue reading is only load-bearing if it can
 * say which tables it actually managed to read.
 */
export interface NamespaceResidueResult {
  namespace: string;
  /** Rows remaining, per table, only for tables that had any. */
  rows_by_table: Record<string, number>;
  /** Total rows remaining across every table that could be read. */
  rows: number;
  /** Tables whose count could not be read, by name, with a content-free reason. */
  unreadable_tables: Record<string, string>;
}

export async function countNamespaceResidue(
  pool: Pool,
  namespace: string,
): Promise<NamespaceResidueResult> {
  const rowsByTable: Record<string, number> = {};
  const unreadableTables: Record<string, string> = {};
  let rows = 0;

  for (const table of PURGE_TABLES) {
    try {
      // Same interpolation argument as `purgeNamespace`: the table name comes
      // from the module-local const tuple, never from a caller. The namespace
      // is parameterized.
      const result = await pool.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE namespace = $1`,
        [namespace],
      );
      const count = Number(result.rows[0]?.n ?? 0);
      if (count > 0) {
        rowsByTable[table] = count;
        rows += count;
      }
    } catch (error: unknown) {
      unreadableTables[table] =
        error instanceof Error ? error.constructor.name : "unknown";
    }
  }

  return {
    namespace,
    rows_by_table: rowsByTable,
    rows,
    unreadable_tables: unreadableTables,
  };
}
