/**
 * Tiering recommendation and staleness reporting.
 *
 * Design authority: `docs/decisions/cognitive-tiering-dream-cycle.md` and
 * `docs/dream-design.md`.
 *
 * EVERY TOOL IN THIS FILE IS READ-ONLY. `tier_recommendations` proposes tier
 * changes and `list_stale` reports decay candidates; neither writes a tier, an
 * archive, or a promotion. That is the dream-cycle contract: phases 1-3 score
 * and recommend, and any actual mutation goes through a separate, explicitly
 * invoked tier tool. A recommendation path that mutated would make the cycle
 * unreviewable, which is the exact failure the dry-run default exists to stop.
 *
 * `entry_access_log` is read as a LOG, never as a counter (per the schema
 * rationale): recency and frequency come from timestamped rows. No index is
 * added on that table here -- `008_index_cleanup.sql` removed the unused ones,
 * and a new index without a reading consumer would repeat that mistake.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../auth/permissions.ts";
import {
  namespacePredicate,
  type NamespacePredicate,
} from "../auth/namespace-policy.ts";
import type { ResourceTable } from "../auth/types.ts";
import { authIdentity, errorResult, textResult, type MemoryToolDependencies } from "./types.ts";
import {
  ALL_TABLES,
  PREVIEW_WIDTH,
  SOURCE_LABELS,
  TIERS,
  qualifyNamespacePredicate,
  tableEnum,
  tierEnum,
  type Tier,
} from "./curation-helpers.ts";

/** Query alias per table, matching observed current-src SQL. */
const TABLE_ALIAS: Readonly<Record<ResourceTable, string>> = {
  thoughts: "t",
  decisions: "d",
  relationships: "r",
  projects: "p",
  sessions: "s",
};

/**
 * Alias-qualified preview expression per table.
 *
 * Written out rather than derived from `CONTENT_PREVIEW` by pattern-replacing
 * column names: a rewrite like that also edits any matching word inside a
 * string literal, so it would corrupt the expression the first time a preview
 * gained one. These are static SQL fragments, never caller input.
 */
const ALIASED_PREVIEW: Readonly<Record<ResourceTable, string>> = {
  thoughts: "t.content",
  decisions: "d.title || ': ' || d.rationale",
  relationships: "r.person_name || ': ' || COALESCE(r.context, '')",
  projects: "p.name || ': ' || COALESCE(p.description, '')",
  sessions: "COALESCE(s.project || ': ', '') || LEFT(s.summary, 200)",
};

interface TierCandidate {
  id: string;
  table: string;
  content_preview: string;
  current_tier: string;
  suggested_tier: string;
  access_count: number;
  recent_accesses?: number;
  last_accessed_at: string | null;
  reasoning: string;
}

