/**
 * Owns the eighteen statements the reporting, repo-facts and skill-usage tools
 * used to execute inline.
 *
 * It exists so the tools tier holds no SQL text: each of those modules takes
 * this port instead of running against the Pool directly (issue 1209). Design
 * authority: `_plans/463-server-rewrite-charter.md:111` gives server/db the
 * repositories, and :117-119 reserves raw SQL for them.
 *
 * Serves `server/tools/reporting.ts`, `server/tools/repo-facts.ts`,
 * `server/tools/context-pack-repo-facts.ts` and `server/tools/skill-usage.ts`.
 *
 * The SQL text moved verbatim. Where a statement interpolated a table name or a
 * clause fragment, that fragment is still built by the caller from its own
 * closed literal list or from the auth-derived namespace predicate and arrives
 * here as an already-validated value -- this module never composes one anew.
 */
import { toSql } from "pgvector/pg";
import type { QuerySurface } from "./transaction.ts";

/** One row of anything these reports read. */
export type ReportRow = Record<string, unknown>;

export interface EntityReportRepository {
  /** reporting.ts: the one-pass access aggregate over `entry_access_log`. */
  accessAggregate(values: {
    entryId: string;
    sourceTable: string;
    days: number;
  }): Promise<ReportRow[]>;

  /** reporting.ts: probe one table for a readable id under the read predicate. */
  findEntryInTable(values: {
    table: string;
    predicateClause: string;
    parameters: unknown[];
  }): Promise<ReportRow[]>;

  /** reporting.ts: the scalar per-table totals. */
  tableTotals(values: {
    table: string;
    scoped: string;
    parameters: unknown[];
  }): Promise<ReportRow[]>;

  /** reporting.ts: the tier breakdown for one table. */
  tableTierCounts(values: {
    table: string;
    activeScoped: string;
    parameters: unknown[];
  }): Promise<ReportRow[]>;

  /** reporting.ts: the top namespaces for one table. */
  tableNamespaceCounts(values: {
    table: string;
    activeScoped: string;
    parameters: unknown[];
    topNamespaces: number;
  }): Promise<ReportRow[]>;

  /** reporting.ts: access-log totals, scoped by the caller's EXISTS arms. */
  accessLogTotals(values: {
    where: string;
    parameters: unknown[];
  }): Promise<ReportRow[]>;

  /** reporting.ts: the `ob_entities` count. */
  entityCount(values: { where: string; parameters: unknown[] }): Promise<ReportRow[]>;

  /** reporting.ts: the `ob_links` count. */
  linkCount(values: { where: string; parameters: unknown[] }): Promise<ReportRow[]>;

  /** reporting.ts: the entity-type breakdown. */
  entityTypeCounts(values: {
    where: string;
    parameters: unknown[];
    topEntityTypes: number;
  }): Promise<ReportRow[]>;

  /** reporting.ts: the busiest entries across the caller's UNION arms. */
  topAccessedEntries(values: {
    arms: string;
    parameters: unknown[];
    previewWidth: number;
    topAccessed: number;
  }): Promise<ReportRow[]>;

  /** repo-facts.ts: upsert one repo fact on the active (namespace, type, name) key. */
  upsertRepoFact(values: {
    name: string;
    canonicalId: string;
    namespace: string;
    metadata: string;
    embedding: number[] | null;
    createdBy: string;
  }): Promise<ReportRow[]>;

  /** repo-facts.ts: list repo facts for one already-built filter set. */
  listRepoFacts(values: {
    columns: string;
    filters: string[];
    parameters: unknown[];
  }): Promise<ReportRow[]>;

  /** context-pack-repo-facts.ts: the exactly-bound rows for one repo. */
  repoFactRowsForRepo(values: {
    namespace: string;
    repo: string;
  }): Promise<ReportRow[]>;

  /** skill-usage.ts: seed (or touch) the entity a usage row points at. */
  seedSkillEntity(values: {
    entityType: string;
    entityName: string;
    namespace: string;
    metadata: string;
    createdBy: string;
  }): Promise<ReportRow[]>;

