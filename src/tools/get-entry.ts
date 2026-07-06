import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../permissions.ts";
import { readableNamespaces } from "../read-policy.ts";
import type { AuthInfo, Table } from "../types.ts";
import type { ToolDeps } from "./index.ts";
import { TABLE_COLUMNS } from "../table-projections.ts";
import {
  CONTENT_PREVIEW,
  SOURCE_LABELS,
  TABLE_ALIAS,
} from "./table-constants.ts";

const DEFAULT_COMPACT_MAX_CHARS = 500;

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
      if (render === "compact") {
        const maxChars = args.max_chars ?? DEFAULT_COMPACT_MAX_CHARS;
        const alias = TABLE_ALIAS[table];
        const preview = CONTENT_PREVIEW[table];
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
        params.push(maxChars);
        const maxCharsParam = `$${params.length}`;
        const previewExpr = `regexp_replace(COALESCE((${preview})::text, ''), '[[:space:]]+', ' ', 'g')`;
        const { rows } = await deps.pool.query(
          `SELECT ${alias}.id, ${alias}.namespace, ${alias}.created_by, ${alias}.created_at, ${updatedAtExpr} AS updated_at, ${alias}.tier, ${alias}.tags,
            LEFT(${previewExpr}, ${maxCharsParam}) AS content_preview,
            length(${previewExpr}) AS content_length,
            length(${previewExpr}) > ${maxCharsParam} AS content_truncated
           FROM ${table} ${alias}
           WHERE ${alias}.id = $1 AND ${alias}.archived_at IS NULL${namespacePredicate}`,
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
                  arguments: { table, id: row.id, render: "full" },
                },
              }),
            },
          ],
        };
      }

      const columns = TABLE_COLUMNS[table];
      const readable = readableNamespaces(auth);
      const namespacePredicate = readable
        ? " AND namespace = ANY($2::text[])"
        : "";
      const { rows } = await deps.pool.query(
        `SELECT ${columns} FROM ${table} WHERE id = $1 AND archived_at IS NULL${namespacePredicate}`,
        readable ? [args.id, readable] : [args.id],
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

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(rows[0]),
          },
        ],
      };
    },
  );
}
