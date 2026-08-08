---
lane: correctness
order: 0
---
## [2026-06-19] Mock-pool tests cannot catch SQL constraint or param-type failures

**Severity:** HIGH
**Source:** Issues #162, PRs #163 (bug) + #164 (regression fix)
**Scope:** `src/tools/*.ts` SQL writers, `src/tools/__tests__/**`
**Status:** active

### Pattern

`lane_upsert` shipped two production-breaking bugs in a row that a mock pool
(`{ query: async () => ({ rows: [...] }) }`) could not detect because the mock
never executes SQL:

1. PR #163: bound explicit `NULL` into the `NOT NULL` `status` column on INSERT
   — every new-lane create failed. Mock returned canned rows, test passed.
2. PR #163's own fix repointed `status` to `$24`, leaving `$3` used only in
   `CASE WHEN $3 IS NULL` / `$3 = 'literal'`. With no typed binding site,
   Postgres failed at plan time: `could not determine data type of parameter
   $3`. Again invisible to the mock.

### Review Questions

- Does the change touch SQL that a mock pool would not execute (INSERT/UPDATE,
  ON CONFLICT, CASE on a bind param, casts)?
- Is every bind param used in at least one typed position, or cast (`$n::type`)
  when used only in `IS NULL`/equality? Unanchored params fail type inference.
- Does an explicit `NULL` get bound into a `NOT NULL DEFAULT` column? The column
  default only applies when the column is OMITTED, not when NULL is supplied.
- Is there a DB-backed test (real pool, env-gated) for the representative
  write path, not only a mock assertion on row shape?

### Prior Fix

PR #164 added env-gated (`OPENBRAIN_TEST_DATABASE_URL`) integration tests that
run the real query through a real pool. Mock-shape assertions are insufficient
for SQL writers; require a real-pool test for new/changed write paths.
