---
lane: adversarial
order: 6
---
## [2026-07-08] Deterministic retrieval arms must survive provider outages

**Severity:** HIGH
**Source:** PR #274 initial swarm for Issue #267
**Scope:** hybrid search fallback paths, deterministic graph/SQL retrieval arms
**Status:** fixed in PR #274; keep as active checklist

### Pattern

Hybrid search can accidentally skip deterministic retrieval when the embedding
provider fails. In PR #274, the embedding failure branch returned keyword-only
fallback rows before running the graph traversal arm, even though relational
graph retrieval does not need an embedding and should remain available during
provider outages.

### Review Questions

- When vector embedding generation fails, which other retrieval arms are still
  independent and should continue?
- Does the fallback branch preserve deterministic SQL/graph retrieval before
  returning degraded results?
- Is there a regression test with `embedFn` returning `null` that still proves
  graph or other non-vector evidence is recovered?
