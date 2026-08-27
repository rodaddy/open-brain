/**
 * `promote_entry`: copy one entry into a target namespace with provenance.
 *
 * Design authority: `docs/decisions/shared-kb-canonical-namespace.md`,
 * `docs/decisions/admin-and-promoter-identities.md`, and
 * `docs/identity-boundary.md`.
 *
 * ## How this differs from `promote_shared`
 *
 * `promote_shared` (in `promotion.ts`) is the CURATED path: thoughts and
 * decisions only, classified first, and hard-refused if the content is a secret
 * or person-private. `promote_entry` is the general one -- any of the five
 * tables, any target namespace the caller may write. They are both kept because
 * they answer different questions, and collapsing them would either drop the
 * content gate from the curated path or impose thoughts/decisions-only on the
 * general one.
 *
 * Both delegate the actual copy to `src/promotion-service.ts`, which owns
 * provenance stamping, duplicate detection in the target, and its own re-check
 * of write authority. That re-check is why a single owning boundary matters: a
 * second copy of the promotion logic here would be a second place for the
 * namespace rule to drift.
 *
 * ## Dry-run is the default
 *
 * `dry_run` defaults to TRUE, so a promotion happens only when a caller asks
 * for it in as many words. Current-src defaults this to `false`; the rewrite
 * flips it, exactly as the ported `promote_shared` already does
 * (`promotion.ts`, `{ dryRun: args.dry_run ?? true }`). Writing into another
 * namespace on a caller's first exploratory call is the failure mode the
 * repo's mutation-is-opt-in standard exists to stop, and the report shape is
 * identical either way so previewing costs a caller nothing.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthIdentity, ResourceTable } from "../auth/types.ts";
import type { AuthInfo } from "../types.ts";
import { sharedNamespaceConfig } from "../../src/shared-namespace.ts";
import { promoteEntry } from "../../src/promotion-service.ts";
import {
  authIdentity,
  errorResult,
  textResult,
  type MemoryToolDependencies,
} from "./types.ts";
import { tableEnum } from "./curation-helpers.ts";
import {
  isPromotionIdentity,
  legacyTargetRefusal,
} from "./promotion-shared.ts";

/**
 * Convert the server identity into the promotion service's shape.
 *
 * `delegated` and `header` name the same fact -- the namespace did not come
 * from the token -- and the promotion service keys its re-check on it, so the
 * value is MAPPED rather than cast.
 */
function promotionAuth(identity: AuthIdentity): AuthInfo {
  return {
    role: identity.role,
    clientId: identity.clientId,
    namespaceSource:
      identity.namespaceSource === "delegated" ? "header" : "token",
  } as AuthInfo;
}

/** Input schema for `promote_entry`. */
const promoteEntryInputSchema = {
  table: tableEnum.describe("Source table"),
  id: z.string().uuid().describe("Source entry UUID"),
  reason: z
    .string()
    .max(1000)
    .optional()
    .describe("Why this entry is being promoted"),
  target_namespace: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe("Target namespace (default: shared-kb)"),
  dry_run: z
    .boolean()
    .optional()
    .describe(
      "Return a promotion report without inserting into the target namespace (default true)",
    ),
};

/** MCP annotations for `promote_entry`. */
const promoteEntryAnnotations = {
  title: "Promote Entry",
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
};

/** The already-validated arguments this tool's helpers operate on. */
interface PromoteEntryArgs {
  table: string;
  id: string;
  reason?: string;
  target_namespace?: string;
  dry_run?: boolean;
}

/**
 * Resolve the promotion target, refusing the legacy shared name.
 *
 * @returns The resolved target namespace, or a refusal message when the
 * requested target is the pre-rename shared namespace.
 */
