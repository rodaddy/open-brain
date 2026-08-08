---
lane: gotcha-agent
order: 0
---
## [2026-07-05] Scratch-DB test fixtures must be built from the real migrations

**Severity:** HIGH
**Source:** PR #237 Codex cross-model review (P1s)
**Scope:** `scripts/retire-collab-migration.ts`, `scripts/retire-collab-migration.test.ts`, any script tested against a scratch Postgres
**Status:** fixed in PR #237

### Pattern

A scratch-Postgres test that hand-builds its own CREATE TABLE fixtures can
pass while the script is broken against production. In PR #237 the invented
fixture gave `ob_session_lanes` an `archived_at` column that production does
not have (its lifecycle is `status` + `ended_at`), so the migration script's
lane step would have crashed on the live DB while the test stayed green. The
same invented schema also hid the second active-uniqueness index on
`ob_entities (namespace, entity_type, canonical_id)`.

Rule: scratch-DB tests MUST create their schema by running the repo's actual
migrations (`runMigrations(pool)` from `src/db/migrate.ts`), never by
hand-writing DDL. Then schema drift between script and production cannot hide.

### Review Questions

- Does any DB-backed test create tables with hand-written DDL instead of the
  repo migrations? Reject it.
- Does a data-migration script touch a column without grepping ALL migrations
  for that table's real lifecycle columns (soft-delete may be `archived_at` on
  one table and `status`/`ended_at` on another)?
- Are multi-step mutating scripts transactional so a mid-run failure cannot
  strand earlier steps?
- Does the script audit for affected-but-unmigrated content (all tables the
  removed code path served), failing loudly instead of reporting success?
