# `dream_once()` is dry-run-only

**Scope key:** `decision.dream_once_is_dry_run_only`
**Source:** rodaddy/open-brain#75 (comment by rodaddy)
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

`DreamEngine.dream_once()` is dry-run-only by design: a multi-mutation planner with no transaction or rollback must not be given an apply mode. Mutations are reached only through individually opt-in explicit wrappers. Do not add a `dry_run=False` path back without a real transaction boundary.

## Verbatim, from the source

> HIGH: dream_once(dry_run=False) could partially apply multiple mutations with no transaction/rollback. Fixed by making dream_once dry-run-only for this first release; explicit wrapper mutations remain individually opt-in.

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