export function registerTieringTools(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "tier_recommendations",
    {
      description:
        "Get tier change recommendations based on access patterns. Suggests entries to promote (cold/warm -> hot) or demote (warm -> cold).",
      inputSchema: {
        action: z.enum(["promote", "demote"]),
        threshold_days: z.number().int().min(1).max(365).optional(),
        candidates: z.number().int().min(1).max(100).optional(),
      },
      annotations: {
        title: "Tier Recommendations",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      if (!identity) return errorResult("Permission denied: not authenticated");
      const accessible = ALL_TABLES.filter((table) => canRead(identity.role, table));
      if (accessible.length === 0) return errorResult("Permission denied: no readable tables");

      const wanted = args.candidates ?? 20;
      const thresholdDays = args.threshold_days ?? (args.action === "demote" ? 30 : 7);
      const candidates: TierCandidate[] = [];

      for (const table of accessible) {
        if (candidates.length >= wanted) break;
        const remaining = wanted - candidates.length;
        const alias = TABLE_ALIAS[table];
        const preview = ALIASED_PREVIEW[table];
        const predicate = namespacePredicate(identity, "read", 3);
        const scoped = qualifyNamespacePredicate(predicate, `${alias}.namespace`, 3);
        const params = [thresholdDays, remaining, ...predicate.values];

        if (args.action === "demote") {
          const { rows } = await dependencies.pool.query(
            `SELECT ${alias}.id,
                    LEFT(${preview}, ${PREVIEW_WIDTH}) AS content_preview,
                    COALESCE(${alias}.tier, 'warm') AS tier,
                    COALESCE(${alias}.access_count, 0) AS access_count,
                    ${alias}.last_accessed_at
               FROM ${table} ${alias}
              WHERE ${alias}.archived_at IS NULL
                AND COALESCE(${alias}.tier, 'warm') = 'warm'
                AND (${alias}.last_accessed_at IS NULL
                     OR ${alias}.last_accessed_at < NOW() - INTERVAL '1 day' * $1)
                AND COALESCE(${alias}.access_count, 0) < 3
                ${scoped}
              ORDER BY COALESCE(${alias}.access_count, 0) ASC, ${alias}.created_at ASC
              FETCH FIRST $2 ROWS ONLY`,
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
          // Recency/frequency come from the access LOG, not a lossy counter.
          const { rows } = await dependencies.pool.query(
            `SELECT sub.id, sub.content_preview, sub.tier, sub.access_count,
                    sub.last_accessed_at, sub.recent_accesses
               FROM (
                 SELECT ${alias}.id,
                        LEFT(${preview}, ${PREVIEW_WIDTH}) AS content_preview,
                        COALESCE(${alias}.tier, 'warm') AS tier,
                        COALESCE(${alias}.access_count, 0) AS access_count,
                        ${alias}.last_accessed_at,
                        (SELECT COUNT(*) FROM entry_access_log eal
                          WHERE eal.entry_id = ${alias}.id
                            AND eal.source_table = $3
                            AND eal.accessed_at >= NOW() - INTERVAL '1 day' * $1) AS recent_accesses
                   FROM ${table} ${alias}
                  WHERE ${alias}.archived_at IS NULL
                    AND COALESCE(${alias}.tier, 'warm') IN ('warm', 'cold')
                    ${qualifyNamespacePredicate(predicate, `${alias}.namespace`, 4)}
               ) sub
              WHERE sub.recent_accesses > 5
              ORDER BY sub.recent_accesses DESC
              FETCH FIRST $2 ROWS ONLY`,
            [thresholdDays, remaining, table, ...predicate.values],
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

      dependencies.logger.info(
        { tool: "tier_recommendations", action: args.action, candidatesFound: candidates.length },
        "tool_result",
      );
      return textResult({
        action: args.action,
        threshold_days: thresholdDays,
        candidates_found: candidates.length,
        candidates,
      });
    },
  );

  server.registerTool(
    "list_stale",
    {
      description:
        "Find brain entries not accessed recently -- candidates for tier demotion (hot->warm->cold). " +
        "Queries by last_accessed_at (falls back to created_at for never-accessed entries). " +
        "Returns {entries, total_count, has_more} envelope by default, or raw array with response_format='array'. " +
        "Resilient parsing: const entries = Array.isArray(result) ? result : result.entries ?? [];",
      inputSchema: {
        table: tableEnum.optional().describe("Optional: filter to a specific table"),
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe(
            "Entries not accessed in this many days are considered stale (default 30)",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Maximum entries to return (default 50, max 500)"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Number of entries to skip for pagination (default 0)"),
        tier: tierEnum
          .optional()
          .describe(
            "Optional: filter to a specific tier (e.g. 'hot' to find hot entries that should decay to warm)",
          ),
        response_format: z
          .enum(["envelope", "array"])
          .optional()
          .describe(
            "Response format: 'envelope' (default) returns {entries, total_count, has_more}; 'array' returns raw array for backwards compatibility",
          ),
      },
      annotations: {
        title: "List Stale",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      if (!identity) return errorResult("Permission denied: no readable tables");

      // A named table the caller cannot read is a distinct refusal from having
      // no readable tables at all, matching observed current-src wording.
      let accessible: readonly ResourceTable[];
      if (args.table) {
        if (!canRead(identity.role, args.table)) {
          return errorResult(`Permission denied: cannot read ${args.table}`);
        }
        accessible = [args.table];
      } else {
        accessible = ALL_TABLES.filter((table) => canRead(identity.role, table));
      }
      if (accessible.length === 0) {
        return errorResult("Permission denied: no readable tables");
      }

      const days = args.days ?? 30;
      const rowCap = args.limit ?? 50;
      const offset = args.offset ?? 0;
      const useArray = args.response_format === "array";

      // The data query binds $1..$3 before the namespace values; the count
      // query binds only $1, so its namespace values start one slot later.
      const dataPredicate = namespacePredicate(identity, "read", 4);
      const countPredicate = namespacePredicate(identity, "read", 2);

      const selects = accessible.map((table) =>
        buildStaleSelect(table, args.tier, dataPredicate, 4),
      );
      const sql = `${selects.join("\nUNION ALL\n")}
        ORDER BY effective_last_access ASC
        LIMIT $2 OFFSET $3`;

      const countSelects = accessible.map((table) =>
        buildStaleCountSelect(table, args.tier, countPredicate, 2),
      );
      const countSql = `SELECT SUM(cnt)::int AS total_count FROM (${countSelects.join("\nUNION ALL\n")}) counts`;

      const [dataResult, countResult] = await Promise.all([
        dependencies.pool.query(sql, [days, rowCap, offset, ...dataPredicate.values]),
        dependencies.pool
          .query(countSql, [days, ...countPredicate.values])
          .catch(() => null),
      ]);

      const totalCount = countResult?.rows[0]?.total_count ?? null;
      const hasMore =
        totalCount !== null ? offset + dataResult.rows.length < totalCount : false;

      dependencies.logger.info(
        { tool: "list_stale", tables: accessible.length, days },
        "tool_result",
      );

      return textResult(
        useArray
          ? dataResult.rows
          : {
              entries: dataResult.rows,
              total_count: totalCount,
              offset,
              limit: rowCap,
              has_more: hasMore,
            },
      );
    },
  );
}

/**
 * Staleness WHERE clause shared by the data and count queries.
 *
 * The tier value reaches an interpolated position, so it is narrowed by
 * `tierEnum` at the schema boundary first -- nothing outside the three tier
 * literals can arrive here. `$1` is always the day threshold.
 */
function staleWhereClause(
  alias: string,
  tier: Tier | undefined,
  predicate: NamespacePredicate,
  namespaceParameter: number,
): string {
  if (tier && !TIERS.includes(tier)) throw new Error(`Invalid tier: ${tier}`);
  const tierFilter = tier ? ` AND ${alias}.tier = '${tier}'` : "";
  const scoped = qualifyNamespacePredicate(
    predicate,
    `${alias}.namespace`,
    namespaceParameter,
  );
  return `WHERE ${alias}.archived_at IS NULL
    AND COALESCE(${alias}.last_accessed_at, ${alias}.created_at) < NOW() - INTERVAL '1 day' * $1${tierFilter}${scoped}`;
}

/** One arm of the stale UNION, reproducing the observed current-src columns. */
function buildStaleSelect(
  table: ResourceTable,
  tier: Tier | undefined,
  predicate: NamespacePredicate,
  namespaceParameter: number,
): string {
  const alias = TABLE_ALIAS[table];
  return `SELECT
    '${SOURCE_LABELS[table]}' AS source_type,
    ${alias}.id,
    LEFT(${ALIASED_PREVIEW[table]}, ${PREVIEW_WIDTH}) AS content_preview,
    ${alias}.tags,
    ${alias}.tier,
    ${alias}.access_count,
    ${alias}.last_accessed_at,
    ${alias}.created_at,
    COALESCE(${alias}.last_accessed_at, ${alias}.created_at) AS effective_last_access
  FROM ${table} ${alias}
  ${staleWhereClause(alias, tier, predicate, namespaceParameter)}`;
}

/** Count arm matching `buildStaleSelect`'s predicate exactly. */
function buildStaleCountSelect(
  table: ResourceTable,
  tier: Tier | undefined,
  predicate: NamespacePredicate,
  namespaceParameter: number,
): string {
  const alias = TABLE_ALIAS[table];
  return `SELECT COUNT(*) AS cnt
  FROM ${table} ${alias}
  ${staleWhereClause(alias, tier, predicate, namespaceParameter)}`;
}
