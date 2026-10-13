/**
 * Owns the statements the REST promotion routes and the promotion, namespace
 * scan, and curation tools execute.
 *
 * It exists so the transport and tools tiers hold no SQL text: rest-promotion,
 * server/tools/promotion.ts, server/tools/scan-namespace.ts and
 * server/tools/curation.ts take this port instead of a Pool (issue 1209).
 * Design authority:
 * `_plans/463-server-rewrite-charter.md` reserves raw SQL for server/db
 * repositories.
 *
 * The four the transport round moved, each named by a token that appears in it
 * alone:
 *   1. selectDemotionSource ... `promoted_from`
 *   2. archiveEntry ........... `SET archived_at = NOW()`
 *   3. findDuplicateInTarget .. `content_hash = $1 AND namespace = $2`
 *   4. scanNominations ........ `ORDER BY t.created_at DESC`
 *
 * The seven the tools round added:
 *   5. countNamespaceRows ..... `GROUP BY namespace`
 *   6. selectPromotionSource .. `tags, extracted_metadata`
 *   7. scanNominatedRows ...... the tool scan projection, `AS metadata`
 *   8. archiveRow ............. curation's archive under a write predicate
 *   9. runScan ................ curation's three caller-built scan statements
 *  10. archiveEntryReturningId. `RETURNING id`
 *  11. rateEntry ............. `usefulness_score = $1`
 *
 * `scan_namespace`'s duplicate lookup is textually identical to (3), so that
 * tool calls `findDuplicateInTarget` rather than adding a second copy.
 *
 * The SQL moved verbatim, placeholders and parameter order unchanged. The
 * scan statement's `metadataSelect` and `nominationFilter` fragments come from
 * `server/domain/promotion-nomination.ts`, which moved with them.
 */
import type { QuerySurface } from "./transaction.ts";
import type { Table } from "../types.ts";

/** The demotion source row, as the demote SELECT projects it. */
export interface DemotionSourceRow {
  id: string;
  namespace: string;
  promoted_from: {
    source_id?: string;
    source_namespace?: string;
  } | null;
}

/** One scan row, as the scan query projects it. */
export interface PromotionScanRow {
  id: string;
  content_hash: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

/** One rated entry, as `rate_entry`'s RETURNING clause projects it. */
export interface RatedEntryRow {
  id: string;
  usefulness_score: number;
}

/** The id of an existing target-namespace entry. */
export interface DuplicateIdRow {
  id: string;
}

export interface PromotionRepository {
  /**
   * One table's live entry counts per namespace, under the caller's read
   * predicate, most entries first.
   */
  countNamespaceRows(values: {
    table: Table;
    predicateClause: string;
    params: unknown[];
  }): Promise<Record<string, unknown>[]>;

  /**
   * The `promote_shared` source row: the unarchived entry by id, under the
   * caller's read predicate. `contentColumns` is chosen by a validated table
   * branch, never from caller text.
   */
  selectPromotionSource(values: {
    table: Table;
    contentColumns: string;
    predicateClause: string;
    params: unknown[];
  }): Promise<Record<string, unknown>[]>;

  /** `scan_namespace`'s nominated-row projection for one table, newest first. */
  scanNominatedRows(values: {
    table: Table;
    metadataSelect: string;
    nominationFilter: string;
    sinceFilter: string;
    params: unknown[];
  }): Promise<Record<string, unknown>[]>;

  /** Curation's archive of one row under the caller's write predicate. */
  archiveRow(values: {
    table: Table;
    predicateClause: string;
    params: unknown[];
  }): Promise<void>;

  /**
   * Curation's three scan modes, whose SQL its own helpers assemble from
   * validated table names and predicate fragments. This method executes the
   * assembled text and decides nothing about it.
   */
  runScan(values: {
    text: string;
    params: unknown[];
  }): Promise<Record<string, unknown>[]>;

  /**
   * `archive_entry`: stamps `archived_at` under the caller's delete predicate
   * and reports the archived id, or no rows when nothing matched.
   */
  archiveEntryReturningId(values: {
    table: Table;
    predicateClause: string;
    params: unknown[];
  }): Promise<DuplicateIdRow[]>;

  /** `rate_entry`: sets the usefulness score under the caller's write predicate. */
  rateEntry(values: {
    table: Table;
    predicateClause: string;
    params: unknown[];
  }): Promise<RatedEntryRow[]>;

  /**
   * The demote route's source lookup: the unarchived entry by id, under the
   * caller's read predicate.
   */
  selectDemotionSource(values: {
    table: Table;
    readPredicate: string;
    params: unknown[];
  }): Promise<DemotionSourceRow[]>;

  /**
   * The demote route's archive: stamps `archived_at` under the caller's write
   * predicate. Returns the affected row count, 0 when nothing matched.
   */
  archiveEntry(values: {
    table: Table;
    writePredicate: string;
    params: unknown[];
  }): Promise<number>;

