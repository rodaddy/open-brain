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
import { canonicalNamespace, sharedNamespaceConfig } from "../../src/shared-namespace.ts";
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
    namespaceSource: identity.namespaceSource === "delegated" ? "header" : "token",
  };
}

/** @returns The text a classifier fed for this row. */
function shareContent(table: PromotableTable, row: Record<string, unknown>): string {
  if (table === "decisions") {
    const title = (row.title as string | null) ?? "";
    const rationale = (row.rationale as string | null) ?? "";
    return `${title} ${rationale}`.trim();
  }
  return (row.content as string | null) ?? "";
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
      inputSchema: {
        raw: z
          .boolean()
          .optional()
          .describe("Return physical namespace names instead of canonical public names"),
      },
      annotations: {
        title: "List Namespaces",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      if (!identity) return errorResult("Permission denied: not authenticated");
      const accessible = ALL_TABLES.filter((table) => canRead(identity.role, table));
      if (accessible.length === 0) {
        return errorResult("Permission denied: no readable tables");
      }

      const results = await Promise.all(
        accessible.map(async (table) => {
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

      // Folding legacy names onto the canonical one can collide two physical
      // namespaces into a single reported lane, so counts are SUMMED per table
      // rather than overwritten.
      const byNamespace = new Map<
        string,
        { total: number; per_table: Record<string, number> }
      >();
      for (const rows of results) {
        for (const row of rows) {
          const physical = String(row.namespace);
          const name = args.raw ? physical : canonicalNamespace(physical);
          const entry = byNamespace.get(name) ?? { total: 0, per_table: {} };
          const count = Number(row.count);
          entry.total += count;
          entry.per_table[String(row.table_name)] =
            (entry.per_table[String(row.table_name)] ?? 0) + count;
          byNamespace.set(name, entry);
        }
      }

      const namespaces = [...byNamespace.entries()]
        .map(([namespace, data]) => ({
          namespace,
          total: data.total,
          per_table: data.per_table,
        }))
        .sort((a, b) => b.total - a.total);

      dependencies.logger.info(
        { tool: "list_namespaces", namespaceCount: namespaces.length },
        "tool_result",
      );
      return textResult({ namespace_count: namespaces.length, namespaces });
    },
  );

  server.registerTool(
    "promote_shared",
    {
      description:
        "Promote a single own-namespace thought or decision into the shared-kb " +
        "namespace (shared truth). Requires the promoter, admin, or ob-admin identity. " +
        "Classifies the entry first and REFUSES secrets or person-private " +
        "content. Dry-run by default.",
      inputSchema: {
        table: z.enum(PROMOTABLE_TABLES).describe("Source table holding the entry to promote"),
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
      },
      annotations: {
        title: "Promote To Shared KB",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      // Defense in depth: refused here before any read, and `promoteEntry`
      // re-checks write authority for the target namespace on its own.
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
      const target = args.target_namespace ?? shared.canonicalSharedNamespace;
      // The legacy name is a migration SOURCE, never a write target: accepting
      // it here would recreate the two-names-for-one-lane split that the
      // canonical-namespace decision exists to end.
      //
      // `collab` is refused UNCONDITIONALLY, not just when it is the configured
      // legacy name. `legacySharedNamespace` defaults to empty, so a
      // config-gated check would silently allow `collab` as a target in exactly
      // the default deployment -- the rule is about the name, not the setting.
      if (target === LEGACY_SHARED_NAMESPACE || target === shared.legacySharedNamespace) {
        return errorResult(
          `Permission denied: '${target}' is a legacy migration source and cannot be a promotion target; use '${shared.canonicalSharedNamespace}'`,
        );
      }

      // Read the source for classification under the caller's own read scope.
      // `table` is a validated enum, so the branch is an allowlist rather than
      // interpolation of caller text.
      const contentColumns = args.table === "decisions" ? "title, rationale" : "content";
      const predicate = namespacePredicate(identity, "read", 2);
      const { rows } = await dependencies.pool.query(
        `SELECT id, ${contentColumns}, tags, extracted_metadata
           FROM ${args.table as ResourceTable}
          WHERE id = $1 AND archived_at IS NULL${predicate.clause}`,
        [args.id, ...predicate.values],
      );
      if (rows.length === 0) return errorResult("Source entry not found or archived");

      const row = rows[0] as Record<string, unknown>;
      const decision = classifyShareCandidate({
        content: shareContent(args.table, row),
        tags: (row.tags as string[] | null) ?? undefined,
        metadata: (row.extracted_metadata as Record<string, unknown> | null) ?? undefined,
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

      try {
        const result = await promoteEntry(
          dependencies.pool,
          args.table,
          args.id,
          target,
          args.reason,
          promotionAuth(identity),
          { dryRun: args.dry_run ?? true },
        );
        dependencies.logger.info(
          {
            tool: "promote_shared",
            id: args.id,
            status: result.status,
            dryRun: args.dry_run ?? true,
          },
          "tool_result",
        );
        return textResult({ classification: decision, ...result });
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        const message = error instanceof Error ? error.message : String(error);
        dependencies.logger.warn(
          { tool: "promote_shared", id: args.id, statusCode },
          "promote_shared_error",
        );
        return errorResult(
          statusCode && statusCode < 500
            ? `Permission denied: ${message}`
            : `Promotion failed: ${message}`,
        );
      }
    },
  );
}

/** @returns Whether this identity may attempt a shared-truth promotion. */
function isPromotionIdentity(identity: AuthIdentity): boolean {
  return (
    identity.role === "promoter" ||
    identity.role === "admin" ||
    identity.role === "ob-admin"
  );
}
