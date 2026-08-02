/**
 * `get_entry`: fetch one readable entry by table and id.
 *
 * This is the fetch path `resolve_entry` hands back, so the two agree on what
 * "readable" means: the same auth-derived namespace predicate is applied to the
 * SELECT itself, never checked in a prior statement. An ID-based read without
 * that predicate returns the row from whatever namespace happens to own the
 * UUID, which is the isolation bug class this repo's rules name explicitly.
 *
 * Two render shapes, both observed from `src/tools/get-entry.ts`:
 *
 *   - `full` (default) returns the table's own projection.
 *   - `compact` returns a bounded preview envelope. The preview width is an
 *     EXISTING observed current-src argument reproduced for parity, not a new
 *     one introduced here.
 *
 * `source_scope` is deliberately absent. Current-src accepts it via
 * `src/source-refs.ts`, which the server rewrite has not ported on any wave --
 * the ported `search_brain` omits it identically. Porting that subsystem here
 * would make this the only surface that understands it, so the argument stays
 * unported alongside its module and is named in the gap map's reason text
 * rather than half-implemented.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../auth/permissions.ts";
import { namespacePredicate } from "../auth/namespace-policy.ts";
import type { ResourceTable } from "../auth/types.ts";
import { authIdentity, errorResult, textResult, type MemoryToolDependencies } from "./types.ts";
import { SOURCE_LABELS, tableEnum } from "./curation-helpers.ts";

/** Observed current-src default preview width for the compact envelope. */
const DEFAULT_COMPACT_MAX_CHARS = 500;

/**
 * Full-row projection per table, observed from `src/table-projections.ts`.
 *
 * Column lists are compile-time literals selected by a `tableEnum`-validated
 * key, never caller text, so the interpolation is inside the same allowlist the
 * table name itself passes through.
 */
const TABLE_COLUMNS: Readonly<Record<ResourceTable, string>> = {
  thoughts:
    "id, content, tags, source, created_by, created_at, updated_at, tier, usefulness_score, access_count, last_accessed_at, extracted_metadata, namespace, promoted_from",
  decisions:
    "id, title, rationale, alternatives, context, tags, created_by, created_at, updated_at, tier, usefulness_score, access_count, last_accessed_at, extracted_metadata, namespace, promoted_from",
  relationships:
    "id, person_name, context, relationship_type, warmth, email, phone, tags, metadata, created_by, created_at, tier, usefulness_score, access_count, namespace, promoted_from",
  projects:
    "id, name, status, description, metadata, tags, created_by, created_at, tier, usefulness_score, access_count, namespace, promoted_from",
  sessions:
    "id, session_id, project, summary, tags, blockers, next_steps, key_decisions, created_by, created_at, updated_at, tier, namespace, promoted_from",
};

/**
 * Compact content expression per table, observed from `src/tools/get-entry.ts`.
 *
 * `sessions` differs from the shared curation preview: it folds decisions and
 * next steps into the text rather than slicing the summary, which is the shape
 * current-src returns and therefore the shape clients parse.
 */
const COMPACT_CONTENT: Readonly<Record<ResourceTable, string>> = {
  thoughts: "content",
  decisions: "title || ': ' || rationale",
  relationships: "person_name || ': ' || COALESCE(context, '')",
  projects: "name || ': ' || COALESCE(description, '')",
  sessions:
    "COALESCE(project || ': ', '') || COALESCE(summary, '')" +
    " || CASE WHEN key_decisions IS NOT NULL AND array_length(key_decisions, 1) > 0" +
    " THEN E'\\nDecisions: ' || immutable_array_to_string(key_decisions, '; ') ELSE '' END" +
    " || CASE WHEN next_steps IS NOT NULL AND array_length(next_steps, 1) > 0" +
    " THEN E'\\nNext: ' || immutable_array_to_string(next_steps, '; ') ELSE '' END",
};

/** Tables whose rows carry no `updated_at`, observed from the live schema. */
const WITHOUT_UPDATED_AT = new Set<ResourceTable>(["relationships", "projects"]);

