---
lane: adversarial
order: 5
---
## [2026-07-06] Retry bounds must not require cooperative lineage metadata

**Severity:** HIGH
**Source:** PR #244 Phase 3 Claude cross-review for Issue #176
**Scope:** `src/tools/append-session-event.ts`, bounded retry/resend responses
that depend on client-supplied metadata
**Status:** fixed in PR #244

### Pattern

A retry bound can still be bypassed after root validation if the bound only
applies when the client supplies lineage metadata. In PR #244, a caller could
omit `sanitized_resubmit_of` on repeated rejected nominations and continue
receiving `resubmittable: true` because every request looked like a new root.

### Review Questions

- Does the server derive retry state from observed same-lane rejects even when
  the client omits lineage?
- Is client lineage treated as a hint that can raise the observed attempt, never
  reset it?
- Do blocked responses omit retry instructions such as `resubmit_metadata`?
- Is an invalid root distinguishable from a genuine max-attempts result?

### Prior Fix

PR #244 derives no-lineage attempts from prior same-lane root rejections,
keeps invalid roots non-resubmittable with `resubmit_blocked_reason:
invalid_resubmit_root`, and omits `resubmit_metadata` when `resubmittable` is
false. Regression tests cover omitted-lineage retry loops and invalid roots.
