---
lane: correctness
order: 5
---
## [2026-06-19] Env-gated DB tests skip silently in CI unless the URL is set

**Severity:** HIGH
**Source:** Issue #165 / #161, PR #171
**Scope:** `.github/workflows/ci.yml`, all `dbDescribe`-gated suites
**Status:** active

### Pattern

The env-gated real-Pool tests (the only ones that catch SQL bugs per the
mock-pool finding above) gate on `OPENBRAIN_TEST_DATABASE_URL`. CI set `DB_*`
and ran migrations against a real Postgres but never set
`OPENBRAIN_TEST_DATABASE_URL`, so every `dbDescribe` suite SKIPPED in CI — the
exact write paths the discipline rule exists to protect had zero CI coverage.

### Review Questions

- Does CI export `OPENBRAIN_TEST_DATABASE_URL` so `dbDescribe` suites actually
  run, not skip?
- When a critical guarantee is only covered by an env-gated test, is that env
  wired in CI, or is it a silent gap?

### Prior Fix

PR #171 set `OPENBRAIN_TEST_DATABASE_URL` in the CI `check` job env, built from
the existing `DB_*` values, enabling all env-gated suites in CI.
