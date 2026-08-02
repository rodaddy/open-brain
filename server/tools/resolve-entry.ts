/**
 * `resolve_entry`: map a memory UUID to its readable source family and a
 * `get_entry` fetch path, without semantic search.
 *
 * The diagnostics it returns (`checked_sources`, `checked_tables`) deliberately
 * describe what the CALLER was allowed to search, never metadata from a row the
 * caller cannot read -- otherwise the tool would confirm the existence of
 * entries in namespaces the identity has no read authority over.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../auth/permissions.ts";
import { canTargetNamespace, namespacePredicate } from "../auth/namespace-policy.ts";
import type { AuthIdentity, ResourceTable } from "../auth/types.ts";
import { authIdentity, errorResult, textResult, type MemoryToolDependencies } from "./types.ts";
import { ALL_TABLES } from "./curation-helpers.ts";

const SOURCE_TYPE_BY_TABLE: Readonly<Record<ResourceTable, string>> = {
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
  table: ResourceTable | null;
  namespace: string | null;
  fetch_path: { tool: "get_entry"; arguments: { table: ResourceTable; id: string } } | null;
  checked_sources: string[];
  checked_tables: ResourceTable[];
}

function unresolved(
  status: ResolveStatus,
  id: string,
  checkedTables: readonly ResourceTable[],
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
    checked_tables: [...checkedTables],
  };
}

/** Probe each readable table in order for the id, under read namespace scope. */
async function findRow(
  dependencies: MemoryToolDependencies,
  identity: AuthIdentity,
  id: string,
  tables: readonly ResourceTable[],
  requestedNamespace: string | undefined,
  archived: boolean,
  checkedTables: ResourceTable[],
): Promise<{ table: ResourceTable; namespace: string } | null> {
  for (const table of tables) {
    checkedTables.push(table);
    const params: unknown[] = [id];
    let clause = "";
    if (requestedNamespace !== undefined) {
      params.push(requestedNamespace);
      clause = ` AND namespace = $${params.length}`;
    } else {
      const predicate = namespacePredicate(identity, "read", 2);
      clause = predicate.clause;
      params.push(...predicate.values);
    }
    const { rows } = await dependencies.pool.query(
      `SELECT id, namespace FROM ${table}
        WHERE id = $1 AND archived_at IS ${archived ? "NOT NULL" : "NULL"}${clause}
        FETCH FIRST 1 ROW ONLY`,
      params,
    );
    const row = rows[0] as { namespace?: unknown } | undefined;
    if (typeof row?.namespace === "string") return { table, namespace: row.namespace };
  }
  return null;
}

function uniqueTables(tables: readonly ResourceTable[]): ResourceTable[] {
  return Array.from(new Set(tables));
}

export function registerResolveEntryTool(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "resolve_entry",
    {
      description:
        "Resolve a memory UUID to its readable source type, namespace, and get_entry fetch path without semantic search.",
      inputSchema: {
        id: z.string().uuid(),
        namespace: z.string().min(1).max(500).optional(),
      },
      annotations: {
        title: "Resolve Entry",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      if (!identity) return errorResult("Permission denied: cannot resolve entries");
      const namespace = args.namespace;

      if (namespace !== undefined && !canTargetNamespace(identity, "read", namespace)) {
        return textResult(unresolved("not_readable", args.id, [], namespace));
      }

      const readableTables = ALL_TABLES.filter((table) => canRead(identity.role, table));
      if (readableTables.length === 0) {
        return textResult(unresolved("not_readable", args.id, [], namespace ?? null));
      }

      const found = await findRow(
        dependencies,
        identity,
        args.id,
        readableTables,
        namespace,
        false,
        [],
      );
      if (found) {
        // First match in table order wins; UUIDs are unique across source tables.
        const checkedTables = uniqueTables(
          readableTables.slice(0, readableTables.indexOf(found.table) + 1),
        );
        return textResult({
          resolved: true,
          status: "found",
          id: args.id,
          source_type: SOURCE_TYPE_BY_TABLE[found.table],
          table: found.table,
          namespace: found.namespace,
          fetch_path: { tool: "get_entry", arguments: { table: found.table, id: args.id } },
          checked_sources: checkedTables.map((table) => SOURCE_TYPE_BY_TABLE[table]),
          checked_tables: checkedTables,
        } satisfies ResolvedEntry);
      }

      // Only admin-tier identities learn that an id exists but is archived.
      if (identity.role === "admin" || identity.role === "ob-admin") {
        const checkedTables: ResourceTable[] = [];
        const archived = await findRow(
          dependencies,
          identity,
          args.id,
          readableTables,
          namespace,
          true,
          checkedTables,
        );
        if (archived) {
          return textResult({
            ...unresolved(
              "archived",
              args.id,
              uniqueTables([...readableTables, ...checkedTables]),
              archived.namespace,
            ),
            source_type: SOURCE_TYPE_BY_TABLE[archived.table],
            table: archived.table,
            namespace: archived.namespace,
          } satisfies ResolvedEntry);
        }
      }

      return textResult(
        unresolved("not_found_or_unreadable", args.id, readableTables, namespace ?? null),
      );
    },
  );
}