function resolvePromotionTarget(
  requested: string | undefined,
): { target: string } | { refusal: string } {
  const shared = sharedNamespaceConfig();
  // The default is the PHYSICAL shared namespace here, where `promote_shared`
  // defaults to the canonical one; the two differ under a split config and
  // that difference is behavior, so each tool keeps its own default.
  const target = requested ?? shared.sharedNamespace;
  const refusal = legacyTargetRefusal(target, shared);
  if (refusal) return { refusal };
  return { target };
}

/**
 * Map a promotion throw onto a caller-safe error result, logging the failure.
 *
 * @returns The tool error response for the failed promotion.
 */
function respondToPromotionFailure(options: {
  dependencies: MemoryToolDependencies;
  args: PromoteEntryArgs;
  target: string;
  dryRun: boolean;
  error: unknown;
}): ReturnType<typeof errorResult> {
  const { dependencies, args, target, dryRun, error } = options;
  // A promotion that never happened used to leave no trace while a
  // successful one did; silence meaning failure is exactly backwards.
  dependencies.logger.error(
    {
      tool: "promote_entry",
      table: args.table,
      sourceId: args.id,
      targetNamespace: target,
      dryRun,
      errorName: error instanceof Error ? error.name : "unknown",
    },
    "promote_entry_failed",
  );
  // The promotion service marks DELIBERATE rejections with a statusCode
  // and a curated message, and those are the contract. An error without
  // one is an unexpected throw whose message is raw driver text --
  // relation names, connection detail, quoted parameter values -- and
  // must not reach a caller.
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return errorResult(
    typeof statusCode === "number" && error instanceof Error
      ? error.message
      : "Promotion failed due to an internal error",
  );
}

/**
 * Run the promotion through the owning service and shape its report.
 *
 * @returns The promotion report, or an error result when the service throws.
 */
async function runPromotion(options: {
  dependencies: MemoryToolDependencies;
  args: PromoteEntryArgs;
  identity: AuthIdentity;
  target: string;
}): Promise<ReturnType<typeof textResult> | ReturnType<typeof errorResult>> {
  const { dependencies, args, identity, target } = options;
  const dryRun = args.dry_run ?? true;
  try {
    const result = await promoteEntry(
      dependencies.pool,
      args.table as ResourceTable,
      args.id,
      target,
      args.reason,
      promotionAuth(identity),
      { dryRun },
    );
    dependencies.logger.info(
      {
        tool: "promote_entry",
        table: args.table,
        sourceId: args.id,
        newId: result.new_id,
        existingId: result.existing_id,
        targetNamespace: result.target_namespace,
        status: result.status,
        dryRun: result.dry_run,
      },
      "tool_result",
    );
    return textResult(result);
  } catch (error) {
    return respondToPromotionFailure({
      dependencies,
      args,
      target,
      dryRun,
      error,
    });
  }
}

export function registerPromoteEntryTool(
  server: McpServer,
  dependencies: MemoryToolDependencies,
): void {
  server.registerTool(
    "promote_entry",
    {
      description:
        "Promote an entry from an agent namespace to shared-kb or another target namespace. " +
        "Copies the entry with provenance tracking and detects duplicate target rows. " +
        "Dry-run by default.",
      inputSchema: promoteEntryInputSchema,
      annotations: promoteEntryAnnotations,
    },
    async (args, extra) => {
      const identity = authIdentity(extra.authInfo);
      // Defense in depth: refused here before any read, and `promoteEntry`
      // re-checks write authority for the target namespace on its own.
      if (!identity || !isPromotionIdentity(identity)) {
        dependencies.logger.warn(
          { tool: "promote_entry", role: identity?.role },
          "promote_entry_denied",
        );
        return errorResult(
          "Permission denied: admin, ob-admin, or promoter role required",
        );
      }

      const resolved = resolvePromotionTarget(args.target_namespace);
      if ("refusal" in resolved) return errorResult(resolved.refusal);

      return runPromotion({
        dependencies,
        args,
        identity,
        target: resolved.target,
      });
    },
  );
}
