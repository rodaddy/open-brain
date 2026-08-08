---
lane: quality
order: 3
---
## [2026-06-27] Cross-language feature parity needs shared golden fixtures

**Severity:** MEDIUM
**Source:** PR #218 full swarm
**Scope:** TS/Python facade parity, disclosure bundle export tests, contract docs
**Status:** fixed in PR #218

### Pattern

When a contract claims TS/Python facade parity, fragment assertions in each
language are not enough. Independent deterministic exporters can drift in file
order, frontmatter, path collision handling, citation rendering, or receipt
formatting while both local tests still pass.

### Review Questions

- Does a shared fixture compare full file paths and contents across both
  language implementations?
- Are stale examples updated when a partial helper becomes feature-complete?
- Do docs distinguish intentional API shape differences from missing behavior?
