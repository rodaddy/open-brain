import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../permissions.ts";
import type { AuthInfo, Table } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";
import { ALL_TABLES } from "./table-constants.ts";

/** Simple content preview per table using a given alias */
function contentPreviewForAlias(table: Table, alias: string): string {
  switch (table) {
    case "thoughts":
      return `${alias}.content`;
    case "decisions":
      return `${alias}.title || ': ' || COALESCE(${alias}.rationale, '')`;
    case "relationships":
      return `${alias}.person_name || ': ' || COALESCE(${alias}.context, '')`;
    case "projects":
      return `${alias}.name || ': ' || COALESCE(${alias}.description, '')`;
    case "sessions":
      return `COALESCE(${alias}.project || ': ', '') || LEFT(${alias}.summary, 200)`;
  }
}

export function registerFindDuplicates(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "find_duplicates",
    {
      description:
        "Discover potential duplicate entries using vector similarity. Read-only -- does NOT archive anything.",
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
          .describe("Optional: limit to a specific table (default: all)"),
        threshold: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Cosine distance threshold for duplicates (default 0.08, lower = stricter)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max duplicate pairs to return (default 20)"),
      },
      annotations: {
        title: "Find Duplicates",
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

      const threshold = args.threshold ?? 0.08;
      const limit = args.limit ?? 20;
      const tableFilter = args.table as Table | undefined;

      const tablesToScan = tableFilter ? [tableFilter] : ALL_TABLES;
      const accessibleTables = tablesToScan.filter((t) => canRead(auth.role, t));

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

      const duplicates: Array<{
        entry_a: { id: string; preview: string };
        entry_b: { id: string; preview: string };
        table: string;
        distance: number;
      }> = [];

      for (const table of accessibleTables) {
        if (duplicates.length >= limit) break;

        const remaining = limit - duplicates.length;
        const previewA = contentPreviewForAlias(table, "a");
        const previewB = contentPreviewForAlias(table, "b");

        // Table name is validated by Zod enum -- safe for interpolation
        const { rows } = await deps.pool.query(
          `SELECT
            a.id AS id_a,
            LEFT(${previewA}, 200) AS preview_a,
            b.id AS id_b,
            LEFT(${previewB}, 200) AS preview_b,
            a.embedding <=> b.embedding AS distance
          FROM ${table} a
          JOIN ${table} b ON a.id < b.id
            AND b.archived_at IS NULL
            AND b.embedding IS NOT NULL
          WHERE a.archived_at IS NULL
            AND a.embedding IS NOT NULL
            AND a.parent_id IS NULL AND b.parent_id IS NULL
            AND a.embedding <=> b.embedding < $1
          ORDER BY distance ASC
          LIMIT $2`,
          [threshold, remaining],
        );

        for (const row of rows) {
          duplicates.push({
            entry_a: { id: row.id_a, preview: row.preview_a },
            entry_b: { id: row.id_b, preview: row.preview_b },
            table,
            distance: Number(row.distance),
          });
        }
      }

      logger.info("find_duplicates_success", {
        tables_scanned: accessibleTables.length,
        duplicates_found: duplicates.length,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              threshold,
              duplicates_found: duplicates.length,
              duplicates,
            }),
          },
        ],
      };
    },
  );
}
