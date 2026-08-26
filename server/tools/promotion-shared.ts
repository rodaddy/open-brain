/**
 * Helpers shared by the two promotion tools.
 *
 * `promote_shared` (`promotion.ts`) and `promote_entry` (`promote-entry.ts`)
 * answer different questions -- curated thoughts/decisions with a content gate
 * versus any table into any writable namespace -- but they enforce the SAME two
 * rules, and each kept its own copy because the two files were owned
 * concurrently. Those rules live here so there is one place to change them:
 *
 * 1. Who may promote at all (`isPromotionIdentity`).
 * 2. That the pre-rename shared namespace is a migration SOURCE and is refused
 *    as a write target (`LEGACY_SHARED_NAMESPACE`, `legacyTargetRefusal`).
 *
 * Design authority: `docs/decisions/shared-kb-canonical-namespace.md`,
 * `docs/decisions/admin-and-promoter-identities.md`.
 *
 * Deliberately NOT shared: each tool's `promotionAuth` mapping and its
 * `runPromotion`. `promote_shared` carries `tokenClientId` into the promotion
 * service and `promote_entry` does not, and the service reads that field to
 * stamp `promoted_by` (`src/promotion-service.ts`) -- so the two mappings
 * differ in observable behavior, not just in spelling. The `runPromotion`
 * pair differ in log event fields, error mapping, and result shape.
 */
import type { AuthIdentity } from "../auth/types.ts";
import type { SharedNamespaceConfig } from "../../src/shared-namespace.ts";

/**
 * The pre-rename shared namespace.
 *
 * Named as a constant rather than read from config because it is refused as a
 * write target unconditionally: `legacySharedNamespace` is empty by default, so
 * a config-only check would permit `collab` in exactly the default deployment
 * -- the rule is about the name, not the setting. Matches
 * `LEGACY_SHARED_NAMESPACE` in `server/auth/namespace-policy.ts`.
 */
export const LEGACY_SHARED_NAMESPACE = "collab";

/** @returns Whether this identity may promote entries between namespaces. */
export function isPromotionIdentity(identity: AuthIdentity): boolean {
  return (
    identity.role === "promoter" ||
    identity.role === "admin" ||
    identity.role === "ob-admin"
  );
}

/**
 * Judge a requested promotion target against the legacy-name rule.
 *
 * The legacy name is a migration SOURCE, never a write target: accepting it
 * would recreate the two-names-for-one-lane split that the canonical-namespace
 * decision exists to end.
 *
 * The caller supplies the already-resolved `target` because the two tools
 * default it differently -- `promote_shared` to the canonical shared namespace
 * and `promote_entry` to the physical one -- and those defaults are behavior.
 *
 * @returns The refusal message, or undefined when the target is allowed.
 */
export function legacyTargetRefusal(
  target: string,
  shared: SharedNamespaceConfig,
): string | undefined {
  if (
    target === LEGACY_SHARED_NAMESPACE ||
    target === shared.legacySharedNamespace
  ) {
    return `Permission denied: '${target}' is a legacy migration source and cannot be a promotion target; use '${shared.canonicalSharedNamespace}'`;
  }
  return undefined;
}
