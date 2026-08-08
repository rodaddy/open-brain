---
lane: correctness
order: 20
---
## [2026-07-18] Exact-scope upgrades need real-Postgres conflict and history tests

**Severity:** HIGH
**Source:** Issues #295/#297, Claude first-class memory rollout
**Scope:** `src/db/migrations/025_normalize_legacy_development_lanes.sql` and its live-Postgres test
**Status:** active

Legacy lane upgrades are data migrations, not ordinary tool behavior. Mock pools cannot prove PostgreSQL JSONB handling, case normalization, conflict predicates, idempotence, or preservation of existing lane IDs and events. Every changed upgrade predicate needs an env-gated real-pool test covering recognized and partially canonical shapes, repeated application, JSON null, unknown agent/source, server/channel/thread/project conflicts, multiple namespaces, and event-history continuity.
