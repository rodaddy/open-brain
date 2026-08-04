# Dream stage certainty boundaries

**Scope key:** `repo.open_brain.dream_stage_certainty_boundaries`
**Source:** issue #389 (Epic DREAM)
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

The three DREAM stages divide by the kind of certainty each can afford, not by cadence: light stops when it would have to infer, REM stops when it would have to decide, deep stops when it is not sure and then asks. REM is a prep stage that finds, groups, and packages work so deep does not have to go looking; it deliberately over-prescribes because deep can ignore extra context but cannot recover what was never sent. Deep commits — it is not advisory.

## Verbatim, from the source

> Each stage does everything cheap that is certain and stops at the first thing needing judgment: **light stops when it would have to infer, REM when it would have to decide, deep when it is not sure** — and then it asks.

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
