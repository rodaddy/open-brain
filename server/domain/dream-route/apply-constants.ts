/**
 * The DREAM apply vocabulary, shared by the mirror apply step
 * (`scripts/dream-route-apply.ts`) and the public apply path (issue 1525).
 *
 * Moved verbatim from `scripts/dream-route-apply.ts`; that module re-exports
 * every name here so its existing importers keep compiling.
 */

/** The source string every row this step writes is attributed to. */
export const DREAM_ROUTE_SOURCE = "dream-route";

/** The tier a routed item lands in; the router commits nothing colder. */
export const DREAM_ROUTE_TIER = "warm";

/**
 * The `candidate_type` a `rule` promote event is filed under.
 *
 * `server/tools/context-pack-guidance.ts:35-38` is the read side: the
 * `process_guidance` section selects exactly
 * `metadata.candidate_type = 'process_rule'` together with
 * `metadata.memory_lifecycle_action = 'promote'`. A rule written under any
 * other type would be stored and never read.
 */
export const RULE_CANDIDATE_TYPE = "process_rule";

/**
 * The `event_type` a lifecycle promote is stored as.
 *
 * `server/db/migrations/013_session_events.sql:22-25` allows nine values and
 * `decision` is the one a standing rule is: the lifecycle action itself lives
 * in `metadata`, which is what `context-pack-repository.ts:156` filters on.
 */
export const PROMOTE_EVENT_TYPE = "decision";

/**
 * The scope key a `rule` promote is filed under.
 *
 * DERIVATION, and why it is this. `candidate_scope.key` has no server-side
 * writer anywhere in the repo -- `server/contracts/schemas-events.ts:232-239`
 * declares it client-supplied provenance, and
 * `server/tools/context-pack-guidance.ts:79-85` reads it back as an opaque
 * string, trusting only a non-empty string and treating everything else as
 * "no stable key". So the router supplies its own, and the only requirement
 * the read side imposes is STABILITY: the same rule routed twice must produce
 * the same key, or a re-run resurrects a rule the operator retired. The
 * candidate's content hash is exactly that stable identity, and it is already
 * the identity the thought path deduplicates on, so the two destinations agree
 * on what "the same item" means.
 *
 * @param contentHash - The candidate's frozen content hash.
 * @returns The scope key string stored at `metadata.candidate_scope.key`.
 */
export function ruleScopeKey(contentHash: string): string {
  return `dream-route:rule:${contentHash}`;
}
