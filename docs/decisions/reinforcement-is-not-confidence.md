# Reinforcement is not confidence

**Scope key:** `repo.open_brain.reinforcement_is_not_confidence`
**Source:** issue #398 (DREAM-9: Semantic near-dupe merge)
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

Confidence (is this claim true?) and reinforcement (how well-established is it?) are independent properties and must never be collapsed into one number. A duplicate does not modify the original's confidence; it writes one row to a reinforcement history table, and counting those rows IS the reinforcement measure. On merge: confidence unchanged, last-said advanced to the duplicate's `occurred_at`, first-said preserved (the span is itself evidence), and `source_refs` are NOT appended inline — refs go to the history table so a hot candidate row stays small.

## Verbatim, from the source

> An earlier draft of this issue proposed adding +0.2 to a candidate confidence score per duplicate. **That was wrong** — it conflates two independent properties [...] **One number cannot hold both**, and arithmetic that turns a 0.7 into a 0.9 because something was repeated is silently changing a truth estimate using an evidence signal.

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
