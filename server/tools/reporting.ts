/**
 * Read-only access and statistics reporting.
 *
 * Design authority: `docs/decisions/cognitive-tiering-dream-cycle.md` for the
 * `entry_access_log`-as-a-log model.
 *
 * BOTH TOOLS HERE ARE READ-ONLY. They aggregate; they never write a tier, a
 * counter, or an archive.
 *
 * `entry_access_log` is read as a LOG, not a counter: totals, distinct queries,
 * distinct agents, and the trend all come from counting timestamped rows. NO
 * INDEX is added on that table -- `008_index_cleanup.sql` removed the unused
 * ones, and adding one with no reading consumer would repeat that.
 *
 * The access log carries no namespace of its own, so every read of it is scoped
 * by joining back to the owning row and applying the auth-derived predicate
 * THERE. Reading the log directly by `entry_id` would leak another namespace's
 * access pattern to any caller who could guess an id.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../auth/permissions.ts";
import {
  namespacePredicate,
  type NamespacePredicate,
} from "../auth/namespace-policy.ts";
import type { AuthIdentity, ResourceTable } from "../auth/types.ts";
import { canonicalNamespace } from "../../src/shared-namespace.ts";
import {
  authIdentity,
  errorResult,
  textResult,
  type MemoryToolDependencies,
} from "./types.ts";
import {
  ALL_TABLES,
  CONTENT_PREVIEW,
  PREVIEW_WIDTH,
  qualifyNamespacePredicate,
} from "./curation-helpers.ts";

/** Query alias per table, matching observed current-src SQL. */
const TABLE_ALIAS: Readonly<Record<ResourceTable, string>> = {
  thoughts: "t",
  decisions: "d",
  relationships: "r",
  projects: "p",
  sessions: "s",
};

/** Observed current-src caps on the reported breakdowns. */
const TOP_NAMESPACES = 10;
const TOP_ACCESSED = 10;
const TOP_ENTITY_TYPES = 25;

/** Trend bands from observed current-src: +/-20% around the prior window. */
const RISING_RATIO = 1.2;
const DECLINING_RATIO = 0.8;

export function registerReportingTools(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  registerAccessReport(server, dependencies);
  registerGetStats(server, dependencies);
}

function registerAccessReport(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "access_report",
    {
      description:
        "Returns a detailed access report for a specific entry: total accesses, unique queries, unique agents, access trend, and recency.",
      inputSchema: {
        entry_id: z.string().uuid().describe("UUID of the entry to report on"),
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe("Number of days to look back (default 30)"),
      },
      annotations: {
        title: "Access Report",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      if (!identity) return errorResult("Permission denied: not authenticated");
      const accessible = ALL_TABLES.filter((table) => canRead(identity.role, table));
      if (accessible.length === 0) {
        return errorResult("Permission denied: no readable tables");
      }

      // Which table owns this id is resolved through the namespace predicate,
      // so an entry the caller cannot read is indistinguishable from a miss.
      const sourceTable = await findReadableEntryTable(
        dependencies,
        identity,
        accessible,
        args.entry_id,
      );
      if (!sourceTable) return errorResult("Entry not found or not readable");

      const days = args.days ?? 30;
      // One pass over the log instead of five sequential round trips: the
      // windows are FILTER clauses over the same scan, which is what the
      // separate current-src queries add up to.
      const { rows } = await dependencies.pool.query(
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
        [args.entry_id, sourceTable, days],
      );

      const row = rows[0] ?? {};
      const recent7d = Number(row.recent_7d ?? 0);
      const previous7d = Number(row.previous_7d ?? 0);
      const lastAccessed = row.last_accessed ?? null;

      dependencies.logger.info(
        { tool: "access_report", entryId: args.entry_id },
        "tool_result",
      );
      return textResult({
        entry_id: args.entry_id,
        source_table: sourceTable,
        period_days: days,
        total_accesses: Number(row.total ?? 0),
        unique_queries: Number(row.unique_queries ?? 0),
        unique_agents: Number(row.unique_agents ?? 0),
        trend: accessTrend(recent7d, previous7d),
        trend_detail: { recent_7d: recent7d, previous_7d: previous7d },
        last_accessed: lastAccessed,
        days_since_last_access: daysSince(lastAccessed),
      });
    },
  );
}

