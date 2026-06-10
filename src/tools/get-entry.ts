import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../permissions.ts";
import type { AuthInfo, Table } from "../types.ts";
import type { ToolDeps } from "./index.ts";
import { TABLE_COLUMNS } from "../table-projections.ts";

export function registerGetEntry(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "get_entry",
    {
      description:
        "Fetch the full content of an entry by table and ID. Use after search to get complete details beyond the 200-char preview.",
      inputSchema: {
        table: z
          .enum([
            "thoughts",
            "decisions",
            "relationships",
            "projects",
            "sessions",
          ])
          .describe(
            "Which table the entry is in (from search result source_type + 's')",
          ),
        id: z.string().uuid().describe("Entry UUID from search results"),
      },
      annotations: {
        title: "Get Entry",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      const table = args.table as Table;

      if (!auth || !canRead(auth.role, table)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Permission denied: cannot read ${table}`,
            },
          ],
          isError: true,
        };
      }

      const columns = TABLE_COLUMNS[table];
      const { rows } = await deps.pool.query(
        `SELECT ${columns} FROM ${table} WHERE id = $1 AND archived_at IS NULL`,
        [args.id],
      );

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Entry not found or archived",
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(rows[0]),
          },
        ],
      };
    },
  );
}
