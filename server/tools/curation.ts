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
 *
 * The three scan modes share one helper, `collectScan`, because they differ
 * only in their query and how a row becomes a finding. The dry-run decision
 * itself is NOT part of that shared code: each caller passes its own
 * `onArchive`, and the `vague` mode passes none at all, so report-only stays a
 * property of the call site rather than a flag the shared helper interprets.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canDelete, canRead } from "../auth/permissions.ts";
import { namespacePredicate } from "../auth/namespace-policy.ts";
import type { AuthIdentity, ResourceTable } from "../auth/types.ts";
import {
  authIdentity,
  errorResult,
  textResult,
  type MemoryToolDependencies,
} from "./types.ts";
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

/** One scan mode's query and the shape it turns a row into. */
interface ScanSpec<Finding> {
  dependencies: MemoryToolDependencies;
  /** SQL to run, and the values its placeholders bind. */
  query: { text: string; values: readonly unknown[] };
  /**
   * The row's id, when the mode may archive it. Omitted by report-only modes,
   * which is what keeps `vague` non-mutating without a flag.
   */
  archiveId?: (row: Record<string, unknown>) => string;
  /** Runs only when the mode may archive AND the caller opted into mutation. */
  onArchive?: (id: string) => Promise<void>;
  /** Builds the finding, given the action label the archive decision produced. */
  toFinding: (row: Record<string, unknown>, action: string) => Finding;
  /** Label used when nothing was archived for this row. */
  reportAction: string;
}

/**
 * Run one scan mode and collect its findings.
 *
 * @returns The findings, and how many rows were archived while collecting them.
 */
async function collectScan<Finding>(
  spec: ScanSpec<Finding>,
): Promise<{ findings: Finding[]; archived: number; scanned: number }> {
  const { rows } = await spec.dependencies.pool.query(spec.query.text, [
    ...spec.query.values,
  ]);
  const findings: Finding[] = [];
  let archived = 0;
  for (const row of rows) {
    let action = spec.reportAction;
    const id = spec.archiveId?.(row);
    if (spec.onArchive && id !== undefined) {
      await spec.onArchive(id);
      action = "archived";
      archived++;
    }
    findings.push(spec.toFinding(row, action));
  }
  return { findings, archived, scanned: rows.length };
}

/** Inputs every per-table scan shares. */
interface ScanContext {
  dependencies: MemoryToolDependencies;
  identity: AuthIdentity;
  table: ResourceTable;
  rowsPerTable: number;
  /** Present only when the caller opted into mutation AND is admin-tier. */
  archive?: (id: string) => Promise<void>;
}

/** Detect near-identical pairs in one table, archiving the older on opt-in. */
async function scanDuplicates(
  context: ScanContext,
): Promise<{
  findings: CurateResult["duplicates"];
  archived: number;
  scanned: number;
}> {
  const readPredicate = namespacePredicate(context.identity, "read", 3);
  return collectScan({
    dependencies: context.dependencies,
    query: {
      text: `SELECT a.id AS id_a, b.id AS id_b, a.embedding <=> b.embedding AS distance
               FROM ${context.table} a
               JOIN ${context.table} b ON a.id < b.id
                AND b.archived_at IS NULL AND b.embedding IS NOT NULL
                AND b.namespace = a.namespace
              WHERE a.archived_at IS NULL AND a.embedding IS NOT NULL
                AND a.embedding <=> b.embedding < $1
                ${qualifyNamespacePredicate(readPredicate, "a.namespace", 3)}
              ORDER BY distance ASC
              FETCH FIRST $2 ROWS ONLY`,
      values: [
        DUPLICATE_THRESHOLD,
        context.rowsPerTable,
        ...readPredicate.values,
      ],
    },
    archiveId: (row) => String(row.id_a),
    onArchive: context.archive,
    reportAction: "would_archive_older",
    toFinding: (row, action) => ({
      table: context.table,
      entry_a: String(row.id_a),
      entry_b: String(row.id_b),
      distance: Number(row.distance),
      action,
    }),
  });
}

/** Flag entries never accessed and older than the stale window. */
async function scanStale(
  context: ScanContext,
): Promise<{
  findings: CurateResult["stale"];
  archived: number;
  scanned: number;
}> {
  const readPredicate = namespacePredicate(context.identity, "read", 3);
  return collectScan({
    dependencies: context.dependencies,
    query: {
      text: `SELECT id, ${CONTENT_PREVIEW[context.table]} AS content_preview
               FROM ${context.table}
              WHERE archived_at IS NULL
                AND created_at < NOW() - INTERVAL '1 day' * $1
                AND COALESCE(access_count, 0) = 0
                ${readPredicate.clause}
              FETCH FIRST $2 ROWS ONLY`,
      values: [STALE_DAYS, context.rowsPerTable, ...readPredicate.values],
    },
    archiveId: (row) => String(row.id),
    onArchive: context.archive,
    reportAction: "would_flag",
    toFinding: (row, action) => ({
      table: context.table,
      id: String(row.id),
      preview: previewOf(row.content_preview),
      action,
    }),
  });
}

