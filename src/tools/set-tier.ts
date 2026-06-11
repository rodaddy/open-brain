import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canWrite } from "../permissions.ts";
import { appendWriteNamespacePredicate } from "../namespace-policy.ts";
import type { AuthInfo, Table, Tier } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";

export function registerSetTier(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "set_tier",
    {
      description:
        "Set the cognitive tier (hot/warm/cold) for a brain entry. Hot entries are boosted in search, cold entries are deprioritized. Requires write permission.",
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
        id: z.string().uuid().describe("UUID of the entry to update"),
        tier: z
          .enum(["hot", "warm", "cold"])
          .describe(
            "Cognitive tier: hot (front-of-mind, boosted), warm (default), cold (deprioritized)",
          ),
      },
      annotations: {
        title: "Set Tier",
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
      const params: unknown[] = [args.tier, args.id];
      const namespacePredicate = appendWriteNamespacePredicate(auth, params);
      const { rows } = await deps.pool.query(
        `UPDATE ${table} SET tier = $1 WHERE id = $2 AND archived_at IS NULL${namespacePredicate} RETURNING id, tier`,
        params,
      );

      if (rows.length === 0) {
        logger.info("set_tier_noop", { table, id: args.id });
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

      logger.info("set_tier_success", {
        table,
        id: rows[0].id,
        tier: rows[0].tier,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              id: rows[0].id,
              table,
              tier: rows[0].tier,
            }),
          },
        ],
      };
    },
  );
}