  /**
   * Looks up an existing unarchived entry with the same content hash in the
   * target namespace. At most one row.
   */
  findDuplicateInTarget(values: {
    table: Table;
    contentHash: string;
    targetNamespace: string;
  }): Promise<DuplicateIdRow[]>;

  /**
   * The scan projection: one table's unarchived nominations in the source
   * namespace, newest first.
   */
  scanNominations(values: {
    table: Table;
    metadataSelect: string;
    nominationFilter: string;
    sinceFilter: string;
    params: unknown[];
  }): Promise<PromotionScanRow[]>;
}

/** The subset of the port the tools round added, split out for readability. */
type ToolStatements = Pick<
  PromotionRepository,
  | "countNamespaceRows"
  | "selectPromotionSource"
  | "scanNominatedRows"
  | "archiveRow"
  | "runScan"
  | "archiveEntryReturningId"
  | "rateEntry"
>;

function toolStatements(pool: QuerySurface): ToolStatements {
  return {
    async countNamespaceRows({ table, predicateClause, params }) {
      const { rows } = await pool.query(
        `SELECT '${table}' AS table_name, namespace, COUNT(*) AS count
           FROM ${table}
          WHERE archived_at IS NULL${predicateClause}
          GROUP BY namespace
          ORDER BY count DESC`,
        params,
      );
      return rows;
    },

    async selectPromotionSource({ table, contentColumns, predicateClause, params }) {
      const { rows } = await pool.query(
        `SELECT id, ${contentColumns}, tags, extracted_metadata
       FROM ${table}
      WHERE id = $1 AND archived_at IS NULL${predicateClause}`,
        params,
      );
      return rows;
    },

    async scanNominatedRows({
      table,
      metadataSelect,
      nominationFilter,
      sinceFilter,
      params,
    }) {
      const { rows } = await pool.query(
        `SELECT t.id, t.content_hash, t.namespace, t.created_at,
            ${metadataSelect} AS metadata
       FROM ${table} t
      WHERE t.namespace = $1
        AND t.archived_at IS NULL${nominationFilter}${sinceFilter}
      ORDER BY t.created_at DESC
      LIMIT $2`,
        params,
      );
      return rows;
    },

    async archiveRow({ table, predicateClause, params }) {
      await pool.query(
        `UPDATE ${table} SET archived_at = NOW() WHERE id = $1 AND archived_at IS NULL${predicateClause}`,
        params,
      );
    },

    async runScan({ text, params }) {
      const { rows } = await pool.query(text, params);
      return rows;
    },

    async archiveEntryReturningId({ table, predicateClause, params }) {
      const { rows } = await pool.query<DuplicateIdRow>(
        `UPDATE ${table} SET archived_at = NOW()
          WHERE id = $1 AND archived_at IS NULL${predicateClause}
        RETURNING id`,
        params,
      );
      return rows;
    },

    async rateEntry({ table, predicateClause, params }) {
      const { rows } = await pool.query<RatedEntryRow>(
        `UPDATE ${table} SET usefulness_score = $1
          WHERE id = $2 AND archived_at IS NULL${predicateClause}
        RETURNING id, usefulness_score`,
        params,
      );
      return rows;
    },
  };
}

export function createPromotionRepository(pool: QuerySurface): PromotionRepository {
  return {
    ...toolStatements(pool),

    async selectDemotionSource({ table, readPredicate, params }) {
      const { rows } = await pool.query<DemotionSourceRow>(
        `SELECT id, namespace, promoted_from FROM ${table} WHERE id = $1 AND archived_at IS NULL${readPredicate}`,
        params,
      );
      return rows;
    },

    async archiveEntry({ table, writePredicate, params }) {
      const { rowCount } = await pool.query(
        `UPDATE ${table} SET archived_at = NOW() WHERE id = $1${writePredicate}`,
        params,
      );
      return rowCount ?? 0;
    },

    async findDuplicateInTarget({ table, contentHash, targetNamespace }) {
      const { rows } = await pool.query<DuplicateIdRow>(
        `SELECT id FROM ${table}
             WHERE content_hash = $1 AND namespace = $2 AND archived_at IS NULL
             LIMIT 1`,
        [contentHash, targetNamespace],
      );
      return rows;
    },

    async scanNominations({
      table,
      metadataSelect,
      nominationFilter,
      sinceFilter,
      params,
    }) {
      const { rows } = await pool.query<PromotionScanRow>(
        `SELECT t.id, t.content_hash, t.namespace, t.created_at,
                ${metadataSelect} AS metadata,
                '${table}' AS table_name
         FROM ${table} t
         WHERE t.namespace = $1 AND t.archived_at IS NULL${nominationFilter}${sinceFilter}
         ORDER BY t.created_at DESC
         LIMIT $2`,
        params,
      );
      return rows;
    },
  };
}
