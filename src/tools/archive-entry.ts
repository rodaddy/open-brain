import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canDelete } from "../permissions.ts";
import { appendWriteNamespacePredicate } from "../namespace-policy.ts";
import type { AuthInfo, Table } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";

export function registerArchiveEntry(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "archive_entry",
    {
      description:
        "Soft-delete a brain entry by setting archived_at. Only admin and n8n roles can archive.",
      inputSchema: {
        table: z
          .enum([
            "thoughts",
            "decisions",
            "relationships",
            "projects",
            "sessions",
          ])
          .describe("Table containing the entry"),
        id: z.string().uuid().describe("UUID of the entry to archive"),
      },
      annotations: {
        title: "Archive Entry",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth || !canDelete(auth.role, args.table as Table)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: cannot archive entries",
            },
          ],
          isError: true,
        };
      }

      const table = args.table as Table;

      // Table name is validated by Zod enum -- safe for interpolation
      const params: unknown[] = [args.id];
      const namespacePredicate = appendWriteNamespacePredicate(auth, params);
      const { rows } = await deps.pool.query(
        `UPDATE ${table} SET archived_at = NOW() WHERE id = $1 AND archived_at IS NULL${namespacePredicate} RETURNING id`,
        params,
      );

      if (rows.length === 0) {
        logger.info("archive_entry_noop", { table, id: args.id });
        return {
          content: [
            {
              type: "text" as const,
              text: "Already archived or not found",
            },
          ],
        };
      }

      logger.info("archive_entry_success", {
        table,
        id: rows[0].id,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              id: rows[0].id,
              table,
              archived: true,
            }),
          },
        ],
      };
    },
  );
}
