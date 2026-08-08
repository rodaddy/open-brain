---
lane: domain-backend
order: 3
---
## [2026-06-11] Python package gates belong in CI

**Severity:** HIGH
**Source:** Issue #79
**Scope:** `.github/workflows/**`, `python/openbrain-memory/**`
**Status:** active

### Pattern

The root Bun/TypeScript gate does not protect Python package regressions,
packaging/import failures, or wheel/sdist build failures.

### Review Questions

- Does CI run `uv run pytest -q` in `python/openbrain-memory`?
- Does CI run `uv build` in `python/openbrain-memory`?
- Are these gates triggered for package changes?
- Are generated artifacts excluded from commits?
