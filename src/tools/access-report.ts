import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../permissions.ts";
import { appendReadNamespacePredicate } from "../read-policy.ts";
import type { AuthInfo, Table } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";
import { ALL_TABLES } from "./table-constants.ts";

async function findReadableEntryTable(
  deps: ToolDeps,
  auth: AuthInfo,
  entryId: string,
): Promise<Table | null> {
  const readableTables = ALL_TABLES.filter((table) => canRead(auth.role, table));
  for (const table of readableTables) {
    const params: unknown[] = [entryId];
    const namespacePredicate = appendReadNamespacePredicate(auth, params);
    const { rows } = await deps.pool.query(
      `SELECT id FROM ${table} WHERE id = $1 AND archived_at IS NULL${namespacePredicate} LIMIT 1`,
      params,
    );
    if (rows.length > 0) {
      return table;
    }
  }
  return null;
}

export function registerAccessReport(server: McpServer, deps: ToolDeps): void {
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

      const hasReadAccess = ALL_TABLES.some((t) => canRead(auth.role, t));
      if (!hasReadAccess) {
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

      const entryId = args.entry_id;
      const days = args.days ?? 30;
      const sourceTable = await findReadableEntryTable(deps, auth, entryId);
      if (sourceTable === null) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Entry not found or not readable",
            },
          ],
          isError: true,
        };
      }

      // Total accesses in period
      const totalResult = await deps.pool.query(
        `SELECT COUNT(*) AS total
         FROM entry_access_log
         WHERE entry_id = $1
           AND accessed_at >= NOW() - INTERVAL '1 day' * $2
           AND source_table = $3`,
        [entryId, days, sourceTable],
      );

      // Unique queries
      const uniqueQueriesResult = await deps.pool.query(
        `SELECT COUNT(DISTINCT query_text) AS unique_queries
         FROM entry_access_log
         WHERE entry_id = $1
           AND accessed_at >= NOW() - INTERVAL '1 day' * $2
           AND source_table = $3
           AND query_text IS NOT NULL`,
        [entryId, days, sourceTable],
      );

      // Unique agents
      const uniqueAgentsResult = await deps.pool.query(
        `SELECT COUNT(DISTINCT accessed_by) AS unique_agents
         FROM entry_access_log
         WHERE entry_id = $1
           AND accessed_at >= NOW() - INTERVAL '1 day' * $2
           AND source_table = $3
           AND accessed_by IS NOT NULL`,
        [entryId, days, sourceTable],
      );

      // Access trend: last 7 days vs previous 7 days
      const trendResult = await deps.pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE accessed_at >= NOW() - INTERVAL '7 days') AS recent_7d,
           COUNT(*) FILTER (WHERE accessed_at >= NOW() - INTERVAL '14 days' AND accessed_at < NOW() - INTERVAL '7 days') AS previous_7d
         FROM entry_access_log
         WHERE entry_id = $1
           AND source_table = $2`,
        [entryId, sourceTable],
      );

      // Last accessed
      const lastAccessResult = await deps.pool.query(
        `SELECT MAX(accessed_at) AS last_accessed
         FROM entry_access_log
         WHERE entry_id = $1
           AND source_table = $2`,
        [entryId, sourceTable],
      );

      const recent7d = Number(trendResult.rows[0]?.recent_7d ?? 0);
      const previous7d = Number(trendResult.rows[0]?.previous_7d ?? 0);
      let trend: string;
      if (recent7d > previous7d * 1.2) {
        trend = "rising";
      } else if (recent7d < previous7d * 0.8) {
        trend = "declining";
      } else {
        trend = "stable";
      }

      const lastAccessed = lastAccessResult.rows[0]?.last_accessed ?? null;
      let daysSinceLastAccess: number | null = null;
      if (lastAccessed) {
        daysSinceLastAccess = Math.floor(
          (Date.now() - new Date(lastAccessed).getTime()) / (1000 * 60 * 60 * 24),
        );
      }

      const report = {
        entry_id: entryId,
        source_table: sourceTable,
        period_days: days,
        total_accesses: Number(totalResult.rows[0]?.total ?? 0),
        unique_queries: Number(uniqueQueriesResult.rows[0]?.unique_queries ?? 0),
        unique_agents: Number(uniqueAgentsResult.rows[0]?.unique_agents ?? 0),
        trend,
        trend_detail: { recent_7d: recent7d, previous_7d: previous7d },
        last_accessed: lastAccessed,
        days_since_last_access: daysSinceLastAccess,
      };

      logger.info("access_report_success", { entry_id: entryId });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(report),
          },
        ],
      };
    },
  );
}
