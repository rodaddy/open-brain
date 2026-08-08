---
lane: correctness
order: 42
---
## [2026-07-23] Shared search helpers need caller-stable defaults

**Severity:** MEDIUM
**Source:** PR #368 review, 2026-07-23
**Scope:** shared search helpers and deployment configuration
**Status:** fixed-pre-merge

A deployment env default must be resolved at the public boundary and passed
explicitly; putting it inside a shared helper silently changes sibling consumers
that never opted into the new behavior.

### Review Questions

- Is deployment configuration resolved by the owning public caller and passed
  explicitly, while shared helpers retain a caller-stable default?
