import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../permissions.ts";
import { readableNamespaces } from "../read-policy.ts";
import type { AuthInfo, Table } from "../types.ts";
import type { ToolDeps } from "./index.ts";
import { TABLE_COLUMNS } from "../table-projections.ts";
import {
  appendSourceScopeParam,
  filterSourceRefsForScope,
  sourceScopeAuthorizationError,
  sourceScopeFilterSql,
  sourceScopeSchema,
  type SourceScope,
} from "../source-refs.ts";
import {
  CONTENT_PREVIEW,
  SOURCE_LABELS,
  TABLE_ALIAS,
} from "./table-constants.ts";

const DEFAULT_COMPACT_MAX_CHARS = 500;

const COMPACT_CONTENT: Record<Table, string> = {
  ...CONTENT_PREVIEW,
  sessions:
    "COALESCE(s.project || ': ', '') || COALESCE(s.summary, '')" +
    " || CASE WHEN s.key_decisions IS NOT NULL AND array_length(s.key_decisions, 1) > 0" +
    " THEN E'\\nDecisions: ' || immutable_array_to_string(s.key_decisions, '; ') ELSE '' END" +
    " || CASE WHEN s.next_steps IS NOT NULL AND array_length(s.next_steps, 1) > 0" +
    " THEN E'\\nNext: ' || immutable_array_to_string(s.next_steps, '; ') ELSE '' END",
};

export function registerGetEntry(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "get_entry",
    {
      description:
        "Fetch a readable entry by table and ID. Defaults to full content; use render=compact for a bounded exact-UUID preview.",
      inputSchema: {
        table: z
          .enum([
            "thoughts",
            "decisions",
            "relationships",
            "projects",
            "sessions",
          ])
          .describe(
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
        source_scope: sourceScopeSchema
          .optional()
          .describe(
            "Optional: require matching source_refs client_id, matter_id, document_id, path, or dms_id before returning source_refs",
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
      const auth = extra.authInfo as AuthInfo | undefined;
      const table = args.table as Table;

      if (!auth || !canRead(auth.role, table)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Permission denied: cannot read ${table}`,
            },
          ],
          isError: true,
        };
      }

      const render = args.render ?? "full";
      const sourceScope = args.source_scope as SourceScope | undefined;
      const sourceScopeError = sourceScopeAuthorizationError(auth, sourceScope);
      if (sourceScopeError) {
        return {
          content: [{ type: "text" as const, text: sourceScopeError }],
          isError: true,
        };
      }
      if (render === "compact") {
        const maxChars = args.max_chars ?? DEFAULT_COMPACT_MAX_CHARS;
        const alias = TABLE_ALIAS[table];
        const compactContent = COMPACT_CONTENT[table];
        const sourceType = SOURCE_LABELS[table];
        const updatedAtExpr =
          table === "relationships" || table === "projects"
            ? "NULL::timestamptz"
            : `${alias}.updated_at`;
        const params: unknown[] = [args.id];
        let namespacePredicate = "";
        const readable = readableNamespaces(auth);
        if (readable) {
          params.push(readable);
          namespacePredicate = ` AND ${alias}.namespace = ANY($${params.length}::text[])`;
        }
        const sourceScopeParamIndex = appendSourceScopeParam(
          params,
          sourceScope,
        );
        const sourceScopeFilter = sourceScopeFilterSql(
          alias,
          sourceScopeParamIndex,
        );
        params.push(maxChars);
        const maxCharsParam = `$${params.length}`;
        const contentExpr = `regexp_replace(COALESCE((${compactContent})::text, ''), '[[:space:]]+', ' ', 'g')`;
        const { rows } = await deps.pool.query(
          `SELECT entry.id, entry.namespace, entry.created_by, entry.created_at, entry.updated_at, entry.tier, entry.tags,
            LEFT(entry.content_text, ${maxCharsParam}) AS content_preview,
            length(entry.content_text) AS content_length,
            length(entry.content_text) > ${maxCharsParam} AS content_truncated
           FROM (
             SELECT ${alias}.id, ${alias}.namespace, ${alias}.created_by, ${alias}.created_at, ${updatedAtExpr} AS updated_at, ${alias}.tier, ${alias}.tags,
               ${contentExpr} AS content_text
             FROM ${table} ${alias}
             WHERE ${alias}.id = $1 AND ${alias}.archived_at IS NULL${namespacePredicate}${sourceScopeFilter}
           ) entry`,
          params,
        );

        if (rows.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Entry not found or archived",
              },
            ],
            isError: true,
          };
        }

        const row = rows[0] as Record<string, unknown>;
        const namespace =
          typeof row.namespace === "string" ? row.namespace : null;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
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
                source_ref: {
                  source: "brain",
                  type: sourceType,
                  id: row.id,
                  namespace,
                },
                full_available: true,
                fetch_path: {
                  tool: "get_entry",
                  arguments: sourceScope
                    ? { table, id: row.id, render: "full", source_scope: sourceScope }
                    : { table, id: row.id, render: "full" },
                },
              }),
            },
          ],
        };
      }

      const columns = TABLE_COLUMNS[table];
      const alias = TABLE_ALIAS[table];
      const readable = readableNamespaces(auth);
      const params: unknown[] = [args.id];
      const namespacePredicate = readable
        ? ` AND ${alias}.namespace = ANY($${params.push(readable)}::text[])`
        : "";
      const sourceScopeParamIndex = appendSourceScopeParam(params, sourceScope);
      const sourceScopeFilter = sourceScopeFilterSql(alias, sourceScopeParamIndex);
      const { rows } = await deps.pool.query(
        `SELECT ${columns} FROM ${table} ${alias} WHERE ${alias}.id = $1 AND ${alias}.archived_at IS NULL${namespacePredicate}${sourceScopeFilter}`,
        params,
      );

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Entry not found or archived",
            },
          ],
          isError: true,
        };
      }

      const row = { ...rows[0] };
      if (sourceScope) {
        row.source_refs = filterSourceRefsForScope(row.source_refs, sourceScope);
      } else {
        delete row.source_refs;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(row),
          },
        ],
      };
    },
  );
}
