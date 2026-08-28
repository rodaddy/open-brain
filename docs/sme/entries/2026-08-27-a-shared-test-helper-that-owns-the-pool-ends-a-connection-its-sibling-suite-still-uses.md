---
lane: correctness
order: 94
---
## [2026-08-27] A shared test helper that owns the pool ends a connection its sibling suite still uses

**Severity:** MEDIUM
**Source:** PR #933 (also PR #932); session-9 #878 split-and-convert lanes
**Scope:** `src/**/*-test-helpers.ts`, `scripts/test-support/*.ts`
**Status:** active

### Pattern

When a long describe block is split across two files, the shared helper module extracted alongside it is the natural place to put the database pool — and that is the defect. A helper that constructs its own `new Pool` and registers its own `afterAll` is imported by both halves, so each half's teardown ends a connection the other half may still be mid-query on. The failure is timing-dependent: it looks like a flaky suite, not a lifecycle bug, and it does not reproduce when either file is run alone.

The same extraction also produces a quieter collision: a shared row accessor lifted into the helper module takes a name that already exists as a local inside one of the moved `it` bodies, and the moved body silently binds to the local instead of the helper.

### Check

- A test helper module takes `pool: Pool` as its first parameter and constructs none. If a helper's source contains `new Pool`, that is the finding.
- Exactly one module-scope `const pool = new Pool({ connectionString: requireTestDatabaseUrl() })` per test file, with that file's own `afterAll` ending it.
- Before hoisting a shared accessor, `rg` its name across the bodies being moved and rename it if it collides.
