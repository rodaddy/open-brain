---
lane: domain-backend
order: 13
---
## [2026-07-08] Shared search helper changes need explicit consumer gating

**Severity:** MEDIUM
**Source:** PR #274 initial swarm for Issue #267
**Scope:** `executeSearch`, `executeSearchWithSharedFallback`,
`executeSearchWithScopedSharedFallback`, `search_all`, `brain_answer`, REST
search paths
**Status:** fixed in PR #274; keep as active checklist

### Pattern

Adding behavior to a shared backend helper can silently expand the public
surface beyond the issue scope. In PR #274, adding graph retrieval inside
`executeSearch` would have affected direct `search_brain`, `search_all`,
`brain_answer`, and REST callers unless the graph arm was explicitly gated for
the direct tool path.

### Review Questions

- Which tools and REST endpoints call the shared helper being changed?
- Is new behavior opt-in when the issue/PR claims a narrower tool scope?
- Are sibling callers covered by graph-off or no-behavior-change regression
  tests, not only by PR-body wording?
