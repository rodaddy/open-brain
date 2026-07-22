import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canDelete } from "../permissions.ts";
import { appendWriteNamespacePredicate } from "../namespace-policy.ts";
import type { AuthInfo, Table } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";

export function registerBulkArchive(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "bulk_archive",
    {
      description:
        "Soft-delete multiple entries in a single transaction. Max 100 entries per call.",
      inputSchema: {
        entries: z
          .array(
            z.object({
              id: z.string().uuid().describe("UUID of the entry to archive"),
              table: z
                .enum([
                  "thoughts",
                  "decisions",
                  "relationships",
                  "projects",
                  "sessions",
                ])
                .describe("Table containing the entry"),
            }),
          )
          .min(1)
          .max(100)
          .describe("Array of entries to archive (max 100)"),
      },
      annotations: {
        title: "Bulk Archive",
        readOnlyHint: false,
        destructiveHint: true,
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

      const entries = args.entries as Array<{ id: string; table: Table }>;

      // Check delete permission for all referenced tables
      const uniqueTables = new Set(entries.map((e) => e.table));
      for (const table of uniqueTables) {
        if (!canDelete(auth.role, table)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Permission denied: cannot delete from ${table}`,
              },
            ],
            isError: true,
          };
        }
      }

      const client = await deps.pool.connect();
      let archived = 0;

      try {
        await client.query("BEGIN");

        for (const entry of entries) {
          // Table name is validated by Zod enum -- safe for interpolation
          const params: unknown[] = [entry.id];
          const namespacePredicate = appendWriteNamespacePredicate(
            auth,
            params,
          );
          const { rowCount } = await client.query(
            `UPDATE ${entry.table} SET archived_at = NOW() WHERE id = $1 AND archived_at IS NULL${namespacePredicate}`,
            params,
          );
          archived += rowCount ?? 0;
        }

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        // Log only stable error class/code -- never raw err.message, which can
        // embed query fragments, row content, or namespace names (PR #275,
        // PR #262 patterns). The response is a stable content-free string.
        logger.error("bulk_archive_error", {
          name: err instanceof Error ? err.name : "unknown",
          code: (err as { code?: string } | null | undefined)?.code,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: "Transaction failed",
            },
          ],
          isError: true,
        };
      } finally {
        client.release();
      }

      logger.info("bulk_archive_success", {
        requested: entries.length,
        archived,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              requested: entries.length,
              archived,
            }),
          },
        ],
      };
    },
  );
}