/**
 * Flag low-value untagged entries.
 *
 * Passes no `onArchive`, so vague entries are ALWAYS report-only even when
 * `dry_run` is false -- the same guarantee the previous inline branch made by
 * simply having no mutation path.
 */
async function scanVague(
  context: ScanContext,
): Promise<{
  findings: CurateResult["vague"];
  archived: number;
  scanned: number;
}> {
  const readPredicate = namespacePredicate(context.identity, "read", 2);
  return collectScan({
    dependencies: context.dependencies,
    query: {
      text: `SELECT id, ${CONTENT_PREVIEW[context.table]} AS content_preview
               FROM ${context.table}
              WHERE archived_at IS NULL
                AND (usefulness_score IS NULL OR usefulness_score < 0.3)
                AND (tags IS NULL OR array_length(tags, 1) IS NULL)
                ${readPredicate.clause}
              FETCH FIRST $1 ROWS ONLY`,
      values: [context.rowsPerTable, ...readPredicate.values],
    },
    reportAction: "flagged_for_review",
    toFinding: (row) => ({
      table: context.table,
      id: String(row.id),
      preview: previewOf(row.content_preview),
      action: "flagged_for_review",
    }),
  });
}

/** Run every mode the request selected across one table, folding into `result`. */
async function curateTable(
  context: ScanContext,
  mode: string,
  result: CurateResult,
): Promise<void> {
  if (mode === "duplicates" || mode === "all") {
    const scan = await scanDuplicates(context);
    result.duplicates.push(...scan.findings);
    result.summary.duplicates_found += scan.scanned;
    result.summary.archived += scan.archived;
  }
  if (mode === "stale" || mode === "all") {
    const scan = await scanStale(context);
    result.stale.push(...scan.findings);
    result.summary.stale_found += scan.scanned;
    result.summary.archived += scan.archived;
  }
  if (mode === "vague" || mode === "all") {
    const scan = await scanVague(context);
    result.vague.push(...scan.findings);
    result.summary.vague_found += scan.scanned;
    result.summary.archived += scan.archived;
  }
}

/** Register `curate_entries`: the dry-run-by-default discovery surface. */
function registerCurateEntries(
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
      if (
        !dryRun &&
        identity.role !== "admin" &&
        identity.role !== "ob-admin"
      ) {
        return errorResult(
          "Permission denied: admin permission required for dry_run=false",
        );
      }

      const requested: readonly ResourceTable[] = args.table
        ? [args.table]
        : ALL_TABLES;
      const accessible = requested.filter((table) =>
        canRead(identity.role, table),
      );
      if (accessible.length === 0)
        return errorResult("Permission denied: no readable tables");

      const result: CurateResult = {
        mode: args.mode,
        dry_run: dryRun,
        tables_processed: [...accessible],
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

      for (const table of accessible) {
        await curateTable(
          {
            dependencies,
            identity,
            table,
            rowsPerTable,
            // The ONLY place mutation is wired in. Dry-run leaves it undefined,
            // so no scan below has an archive path to take at all.
            archive: dryRun
              ? undefined
              : (id: string) => archiveRow(dependencies, identity, table, id),
          },
          args.mode,
          result,
        );
      }

      dependencies.logger.info(
        { tool: "curate_entries", mode: args.mode, dryRun, ...result.summary },
        "tool_result",
      );
      return textResult(result);
    },
  );
}

/** Register `archive_entry`: explicit single-row soft delete. */
function registerArchiveEntry(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
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
        dependencies.logger.info(
          { tool: "archive_entry", table: args.table },
          "tool_noop",
        );
        return textResult("Already archived or not found");
      }
      dependencies.logger.info(
        { tool: "archive_entry", table: args.table, id: rows[0].id },
        "tool_result",
      );
      return textResult({ id: rows[0].id, table: args.table, archived: true });
    },
  );
}

/** Register `rate_entry`: usefulness scoring under the write predicate. */
function registerRateEntry(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
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
      const auth = authorize(
        identity,
        "write",
        args.table,
        `cannot write to ${args.table}`,
      );
      if (!auth.ok) return auth.response;
      const predicate = namespacePredicate(auth.identity, "write", 3);
      const { rows } = await dependencies.pool.query(
        `UPDATE ${args.table} SET usefulness_score = $1
          WHERE id = $2 AND archived_at IS NULL${predicate.clause}
        RETURNING id, usefulness_score`,
        [args.score, args.id, ...predicate.values],
      );
      if (rows.length === 0) {
        dependencies.logger.info(
          { tool: "rate_entry", table: args.table },
          "tool_noop",
        );
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

export function registerCurationTools(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  registerCurateEntries(server, dependencies);
  registerArchiveEntry(server, dependencies);
  registerRateEntry(server, dependencies);
}
