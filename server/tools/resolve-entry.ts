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
import {
  canTargetNamespace,
  namespacePredicate,
} from "../auth/namespace-policy.ts";
import type { AuthIdentity, ResourceTable } from "../auth/types.ts";
import {
  authIdentity,
  errorResult,
  textResult,
  type MemoryToolDependencies,
} from "./types.ts";
import { ALL_TABLES } from "./curation-helpers.ts";

const NOT_AUTHENTICATED = "Permission denied: cannot resolve entries";

const SOURCE_TYPE_BY_TABLE: Readonly<Record<ResourceTable, string>> = {
  thoughts: "thought",
  decisions: "decision",
  relationships: "relationship",
  projects: "project",
  sessions: "session",
};

/** Frozen `resolve_entry` argument contract: the names and rule values are the API. */
const resolveEntryInputSchema = {
  id: z.string().uuid(),
  namespace: z.string().min(1).max(500).optional(),
};

/** Tool annotations; `resolve_entry` reads and never mutates. */
const resolveEntryAnnotations = {
  title: "Resolve Entry",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};

type ResolveStatus =
  "found" | "archived" | "not_found_or_unreadable" | "not_readable";

interface ResolvedEntry {
  resolved: boolean;
  status: ResolveStatus;
  id: string;
  source_type: string | null;
  table: ResourceTable | null;
  namespace: string | null;
  fetch_path: {
    tool: "get_entry";
    arguments: { table: ResourceTable; id: string };
  } | null;
  checked_sources: string[];
  checked_tables: ResourceTable[];
}

/** One probe pass: which tables, archived or live, and where to record progress. */
interface ProbeRequest {
  identity: AuthIdentity;
  id: string;
  tables: readonly ResourceTable[];
  requestedNamespace: string | undefined;
  archived: boolean;
  checkedTables: ResourceTable[];
}

interface ProbeHit {
  table: ResourceTable;
  namespace: string;
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

/**
 * Bind the namespace scope for one probe.
 *
 * This is the security boundary of an ID-based read: an explicit namespace is
 * bound as a parameter only after {@link canTargetNamespace} has cleared it,
 * and otherwise the auth-derived read predicate applies. Neither branch ever
 * leaves the query unscoped, so an id alone can never reach a row the identity
 * has no read authority over.
 */
function scopeParameters(
  identity: AuthIdentity,
  id: string,
  requestedNamespace: string | undefined,
): { params: unknown[]; clause: string } {
  const params: unknown[] = [id];
  if (requestedNamespace !== undefined) {
    params.push(requestedNamespace);
    return { params, clause: ` AND namespace = $${params.length}` };
  }
  const predicate = namespacePredicate(identity, "read", 2);
  params.push(...predicate.values);
  return { params, clause: predicate.clause };
}

/** Probe each readable table in order for the id, under read namespace scope. */
async function findRow(
  dependencies: MemoryToolDependencies,
  request: ProbeRequest,
): Promise<ProbeHit | null> {
  const { identity, id, tables, requestedNamespace, archived, checkedTables } =
    request;
  for (const table of tables) {
    checkedTables.push(table);
    const { params, clause } = scopeParameters(
      identity,
      id,
      requestedNamespace,
    );
    const { rows } = await dependencies.pool.query(
      `SELECT id, namespace FROM ${table}
        WHERE id = $1 AND archived_at IS ${archived ? "NOT NULL" : "NULL"}${clause}
        FETCH FIRST 1 ROW ONLY`,
      params,
    );
    const row = rows[0] as { namespace?: unknown } | undefined;
    if (typeof row?.namespace === "string")
      return { table, namespace: row.namespace };
  }
  return null;
}

function uniqueTables(tables: readonly ResourceTable[]): ResourceTable[] {
  return Array.from(new Set(tables));
}

/** Shape the success payload; the first match in table order wins. */
function resolvedHit(
  id: string,
  found: ProbeHit,
  readableTables: readonly ResourceTable[],
): ResolvedEntry {
  // First match in table order wins; UUIDs are unique across source tables.
  const checkedTables = uniqueTables(
    readableTables.slice(0, readableTables.indexOf(found.table) + 1),
  );
  return {
    resolved: true,
    status: "found",
    id,
    source_type: SOURCE_TYPE_BY_TABLE[found.table],
    table: found.table,
    namespace: found.namespace,
    fetch_path: { tool: "get_entry", arguments: { table: found.table, id } },
    checked_sources: checkedTables.map((table) => SOURCE_TYPE_BY_TABLE[table]),
    checked_tables: checkedTables,
  };
}

/**
 * Second pass for admin-tier identities only: report that an id exists but is
 * archived. Non-admin callers never reach this, so archived rows stay invisible
 * to them exactly as an absent row would be.
 */
async function resolveArchived(
  dependencies: MemoryToolDependencies,
  identity: AuthIdentity,
  id: string,
  scope: {
    readableTables: readonly ResourceTable[];
    requestedNamespace: string | undefined;
  },
): Promise<ResolvedEntry | null> {
  if (identity.role !== "admin" && identity.role !== "ob-admin") return null;
  const checkedTables: ResourceTable[] = [];
  const archived = await findRow(dependencies, {
    identity,
    id,
    tables: scope.readableTables,
    requestedNamespace: scope.requestedNamespace,
    archived: true,
    checkedTables,
  });
  if (!archived) return null;
  return {
    ...unresolved(
      "archived",
      id,
      uniqueTables([...scope.readableTables, ...checkedTables]),
      archived.namespace,
    ),
    source_type: SOURCE_TYPE_BY_TABLE[archived.table],
    table: archived.table,
    namespace: archived.namespace,
  };
}

/** Resolve one authenticated request end to end, live pass then archived pass. */
async function resolveEntry(
  dependencies: MemoryToolDependencies,
  identity: AuthIdentity,
  args: { id: string; namespace?: string | undefined },
): Promise<ResolvedEntry> {
  const namespace = args.namespace;
  if (
    namespace !== undefined &&
    !canTargetNamespace(identity, "read", namespace)
  ) {
    return unresolved("not_readable", args.id, [], namespace);
  }

  const readableTables = ALL_TABLES.filter((table) =>
    canRead(identity.role, table),
  );
  if (readableTables.length === 0) {
    return unresolved("not_readable", args.id, [], namespace ?? null);
  }

  const found = await findRow(dependencies, {
    identity,
    id: args.id,
    tables: readableTables,
    requestedNamespace: namespace,
    archived: false,
    checkedTables: [],
  });
  if (found) return resolvedHit(args.id, found, readableTables);

  const archived = await resolveArchived(dependencies, identity, args.id, {
    readableTables,
    requestedNamespace: namespace,
  });
  if (archived) return archived;

  return unresolved(
    "not_found_or_unreadable",
    args.id,
    readableTables,
    namespace ?? null,
  );
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
      inputSchema: resolveEntryInputSchema,
      annotations: resolveEntryAnnotations,
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      if (!identity) return errorResult(NOT_AUTHENTICATED);
      return textResult(await resolveEntry(dependencies, identity, args));
    },
  );
}
