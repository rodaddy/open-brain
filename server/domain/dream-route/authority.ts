/**
 * R3 authority comes from the source of the text, never from a model
 * (`docs/code-brain-design.md:127-149`).
 */

import type { AuthorityTier, RouteCandidate } from "./types.ts";

/**
 * `decided` only when the operator typed it as a whole exchange: a fragment,
 * an orphan anchor, or a missing anchor is at best something we observed.
 */
export function authorityTierOf(c: RouteCandidate): AuthorityTier {
  const typedByOperator =
    c.anchorKind === "typed" || c.anchorKind === "askuserquestion";
  return c.unitKind === "exchange" && typedByOperator ? "decided" : "observed";
}
