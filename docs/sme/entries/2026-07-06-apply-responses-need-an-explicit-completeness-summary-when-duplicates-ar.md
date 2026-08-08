---
lane: quality
order: 7
---
## [2026-07-06] Apply responses need an explicit completeness summary when duplicates are possible

**Severity:** MEDIUM
**Source:** PR #254 Claude/Opus cross-review for Issue #247
**Scope:** explicit apply tools that can skip or collapse requested writes
**Status:** fixed in PR #254; keep as active checklist

### Pattern

`status: "applied"` is not enough when an apply request may skip pre-existing
duplicates or collapse duplicates inside the same batch. Clients need a
machine-readable answer for "were all requested replacements accounted for?" and
whether the source row was mutated.

### Review Questions

- Does the response expose requested, written, skipped, and collapsed counts?
- Is there an explicit boolean such as `fully_written` or an equivalent
  completeness marker?
- Does the response state whether the source row was archived, demoted, or left
  unchanged?
