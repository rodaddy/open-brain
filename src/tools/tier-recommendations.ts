import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../permissions.ts";
import { appendReadNamespacePredicate } from "../read-policy.ts";
import type { AuthInfo, Table } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";
import { ALL_TABLES, CONTENT_PREVIEW, TABLE_ALIAS } from "./table-constants.ts";

export function registerTierRecommendations(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "tier_recommendations",
    {
      description:
        "Get tier change recommendations based on access patterns. Suggests entries to promote (cold/warm -> hot) or demote (warm -> cold).",
      inputSchema: {
        action: z
          .enum(["promote", "demote"])
          .describe("Direction: promote (increase tier) or demote (decrease tier)"),
        threshold_days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe("Days threshold (default: 30 for demote, 7 for promote)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max candidates to return (default 20)"),
      },
      annotations: {
        title: "Tier Recommendations",
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

      const action = args.action as "promote" | "demote";
      const limit = args.limit ?? 20;
      const thresholdDays = args.threshold_days ?? (action === "demote" ? 30 : 7);

      const candidates: Array<{
        id: string;
        table: string;
        content_preview: string;
        current_tier: string;
        suggested_tier: string;
        access_count: number;
        recent_accesses?: number;
        last_accessed_at: string | null;
        reasoning: string;
      }> = [];

      for (const table of accessibleTables) {
        if (candidates.length >= limit) break;

        const remaining = limit - candidates.length;
        const alias = TABLE_ALIAS[table];
        const preview = CONTENT_PREVIEW[table];
        const params: unknown[] = [thresholdDays, remaining];
        const namespacePredicate = appendReadNamespacePredicate(
          auth,
          params,
          `${alias}.namespace`,
        );

        if (action === "demote") {
          // Find warm entries not accessed recently with low access_count
          const { rows } = await deps.pool.query(
            `SELECT
              ${alias}.id,
              LEFT(${preview}, 200) AS content_preview,
              COALESCE(${alias}.tier, 'warm') AS tier,
              COALESCE(${alias}.access_count, 0) AS access_count,
              ${alias}.last_accessed_at
            FROM ${table} ${alias}
            WHERE ${alias}.archived_at IS NULL
              AND COALESCE(${alias}.tier, 'warm') = 'warm'
              AND (${alias}.last_accessed_at IS NULL OR ${alias}.last_accessed_at < NOW() - INTERVAL '1 day' * $1)
              AND COALESCE(${alias}.access_count, 0) < 3
              ${namespacePredicate}
            ORDER BY COALESCE(${alias}.access_count, 0) ASC, ${alias}.created_at ASC
            LIMIT $2`,
            params,
          );

          for (const row of rows) {
            candidates.push({
              id: row.id,
              table,
              content_preview: row.content_preview,
              current_tier: row.tier,
              suggested_tier: "cold",
              access_count: Number(row.access_count),
              last_accessed_at: row.last_accessed_at,
              reasoning: `Warm entry with ${row.access_count} accesses, not accessed in ${thresholdDays}+ days`,
            });
          }
        } else {
          // Promote: find warm/cold entries with high recent access (>5 in threshold period)
          const { rows } = await deps.pool.query(
            `SELECT
              sub.id,
              sub.content_preview,
              sub.tier,
              sub.access_count,
              sub.last_accessed_at,
              sub.recent_accesses
            FROM (
              SELECT
                ${alias}.id,
                LEFT(${preview}, 200) AS content_preview,
                COALESCE(${alias}.tier, 'warm') AS tier,
                COALESCE(${alias}.access_count, 0) AS access_count,
                ${alias}.last_accessed_at,
                (SELECT COUNT(*) FROM entry_access_log eal
                 WHERE eal.entry_id = ${alias}.id
                   AND eal.source_table = '${table}'
                   AND eal.accessed_at >= NOW() - INTERVAL '1 day' * $1) AS recent_accesses
              FROM ${table} ${alias}
              WHERE ${alias}.archived_at IS NULL
                AND COALESCE(${alias}.tier, 'warm') IN ('warm', 'cold')
                ${namespacePredicate}
            ) sub
            WHERE sub.recent_accesses > 5
            ORDER BY sub.recent_accesses DESC
            LIMIT $2`,
            params,
          );

          for (const row of rows) {
            candidates.push({
              id: row.id,
              table,
              content_preview: row.content_preview,
              current_tier: row.tier,
              suggested_tier: "hot",
              access_count: Number(row.access_count),
              recent_accesses: Number(row.recent_accesses),
              last_accessed_at: row.last_accessed_at,
              reasoning: `${row.tier} entry with ${row.recent_accesses} accesses in last ${thresholdDays} days`,
            });
          }
        }
      }

      logger.info("tier_recommendations_success", {
        action,
        candidates_found: candidates.length,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              action,
              threshold_days: thresholdDays,
              candidates_found: candidates.length,
              candidates,
            }),
          },
        ],
      };
    },
  );
}
