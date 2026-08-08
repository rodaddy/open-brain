---
lane: adversarial
order: 29
section: harvest-522
---
## [2026-08-03] A namespace test must pin the WHERE predicate and its bound parameter

**Severity:** MEDIUM (stated in source)
**Source:** PR #113 (review findings); harvested in #522
**Scope key:** `review.namespace_predicate_tests_must_pin_the_where_clause`
**Status:** active

### Pattern

A namespace-isolation test that asserts `sql.includes("namespace")` proves nothing — the word appears in the SELECT column list. Isolation regression tests must assert the exact WHERE predicate and its bound parameter. Same PR: a read-only tool must not issue writes (assert no UPDATE and no entry_access_log INSERT), and a `known_gaps`-style field must return an empty list rather than a success banner string.

Verbatim, from the source:

> Correctness MEDIUM: the namespace-predicate test is too loose because it only checks `sql.includes("namespace")`, which can pass on selected columns rather than the WHERE predicate.
