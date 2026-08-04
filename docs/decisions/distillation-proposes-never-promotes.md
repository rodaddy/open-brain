# Distillation proposes, never promotes

**Scope key:** `repo.open_brain.distillation_proposes_never_promotes`
**Source:** issue #382 (DISTILL-1)
**Recorded:** 2026-08-03 (harvest #522, operator-routed)
**Status:** settled. Recorded from the source issue/PR; verify against current code before relying on an implementation detail.

---

## The decision

Distillation proposes and never promotes: the `memory.distill` handler writes to `candidate_memory` only, never directly to `thoughts` or `decisions`, and promotion stays a separate reviewable step. That separation is what makes verbose-first extraction safe — over-proposing costs review attention, not corpus integrity. The handler mirrors the proven `graph.derive` discipline: reject foreign `job.version` before parsing the payload, treat malformed payloads as terminal rather than retryable, and check namespace writability server-side.

## Verbatim, from the source

> Write proposals to `candidate_memory` — **never** directly to `thoughts`/`decisions`. [...] No auto-promotion to durable memory in v1. Distillation proposes; promotion stays a separate reviewable step. This is what makes verbose-first safe: over-proposing costs review attention, not corpus integrity.

## Provenance

Harvested in #522 from the issue/PR text cited above, reviewed by the operator on
2026-08-03, and routed here rather than into a guidance lane: a decision with
rationale worth not re-litigating lives in a file, not only in a closed issue.
The quote is byte-identical to the harvest record; the decision paragraph is the
harvest's distilled rule text, unedited.
