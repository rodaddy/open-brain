---
lane: adversarial
order: 32
section: harvest-522
---
## [2026-08-03] Atomicity tests need an app-side throw, not a Postgres RAISE

**Severity:** not stated in source
**Source:** PR #430 (test(dream): live-Postgres coverage); harvested in #522
**Scope key:** `sme.atomicity_tests_need_app_side_throw`
**Status:** active

### Pattern

Reusable review check for transaction-atomicity tests: forcing the failure with a Postgres-side `RAISE` proves nothing, because an aborted transaction treats `COMMIT` as `ROLLBACK` — the wrong keyword produces the right outcome and the test passes over the bug. The reachable partial-commit path is a throw from application code between `BEGIN` and `COMMIT`, where the transaction is still healthy.

Verbatim, from the source:

> **The obvious atomicity test was worthless.** The first `bulk_set_tier` rollback test passed with `ROLLBACK` swapped to `COMMIT`. A `RAISE` inside Postgres aborts the transaction, and an aborted transaction treats `COMMIT` as `ROLLBACK`, so the wrong keyword produces the right outcome.
