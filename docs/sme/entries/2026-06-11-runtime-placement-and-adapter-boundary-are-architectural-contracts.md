---
lane: domain-backend
order: 4
---
## [2026-06-11] Runtime placement and adapter boundary are architectural contracts

**Severity:** MEDIUM
**Source:** PR #76, issue #71
**Scope:** README, integration docs
**Status:** superseded (2026-06-11, by "Two MCP client implementations exist" below -- Rico
accepted a stdlib transport inside rtech-hermes-runtime instead of consuming this package)

### Pattern

`openbrain-memory` installs on agent hosts. The Open Brain service stays remote
on the LXC. `rtech-hermes` owns the Hermes adapter/lifecycle integration and
should consume this package instead of reimplementing protocol logic.

### Review Questions

- Does a change preserve one-way dependency direction?
- Does open-brain avoid importing Hermes runtime code?
- Does Hermes-specific lifecycle logic stay out of the reusable package?
