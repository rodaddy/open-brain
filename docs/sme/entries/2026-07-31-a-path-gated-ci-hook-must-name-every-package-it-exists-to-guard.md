---
lane: quality
order: 15
---
## [2026-07-31] A path-gated CI hook must name every package it exists to guard

**Severity:** MEDIUM
**Source:** Step-8 review swarm (Sol terminal audit), fixed in `967a3be`
**Scope:** `_githooks/pre-push`
**Status:** active

### Pattern

The pre-push hook gated Python validation on `python/openbrain-memory` paths
only, so a push touching only `python/openbrain` skipped pytest/ruff/mypy
entirely -- true of the very range that introduced the second package. When a
repo grows a sibling package, every path-predicated gate written for the
first one silently exempts the second. Each package gets its own path
predicate and its own validation commands.

### Review Questions

- List the packages/workspaces in the repo; does each appear in the hook's
  path predicates with its own gate?
- Was the hook's predicate re-checked when a new top-level package landed?
