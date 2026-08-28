---
lane: correctness
order: 96
---
## [2026-08-27] A non-superuser restore target needs its extensions created by an administrator first

**Severity:** MEDIUM
**Source:** pull request #944 (pushed, not merged) (issue #938)
**Scope:** `scripts/restore.ts`, `scripts/__tests__/backup-restore-live*.ts`, `scripts/test-support/clone-database.ts`

**Status:** active

### Pattern

A restore into a database owned by a non-superuser role fails inside `pg_restore` on `CREATE EXTENSION` even when the target is empty. The extensions the dump carries — `vector`, `pg_stat_statements` — are not creatable by an ordinary owner, so ownership of a fresh database is not sufficient privilege to receive the dump.

This makes a fix for restore's non-empty-target refusal misleading: granting the unprivileged role ownership of a fresh, empty database clears the refusal and then trades it for a failure deeper inside `pg_restore`, further from the cause and harder to read. The first error was legible; the second is not.

### Check

- Any test or script that restores as a deliberately unprivileged role creates the dump's extensions as the administrator first, the way `scripts/test-support/clone-database.ts:188-194` does for the runner's clone.
- When a refusal is cleared by re-targeting a restore, run the restore to completion before accepting the fix — the refusal disappearing is not the same as the restore succeeding.
