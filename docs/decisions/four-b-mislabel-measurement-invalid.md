# The 4B mislabel measurement is invalid

**Scope key:** `repo.open_brain.four_b_mislabel_measurement_invalid`
**Source:** issue #435 (DREAM-11)
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

The widely-cited '4B mislabelled 112 of 214 candidates as preference' measurement is invalid: that run left `enable_thinking` on, and Qwen3.5-4B is a reasoning model, so the parser read deliberation instead of the verdict. Do not cite it as evidence that local small models cannot grade. The load-bearing conclusion it was used to support — confidence must be corroborated, not self-reported — still stands on other grounds, but this particular evidence does not support it. General rule: when benchmarking a reasoning model through a parser, prove `enable_thinking` is off before trusting the numbers.

## Verbatim, from the source

> That run had `enable_thinking` left on; Qwen3.5-4B is a reasoning model, so the parser was reading deliberation instead of the verdict. The cited evidence does not support the conclusion drawn from it.

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
