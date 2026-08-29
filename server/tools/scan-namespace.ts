/**
 * `scan_namespace`: report pending explicit shared-kb nominations in one
 * namespace.
 *
 * Design authority: `docs/decisions/shared-kb-canonical-namespace.md` (the
 * canonical shared namespace), `docs/decisions/admin-and-promoter-identities.md`
 * (who may see across namespaces), and `docs/identity-boundary.md`.
 *
 * READ-ONLY, and deliberately so: this is the planning step that tells a
 * promoter what `promote_entry` COULD lift. It nominates nothing, promotes
 * nothing, and writes nothing. A scan that also promoted would make the
 * promotion queue unreviewable, which is the same reason the dream cycle keeps
 * its scoring phases separate from its mutations.
 *
 * The nomination predicate and metadata projection are reused from
 * `server/domain/promotion-nomination.ts` rather than restated. What counts as an
 * "explicit nomination" is one rule; a second copy here would drift and the two
 * servers would disagree about which entries are pending.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canTargetNamespace } from "../auth/namespace-policy.ts";
import type { AuthIdentity, ResourceTable } from "../auth/types.ts";
import {
  canonicalNamespace,
  physicalNamespace,
  sharedNamespaceConfig,
  type SharedNamespaceConfig,
} from "./shared-namespace.ts";
import {
  explicitSharedNominationSqlPredicate,
  isExplicitSharedNomination,
  promotionMetadataSelect,
} from "../domain/promotion-nomination.ts";
import {
  authIdentity,
  errorResult,
  textResult,
  type MemoryToolDependencies,
} from "./types.ts";
import { ALL_TABLES, tableEnum } from "./curation-helpers.ts";

/** Entries scanned per table when the caller names no preference. */
const DEFAULT_ENTRIES_PER_TABLE = 20;

interface Candidate {
  readonly table: ResourceTable;
  readonly id: string;
  readonly created_at: unknown;
}

interface Duplicate extends Candidate {
  readonly target_namespace: string;
  readonly existing_target_id: string;
}

/** @returns Whether this identity may scan another namespace for nominations. */
function isScanIdentity(identity: AuthIdentity): boolean {
  return (
    identity.role === "admin" ||
    identity.role === "ob-admin" ||
    identity.role === "promoter"
  );
}

const scanNamespaceInputSchema = {
  namespace: z.string().min(1).max(500).describe("Agent namespace to scan"),
  target_namespace: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "Namespace to check for existing promoted duplicates (default shared-kb)",
    ),
  table: tableEnum.optional().describe("Limit scan to a specific table"),
  since: z.string().optional().describe("Only entries created after this ISO date"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(`Max entries to scan per table (default ${DEFAULT_ENTRIES_PER_TABLE})`),
};

const scanNamespaceAnnotations = {
  title: "Scan Namespace",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};

interface ScanScope {
  readonly tables: readonly ResourceTable[];
  readonly perTable: number;
  readonly scanned: string;
  readonly targetPhysical: string;
  readonly targetCanonical: string;
  readonly since: string | undefined;
}

interface ScanArgs {
  readonly namespace: string;
  readonly target_namespace?: string;
  readonly table?: string;
  readonly since?: string;
  readonly limit?: number;
}

/**
 * Resolve the read scope for one scan, or the reason the caller may not have it.
 *
 * Cross-namespace visibility is the promotion identities' surface. The role
 * gate runs first so an unprivileged caller never learns whether the namespace
 * it named exists.
 *
 * @param sharedNamespaceNames Resolved shared-namespace names from the composition root.
 * @returns The resolved scope, or a `denied` message to return verbatim.
 */
function resolveScanScope(
  sharedNamespaceNames: SharedNamespaceConfig,
  identity: AuthIdentity | null | undefined,
  args: ScanArgs,
): { scope: ScanScope } | { denied: string } {
  if (!identity || !isScanIdentity(identity)) {
    return {
      denied: "Permission denied: admin, ob-admin, or promoter role required",
    };
  }
  if (!canTargetNamespace(identity, "read", args.namespace)) {
    return { denied: "Permission denied: namespace read access denied" };
  }

  const target = args.target_namespace ?? sharedNamespaceNames.sharedNamespace;
  if (!canTargetNamespace(identity, "read", target)) {
    return { denied: "Permission denied: target namespace read access denied" };
  }

  // The scanned namespace is bound as a PARAMETER on every statement, not
  // resolved once and trusted: it is the only thing scoping this read, and
  // the role gate above proves the caller may target it, not that a later
  // statement stays inside it.
  const scanned = physicalNamespace(args.namespace, sharedNamespaceNames);
  const targetPhysical = physicalNamespace(target, sharedNamespaceNames);
  const targetCanonical = canonicalNamespace(targetPhysical, sharedNamespaceNames);
  return {
    scope: {
      tables: args.table ? [args.table as ResourceTable] : ALL_TABLES,
      perTable: args.limit ?? DEFAULT_ENTRIES_PER_TABLE,
      scanned,
      targetPhysical,
      targetCanonical,
      since: args.since,
    },
  };
}

