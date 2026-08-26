/**
 * Namespace discovery and shared-truth promotion.
 *
 * Design authority: `docs/decisions/shared-kb-canonical-namespace.md` fixes
 * `shared-kb` as the canonical shared namespace and rejects legacy external
 * writes; `docs/decisions/admin-and-promoter-identities.md` grants the promoter
 * identity its cross-namespace surface; `docs/identity-boundary.md` requires
 * token-derived lane identity.
 *
 * `promote_shared` accepts an explicit `target_namespace`. Legacy `collab` is
 * an INTERNAL MIGRATION SOURCE ONLY and is refused as a target here -- the
 * canonical name is `shared-kb`, and accepting the legacy spelling as a write
 * target is how two names for one lane get re-established after the migration
 * that removed them.
 *
 * Classification runs BEFORE the promotion and hard-refuses secret or
 * person-private content even when an authorized promoter explicitly asks. An
 * authorized identity is permission to promote shareable content, never
 * permission to override the content gate.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canRead } from "../auth/permissions.ts";
import { namespacePredicate } from "../auth/namespace-policy.ts";
import type { AuthIdentity, ResourceTable } from "../auth/types.ts";
import type { AuthInfo } from "../../src/types.ts";
import {
  canonicalNamespace,
  sharedNamespaceConfig,
} from "../../src/shared-namespace.ts";
import { classifyShareCandidate } from "../../src/sharing.ts";
import { promoteEntry } from "../../src/promotion-service.ts";
import {
  authIdentity,
  errorResult,
  textResult,
  type MemoryToolDependencies,
} from "./types.ts";
import { ALL_TABLES } from "./curation-helpers.ts";

/** Tables `promote_shared` can lift into shared truth. */
const PROMOTABLE_TABLES = ["thoughts", "decisions"] as const;
type PromotableTable = (typeof PROMOTABLE_TABLES)[number];

/**
 * The pre-rename shared namespace.
 *
 * Named here as a constant rather than read from config because it is refused
 * as a write target unconditionally: `legacySharedNamespace` is empty by
 * default, so a config-only check would permit `collab` in the default
 * deployment. Matches `LEGACY_SHARED_NAMESPACE` in `server/auth/namespace-policy.ts`.
 */
const LEGACY_SHARED_NAMESPACE = "collab";

/**
 * Convert the server identity into the promotion service's shape.
 *
 * `delegated` and `header` are the same idea under two names: the namespace did
 * not come from the token. The promotion service keys its re-check on that, so
 * the value is mapped rather than cast.
 */
function promotionAuth(identity: AuthIdentity): AuthInfo {
  return {
    role: identity.role,
    clientId: identity.clientId,
    tokenClientId: identity.tokenClientId,
    namespaceSource:
      identity.namespaceSource === "delegated" ? "header" : "token",
  };
}

/** @returns The text a classifier fed for this row. */
function shareContent(
  table: PromotableTable,
  row: Record<string, unknown>,
): string {
  if (table === "decisions") {
    const title = (row.title as string | null) ?? "";
    const rationale = (row.rationale as string | null) ?? "";
    return `${title} ${rationale}`.trim();
  }
  return (row.content as string | null) ?? "";
}

/** @returns Whether this identity may attempt a shared-truth promotion. */
function isPromotionIdentity(identity: AuthIdentity): boolean {
  return (
    identity.role === "promoter" ||
    identity.role === "admin" ||
    identity.role === "ob-admin"
  );
}

/** Frozen `list_namespaces` argument contract: the names and types are the API. */
const listNamespacesInputSchema = {
  raw: z
    .boolean()
    .optional()
    .describe(
      "Return physical namespace names instead of canonical public names",
    ),
};

/** Tool annotations; `list_namespaces` reads and never mutates. */
const listNamespacesAnnotations = {
  title: "List Namespaces",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};

/** Frozen `promote_shared` argument contract: the names, types, and rule values are the API. */
const promoteSharedInputSchema = {
  table: z
    .enum(PROMOTABLE_TABLES)
    .describe("Source table holding the entry to promote"),
  id: z.string().uuid().describe("Source entry id"),
  target_namespace: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "Shared namespace to promote into. Defaults to the canonical shared " +
        "namespace. The legacy 'collab' name is an internal migration source " +
        "only and is refused as a target.",
    ),
  reason: z
    .string()
    .min(1)
    .max(2000)
    .optional()
    .describe("Why this entry is being promoted to shared truth"),
  dry_run: z
    .boolean()
    .optional()
    .describe("Preview without writing to shared-kb (default true)"),
};

/** Tool annotations; `promote_shared` writes, but re-promoting is idempotent. */
const promoteSharedAnnotations = {
  title: "Promote To Shared KB",
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
};

/** One namespace's rolled-up counts across every readable table. */
interface NamespaceTotals {
  total: number;
  per_table: Record<string, number>;
}

