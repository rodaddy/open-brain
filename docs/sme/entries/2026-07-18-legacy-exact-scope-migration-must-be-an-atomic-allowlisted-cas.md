---
lane: security
order: 16
---
## [2026-07-18] Legacy exact-scope migration must be an atomic allowlisted CAS

**Severity:** HIGH
**Source:** Issues #295/#297, Claude first-class memory rollout
**Scope:** versioned lane migrations, replay, and restore paths
**Status:** active

A caller must not be able to relabel an arbitrary existing lane by presenting a new exact scope. Prefer a reviewed versioned database migration over silently broadening a published runtime tool contract. Automatic migration is permitted only for explicitly recognized legacy markers and canonical target coordinates derived from the same row's stable session key. The database predicate must constrain agent/source/server/channel/thread/project independently; unknown non-null conflicts remain untouched for operator review. Require live-Postgres tests for recognized and partial migration, idempotence, every coordinate conflict, namespace-independent row identity, and event-history preservation.
