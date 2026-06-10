import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../permissions.ts";
import { readableNamespaces } from "../read-policy.ts";
import type { AuthInfo, Table } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";
import { ALL_TABLES } from "./table-constants.ts";

export function registerListNamespaces(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "list_namespaces",
    {
      description:
        "List all namespaces with entry counts per table. Useful for understanding data distribution across agents/users.",
      inputSchema: {},
      annotations: {
        title: "List Namespaces",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (_args, extra) => {
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

      const accessibleTables = ALL_TABLES.filter((t) => canRead(auth.role, t));
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

      // Query each table for namespace counts
      const readable = readableNamespaces(auth);
      const queries = accessibleTables.map((table) => {
        const namespacePredicate = readable
          ? " AND namespace = ANY($1::text[])"
          : "";
        return deps.pool.query(
          `SELECT
            '${table}' AS table_name,
            namespace,
            COUNT(*) AS count
          FROM ${table}
          WHERE archived_at IS NULL${namespacePredicate}
          GROUP BY namespace
          ORDER BY count DESC`,
          readable ? [readable] : [],
        );
      });

      const results = await Promise.all(queries);

      // Aggregate by namespace
      const nsMap = new Map<
        string,
        { total: number; per_table: Record<string, number> }
      >();

      for (const result of results) {
        for (const row of result.rows) {
          const ns = row.namespace as string;
          const existing = nsMap.get(ns) ?? { total: 0, per_table: {} };
          const count = Number(row.count);
          existing.total += count;
          existing.per_table[row.table_name] = count;
          nsMap.set(ns, existing);
        }
      }

      // Sort by total count descending
      const namespaces = Array.from(nsMap.entries())
        .map(([namespace, data]) => ({
          namespace,
          total: data.total,
          per_table: data.per_table,
        }))
        .sort((a, b) => b.total - a.total);

      logger.info("list_namespaces_success", {
        namespace_count: namespaces.length,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              namespace_count: namespaces.length,
              namespaces,
            }),
          },
        ],
      };
    },
  );
}