function registerGetStats(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "get_stats",
    {
      description:
        "Returns aggregate statistics about the Open Brain knowledge base: entry counts, tier distribution, namespace breakdown, and access analytics.",
      inputSchema: {
        raw: z
          .boolean()
          .optional()
          .describe(
            "Return physical namespace names instead of canonical public names",
          ),
      },
      annotations: {
        title: "Get Stats",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      if (!identity) return errorResult("Permission denied: not authenticated");
      const accessible = ALL_TABLES.filter((table) => canRead(identity.role, table));
      if (accessible.length === 0) {
        return errorResult("Permission denied: no readable tables");
      }

      const perTable = await Promise.all(
        accessible.map((table) => tableStats(dependencies, identity, table)),
      );
      const [accessStats, graph, topAccessed] = await Promise.all([
        accessLogStats(dependencies, identity, accessible),
        graphCounts(dependencies, identity),
        topAccessedEntries(dependencies, identity, accessible),
      ]);

      const entryCounts: Record<string, { active: number; archived: number }> = {};
      const tierDistribution: Record<string, Record<string, number>> = {};
      const zeroAccess: Record<string, number> = {};
      const namespaceRows: Array<{ table: string; namespace: string; count: number }> = [];
      let avgTotal = 0;

      for (const stats of perTable) {
        entryCounts[stats.table] = { active: stats.active, archived: stats.archived };
        // Observed current-src omits a table with no rows entirely rather than
        // mapping it to an empty object, because it builds this from the
        // GROUP BY result rows. A table key with `{}` would be a new shape.
        if (Object.keys(stats.tiers).length > 0) {
          tierDistribution[stats.table] = stats.tiers;
        }
        zeroAccess[stats.table] = stats.zeroAccess;
        avgTotal += stats.avgAccess;
        for (const entry of stats.namespaces) {
          namespaceRows.push({
            table: stats.table,
            // Legacy `collab` is folded into the canonical shared name unless
            // the caller explicitly asked for physical names.
            namespace: args.raw ? entry.namespace : canonicalNamespace(entry.namespace),
            count: entry.count,
          });
        }
      }

      // Folding can collide two physical names onto one canonical name, so sum
      // before ranking rather than ranking the pre-fold rows.
      const merged = new Map<string, { table: string; namespace: string; count: number }>();
      for (const entry of namespaceRows) {
        const key = `${entry.table}\u0000${entry.namespace}`;
        const existing = merged.get(key);
        if (existing) existing.count += entry.count;
        else merged.set(key, { ...entry });
      }
      const namespaces = [...merged.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, TOP_NAMESPACES);

      dependencies.logger.info(
        { tool: "get_stats", tables: accessible.length },
        "tool_result",
      );
      return textResult({
        entry_counts: entryCounts,
        tier_distribution: tierDistribution,
        namespaces,
        access_stats: {
          total_log_entries: accessStats.totalLogEntries,
          unique_entries_accessed: accessStats.uniqueEntriesAccessed,
          avg_access_count:
            perTable.length > 0
              ? Math.round((avgTotal / perTable.length) * 100) / 100
              : 0,
        },
        graph_counts: graph,
        zero_access_entries: zeroAccess,
        top_accessed: topAccessed,
      });
    },
  );
}

/** @returns The first readable table holding this id, or `undefined`. */
async function findReadableEntryTable(
  dependencies: MemoryToolDependencies,
  identity: AuthIdentity,
  accessible: readonly ResourceTable[],
  entryId: string,
): Promise<ResourceTable | undefined> {
  for (const table of accessible) {
    const predicate = namespacePredicate(identity, "read", 2);
    const { rows } = await dependencies.pool.query(
      `SELECT id FROM ${table}
        WHERE id = $1 AND archived_at IS NULL${predicate.clause}
        FETCH FIRST 1 ROWS ONLY`,
      [entryId, ...predicate.values],
    );
    if (rows.length > 0) return table;
  }
  return undefined;
}