/** @returns Nominated rows in one table, newest first, within the scan scope. */
async function queryNominatedRows(
  dependencies: MemoryToolDependencies,
  table: ResourceTable,
  scope: ScanScope,
): Promise<Record<string, unknown>[]> {
  const values: unknown[] = [scope.scanned, scope.perTable];
  if (scope.since !== undefined) values.push(scope.since);
  const sinceFilter = scope.since !== undefined ? " AND t.created_at >= $3" : "";

  const { rows } = await dependencies.pool.query(
    `SELECT t.id, t.content_hash, t.namespace, t.created_at,
            ${promotionMetadataSelect(table)} AS metadata
       FROM ${table} t
      WHERE t.namespace = $1
        AND t.archived_at IS NULL${explicitSharedNominationSqlPredicate(table)}${sinceFilter}
      ORDER BY t.created_at DESC
      LIMIT $2`,
    values,
  );
  return rows;
}

/**
 * @returns The id of an entry in the target namespace with the same content, if
 * one exists.
 */
async function findTargetDuplicateId(
  dependencies: MemoryToolDependencies,
  table: ResourceTable,
  contentHash: unknown,
  targetPhysical: string,
): Promise<string | undefined> {
  if (!contentHash) return undefined;
  const { rows: existing } = await dependencies.pool.query(
    `SELECT id FROM ${table}
      WHERE content_hash = $1 AND namespace = $2 AND archived_at IS NULL
      LIMIT 1`,
    [contentHash, targetPhysical],
  );
  return (existing[0] as { id: string } | undefined)?.id;
}

/**
 * Sort one table's rows into candidates and already-promoted duplicates.
 *
 * An entry whose content already exists in the target is reported as a
 * duplicate INSTEAD of a candidate, so a promoter working the list top to
 * bottom never re-promotes something already there.
 */
async function collectTable(options: {
  dependencies: MemoryToolDependencies;
  table: ResourceTable;
  scope: ScanScope;
  candidates: Candidate[];
  duplicates: Duplicate[];
}): Promise<void> {
  const { dependencies, table, scope, candidates, duplicates } = options;
  const rows = await queryNominatedRows(dependencies, table, scope);

  for (const row of rows) {
    const existingId = await findTargetDuplicateId(
      dependencies,
      table,
      row.content_hash,
      scope.targetPhysical,
    );
    if (existingId) {
      duplicates.push({
        table,
        id: row.id as string,
        target_namespace: scope.targetCanonical,
        existing_target_id: existingId,
        created_at: row.created_at,
      });
      continue;
    }

    if (isExplicitSharedNomination(row.metadata as Record<string, unknown> | null)) {
      candidates.push({
        table,
        id: row.id as string,
        created_at: row.created_at,
      });
    }
  }
}

async function handleScanNamespace(
  dependencies: MemoryToolDependencies,
  identity: AuthIdentity | null | undefined,
  args: ScanArgs,
) {
  const resolved = resolveScanScope(
    sharedNamespaceConfig(dependencies.sharedNamespaceNames),
    identity,
    args,
  );
  if ("denied" in resolved) return errorResult(resolved.denied);
  const { scope } = resolved;

  const candidates: Candidate[] = [];
  const duplicates: Duplicate[] = [];
  for (const table of scope.tables) {
    await collectTable({ dependencies, table, scope, candidates, duplicates });
  }

  dependencies.logger.info(
    {
      tool: "scan_namespace",
      namespace: scope.scanned,
      targetNamespace: scope.targetCanonical,
      candidates: candidates.length,
      duplicates: duplicates.length,
    },
    "tool_result",
  );
  return textResult({
    namespace: args.namespace,
    target_namespace: scope.targetCanonical,
    candidates,
    duplicates,
    summary: {
      candidates: candidates.length,
      duplicates: duplicates.length,
    },
  });
}

export function registerScanNamespaceTool(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "scan_namespace",
    {
      description:
        "Scan an agent namespace for pending explicit shared-kb nominations. " +
        "Returns nominated candidates and duplicates in the target namespace.",
      inputSchema: scanNamespaceInputSchema,
      annotations: scanNamespaceAnnotations,
    },
    async (args, extra) =>
      handleScanNamespace(dependencies, authIdentity(extra.authInfo), args),
  );
}
