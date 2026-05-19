import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canWrite } from "../permissions.ts";
import type { AuthInfo, Table } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";

export function registerBulkSetTier(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "bulk_set_tier",
    {
      description:
        "Set cognitive tiers for multiple entries in a single transaction. Max 100 entries per call.",
      inputSchema: {
        entries: z
          .array(
            z.object({
              id: z.string().uuid().describe("UUID of the entry"),
              table: z
                .enum([
                  "thoughts",
                  "decisions",
                  "relationships",
                  "projects",
                  "sessions",
                ])
                .describe("Table containing the entry"),
              tier: z
                .enum(["hot", "warm", "cold"])
                .describe("Target cognitive tier"),
            }),
          )
          .min(1)
          .max(100)
          .describe("Array of entries to update (max 100)"),
      },
      annotations: {
        title: "Bulk Set Tier",
        readOnlyHint: false,
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

      const entries = args.entries as Array<{
        id: string;
        table: Table;
        tier: string;
      }>;

      // Check write permission for all referenced tables
      const uniqueTables = new Set(entries.map((e) => e.table));
      for (const table of uniqueTables) {
        if (!canWrite(auth.role, table)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Permission denied: cannot write to ${table}`,
              },
            ],
            isError: true,
          };
        }
      }

      const client = await deps.pool.connect();
      let updated = 0;

      try {
        await client.query("BEGIN");

        for (const entry of entries) {
          // Table name is validated by Zod enum -- safe for interpolation
          const { rowCount } = await client.query(
            `UPDATE ${entry.table} SET tier = $1 WHERE id = $2 AND archived_at IS NULL`,
            [entry.tier, entry.id],
          );
          updated += rowCount ?? 0;
        }

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        const message = err instanceof Error ? err.message : String(err);
        logger.error("bulk_set_tier_error", { error: message });
        return {
          content: [
            {
              type: "text" as const,
              text: `Transaction failed: ${message}`,
            },
          ],
          isError: true,
        };
      } finally {
        client.release();
      }

      logger.info("bulk_set_tier_success", {
        requested: entries.length,
        updated,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              requested: entries.length,
              updated,
            }),
          },
        ],
      };
    },
  );
}
