import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead, canDelete } from "../permissions.ts";
import { appendWriteNamespacePredicate } from "../namespace-policy.ts";
import type { AuthInfo, Table } from "../types.ts";
import { logger } from "../logger.ts";
import type { ToolDeps } from "./index.ts";
import { ALL_TABLES } from "./table-constants.ts";

/** Content preview SQL per table (matches curate.ts) */
const CONTENT_PREVIEW: Record<Table, string> = {
  thoughts: "content",
  decisions: "title || ': ' || rationale",
  relationships: "person_name || ': ' || COALESCE(context, '')",
  projects: "name || ': ' || COALESCE(description, '')",
  sessions: "COALESCE(project || ': ', '') || LEFT(summary, 200)",
};

const DUPLICATE_THRESHOLD = 0.08;
const STALE_DAYS = 90;

interface CurateResult {
  mode: string;
  dry_run: boolean;
  tables_processed: string[];
  duplicates: Array<{
    table: string;
    entry_a: string;
    entry_b: string;
    distance: number;
    action: string;
  }>;
  stale: Array<{
    table: string;
    id: string;
    preview: string;
    action: string;
  }>;
  vague: Array<{
    table: string;
    id: string;
    preview: string;
    action: string;
  }>;
  summary: {
    duplicates_found: number;
    stale_found: number;
    vague_found: number;
    archived: number;
  };
}

export function registerCurateEntries(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "curate_entries",
    {
      description:
        "Run curation analysis on brain entries. Detects duplicates, stale entries, and vague content. SAFE BY DEFAULT (dry_run=true).",
      inputSchema: {
        mode: z
          .enum(["duplicates", "stale", "vague", "all"])
          .describe("Curation mode: which checks to run"),
        dry_run: z
          .boolean()
          .optional()
          .describe("If true (default), only report findings without modifying data"),
        table: z
          .enum([
            "thoughts",
            "decisions",
            "relationships",
            "projects",
            "sessions",
          ])
          .optional()
          .describe("Optional: limit to a specific table"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max entries to process per table (default 20)"),
      },
      annotations: {
        title: "Curate Entries",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
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

      const dryRun = args.dry_run !== false; // default true
      const mode = args.mode as string;
      const limit = args.limit ?? 20;
      const tableFilter = args.table as Table | undefined;

      // For dry_run=false, require admin/delete permission
      if (!dryRun) {
        const hasAdmin = auth.role === "admin" || auth.role === "n8n";
        if (!hasAdmin) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Permission denied: admin permission required for dry_run=false",
              },
            ],
            isError: true,
          };
        }
      }

      const tablesToScan = tableFilter ? [tableFilter] : ALL_TABLES;
      const accessibleTables = tablesToScan.filter((t) => canRead(auth.role, t));

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

      const result: CurateResult = {
        mode,
        dry_run: dryRun,
        tables_processed: accessibleTables,
        duplicates: [],
        stale: [],
        vague: [],
        summary: {
          duplicates_found: 0,
          stale_found: 0,
          vague_found: 0,
          archived: 0,
        },
      };

      for (const table of accessibleTables) {
        const preview = CONTENT_PREVIEW[table];

        // Duplicates
        if (mode === "duplicates" || mode === "all") {
          const params: unknown[] = [DUPLICATE_THRESHOLD, limit];
          const namespacePredicate = appendWriteNamespacePredicate(
            auth,
            params,
            "a.namespace",
          );
          const { rows } = await deps.pool.query(
            `SELECT
              a.id AS id_a,
              b.id AS id_b,
              a.embedding <=> b.embedding AS distance
            FROM ${table} a
            JOIN ${table} b ON a.id < b.id
              AND b.archived_at IS NULL AND b.embedding IS NOT NULL
              AND b.namespace = a.namespace
            WHERE a.archived_at IS NULL AND a.embedding IS NOT NULL
              AND a.embedding <=> b.embedding < $1
              ${namespacePredicate}
            ORDER BY distance ASC
            LIMIT $2`,
            params,
          );

          for (const row of rows) {
            let action = "would_archive_older";
            if (!dryRun) {
              // Archive the first entry (a < b by ID, but we archive a)
              const archiveParams: unknown[] = [row.id_a];
              const archiveNamespacePredicate = appendWriteNamespacePredicate(
                auth,
                archiveParams,
              );
              await deps.pool.query(
                `UPDATE ${table} SET archived_at = NOW() WHERE id = $1 AND archived_at IS NULL${archiveNamespacePredicate}`,
                archiveParams,
              );
              action = "archived";
              result.summary.archived++;
            }
            result.duplicates.push({
              table,
              entry_a: row.id_a,
              entry_b: row.id_b,
              distance: Number(row.distance),
              action,
            });
          }
          result.summary.duplicates_found += rows.length;
        }

        // Stale
        if (mode === "stale" || mode === "all") {
          const params: unknown[] = [STALE_DAYS, limit];
          const namespacePredicate = appendWriteNamespacePredicate(
            auth,
            params,
          );
          const { rows } = await deps.pool.query(
            `SELECT id, ${preview} AS content_preview
             FROM ${table}
             WHERE archived_at IS NULL
               AND created_at < NOW() - INTERVAL '1 day' * $1
               AND COALESCE(access_count, 0) = 0
               ${namespacePredicate}
             LIMIT $2`,
            params,
          );

          for (const row of rows) {
            let action = "would_flag";
            if (!dryRun) {
              const archiveParams: unknown[] = [row.id];
              const archiveNamespacePredicate = appendWriteNamespacePredicate(
                auth,
                archiveParams,
              );
              await deps.pool.query(
                `UPDATE ${table} SET archived_at = NOW() WHERE id = $1 AND archived_at IS NULL${archiveNamespacePredicate}`,
                archiveParams,
              );
              action = "archived";
              result.summary.archived++;
            }
            result.stale.push({
              table,
              id: row.id,
              preview: (row.content_preview ?? "").slice(0, 200),
              action,
            });
          }
          result.summary.stale_found += rows.length;
        }

        // Vague
        if (mode === "vague" || mode === "all") {
          const params: unknown[] = [limit];
          const namespacePredicate = appendWriteNamespacePredicate(
            auth,
            params,
          );
          const { rows } = await deps.pool.query(
            `SELECT id, ${preview} AS content_preview
             FROM ${table}
             WHERE archived_at IS NULL
               AND (usefulness_score IS NULL OR usefulness_score < 0.3)
               AND (tags IS NULL OR array_length(tags, 1) IS NULL)
               ${namespacePredicate}
             LIMIT $1`,
            params,
          );

          for (const row of rows) {
            result.vague.push({
              table,
              id: row.id,
              preview: (row.content_preview ?? "").slice(0, 200),
              action: "flagged_for_review",
            });
          }
          result.summary.vague_found += rows.length;
        }
      }

      logger.info("curate_entries_success", {
        mode,
        dry_run: dryRun,
        ...result.summary,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result),
          },
        ],
      };
    },
  );
}
