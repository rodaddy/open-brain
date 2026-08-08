---
lane: correctness
order: 16
---
## [2026-07-08] Operator health surfaces need a tri-state, and REST codes must mirror body state

**Severity:** HIGH
**Source:** PR #277 pre-merge gauntlet for Issue #270
**Scope:** `src/operator-doctor.ts`, REST status endpoints, health aggregation
**Status:** fixed in PR #277

### Pattern

A binary healthy/degraded rollup hides the difference that matters to an
operator: a hard-dependency failure (DB down) must surface as unhealthy, not as
the same "degraded" used for cosmetic problems. Two related traps shipped in
the first pass: the REST status code did not mirror the body state (200 on a
degraded body), and a subsystem reporting "unknown" was allowed to pass as
healthy instead of degrading the rollup.

### Review Questions

- Does the aggregate expose at least healthy / degraded / unhealthy, with
  hard-dependency failures mapped to unhealthy?
- Does the REST status code always agree with the body state -- no
  200-on-degraded, no 5xx with a healthy body?
- Does an "unknown" subsystem status degrade the rollup rather than defaulting
  to healthy?
- Do tests cover each subsystem failing alone and assert both body state and
  HTTP code?
