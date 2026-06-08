import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../permissions.ts";
import type { AuthInfo, Table, Tier } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";

import {
  ALL_TABLES,
  SOURCE_LABELS,
  CONTENT_PREVIEW,
  TABLE_ALIAS,
  VALID_TIERS,
} from "./table-constants.ts";

function buildWhereClause(
  alias: string,
  includeArchived: boolean,
  tier?: Tier,
): string {
  const archiveFilter = includeArchived
    ? ""
    : ` AND ${alias}.archived_at IS NULL`;
  const tierFilter = tier ? ` AND ${alias}.tier = '${tier}'` : "";
  return `WHERE ${alias}.created_at >= NOW() - INTERVAL '1 day' * $1${archiveFilter}${tierFilter}`;
}

function buildTableSelect(
  table: Table,
  includeArchived: boolean,
  tier?: Tier,
): string {
  if (tier && !VALID_TIERS.has(tier)) throw new Error(`Invalid tier: ${tier}`);
  const alias = TABLE_ALIAS[table];
  const label = SOURCE_LABELS[table];
  const preview = CONTENT_PREVIEW[table];
  const where = buildWhereClause(alias, includeArchived, tier);

  return `SELECT
    '${label}' AS source_type,
    ${alias}.id,
    ${preview} AS content_preview,
    ${alias}.tags,
    ${alias}.tier,
    ${alias}.created_at
  FROM ${table} ${alias}
  ${where}`;
}

function buildCountSelect(
  table: Table,
  includeArchived: boolean,
  tier?: Tier,
): string {
  if (tier && !VALID_TIERS.has(tier)) throw new Error(`Invalid tier: ${tier}`);
  const alias = TABLE_ALIAS[table];
  const where = buildWhereClause(alias, includeArchived, tier);

  return `SELECT COUNT(*) AS cnt
  FROM ${table} ${alias}
  ${where}`;
}

export function registerListRecent(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_recent",
    {
      description:
        "List recent brain entries chronologically. Supports table filter, date range, tier filter, and pagination with total_count.",
      inputSchema: {
        table: z
          .enum([
            "thoughts",
            "decisions",
            "relationships",
            "projects",
            "sessions",
          ])
          .optional()
          .describe("Optional: filter to a specific table"),
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe("Number of days to look back (default 7)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximum entries to return (default 20, max 500)"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Number of entries to skip for pagination (default 0)"),
        include_archived: z
          .boolean()
          .optional()
          .describe("Include archived entries (default false)"),
        tier: z
          .enum(["hot", "warm", "cold"])
          .optional()
          .describe("Optional: filter to a specific cognitive tier"),
        response_format: z
          .enum(["envelope", "array"])
          .optional()
          .describe(
            "Response format: 'envelope' (default) returns {entries, total_count, has_more}; 'array' returns raw array for backwards compatibility",
          ),
      },
      annotations: {
        title: "List Recent",
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
              text: "Permission denied: no readable tables",
            },
          ],
          isError: true,
        };
      }

      // Determine which tables the caller can read
      const tableFilter = args.table as Table | undefined;
      let accessibleTables: Table[];

      if (tableFilter) {
        if (!canRead(auth.role, tableFilter)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Permission denied: cannot read ${tableFilter}`,
              },
            ],
            isError: true,
          };
        }
        accessibleTables = [tableFilter];
      } else {
        accessibleTables = ALL_TABLES.filter((t) => canRead(auth.role, t));
      }

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

      const days = args.days ?? 7;
      const limit = args.limit ?? 20;
      const offset = args.offset ?? 0;
      const includeArchived = args.include_archived ?? false;
      const tier = args.tier as Tier | undefined;
      const useArray = args.response_format === "array";

      // Build UNION ALL of table SELECTs
      const selects = accessibleTables.map((t) =>
        buildTableSelect(t, includeArchived, tier),
      );

      const unionSql = selects.join("\nUNION ALL\n");
      const sql = `${unionSql}\nORDER BY created_at DESC\nLIMIT $2 OFFSET $3`;

      // Build total count query
      const countSelects = accessibleTables.map((t) =>
        buildCountSelect(t, includeArchived, tier),
      );
      const countSql = `SELECT SUM(cnt)::int AS total_count FROM (${countSelects.join("\nUNION ALL\n")}) counts`;

      logger.info("list_recent_query", {
        tables: accessibleTables,
        days,
        limit,
        offset,
        includeArchived,
      });

      const [dataResult, countResult] = await Promise.all([
        deps.pool.query(sql, [days, limit, offset]),
        deps.pool.query(countSql, [days]).catch(() => null),
      ]);

      const totalCount = countResult?.rows[0]?.total_count ?? null;
      const hasMore =
        totalCount !== null
          ? offset + dataResult.rows.length < totalCount
          : false;

      const responseBody = useArray
        ? dataResult.rows
        : {
            entries: dataResult.rows,
            total_count: totalCount,
            offset,
            limit,
            has_more: hasMore,
          };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(responseBody),
          },
        ],
      };
    },
  );
}
