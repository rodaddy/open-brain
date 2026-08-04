# The semantic near-dupe threshold is 0.91

**Scope key:** `repo.open_brain.semantic_dupe_threshold_091`
**Source:** issue #398 (DREAM-9)
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

Semantic near-dupe merge for candidate-to-candidate comparison uses 0.09 cosine distance (0.91 similarity), carried over from Rico's standing LiteLLM semantic-caching rule. This is settled, not an open fitting problem. `DEFAULT_DUP_THRESHOLD = 0.08` remains correct for lane-event-to-durable comparison, which was what it was tuned for. Slightly too tight is the safer default direction.

## Verbatim, from the source

> Rico standing rule from LiteLLM semantic caching: **0.91 similarity**. Same question in a different domain — "is this close enough to treat as the same thing" — and two independent arrivals at 0.91/0.92 is good evidence for the neighbourhood. Use **0.09 distance** for candidate-to-candidate. Not an open fitting problem.

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
