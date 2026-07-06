import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../permissions.ts";
import {
  canReadNamespace,
  namespaceFilterFor,
} from "../read-policy.ts";
import type { AuthInfo, Table } from "../types.ts";
import type { ToolDeps } from "./index.ts";

const SOURCE_TABLES = [
  "thoughts",
  "decisions",
  "relationships",
  "projects",
  "sessions",
] as const satisfies readonly Table[];

const SOURCE_TYPE_BY_TABLE: Record<Table, string> = {
  thoughts: "thought",
  decisions: "decision",
  relationships: "relationship",
  projects: "project",
  sessions: "session",
};

type ResolveStatus = "found" | "archived" | "not_found_or_unreadable" | "not_readable";

interface ResolvedEntry {
  resolved: boolean;
  status: ResolveStatus;
  id: string;
  source_type: string | null;
  table: Table | null;
  namespace: string | null;
  fetch_path: {
    tool: "get_entry";
    arguments: {
      table: Table;
      id: string;
    };
  } | null;
  // Contract diagnostics: these intentionally expose what the caller was allowed
  // to search, not any unreadable row metadata.
  checked_sources: string[];
  checked_tables: Table[];
}

function unresolved(
  status: ResolveStatus,
  id: string,
  checkedTables: Table[],
  namespace: string | null,
): ResolvedEntry {
  return {
    resolved: false,
    status,
    id,
    source_type: null,
    table: null,
    namespace,
    fetch_path: null,
    checked_sources: checkedTables.map((table) => SOURCE_TYPE_BY_TABLE[table]),
    checked_tables: checkedTables,
  };
}

function buildNamespacePredicate(
  auth: AuthInfo,
  params: unknown[],
  namespace?: string,
): string {
  const filter = namespaceFilterFor(auth, namespace);
  if (filter === undefined) return "";
  params.push(filter);
  if (Array.isArray(filter)) {
    return ` AND namespace = ANY($${params.length}::text[])`;
  }
  return ` AND namespace = $${params.length}`;
}

async function findRow(
  deps: ToolDeps,
  auth: AuthInfo,
  id: string,
  tables: Table[],
  namespace: string | undefined,
  archived: boolean,
  checkedTables: Table[],
): Promise<{ table: Table; namespace: string } | null> {
  for (const table of tables) {
    checkedTables.push(table);
    const params: unknown[] = [id];
    const namespacePredicate = buildNamespacePredicate(auth, params, namespace);
    const archivedPredicate = archived
      ? "archived_at IS NOT NULL"
      : "archived_at IS NULL";
    const { rows } = await deps.pool.query(
      `SELECT id, namespace FROM ${table} WHERE id = $1 AND ${archivedPredicate}${namespacePredicate} LIMIT 1`,
      params,
    );
    const row = rows[0] as { namespace?: unknown } | undefined;
    if (typeof row?.namespace === "string") {
      return { table, namespace: row.namespace };
    }
  }
  return null;
}

function uniqueTables(tables: Table[]): Table[] {
  return Array.from(new Set(tables));
}

function canResolveArchived(auth: AuthInfo): boolean {
  return auth.role === "admin" || auth.role === "ob-admin";
}

export function registerResolveEntry(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "resolve_entry",
    {
      description:
        "Resolve a memory UUID to its readable source type, namespace, and get_entry fetch path without semantic search.",
      inputSchema: {
        id: z.string().uuid().describe("Entry UUID to resolve across readable source families"),
        namespace: z
          .string()
          .min(1)
          .max(500)
          .optional()
          .describe(
            "Optional namespace to constrain resolution. The server checks this against auth-derived read policy.",
          ),
      },
      annotations: {
        title: "Resolve Entry",
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
              text: "Permission denied: cannot resolve entries",
            },
          ],
          isError: true,
        };
      }

      const id = args.id as string;
      const namespace =
        typeof args.namespace === "string" ? args.namespace : undefined;

      if (namespace !== undefined && !canReadNamespace(auth, namespace)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(unresolved("not_readable", id, [], namespace)),
            },
          ],
        };
      }

      const readableTables = SOURCE_TABLES.filter((table) =>
        canRead(auth.role, table),
      );
      if (readableTables.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                unresolved("not_readable", id, [], namespace ?? null),
              ),
            },
          ],
        };
      }

      const found = await findRow(
        deps,
        auth,
        id,
        readableTables,
        namespace,
        false,
        [],
      );
      if (found) {
        // Resolution is first-match in SOURCE_TABLES order; UUIDs are expected
        // to be globally unique across source tables.
        const checkedTables = uniqueTables(
          readableTables.slice(0, readableTables.indexOf(found.table) + 1),
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                resolved: true,
                status: "found",
                id,
                source_type: SOURCE_TYPE_BY_TABLE[found.table],
                table: found.table,
                namespace: found.namespace,
                fetch_path: {
                  tool: "get_entry",
                  arguments: {
                    table: found.table,
                    id,
                  },
                },
                checked_sources: checkedTables.map(
                  (table) => SOURCE_TYPE_BY_TABLE[table],
                ),
                checked_tables: checkedTables,
              } satisfies ResolvedEntry),
            },
          ],
        };
      }

      if (canResolveArchived(auth)) {
        const checkedTables: Table[] = [];
        const archived = await findRow(
          deps,
          auth,
          id,
          readableTables,
          namespace,
          true,
          checkedTables,
        );
        if (archived) {
          const allCheckedTables = uniqueTables([...readableTables, ...checkedTables]);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ...unresolved("archived", id, allCheckedTables, archived.namespace),
                  source_type: SOURCE_TYPE_BY_TABLE[archived.table],
                  table: archived.table,
                  namespace: archived.namespace,
                } satisfies ResolvedEntry),
              },
            ],
          };
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              unresolved(
                "not_found_or_unreadable",
                id,
                readableTables,
                namespace ?? null,
              ),
            ),
          },
        ],
      };
    },
  );
}
