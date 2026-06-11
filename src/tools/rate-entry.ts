import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canWrite } from "../permissions.ts";
import { appendWriteNamespacePredicate } from "../namespace-policy.ts";
import type { AuthInfo, Table } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";

export function registerRateEntry(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "rate_entry",
    {
      description:
        "Rate a brain entry's usefulness on a 0.0-1.0 scale. Requires write permission.",
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
        id: z.string().uuid().describe("UUID of the entry to rate"),
        score: z
          .number()
          .min(0)
          .max(1)
          .describe("Usefulness score: 0.0 (not useful) to 1.0 (very useful)"),
      },
      annotations: {
        title: "Rate Entry",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      const table = args.table as Table;

      if (!auth || !canWrite(auth.role, table)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: cannot write to " + table,
            },
          ],
          isError: true,
        };
      }

      // Table name is validated by Zod enum -- safe for interpolation
      const params: unknown[] = [args.score, args.id];
      const namespacePredicate = appendWriteNamespacePredicate(auth, params);
      const { rows } = await deps.pool.query(
        `UPDATE ${table} SET usefulness_score = $1 WHERE id = $2 AND archived_at IS NULL${namespacePredicate} RETURNING id, usefulness_score`,
        params,
      );

      if (rows.length === 0) {
        logger.info("rate_entry_noop", {
          table,
          id: args.id,
        });
        return {
          content: [
            {
              type: "text" as const,
              text: "Cannot rate archived entry",
            },
          ],
          isError: true,
        };
      }

      logger.info("rate_entry_success", {
        table,
        id: rows[0].id,
        score: rows[0].usefulness_score,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              id: rows[0].id,
              table,
              usefulness_score: rows[0].usefulness_score,
            }),
          },
        ],
      };
    },
  );
}
