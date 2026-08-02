/**
 * Curation tools: discovery, archival, and rating.
 *
 * Design authority: `docs/dream-design.md` and
 * `docs/decisions/cognitive-tiering-dream-cycle.md`.
 *
 * THE DRY-RUN DEFAULT IS INVIOLABLE. `curate_entries` reports by default and
 * only mutates when the caller explicitly passes `dry_run: false` AND holds an
 * admin-tier role. Planning never mutates: that is the exact call shape the
 * dream-cycle design depends on, because a planning pass that silently archived
 * would make the whole cycle unreviewable and irreversible.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canDelete, canRead } from "../auth/permissions.ts";
import { namespacePredicate } from "../auth/namespace-policy.ts";
import type { AuthIdentity, ResourceTable } from "../auth/types.ts";
import { authIdentity, errorResult, textResult, type MemoryToolDependencies } from "./types.ts";
import { authorize } from "./memory-helpers.ts";
import {
  ALL_TABLES,
  CONTENT_PREVIEW,
  DUPLICATE_THRESHOLD,
  STALE_DAYS,
  previewOf,
  qualifyNamespacePredicate,
  tableEnum,
} from "./curation-helpers.ts";

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
  stale: Array<{ table: string; id: string; preview: string; action: string }>;
  vague: Array<{ table: string; id: string; preview: string; action: string }>;
  summary: {
    duplicates_found: number;
    stale_found: number;
    vague_found: number;
    archived: number;
  };
}

/**
 * Archive one row under an auth-derived write predicate.
 *
 * Only ever called from a `dry_run: false` branch that already proved the
 * caller holds an admin-tier role.
 */
async function archiveRow(
  dependencies: MemoryToolDependencies,
  identity: AuthIdentity,
  table: ResourceTable,
  id: string,
): Promise<void> {
  const predicate = namespacePredicate(identity, "write", 2);
  await dependencies.pool.query(
    `UPDATE ${table} SET archived_at = NOW() WHERE id = $1 AND archived_at IS NULL${predicate.clause}`,
    [id, ...predicate.values],
  );
}

