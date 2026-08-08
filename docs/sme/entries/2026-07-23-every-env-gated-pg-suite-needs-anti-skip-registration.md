---
lane: correctness
order: 43
---
## [2026-07-23] Every env-gated PG suite needs anti-skip registration

**Severity:** MEDIUM
**Source:** PR #368 review, 2026-07-23
**Scope:** env-gated live-Postgres suites and CI anti-skip guards
**Status:** fixed-pre-merge; all three PR #368 suites registered

Adding an `OPENBRAIN_TEST_DATABASE_URL` suite is incomplete until its exact
suite name and minimum case count are registered in the CI anti-skip allowlist,
so a missing DB cannot turn new functional coverage into a green skip. The
pre-merge fix registers all three PR #368 suites, raises the aggregate floor, and
tests missing and skipped-suite failures.

### Review Questions

- Does every new env-gated PG suite appear in the anti-skip allowlist with a
  minimum executed count and a guard regression?
