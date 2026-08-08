---
lane: gotcha-agent
order: 15
---
## [2026-07-18] Legacy-lane repair can become a scope takeover

**Severity:** HIGH
**Source:** Issues #295/#297, Claude first-class memory rollout
**Scope:** versioned exact-scope lane migrations
**Status:** active

Do not broaden a published lifecycle tool to rewrite non-null legacy coordinates without a contract/version rollout. A versioned migration must derive the canonical project/channel from the row's own stable key, require explicit legacy agent/source markers, keep threaded lanes out, accept only absent or already-canonical server/channel/project values, and leave unknown conflicts untouched. Require a real-Postgres migration test with JSON null, partial migration, idempotence, multiple namespaces, and preserved event history.