export function registerCurationTools(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "curate_entries",
    {
      description:
        "Run curation analysis on brain entries. Detects duplicates, stale entries, and vague content. SAFE BY DEFAULT (dry_run=true).",
      inputSchema: {
        mode: z.enum(["duplicates", "stale", "vague", "all"]),
        dry_run: z.boolean().optional(),
        table: tableEnum.optional(),
        rows_per_table: z.number().int().min(1).max(100).optional(),
      },
      annotations: {
        title: "Curate Entries",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      if (!identity) return errorResult("Permission denied: not authenticated");

      // Safe by default: anything other than an explicit `false` reports only.
      const dryRun = args.dry_run !== false;
      const rowsPerTable = args.rows_per_table ?? 20;

      // The mutating wrapper is admin-only. Planning callers never reach here.
      if (!dryRun && identity.role !== "admin" && identity.role !== "ob-admin") {
        return errorResult("Permission denied: admin permission required for dry_run=false");
      }

      const requested: readonly ResourceTable[] = args.table ? [args.table] : ALL_TABLES;
      const accessible = requested.filter((table) => canRead(identity.role, table));
      if (accessible.length === 0) return errorResult("Permission denied: no readable tables");

      const result: CurateResult = {
        mode: args.mode,
        dry_run: dryRun,
        tables_processed: [...accessible],
        duplicates: [],
        stale: [],
        vague: [],
        summary: { duplicates_found: 0, stale_found: 0, vague_found: 0, archived: 0 },
      };

      for (const table of accessible) {
        const preview = CONTENT_PREVIEW[table];

        if (args.mode === "duplicates" || args.mode === "all") {
          const readPredicate = namespacePredicate(identity, "read", 3);
          const { rows } = await dependencies.pool.query(
            `SELECT a.id AS id_a, b.id AS id_b, a.embedding <=> b.embedding AS distance
               FROM ${table} a
               JOIN ${table} b ON a.id < b.id
                AND b.archived_at IS NULL AND b.embedding IS NOT NULL
                AND b.namespace = a.namespace
              WHERE a.archived_at IS NULL AND a.embedding IS NOT NULL
                AND a.embedding <=> b.embedding < $1
                ${qualifyNamespacePredicate(readPredicate, "a.namespace", 3)}
              ORDER BY distance ASC
              FETCH FIRST $2 ROWS ONLY`,
            [DUPLICATE_THRESHOLD, rowsPerTable, ...readPredicate.values],
          );
          for (const row of rows) {
            let action = "would_archive_older";
            if (!dryRun) {
              await archiveRow(dependencies, identity, table, row.id_a);
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

        if (args.mode === "stale" || args.mode === "all") {
          const readPredicate = namespacePredicate(identity, "read", 3);
          const { rows } = await dependencies.pool.query(
            `SELECT id, ${preview} AS content_preview
               FROM ${table}
              WHERE archived_at IS NULL
                AND created_at < NOW() - INTERVAL '1 day' * $1
                AND COALESCE(access_count, 0) = 0
                ${readPredicate.clause}
              FETCH FIRST $2 ROWS ONLY`,
            [STALE_DAYS, rowsPerTable, ...readPredicate.values],
          );
          for (const row of rows) {
            let action = "would_flag";
            if (!dryRun) {
              await archiveRow(dependencies, identity, table, row.id);
              action = "archived";
              result.summary.archived++;
            }
            result.stale.push({
              table,
              id: row.id,
              preview: previewOf(row.content_preview),
              action,
            });
          }
          result.summary.stale_found += rows.length;
        }

        if (args.mode === "vague" || args.mode === "all") {
          const readPredicate = namespacePredicate(identity, "read", 2);
          const { rows } = await dependencies.pool.query(
            `SELECT id, ${preview} AS content_preview
               FROM ${table}
              WHERE archived_at IS NULL
                AND (usefulness_score IS NULL OR usefulness_score < 0.3)
                AND (tags IS NULL OR array_length(tags, 1) IS NULL)
                ${readPredicate.clause}
              FETCH FIRST $1 ROWS ONLY`,
            [rowsPerTable, ...readPredicate.values],
          );
          for (const row of rows) {
            // Vague entries are ALWAYS report-only, even when dry_run is false.
            result.vague.push({
              table,
              id: row.id,
              preview: previewOf(row.content_preview),
              action: "flagged_for_review",
            });
          }
          result.summary.vague_found += rows.length;
        }
      }

      dependencies.logger.info(
        { tool: "curate_entries", mode: args.mode, dryRun, ...result.summary },
        "tool_result",
      );
      return textResult(result);
    },
  );

  server.registerTool(
    "archive_entry",
    {
      description:
        "Soft-delete a brain entry by setting archived_at. Only admin and ob-admin roles can archive.",
      inputSchema: {
        table: tableEnum,
        id: z.string().uuid(),
      },
      annotations: {
        title: "Archive Entry",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      if (!identity || !canDelete(identity.role, args.table)) {
        return errorResult("Permission denied: cannot archive entries");
      }
      const predicate = namespacePredicate(identity, "delete", 2);
      const { rows } = await dependencies.pool.query(
        `UPDATE ${args.table} SET archived_at = NOW()
          WHERE id = $1 AND archived_at IS NULL${predicate.clause}
        RETURNING id`,
        [args.id, ...predicate.values],
      );
      if (rows.length === 0) {
        dependencies.logger.info({ tool: "archive_entry", table: args.table }, "tool_noop");
        return textResult("Already archived or not found");
      }
      dependencies.logger.info(
        { tool: "archive_entry", table: args.table, id: rows[0].id },
        "tool_result",
      );
      return textResult({ id: rows[0].id, table: args.table, archived: true });
    },
  );

  server.registerTool(
    "rate_entry",
    {
      description:
        "Rate a brain entry's usefulness on a 0.0-1.0 scale. Requires write permission.",
      inputSchema: {
        table: tableEnum,
        id: z.string().uuid(),
        score: z.number().min(0).max(1),
      },
      annotations: {
        title: "Rate Entry",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      const auth = authorize(identity, "write", args.table, `cannot write to ${args.table}`);
      if (!auth.ok) return auth.response;
      const predicate = namespacePredicate(auth.identity, "write", 3);
      const { rows } = await dependencies.pool.query(
        `UPDATE ${args.table} SET usefulness_score = $1
          WHERE id = $2 AND archived_at IS NULL${predicate.clause}
        RETURNING id, usefulness_score`,
        [args.score, args.id, ...predicate.values],
      );
      if (rows.length === 0) {
        dependencies.logger.info({ tool: "rate_entry", table: args.table }, "tool_noop");
        return errorResult("Cannot rate archived entry");
      }
      dependencies.logger.info(
        { tool: "rate_entry", table: args.table, id: rows[0].id },
        "tool_result",
      );
      return textResult({
        id: rows[0].id,
        table: args.table,
        usefulness_score: rows[0].usefulness_score,
      });
    },
  );
}
