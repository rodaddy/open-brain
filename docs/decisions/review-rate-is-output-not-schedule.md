# Review rate is an output, not a schedule

**Scope key:** `repo.open_brain.review_rate_is_output_not_schedule`
**Source:** issue #436 (DREAM-12)
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

The nightly/morning review page shrinks because Deep learns from operator labels, not because anything filters it — the review rate is an output, never a configured schedule. The morning report has two parts: what was decided (skimmable, grows) and what could not be (the residual that costs attention); the first part is what makes the second trustworthy. Auto-decided items must always carry `graded_by = 'auto:...'` so the trail distinguishes 'Rico decided' from 'the model was trusted to decide'.

## Verbatim, from the source

> **The rate is an output, not a schedule.** Nothing sets it. It falls as agreement rises; if it stops falling, that is a real signal the residual is genuinely hard.

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
