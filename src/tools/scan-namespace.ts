import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canReadNamespace } from "../read-policy.ts";
import type { AuthInfo, Table } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";
import { ALL_TABLES } from "./table-constants.ts";

export function registerScanNamespace(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "scan_namespace",
    {
      description:
        "Scan an agent namespace for promotion candidates. Returns entries categorized as " +
        "candidates (not yet in collab), duplicates (already in collab), or already_promoted.",
      inputSchema: {
        namespace: z.string().min(1).max(500).describe("Agent namespace to scan"),
        table: z
          .enum(["thoughts", "decisions", "relationships", "projects", "sessions"])
          .optional()
          .describe("Limit scan to a specific table"),
        since: z
          .string()
          .optional()
          .describe("Only entries created after this ISO date"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max entries to scan per table (default 20)"),
      },
      annotations: {
        title: "Scan Namespace",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const auth = extra.authInfo as AuthInfo | undefined;
      if (!auth || (auth.role !== "admin" && auth.role !== "n8n")) {
        return {
          content: [{ type: "text" as const, text: "Permission denied: admin or n8n role required" }],
          isError: true,
        };
      }
      if (!canReadNamespace(auth, args.namespace)) {
        return {
          content: [{ type: "text" as const, text: "Permission denied: namespace read access denied" }],
          isError: true,
        };
      }

      const tables = args.table ? [args.table as Table] : ALL_TABLES;
      const limit = args.limit ?? 20;
      const candidates: any[] = [];
      const duplicates: any[] = [];
      const alreadyPromoted: any[] = [];

      for (const table of tables) {
        const sinceFilter = args.since ? ` AND t.created_at >= $3` : "";
        const params: unknown[] = [args.namespace, limit];
        if (args.since) params.push(args.since);

        const { rows } = await deps.pool.query(
          `SELECT t.id, t.content_hash, t.namespace, t.created_at, t.promoted_from,
                  '${table}' AS table_name
           FROM ${table} t
           WHERE t.namespace = $1 AND t.archived_at IS NULL${sinceFilter}
           ORDER BY t.created_at DESC
           LIMIT $2`,
          params,
        );

        for (const row of rows) {
          if (row.promoted_from) {
            alreadyPromoted.push({
              table: table,
              id: row.id,
              created_at: row.created_at,
              promoted_to: row.promoted_from,
            });
            continue;
          }

          if (row.content_hash) {
            const { rows: collabDupes } = await deps.pool.query(
              `SELECT id FROM ${table}
               WHERE content_hash = $1 AND namespace = 'collab' AND archived_at IS NULL
               LIMIT 1`,
              [row.content_hash],
            );

            if (collabDupes.length > 0) {
              duplicates.push({
                table: table,
                id: row.id,
                existing_collab_id: collabDupes[0].id,
                created_at: row.created_at,
              });
              continue;
            }
          }

          candidates.push({
            table: table,
            id: row.id,
            created_at: row.created_at,
          });
        }
      }

      logger.info("scan_namespace_ok", {
        namespace: args.namespace,
        candidates: candidates.length,
        duplicates: duplicates.length,
        already_promoted: alreadyPromoted.length,
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            namespace: args.namespace,
            candidates,
            duplicates,
            already_promoted: alreadyPromoted,
            summary: {
              candidates: candidates.length,
              duplicates: duplicates.length,
              already_promoted: alreadyPromoted.length,
            },
          }),
        }],
      };
    },
  );
}