export function registerGetEntryTool(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "get_entry",
    {
      description:
        "Fetch a readable entry by table and ID. Defaults to full content; use render=compact for a bounded exact-UUID preview.",
      inputSchema: {
        table: tableEnum.describe(
          "Which table the entry is in (from search result source_type + 's')",
        ),
        id: z.string().uuid().describe("Entry UUID from search results"),
        render: z
          .enum(["full", "compact"])
          .optional()
          .describe(
            "Response shape: full returns the complete row (default); compact returns a bounded preview envelope.",
          ),
        max_chars: z
          .number()
          .int()
          .min(80)
          .max(2000)
          .optional()
          .describe(
            "Maximum compact content_preview length in characters (default 500, max 2000). Ignored for full render.",
          ),
      },
      annotations: {
        title: "Get Entry",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      const table = args.table as ResourceTable;
      if (!identity || !canRead(identity.role, table)) {
        return errorResult(`Permission denied: cannot read ${table}`);
      }

      // Found-but-unreadable and genuinely-absent collapse to ONE error string,
      // so a caller cannot use this tool to probe which UUIDs exist in a
      // namespace it has no read authority over.
      const notFound = errorResult("Entry not found or archived");
      const predicate = namespacePredicate(identity, "read", 2);

      if ((args.render ?? "full") === "compact") {
        const maxChars = args.max_chars ?? DEFAULT_COMPACT_MAX_CHARS;
        const parameters: unknown[] = [args.id, ...predicate.values];
        parameters.push(maxChars);
        const maxCharsParameter = `$${parameters.length}`;
        const updatedAt = WITHOUT_UPDATED_AT.has(table)
          ? "NULL::timestamptz"
          : "updated_at";
        const contentExpression =
          `regexp_replace(COALESCE((${COMPACT_CONTENT[table]})::text, ''), '[[:space:]]+', ' ', 'g')`;

        const { rows } = await dependencies.pool.query(
          `SELECT entry.id, entry.namespace, entry.created_by, entry.created_at,
                  entry.updated_at, entry.tier, entry.tags,
                  LEFT(entry.content_text, ${maxCharsParameter}) AS content_preview,
                  length(entry.content_text) AS content_length,
                  length(entry.content_text) > ${maxCharsParameter} AS content_truncated
             FROM (
               SELECT id, namespace, created_by, created_at, ${updatedAt} AS updated_at,
                      tier, tags, ${contentExpression} AS content_text
                 FROM ${table}
                WHERE id = $1 AND archived_at IS NULL${predicate.clause}
             ) entry`,
          parameters,
        );
        if (rows.length === 0) return notFound;

        const row = rows[0] as Record<string, unknown>;
        const namespace = typeof row.namespace === "string" ? row.namespace : null;
        const sourceType = SOURCE_LABELS[table];
        dependencies.logger.info({ tool: "get_entry", render: "compact" }, "tool_result");
        return textResult({
          id: row.id,
          table,
          source_type: sourceType,
          namespace,
          render: "compact",
          max_chars: maxChars,
          content_preview: row.content_preview,
          content_length: Number(row.content_length ?? 0),
          content_truncated: Boolean(row.content_truncated),
          created_by: row.created_by,
          created_at: row.created_at,
          updated_at: row.updated_at,
          tier: row.tier,
          tags: row.tags,
          source_ref: { source: "brain", type: sourceType, id: row.id, namespace },
          full_available: true,
          fetch_path: { tool: "get_entry", arguments: { table, id: row.id, render: "full" } },
        });
      }

      const { rows } = await dependencies.pool.query(
        `SELECT ${TABLE_COLUMNS[table]} FROM ${table}
          WHERE id = $1 AND archived_at IS NULL${predicate.clause}`,
        [args.id, ...predicate.values],
      );
      if (rows.length === 0) return notFound;
      dependencies.logger.info({ tool: "get_entry", render: "full" }, "tool_result");
      return textResult(rows[0]);
    },
  );
}
