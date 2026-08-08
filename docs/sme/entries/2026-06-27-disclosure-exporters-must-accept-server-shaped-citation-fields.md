---
lane: correctness
order: 9
---
## [2026-06-27] Disclosure exporters must accept server-shaped citation fields

**Severity:** MEDIUM
**Source:** PR #218 full swarm
**Scope:** `src/disclosure-bundle.ts`, `python/openbrain-memory/src/openbrain_memory/agent.py`
**Status:** fixed in PR #218

### Pattern

Adapter fixtures used camelCase citation fields (`sourceRef`, `artifactPath`),
but Open Brain server rows and docs expose snake_case fields (`source_ref`,
`artifact_path`). Exporters that only read camelCase silently drop citations
from real `session_context` / `search_all` shaped rows.

### Review Questions

- Do disclosure exporters normalize both camelCase wrapper fixtures and
  snake_case server rows at the boundary?
- Do tests include raw server-shaped rows, not only hand-authored camelCase
  fixtures?
- Does TS/Python parity test compare the full generated bundle, not fragments?