  /** skill-usage.ts: append the one usage row and return it as stored. */
  appendUsageRow(values: {
    entityId: string;
    skillSlug: string;
    agent: string | null;
    repo: string | null;
    sessionId: string | null;
    runtime: string | null;
    usageKind: string;
  }): Promise<ReportRow[]>;

  /** skill-usage.ts: counts per skill x agent x repo x runtime. */
  usageCounts(values: {
    join: string;
    windowParameter: string;
    kindFilter: string;
    reportRowCount: number;
    parameters: unknown[];
  }): Promise<ReportRow[]>;

  /** skill-usage.ts: the prior window of equal length. */
  priorWindowCounts(values: {
    join: string;
    windowParameter: string;
    kindFilter: string;
    parameters: unknown[];
  }): Promise<ReportRow[]>;

  /** skill-usage.ts: seeded skills with no invocation inside the window. */
  neverUsedSkills(values: {
    entityType: string;
    scoped: string;
    windowParameter: string;
    reportRowCount: number;
    parameters: unknown[];
  }): Promise<ReportRow[]>;
}

/** `reporting.ts`'s per-entry and per-table statements. */
type ReportingStatements = Pick<
  EntityReportRepository,
  | "accessAggregate"
  | "findEntryInTable"
  | "tableTotals"
  | "tableTierCounts"
  | "tableNamespaceCounts"
>;

/** `reporting.ts`'s cross-table aggregate statements. */
type ReportingAggregateStatements = Pick<
  EntityReportRepository,
  | "accessLogTotals"
  | "entityCount"
  | "linkCount"
  | "entityTypeCounts"
  | "topAccessedEntries"
>;

/** The three statements the two repo-facts modules used to run inline. */
type RepoFactStatements = Pick<
  EntityReportRepository,
  "upsertRepoFact" | "listRepoFacts" | "repoFactRowsForRepo"
>;

/** The five statements `server/tools/skill-usage.ts` used to run inline. */
type SkillUsageStatements = Pick<
  EntityReportRepository,
  | "seedSkillEntity"
  | "appendUsageRow"
  | "usageCounts"
  | "priorWindowCounts"
  | "neverUsedSkills"
>;

function reportingStatements(db: QuerySurface): ReportingStatements {
  return {
    async accessAggregate(values) {
      const { rows } = await db.query(
        `SELECT
       COUNT(*) FILTER (WHERE accessed_at >= NOW() - INTERVAL '1 day' * $3) AS total,
       COUNT(DISTINCT query_text) FILTER (
         WHERE accessed_at >= NOW() - INTERVAL '1 day' * $3 AND query_text IS NOT NULL
       ) AS unique_queries,
       COUNT(DISTINCT accessed_by) FILTER (
         WHERE accessed_at >= NOW() - INTERVAL '1 day' * $3 AND accessed_by IS NOT NULL
       ) AS unique_agents,
       COUNT(*) FILTER (WHERE accessed_at >= NOW() - INTERVAL '7 days') AS recent_7d,
       COUNT(*) FILTER (
         WHERE accessed_at >= NOW() - INTERVAL '14 days'
           AND accessed_at < NOW() - INTERVAL '7 days'
       ) AS previous_7d,
       MAX(accessed_at) AS last_accessed
     FROM entry_access_log
     WHERE entry_id = $1 AND source_table = $2`,
        [values.entryId, values.sourceTable, values.days],
      );
      return rows;
    },

    async findEntryInTable(values) {
      const { rows } = await db.query(
        `SELECT id FROM ${values.table}
        WHERE id = $1 AND archived_at IS NULL${values.predicateClause}
        FETCH FIRST 1 ROWS ONLY`,
        values.parameters,
      );
      return rows;
    },

    async tableTotals(values) {
      const { rows } = await db.query(
        `SELECT
         COUNT(*) FILTER (WHERE archived_at IS NULL) AS active,
         COUNT(*) FILTER (WHERE archived_at IS NOT NULL) AS archived,
         COUNT(*) FILTER (WHERE archived_at IS NULL AND COALESCE(access_count, 0) = 0) AS zero_access,
         AVG(COALESCE(access_count, 0)) FILTER (WHERE archived_at IS NULL) AS avg_access
       FROM ${values.table}${values.scoped}`,
        values.parameters,
      );
      return rows;
    },

    async tableTierCounts(values) {
      const { rows } = await db.query(
        `SELECT COALESCE(tier, 'warm') AS tier, COUNT(*) AS count
         FROM ${values.table}${values.activeScoped}
        GROUP BY COALESCE(tier, 'warm')`,
        values.parameters,
      );
      return rows;
    },

    async tableNamespaceCounts(values) {
      const { rows } = await db.query(
        `SELECT namespace, COUNT(*) AS count
         FROM ${values.table}${values.activeScoped}
        GROUP BY namespace
        ORDER BY count DESC
        FETCH FIRST ${values.topNamespaces} ROWS ONLY`,
        values.parameters,
      );
      return rows;
    },
  };
}

