import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toSql } from "pgvector/pg";
import { canRead } from "../permissions.ts";
import type { AuthInfo, Table } from "../types.ts";
import type { ToolDeps } from "./index.ts";

const ALL_TABLES: Table[] = [
  "thoughts",
  "decisions",
  "relationships",
  "projects",
  "sessions",
];

/** Singular labels for search results */
const SOURCE_LABELS: Record<Table, string> = {
  thoughts: "thought",
  decisions: "decision",
  relationships: "relationship",
  projects: "project",
  sessions: "session",
};

/**
 * Content preview SQL expression per table.
 * Each produces a single text column normalized for search results.
 */
const CONTENT_PREVIEW: Record<Table, string> = {
  thoughts: "t.content",
  decisions: "d.title || ': ' || d.rationale",
  relationships: "r.person_name || ': ' || COALESCE(r.context, '')",
  projects: "p.name || ': ' || COALESCE(p.description, '')",
  sessions: "COALESCE(s.project || ': ', '') || LEFT(s.summary, 200)",
};

/** Table alias used in CTE SELECTs */
const TABLE_ALIAS: Record<Table, string> = {
  thoughts: "t",
  decisions: "d",
  relationships: "r",
  projects: "p",
  sessions: "s",
};

function buildTableCTE(table: Table): string {
  const alias = TABLE_ALIAS[table];
  const label = SOURCE_LABELS[table];
  const preview = CONTENT_PREVIEW[table];
  const cteName = `${table}_results`;

  return `${cteName} AS (
  SELECT
    '${label}' AS source_type,
    ${alias}.id,
    ${preview} AS content_preview,
    ${alias}.tags,
    ${alias}.created_at,
    ${alias}.embedding <=> (SELECT emb FROM query_embedding) AS distance
  FROM ${table} ${alias}
  WHERE ${alias}.embedding IS NOT NULL AND ${alias}.archived_at IS NULL
  ORDER BY distance
  LIMIT $2
)`;
}

export function registerSearchBrain(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "search_brain",
    {
      description: "Search across all brain tables using semantic similarity",
      inputSchema: {
        query: z.string().min(1).describe("Natural language search query"),
        table: z
          .enum([
            "thoughts",
            "decisions",
            "relationships",
            "projects",
            "sessions",
          ])
          .optional()
          .describe("Optional: limit search to a specific table"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Maximum results to return (default 10)"),
      },
      annotations: {
        title: "Search Brain",
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
        // Specific table requested -- check read permission
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
        // No filter -- include all readable tables
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

      // Generate query embedding -- required for search
      const embedding = await deps.embedFn(args.query);
      if (!embedding) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Failed to generate query embedding",
            },
          ],
          isError: true,
        };
      }

      const limit = args.limit ?? 10;

      // Build dynamic CTE SQL based on accessible tables
      const ctes = accessibleTables.map(buildTableCTE);
      const cteNames = accessibleTables.map((t) => `${t}_results`);

      const unionAll = cteNames
        .map((name) => `SELECT * FROM ${name}`)
        .join("\nUNION ALL\n");

      const sql = `WITH query_embedding AS (
  SELECT $1::halfvec(768) AS emb
),
${ctes.join(",\n")}
${unionAll}
ORDER BY distance ASC
LIMIT $2`;

      const { rows } = await deps.pool.query(sql, [toSql(embedding), limit]);

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
