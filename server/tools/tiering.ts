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
import { namespacePredicate } from "../auth/namespace-policy.ts";
import type { ResourceTable } from "../auth/types.ts";
import { authIdentity, errorResult, textResult, type MemoryToolDependencies } from "./types.ts";
import { ALL_TABLES, PREVIEW_WIDTH, qualifyNamespacePredicate } from "./curation-helpers.ts";

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
}
