---
lane: quality
order: 17
section: harvest-522
---
## [2026-08-03] DDL tests need a dedicated schema, not row-scoped cleanup

**Severity:** P3 (stated in source)
**Source:** PR #352 (initial Full-tier review, P3); harvested in #522
**Scope key:** `testing.ddl_tests_need_a_dedicated_schema_not_row_cleanup`
**Status:** active

### Pattern

Namespace- or row-scoped cleanup does not isolate table-level DDL: a test that drops or narrows a constraint on a shared database is visible to every parallel test file and to duplicate CI workflows sharing that database. Run schema-mutating regressions inside a dedicated test schema with a scoped search_path, and serialize duplicate workflows with a session advisory lock.

Verbatim, from the source:

> The fixture globally drops and narrows `maintenance_jobs_last_error_category_check` on the shared CI database. Bun runs test files in parallel by default, so another live queue test can observe the temporary old constraint and fail spuriously. Namespace-scoped row cleanup does not isolate table-level DDL.