/**
 * Count live entries per namespace in every table this role may read.
 *
 * @returns One row set per readable table, each carrying `table_name`,
 * `namespace`, and `count`.
 */
function countNamespaceRows(
  dependencies: MemoryToolDependencies,
  identity: AuthIdentity,
  tables: readonly ResourceTable[],
): Promise<Record<string, unknown>[][]> {
  return Promise.all(
    tables.map(async (table) => {
      const predicate = namespacePredicate(identity, "read", 1);
      const { rows } = await dependencies.pool.query(
        `SELECT '${table}' AS table_name, namespace, COUNT(*) AS count
           FROM ${table}
          WHERE archived_at IS NULL${predicate.clause}
          GROUP BY namespace
          ORDER BY count DESC`,
        [...predicate.values],
      );
      return rows;
    }),
  );
}

/**
 * Fold per-table counts into one entry per reported namespace.
 *
 * Folding legacy names onto the canonical one can collide two physical
 * namespaces into a single reported lane, so counts are SUMMED per table rather
 * than overwritten.
 *
 * @returns Namespaces with their totals, most entries first.
 */
function foldNamespaceCounts(
  results: Record<string, unknown>[][],
  raw: boolean | undefined,
): Array<{ namespace: string } & NamespaceTotals> {
  const byNamespace = new Map<string, NamespaceTotals>();
  for (const rows of results) {
    for (const row of rows) {
      const physical = String(row.namespace);
      const name = raw ? physical : canonicalNamespace(physical);
      const entry = byNamespace.get(name) ?? { total: 0, per_table: {} };
      const count = Number(row.count);
      entry.total += count;
      entry.per_table[String(row.table_name)] =
        (entry.per_table[String(row.table_name)] ?? 0) + count;
      byNamespace.set(name, entry);
    }
  }

  return [...byNamespace.entries()]
    .map(([namespace, data]) => ({
      namespace,
      total: data.total,
      per_table: data.per_table,
    }))
    .sort((a, b) => b.total - a.total);
}

/** @returns The namespace inventory, or an error result when nothing is readable. */
async function handleListNamespaces(
  dependencies: MemoryToolDependencies,
  args: { raw?: boolean },
  authInfo: unknown,
): Promise<ReturnType<typeof textResult>> {
  const identity = authIdentity(authInfo as Parameters<typeof authIdentity>[0]);
  if (!identity) return errorResult("Permission denied: not authenticated");
  const accessible = ALL_TABLES.filter((table) =>
    canRead(identity.role, table),
  );
  if (accessible.length === 0) {
    return errorResult("Permission denied: no readable tables");
  }

  const results = await countNamespaceRows(dependencies, identity, accessible);
  const namespaces = foldNamespaceCounts(results, args.raw);

  dependencies.logger.info(
    { tool: "list_namespaces", namespaceCount: namespaces.length },
    "tool_result",
  );
  return textResult({ namespace_count: namespaces.length, namespaces });
}

/** A promotion request that cleared identity and target-namespace checks. */
interface PromotionTarget {
  identity: AuthIdentity;
  target: string;
}

/**
 * Check that the caller may promote and that the target namespace is writable.
 *
 * Defense in depth: refused here before any read, and `promoteEntry` re-checks
 * write authority for the target namespace on its own.
 *
 * @returns The authorized target, or the error result that refused it.
 */
function authorizePromotion(
  dependencies: MemoryToolDependencies,
  identity: AuthIdentity | undefined,
  requestedNamespace: string | undefined,
): PromotionTarget | ReturnType<typeof errorResult> {
  if (!identity || !isPromotionIdentity(identity)) {
    dependencies.logger.warn(
      { tool: "promote_shared", role: identity?.role },
      "promote_shared_denied",
    );
    return errorResult(
      "Permission denied: shared-kb promotion requires the promoter, admin, or ob-admin identity",
    );
  }

  const shared = sharedNamespaceConfig();
  const target = requestedNamespace ?? shared.canonicalSharedNamespace;
  // The legacy name is a migration SOURCE, never a write target: accepting
  // it here would recreate the two-names-for-one-lane split that the
  // canonical-namespace decision exists to end.
  //
  // `collab` is refused UNCONDITIONALLY, not just when it is the configured
  // legacy name. `legacySharedNamespace` defaults to empty, so a
  // config-gated check would silently allow `collab` as a target in exactly
  // the default deployment -- the rule is about the name, not the setting.
  if (
    target === LEGACY_SHARED_NAMESPACE ||
    target === shared.legacySharedNamespace
  ) {
    return errorResult(
      `Permission denied: '${target}' is a legacy migration source and cannot be a promotion target; use '${shared.canonicalSharedNamespace}'`,
    );
  }

  return { identity, target };
}

/** @returns True when authorization returned a refusal rather than a target. */
function isRefusal(
  outcome: PromotionTarget | ReturnType<typeof errorResult>,
): outcome is ReturnType<typeof errorResult> {
  return !("identity" in outcome);
}