function reportingAggregateStatements(db: QuerySurface): ReportingAggregateStatements {
  return {
    async accessLogTotals(values) {
      const { rows } = await db.query(
        `SELECT COUNT(*) AS total_log_entries,
            COUNT(DISTINCT entry_id) AS unique_entries_accessed
       FROM entry_access_log eal${values.where}`,
        values.parameters,
      );
      return rows;
    },

    async entityCount(values) {
      const { rows } = await db.query(
        `SELECT COUNT(*) AS total FROM ob_entities${values.where}`,
        values.parameters,
      );
      return rows;
    },

    async linkCount(values) {
      const { rows } = await db.query(
        `SELECT COUNT(*) AS total FROM ob_links${values.where}`,
        values.parameters,
      );
      return rows;
    },

    async entityTypeCounts(values) {
      const { rows } = await db.query(
        `SELECT entity_type, COUNT(*) AS count
         FROM ob_entities${values.where}
        GROUP BY entity_type
        ORDER BY count DESC, entity_type ASC
        FETCH FIRST ${values.topEntityTypes} ROWS ONLY`,
        values.parameters,
      );
      return rows;
    },

    async topAccessedEntries(values) {
      const { rows } = await db.query(
        `SELECT id, table_name, LEFT(content_preview, ${values.previewWidth}) AS content_preview, access_count
       FROM (${values.arms}) AS combined
      ORDER BY access_count DESC
      FETCH FIRST ${values.topAccessed} ROWS ONLY`,
        values.parameters,
      );
      return rows;
    },
  };
}

function repoFactStatements(db: QuerySurface): RepoFactStatements {
  return {
    async upsertRepoFact(values) {
      const { rows } = await db.query(
        `INSERT INTO ob_entities
       (entity_type, name, canonical_id, namespace, metadata, embedding, created_by)
     VALUES ('repo_fact', $1, $2, $3, $4::jsonb, $5, $6)
     ON CONFLICT (namespace, entity_type, lower(name))
     WHERE archived_at IS NULL
     DO UPDATE SET
       canonical_id = EXCLUDED.canonical_id,
       metadata = EXCLUDED.metadata,
       embedding = COALESCE(EXCLUDED.embedding, ob_entities.embedding),
       archived_at = NULL,
       updated_at = NOW()
     RETURNING id, (xmax = 0) AS is_new, entity_type, name, canonical_id,
               namespace, metadata, created_at, updated_at`,
        [
          values.name,
          values.canonicalId,
          values.namespace,
          values.metadata,
          values.embedding ? toSql(values.embedding) : null,
          values.createdBy,
        ],
      );
      return rows;
    },

    async listRepoFacts(values) {
      const { rows } = await db.query(
        `SELECT ${values.columns}
         FROM ob_entities
        WHERE ${values.filters.join(" AND ")}
        ORDER BY updated_at DESC, created_at DESC
        LIMIT $${values.parameters.length - 1} OFFSET $${values.parameters.length}`,
        values.parameters,
      );
      return rows;
    },

    async repoFactRowsForRepo(values) {
      const { rows } = await db.query(
        `SELECT id, namespace, metadata, updated_at
         FROM ob_entities
        WHERE entity_type = 'repo_fact'
          AND archived_at IS NULL
          AND namespace = $1
          AND metadata->>'repo' = $2
        ORDER BY updated_at DESC, id DESC`,
        [values.namespace, values.repo],
      );
      return rows;
    },
  };
}

