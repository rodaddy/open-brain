# Canon plus index are two halves

**Scope key:** `repo.open_brain.canon_plus_index_two_halves`
**Source:** issue #440 (SEARCH-1)
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

Search indexing and always-known canon are two halves of one mechanism and neither works alone: canon carries the short absolute rule so the agent knows a rule exists, and the index serves the full procedure once that triggers a search. Index-only fails because an agent that does not know a rule exists never searches for it — measured 2026-07-29, `_DOCS/` and `_ob/` were in no qmd index and agents reliably failed in exactly the ways those unreachable docs warned against. Do not fix indexing gaps by widening the repo index; the scoping guard exists because an unscoped run cost a GPU hour on 2026-07-27.

## Verbatim, from the source

> This is the *retrieval* half only. The always-known half is #438/#439: canon carries the short absolute rule, the index serves the full procedure on trigger. Index-only is what failed here — an agent that does not know a rule exists never searches for it.

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
