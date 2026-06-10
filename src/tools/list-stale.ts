import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../permissions.ts";
import { readableNamespaces } from "../read-policy.ts";
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
  tier?: Tier,
  namespaceParamIndex?: number,
): string {
  const tierFilter = tier ? ` AND ${alias}.tier = '${tier}'` : "";
  const namespaceFilter = namespaceParamIndex
    ? ` AND ${alias}.namespace = ANY($${namespaceParamIndex}::text[])`
    : "";
  return `WHERE ${alias}.archived_at IS NULL
    AND COALESCE(${alias}.last_accessed_at, ${alias}.created_at) < NOW() - INTERVAL '1 day' * $1${tierFilter}${namespaceFilter}`;
}

function buildStaleSelect(
  table: Table,
  tier?: Tier,
  namespaceParamIndex?: number,
): string {
  if (tier && !VALID_TIERS.has(tier)) throw new Error(`Invalid tier: ${tier}`);
  const alias = TABLE_ALIAS[table];
  const label = SOURCE_LABELS[table];
  const preview = CONTENT_PREVIEW[table];
  const where = buildWhereClause(alias, tier, namespaceParamIndex);

  return `SELECT
    '${label}' AS source_type,
    ${alias}.id,
    LEFT(${preview}, 200) AS content_preview,
    ${alias}.tags,
    ${alias}.tier,
    ${alias}.access_count,
    ${alias}.last_accessed_at,
    ${alias}.created_at,
    COALESCE(${alias}.last_accessed_at, ${alias}.created_at) AS effective_last_access
  FROM ${table} ${alias}
  ${where}`;
}

function buildCountSelect(
  table: Table,
  tier?: Tier,
  namespaceParamIndex?: number,
): string {
  if (tier && !VALID_TIERS.has(tier)) throw new Error(`Invalid tier: ${tier}`);
  const alias = TABLE_ALIAS[table];
  const where = buildWhereClause(alias, tier, namespaceParamIndex);

  return `SELECT COUNT(*) AS cnt
  FROM ${table} ${alias}
  ${where}`;
}

export function registerListStale(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_stale",
    {
      description:
        "Find brain entries not accessed recently -- candidates for tier demotion (hot->warm->cold). " +
        "Queries by last_accessed_at (falls back to created_at for never-accessed entries). " +
        "Returns {entries, total_count, has_more} envelope by default, or raw array with response_format='array'. " +
        "Resilient parsing: const entries = Array.isArray(result) ? result : result.entries ?? [];",
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
          .describe(
            "Entries not accessed in this many days are considered stale (default 30)",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximum entries to return (default 50, max 500)"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Number of entries to skip for pagination (default 0)"),
        tier: z
          .enum(["hot", "warm", "cold"])
          .optional()
          .describe(
            "Optional: filter to a specific tier (e.g. 'hot' to find hot entries that should decay to warm)",
          ),
        response_format: z
          .enum(["envelope", "array"])
          .optional()
          .describe(
            "Response format: 'envelope' (default) returns {entries, total_count, has_more}; 'array' returns raw array for backwards compatibility",
          ),
      },
      annotations: {
        title: "List Stale",
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

      const days = args.days ?? 30;
      const limit = args.limit ?? 50;
      const offset = args.offset ?? 0;
      const tier = args.tier as Tier | undefined;
      const useArray = args.response_format === "array";
      const readable = readableNamespaces(auth);
      const namespaceParamIndex = readable ? 4 : undefined;

      const selects = accessibleTables.map((t) =>
        buildStaleSelect(t, tier, namespaceParamIndex),
      );
      const unionSql = selects.join("\nUNION ALL\n");
      const sql = `${unionSql}\nORDER BY effective_last_access ASC\nLIMIT $2 OFFSET $3`;

      const countSelects = accessibleTables.map((t) =>
        buildCountSelect(t, tier, namespaceParamIndex),
      );
      const countSql = `SELECT SUM(cnt)::int AS total_count FROM (${countSelects.join("\nUNION ALL\n")}) counts`;

      logger.info("list_stale_query", {
        tables: accessibleTables,
        days,
        limit,
        offset,
        tier: tier ?? null,
      });

      const [dataResult, countResult] = await Promise.all([
        deps.pool.query(sql, readable ? [days, limit, offset, readable] : [days, limit, offset]),
        deps.pool.query(countSql, readable ? [days, undefined, undefined, readable] : [days]).catch(() => null),
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