interface TableStats {
  table: ResourceTable;
  active: number;
  archived: number;
  tiers: Record<string, number>;
  zeroAccess: number;
  avgAccess: number;
  namespaces: Array<{ namespace: string; count: number }>;
}

/**
 * Per-table aggregates.
 *
 * The scalar aggregates all scan the same rows under the same predicate, so
 * they collapse into a single row rather than the four separate round trips
 * current-src issues. The tier and namespace breakdowns each need their own
 * GROUP BY and stay separate -- folding them into the scalar query would need
 * a padded UNION whose column types must be asserted by hand, which is a
 * silent-wrong-answer risk that is not worth one saved round trip.
 */
async function tableStats(
  dependencies: MemoryToolDependencies,
  identity: AuthIdentity,
  table: ResourceTable,
): Promise<TableStats> {
  const predicate = namespacePredicate(identity, "read", 1);
  const scoped = predicate.clause ? ` WHERE ${predicate.clause.slice(" AND ".length)}` : "";
  const activeScoped = ` WHERE archived_at IS NULL${predicate.clause}`;

  const [totals, tierRows, namespaces] = await Promise.all([
    dependencies.pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE archived_at IS NULL) AS active,
         COUNT(*) FILTER (WHERE archived_at IS NOT NULL) AS archived,
         COUNT(*) FILTER (WHERE archived_at IS NULL AND COALESCE(access_count, 0) = 0) AS zero_access,
         AVG(COALESCE(access_count, 0)) FILTER (WHERE archived_at IS NULL) AS avg_access
       FROM ${table}${scoped}`,
      [...predicate.values],
    ),
    dependencies.pool.query(
      `SELECT COALESCE(tier, 'warm') AS tier, COUNT(*) AS count
         FROM ${table}${activeScoped}
        GROUP BY COALESCE(tier, 'warm')`,
      [...predicate.values],
    ),
    dependencies.pool.query(
      `SELECT namespace, COUNT(*) AS count
         FROM ${table}${activeScoped}
        GROUP BY namespace
        ORDER BY count DESC
        FETCH FIRST ${TOP_NAMESPACES} ROWS ONLY`,
      [...predicate.values],
    ),
  ]);

  const row = totals.rows[0] ?? {};
  const tiers: Record<string, number> = {};
  for (const tierRow of tierRows.rows) {
    tiers[String(tierRow.tier)] = Number(tierRow.count);
  }
  return {
    table,
    active: Number(row.active ?? 0),
    archived: Number(row.archived ?? 0),
    tiers,
    zeroAccess: Number(row.zero_access ?? 0),
    avgAccess: Number(row.avg_access ?? 0),
    namespaces: namespaces.rows.map((entry) => ({
      namespace: String(entry.namespace),
      count: Number(entry.count),
    })),
  };
}

/**
 * Access-log totals, scoped by joining back to the owning row.
 *
 * The log has no namespace column of its own, so the predicate is applied to
 * the source table inside an EXISTS -- reading the log unscoped would report
 * another namespace's activity.
 */
async function accessLogStats(
  dependencies: MemoryToolDependencies,
  identity: AuthIdentity,
  accessible: readonly ResourceTable[],
): Promise<{ totalLogEntries: number; uniqueEntriesAccessed: number }> {
  const values: unknown[] = [];
  const clauses = accessible.map((table) => {
    const predicate = namespacePredicate(identity, "read", values.length + 1);
    values.push(...predicate.values);
    const scoped = qualifyNamespacePredicate(
      predicate,
      "source.namespace",
      values.length,
    );
    return `EXISTS (
      SELECT 1 FROM ${table} source
       WHERE source.id = eal.entry_id
         AND eal.source_table = '${table}'${scoped}
    )`;
  });
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" OR ")}` : "";
  const { rows } = await dependencies.pool.query(
    `SELECT COUNT(*) AS total_log_entries,
            COUNT(DISTINCT entry_id) AS unique_entries_accessed
       FROM entry_access_log eal${where}`,
    values,
  );
  return {
    totalLogEntries: Number(rows[0]?.total_log_entries ?? 0),
    uniqueEntriesAccessed: Number(rows[0]?.unique_entries_accessed ?? 0),
  };
}

/** Knowledge-graph counts, which live in `ob_entities`/`ob_links`. */
async function graphCounts(
  dependencies: MemoryToolDependencies,
  identity: AuthIdentity,
): Promise<{
  entities: number;
  links: number;
  entity_types: Array<{ entity_type: string; count: number }>;
}> {
  const predicate = namespacePredicate(identity, "read", 1);
  const where = predicate.clause
    ? ` WHERE ${predicate.clause.slice(" AND ".length)}`
    : "";
  const [entities, links, types] = await Promise.all([
    dependencies.pool.query(
      `SELECT COUNT(*) AS total FROM ob_entities${where}`,
      [...predicate.values],
    ),
    dependencies.pool.query(
      `SELECT COUNT(*) AS total FROM ob_links${where}`,
      [...predicate.values],
    ),
    dependencies.pool.query(
      `SELECT entity_type, COUNT(*) AS count
         FROM ob_entities${where}
        GROUP BY entity_type
        ORDER BY count DESC, entity_type ASC
        FETCH FIRST ${TOP_ENTITY_TYPES} ROWS ONLY`,
      [...predicate.values],
    ),
  ]);
  return {
    entities: Number(entities.rows[0]?.total ?? 0),
    links: Number(links.rows[0]?.total ?? 0),
    entity_types: types.rows.map((row) => ({
      entity_type: String(row.entity_type),
      count: Number(row.count),
    })),
  };
}

/** Busiest entries across every readable table, by stored access counter. */
async function topAccessedEntries(
  dependencies: MemoryToolDependencies,
  identity: AuthIdentity,
  accessible: readonly ResourceTable[],
): Promise<
  Array<{ id: string; table: string; content_preview: string; access_count: number }>
> {
  const values: unknown[] = [];
  const arms = accessible.map((table) => {
    const alias = TABLE_ALIAS[table];
    const predicate = namespacePredicate(identity, "read", values.length + 1);
    values.push(...predicate.values);
    const scoped = qualifyNamespacePredicate(
      predicate,
      `${alias}.namespace`,
      values.length,
    );
    return `SELECT ${alias}.id, '${table}' AS table_name,
                   ${CONTENT_PREVIEW[table]} AS content_preview,
                   COALESCE(${alias}.access_count, 0) AS access_count
              FROM ${table} ${alias}
             WHERE ${alias}.archived_at IS NULL${scoped}`;
  });
  const { rows } = await dependencies.pool.query(
    `SELECT id, table_name, LEFT(content_preview, ${PREVIEW_WIDTH}) AS content_preview, access_count
       FROM (${arms.join(" UNION ALL ")}) AS combined
      ORDER BY access_count DESC
      FETCH FIRST ${TOP_ACCESSED} ROWS ONLY`,
    values,
  );
  return rows.map((row) => ({
    id: String(row.id),
    table: String(row.table_name),
    content_preview: row.content_preview,
    access_count: Number(row.access_count),
  }));
}

/** @returns `rising`, `declining`, or `stable` per the observed bands. */
function accessTrend(recent: number, previous: number): string {
  if (recent > previous * RISING_RATIO) return "rising";
  if (recent < previous * DECLINING_RATIO) return "declining";
  return "stable";
}

/** @returns Whole days since the timestamp, or `null` when never accessed. */
function daysSince(value: unknown): number | null {
  if (!value) return null;
  const when = new Date(value as string).getTime();
  return Math.floor((Date.now() - when) / (1000 * 60 * 60 * 24));
}
