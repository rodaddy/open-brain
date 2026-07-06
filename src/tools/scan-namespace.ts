import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canReadNamespace } from "../read-policy.ts";
import {
  canonicalNamespace,
  physicalNamespace,
  sharedNamespaceConfig,
} from "../shared-namespace.ts";
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
        "candidates, duplicates in the target namespace, or already_promoted.",
      inputSchema: {
        namespace: z.string().min(1).max(500).describe("Agent namespace to scan"),
        target_namespace: z
          .string()
          .min(1)
          .max(500)
          .optional()
          .describe(
            "Namespace to check for existing promoted duplicates (default shared-kb)",
          ),
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
      if (
        !auth ||
        (auth.role !== "admin" &&
          auth.role !== "ob-admin" &&
          auth.role !== "promoter")
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Permission denied: admin, ob-admin, or promoter role required",
            },
          ],
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
      const targetNamespace =
        args.target_namespace ?? sharedNamespaceConfig().sharedNamespace;
      const targetPhysicalNamespace = physicalNamespace(targetNamespace);
      const targetCanonicalNamespace = canonicalNamespace(targetPhysicalNamespace);
      if (!canReadNamespace(auth, targetNamespace)) {
        return {
          content: [{ type: "text" as const, text: "Permission denied: target namespace read access denied" }],
          isError: true,
        };
      }
      const candidates: any[] = [];
      const duplicates: any[] = [];
      const alreadyPromoted: any[] = [];

      for (const table of tables) {
        const sinceFilter = args.since ? ` AND t.created_at >= $3` : "";
        const params: unknown[] = [args.namespace, limit];
        if (args.since) params.push(args.since);

        const metadataSelect =
          table === "thoughts" || table === "decisions"
            ? "t.extracted_metadata"
            : table === "relationships" || table === "projects"
              ? "t.metadata"
              : "NULL::jsonb";
        const nominationFilter =
          table === "thoughts" || table === "decisions"
            ? " AND t.extracted_metadata->>'share_candidate' = 'true' AND t.extracted_metadata->>'memory_lifecycle_action' = 'nominate_shared'"
            : table === "relationships" || table === "projects"
              ? " AND t.metadata->>'share_candidate' = 'true' AND t.metadata->>'memory_lifecycle_action' = 'nominate_shared'"
              : " AND false";

        const { rows } = await deps.pool.query(
          `SELECT t.id, t.content_hash, t.namespace, t.created_at, t.promoted_from,
                  ${metadataSelect} AS metadata,
                  '${table}' AS table_name
           FROM ${table} t
           WHERE t.namespace = $1 AND t.archived_at IS NULL${nominationFilter}${sinceFilter}
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
            const { rows: targetDupes } = await deps.pool.query(
              `SELECT id FROM ${table}
               WHERE content_hash = $1 AND namespace = $2 AND archived_at IS NULL
               LIMIT 1`,
              [row.content_hash, targetPhysicalNamespace],
            );

            if (targetDupes.length > 0) {
              const duplicate: Record<string, unknown> = {
                table: table,
                id: row.id,
                target_namespace: targetCanonicalNamespace,
                existing_target_id: targetDupes[0].id,
                created_at: row.created_at,
              };
              duplicates.push(duplicate);
              continue;
            }
          }

          const metadata = row.metadata as Record<string, unknown> | null;
          if (
            (metadata?.share_candidate === true ||
              metadata?.share_candidate === "true") &&
            metadata.memory_lifecycle_action === "nominate_shared"
          ) {
            candidates.push({
              table: table,
              id: row.id,
              created_at: row.created_at,
            });
          }
        }
      }

      logger.info("scan_namespace_ok", {
        namespace: args.namespace,
        target_namespace: targetCanonicalNamespace,
        candidates: candidates.length,
        duplicates: duplicates.length,
        already_promoted: alreadyPromoted.length,
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            namespace: args.namespace,
            target_namespace: targetCanonicalNamespace,
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
