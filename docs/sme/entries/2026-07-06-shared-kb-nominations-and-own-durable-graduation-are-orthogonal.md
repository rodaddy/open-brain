---
lane: correctness
order: 11
---
## [2026-07-06] Shared-kb nominations and own-durable graduation are orthogonal

**Severity:** HIGH
**Source:** PR #251 Claude cross-review for Issue #224
**Scope:** `src/tiering.ts`, lifecycle metadata actions, any own-durable lane classifier
**Status:** fixed in PR #251

### Pattern

Lifecycle metadata can be audit/control-plane intent without changing the
memory's own-lane graduation semantics. In PR #251, `classifyLaneEvent`
initially short-circuited every `memory_lifecycle_action`, including
`nominate_shared`, into the own-durable lane. That meant an explicit shared-kb
nomination could prevent otherwise hot/fact/long content from graduating by its
normal own-durable rules.

### Review Questions

- Is the lifecycle action a durable-lane control action, or a shared-kb
  nomination/audit marker that should remain orthogonal?
- Does adding metadata to support one promotion path accidentally suppress a
  sibling promotion/classification path?
- Do tests cover the same event qualifying for shared-kb nomination and
  own-durable graduation at the same time?

### Prior Fix

PR #251 restricted own-durable lifecycle short-circuiting to explicit
`candidate`, `promote`, `relegate`, and `discard` actions. `nominate_shared`
now follows normal graduation rules while still recording shared-kb intent.