/**
 * Read the source row under the caller's own read scope.
 *
 * `table` is a validated enum, so the branch is an allowlist rather than
 * interpolation of caller text.
 *
 * @returns The row, or undefined when it is missing or archived.
 */
async function loadPromotionSource(
  dependencies: MemoryToolDependencies,
  identity: AuthIdentity,
  table: PromotableTable,
  id: string,
): Promise<Record<string, unknown> | undefined> {
  const contentColumns = table === "decisions" ? "title, rationale" : "content";
  const predicate = namespacePredicate(identity, "read", 2);
  const { rows } = await dependencies.pool.query(
    `SELECT id, ${contentColumns}, tags, extracted_metadata
       FROM ${table as ResourceTable}
      WHERE id = $1 AND archived_at IS NULL${predicate.clause}`,
    [id, ...predicate.values],
  );
  return rows.length === 0 ? undefined : (rows[0] as Record<string, unknown>);
}

/** Everything the promotion call itself needs once the request is authorized. */
interface RunPromotionOptions {
  dependencies: MemoryToolDependencies;
  identity: AuthIdentity;
  table: PromotableTable;
  id: string;
  target: string;
  reason: string | undefined;
  dryRun: boolean;
  classification: string;
}

/** @returns The promotion result, or the error result its failure maps to. */
async function runPromotion(
  options: RunPromotionOptions,
): Promise<ReturnType<typeof textResult>> {
  const {
    dependencies,
    identity,
    table,
    id,
    target,
    reason,
    dryRun,
    classification,
  } = options;
  try {
    const result = await promoteEntry(
      dependencies.pool,
      table,
      id,
      target,
      reason,
      promotionAuth(identity),
      { dryRun },
    );
    dependencies.logger.info(
      { tool: "promote_shared", id, status: result.status, dryRun },
      "tool_result",
    );
    return textResult({ classification, ...result });
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    const message = error instanceof Error ? error.message : String(error);
    dependencies.logger.warn(
      { tool: "promote_shared", id, statusCode },
      "promote_shared_error",
    );
    return errorResult(
      statusCode && statusCode < 500
        ? `Permission denied: ${message}`
        : `Promotion failed: ${message}`,
    );
  }
}

/** The `promote_shared` arguments, as validated by its input schema. */
interface PromoteSharedArgs {
  table: PromotableTable;
  id: string;
  target_namespace?: string;
  reason?: string;
  dry_run?: boolean;
}

/** @returns The promotion outcome, or the error result that refused it. */
async function handlePromoteShared(
  dependencies: MemoryToolDependencies,
  args: PromoteSharedArgs,
  authInfo: unknown,
): Promise<ReturnType<typeof textResult>> {
  const outcome = authorizePromotion(
    dependencies,
    authIdentity(authInfo as Parameters<typeof authIdentity>[0]),
    args.target_namespace,
  );
  if (isRefusal(outcome)) return outcome;

  const row = await loadPromotionSource(
    dependencies,
    outcome.identity,
    args.table,
    args.id,
  );
  if (!row) return errorResult("Source entry not found or archived");

  const decision = classifyShareCandidate({
    content: shareContent(args.table, row),
    tags: (row.tags as string[] | null) ?? undefined,
    metadata:
      (row.extracted_metadata as Record<string, unknown> | null) ?? undefined,
  });

  // An authorized identity is permission to promote SHAREABLE content, not
  // permission to override this gate.
  if (decision === "reject-secret" || decision === "reject-private") {
    dependencies.logger.warn(
      { tool: "promote_shared", id: args.id, decision },
      "promote_shared_refused",
    );
    return errorResult(
      `Refused: entry classified as ${decision} and cannot be promoted to shared truth`,
    );
  }

  return runPromotion({
    dependencies,
    identity: outcome.identity,
    table: args.table,
    id: args.id,
    target: outcome.target,
    reason: args.reason,
    dryRun: args.dry_run ?? true,
    classification: decision,
  });
}

export function registerPromotionTools(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "list_namespaces",
    {
      description:
        "List all namespaces with entry counts per table. Useful for understanding data distribution across agents/users.",
      inputSchema: listNamespacesInputSchema,
      annotations: listNamespacesAnnotations,
    },
    (args, extra) => handleListNamespaces(dependencies, args, extra.authInfo),
  );

  server.registerTool(
    "promote_shared",
    {
      description:
        "Promote a single own-namespace thought or decision into the shared-kb " +
        "namespace (shared truth). Requires the promoter, admin, or ob-admin identity. " +
        "Classifies the entry first and REFUSES secrets or person-private " +
        "content. Dry-run by default.",
      inputSchema: promoteSharedInputSchema,
      annotations: promoteSharedAnnotations,
    },
    (args, extra) => handlePromoteShared(dependencies, args, extra.authInfo),
  );
}
