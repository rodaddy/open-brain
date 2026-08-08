---
lane: adversarial
order: 14
---
## [2026-07-21] Negative isolation matrices need full surface enumeration, an override attempt, and one live-DB anchor

**Severity:** MEDIUM
**Source:** PR #316 review swarm, 2026-07-21
**Scope:** `src/tools/__tests__/namespace-isolation-matrix.test.ts`,
`src/tools/__tests__/namespace-isolation-matrix-live.test.ts`, any cross-surface
security boundary test suite
**Status:** fixed-pre-merge

### Pattern

The first #297 negative matrix pinned only 2 of the 4 delete-capable
header-scopable tools (archive_entry, bulk_archive — missing archive_entity and
unlink_entities), never attempted a caller-supplied `namespace` argument, and
proved SQL/param shape on mocks only. Each gap is a distinct escape class:
an unenumerated tool can regress independently; a caller-influenceable
namespace argument (the `unlink_entities` schema accepts one, making this a
real future footgun for any tool that copies that schema) converts "predicate
present" into "predicate caller-controllable" unless an override attempt is
pinned; and mock-only shape proof never exercises real Postgres evaluation of
the predicate. Fixed by enumerating archive_entity/unlink_entities, adding an
override-attempt case (unknown key stripped, bound params stay auth-derived),
parameterizing over both delete-capable header-scopable roles, and adding an
`OPENBRAIN_TEST_DATABASE_URL`-gated live negative test that proves the foreign
row's `archived_at` stays NULL and the owning-namespace call succeeds
(non-vacuous).

### Review Questions

- Does the matrix enumerate EVERY tool in the boundary's capability class
  (grep the predicate/gate helper for all callers), not just the famous two?
- Is there a case where the caller actively supplies the protected dimension
  (namespace/scope) as an argument or unknown extra key, asserting it cannot
  influence the bound predicate?
- Is at least one denial anchored on a real database (row provably untouched)
  with a paired owning-identity success proving the test is not vacuous?
- Are all roles sharing the guarded branch parameterized, so a future
  role-specific branch cannot silently un-scope one of them?
