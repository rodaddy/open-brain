import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../permissions.ts";
import type { AuthInfo, Table, Tier } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";

const ALL_TABLES: Table[] = [
  "thoughts",
  "decisions",
  "relationships",
  "projects",
  "sessions",
];

/** Singular labels for list results */
const SOURCE_LABELS: Record<Table, string> = {
  thoughts: "thought",
  decisions: "decision",
  relationships: "relationship",
  projects: "project",
  sessions: "session",
};

/** Content preview SQL expression per table */
const CONTENT_PREVIEW: Record<Table, string> = {
  thoughts: "t.content",
  decisions: "d.title || ': ' || d.rationale",
  relationships: "r.person_name || ': ' || COALESCE(r.context, '')",
  projects: "p.name || ': ' || COALESCE(p.description, '')",
  sessions: "COALESCE(s.project || ': ', '') || LEFT(s.summary, 200)",
};

/** Table alias used in SELECTs */
const TABLE_ALIAS: Record<Table, string> = {
  thoughts: "t",
  decisions: "d",
  relationships: "r",
  projects: "p",
  sessions: "s",
};

function buildTableSelect(
  table: Table,
  includeArchived: boolean,
  tier?: Tier,
): string {
  const alias = TABLE_ALIAS[table];
  const label = SOURCE_LABELS[table];
  const preview = CONTENT_PREVIEW[table];

  const archiveFilter = includeArchived
    ? ""
    : ` AND ${alias}.archived_at IS NULL`;
  const tierFilter = tier ? ` AND ${alias}.tier = '${tier}'` : "";

  return `SELECT
    '${label}' AS source_type,
    ${alias}.id,
    ${preview} AS content_preview,
    ${alias}.tags,
    ${alias}.tier,
    ${alias}.created_at
  FROM ${table} ${alias}
  WHERE ${alias}.created_at >= NOW() - INTERVAL '1 day' * $1${archiveFilter}${tierFilter}`;
}

export function registerListRecent(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_recent",
    {
      description:
        "List recent brain entries chronologically. Supports table filter, date range, and archived toggle.",
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
          .max(100)
          .optional()
          .describe("Maximum entries to return (default 20)"),
        include_archived: z
          .boolean()
          .optional()
          .describe("Include archived entries (default false)"),
        tier: z
          .enum(["hot", "warm", "cold"])
          .optional()
          .describe("Optional: filter to a specific cognitive tier"),
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
      const includeArchived = args.include_archived ?? false;
      const tier = args.tier as Tier | undefined;

      // Build UNION ALL of table SELECTs
      const selects = accessibleTables.map((t) =>
        buildTableSelect(t, includeArchived, tier),
      );

      const unionSql = selects.join("\nUNION ALL\n");
      const sql = `${unionSql}\nORDER BY created_at DESC\nLIMIT $2`;

      logger.info("list_recent_query", {
        tables: accessibleTables,
        days,
        limit,
        includeArchived,
      });

      const { rows } = await deps.pool.query(sql, [days, limit]);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(rows),
          },
        ],
      };
    },
  );
}
