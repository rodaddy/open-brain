# Dream Light is a model-free write path

**Scope key:** `repo.open_brain.dream_light_model_free_write_path`
**Source:** issue #389 (Epic DREAM) / #390 (DREAM-1)
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

The DREAM light stage is model-free by hard requirement and runs in the write path inside the same transaction as the raw turn insert — not on a timer. If light would need a model to infer something capture already carries, the bug is in capture, not in light. Always-on removes the entire 'light is behind' state class: either the turn was written with its tags or it was not, so REM never reads partially-tagged rows. Do not add a light scheduler, a light backlog counter, or a 'did light run' health check.

## Verbatim, from the source

> **Rule:** if light needs a model to infer what capture already told it, the capture is broken. [...] Light is **not a scheduled job**. It runs **in the write path**, in the same transaction as the raw turn insert.

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