function skillUsageStatements(db: QuerySurface): SkillUsageStatements {
  return {
    async seedSkillEntity(values) {
      const { rows } = await db.query(
        `INSERT INTO ob_entities
       (entity_type, name, namespace, metadata, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (namespace, entity_type, lower(name))
     WHERE archived_at IS NULL
     DO UPDATE SET updated_at = NOW()
     RETURNING id`,
        [
          values.entityType,
          values.entityName,
          values.namespace,
          values.metadata,
          values.createdBy,
        ],
      );
      return rows;
    },

    async appendUsageRow(values) {
      const { rows } = await db.query(
        `INSERT INTO skill_usage_log
       (entity_id, skill_slug, agent, repo, session_id, runtime, usage_kind)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, entity_id, skill_slug, agent, repo, session_id, runtime,
               usage_kind, invoked_at`,
        [
          values.entityId,
          values.skillSlug,
          values.agent,
          values.repo,
          values.sessionId,
          values.runtime,
          values.usageKind,
        ],
      );
      return rows;
    },

    async usageCounts(values) {
      const { rows } = await db.query(
        `SELECT sul.skill_slug,
            sul.usage_kind,
            sul.agent,
            sul.repo,
            sul.runtime,
            COUNT(*)::int          AS invocations,
            MAX(sul.invoked_at)    AS last_used_at
       FROM skill_usage_log sul${values.join}
      WHERE sul.invoked_at >= NOW() - (${values.windowParameter} || ' days')::interval${values.kindFilter}
      GROUP BY sul.skill_slug, sul.usage_kind, sul.agent, sul.repo,
               sul.runtime
      ORDER BY invocations DESC, sul.skill_slug ASC
      LIMIT ${values.reportRowCount}`,
        values.parameters,
      );
      return rows;
    },

    async priorWindowCounts(values) {
      const { rows } = await db.query(
        `SELECT sul.skill_slug, COUNT(*)::int AS invocations
       FROM skill_usage_log sul${values.join}
      WHERE sul.invoked_at <  NOW() - (${values.windowParameter} || ' days')::interval
        AND sul.invoked_at >= NOW() - (${values.windowParameter} || ' days')::interval * 2${values.kindFilter}
      GROUP BY sul.skill_slug`,
        values.parameters,
      );
      return rows;
    },

    async neverUsedSkills(values) {
      const { rows } = await db.query(
        `SELECT e.name
       FROM ob_entities e
      WHERE e.entity_type = '${values.entityType}'
        AND e.archived_at IS NULL${values.scoped}
        AND NOT EXISTS (
              SELECT 1
                FROM skill_usage_log sul
               WHERE sul.entity_id = e.id
                 AND sul.invoked_at >=
                     NOW() - (${values.windowParameter} || ' days')::interval
            )
      ORDER BY e.name ASC
      LIMIT ${values.reportRowCount}`,
        values.parameters,
      );
      return rows;
    },
  };
}

/**
 * Build the port over any query surface -- a `pg.Pool` outside a transaction, a
 * checked-out client inside one.
 */
export function createEntityReportRepository(db: QuerySurface): EntityReportRepository {
  return {
    ...reportingStatements(db),
    ...reportingAggregateStatements(db),
    ...repoFactStatements(db),
    ...skillUsageStatements(db),
  };
}
