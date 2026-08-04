# The eval gate precedes any retrieval change

**Scope key:** `process.eval_gate_precedes_retrieval_change`
**Source:** https://github.com/rodaddy/open-brain/issues/265
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

Prior-art borrowing (gbrain) is scoped, never wholesale: no new graph database, no schema import, no public behavior change without namespace/auth regression tests. Open Brain already has the graph substrate (`ob_entities`, `ob_links`, `adjacent_context`); the borrowed idea is retrieval-time typed-edge recall. Ordering rule: a retrieval-quality change must not land before the A/B eval gate that proves relational lift AND normal-query no-regression exists.

## Verbatim, from the source

> Turn the useful parts of the gbrain audit into scoped Open Brain enhancements without importing gbrain wholesale. ... Rule: the retrieval arm must not land without the eval gate that proves relational lift and normal-query no-regression. ... Non-goals: No new graph database. No visual graph UI in this sprint. No gbrain schema import. No public behavior change without namespace/auth regression tests.

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
