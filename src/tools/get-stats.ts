import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../permissions.ts";
import type { AuthInfo, Table } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";
import { ALL_TABLES, CONTENT_PREVIEW, TABLE_ALIAS } from "./table-constants.ts";

export function registerGetStats(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "get_stats",
    {
      description:
        "Returns aggregate statistics about the Open Brain knowledge base: entry counts, tier distribution, namespace breakdown, and access analytics.",
      inputSchema: {},
      annotations: {
        title: "Get Stats",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (_args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: not authenticated",
            },
          ],
          isError: true,
        };
      }

      const accessibleTables = ALL_TABLES.filter((t) => canRead(auth.role, t));
      if (accessibleTables.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: no readable tables",
            },
          ],
          isError: true,
        };
      }

      // 1. Entry counts per table (active vs archived)
      const countQueries = accessibleTables.map((table) =>
        deps.pool.query(
          `SELECT
            '${table}' AS table_name,
            COUNT(*) FILTER (WHERE archived_at IS NULL) AS active,
            COUNT(*) FILTER (WHERE archived_at IS NOT NULL) AS archived
          FROM ${table}`,
        ),
      );

      // 2. Tier distribution per table
      const tierQueries = accessibleTables.map((table) =>
        deps.pool.query(
          `SELECT
            '${table}' AS table_name,
            COALESCE(tier, 'warm') AS tier,
            COUNT(*) AS count
          FROM ${table}
          WHERE archived_at IS NULL
          GROUP BY tier`,
        ),
      );

      // 3. Namespace breakdown (top 10)
      const nsQueries = accessibleTables.map((table) =>
        deps.pool.query(
          `SELECT
            '${table}' AS table_name,
            namespace,
            COUNT(*) AS count
          FROM ${table}
          WHERE archived_at IS NULL
          GROUP BY namespace
          ORDER BY count DESC
          LIMIT 10`,
        ),
      );

      // 4. Access stats
      const accessStatsQuery = deps.pool.query(
        `SELECT
          COUNT(*) AS total_log_entries,
          COUNT(DISTINCT entry_id) AS unique_entries_accessed
        FROM entry_access_log`,
      );

      // 5. Average access_count across all tables
      const avgAccessQueries = accessibleTables.map((table) =>
        deps.pool.query(
          `SELECT AVG(COALESCE(access_count, 0)) AS avg_access FROM ${table} WHERE archived_at IS NULL`,
        ),
      );

      // 6. Zero-access entries per table
      const zeroAccessQueries = accessibleTables.map((table) =>
        deps.pool.query(
          `SELECT '${table}' AS table_name, COUNT(*) AS count
          FROM ${table}
          WHERE archived_at IS NULL AND COALESCE(access_count, 0) = 0`,
        ),
      );

      // 7. Top 10 most accessed entries
      const topAccessedParts = accessibleTables.map((table) => {
        const alias = TABLE_ALIAS[table];
        const preview = CONTENT_PREVIEW[table];
        return `SELECT ${alias}.id, '${table}' AS table_name, ${preview} AS content_preview, COALESCE(${alias}.access_count, 0) AS access_count FROM ${table} ${alias} WHERE ${alias}.archived_at IS NULL`;
      });
      const topAccessedSql = `SELECT id, table_name, LEFT(content_preview, 200) AS content_preview, access_count FROM (${topAccessedParts.join(" UNION ALL ")}) AS combined ORDER BY access_count DESC LIMIT 10`;

      const [
        countResults,
        tierResults,
        nsResults,
        accessStats,
        avgAccessResults,
        zeroAccessResults,
        topAccessed,
      ] = await Promise.all([
        Promise.all(countQueries),
        Promise.all(tierQueries),
        Promise.all(nsQueries),
        accessStatsQuery,
        Promise.all(avgAccessQueries),
        Promise.all(zeroAccessQueries),
        deps.pool.query(topAccessedSql),
      ]);

      // Build entry counts
      const entryCounts: Record<string, { active: number; archived: number }> = {};
      for (const result of countResults) {
        const row = result.rows[0];
        entryCounts[row.table_name] = {
          active: Number(row.active),
          archived: Number(row.archived),
        };
      }

      // Build tier distribution
      const tierDistribution: Record<string, Record<string, number>> = {};
      for (const result of tierResults) {
        for (const row of result.rows) {
          const td = tierDistribution[row.table_name] ?? {}; tierDistribution[row.table_name] = td;
          td[row.tier] = Number(row.count);
        }
      }

      // Build namespace breakdown
      const namespaces: Array<{ table: string; namespace: string; count: number }> = [];
      for (const result of nsResults) {
        for (const row of result.rows) {
          namespaces.push({
            table: row.table_name,
            namespace: row.namespace,
            count: Number(row.count),
          });
        }
      }

      // Compute average access count across tables
      let totalAvg = 0;
      let avgCount = 0;
      for (const result of avgAccessResults) {
        const val = Number(result.rows[0]?.avg_access ?? 0);
        totalAvg += val;
        avgCount++;
      }

      // Build zero-access
      const zeroAccess: Record<string, number> = {};
      for (const result of zeroAccessResults) {
        const row = result.rows[0];
        zeroAccess[row.table_name] = Number(row.count);
      }

      const stats = {
        entry_counts: entryCounts,
        tier_distribution: tierDistribution,
        namespaces: namespaces.slice(0, 10),
        access_stats: {
          total_log_entries: Number(accessStats.rows[0]?.total_log_entries ?? 0),
          unique_entries_accessed: Number(accessStats.rows[0]?.unique_entries_accessed ?? 0),
          avg_access_count: avgCount > 0 ? Math.round((totalAvg / avgCount) * 100) / 100 : 0,
        },
        zero_access_entries: zeroAccess,
        top_accessed: topAccessed.rows.map((r: any) => ({
          id: r.id,
          table: r.table_name,
          content_preview: r.content_preview,
          access_count: Number(r.access_count),
        })),
      };

      logger.info("get_stats_success", { tables: accessibleTables.length });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(stats),
          },
        ],
      };
    },
  );
}
