---
lane: correctness
order: 6
---
## [2026-07-23] Operator clone procedures need their own required live boundary

**Severity:** HIGH
**Source:** PR #373 review findings P1/P2
**Scope:** local-clone runbook, `scripts/local-clone.test.ts`, backup/restore CI wiring
**Status:** fixed in PR #373

### Pattern

A clone-only test can be env-gated and silently skip even while generic
database integration suites run. A non-superuser restore additionally cannot
create source-required untrusted extensions or replay their comments. The
administrative bootstrap must cover every extension created by repository
migrations (`vector` and `pg_stat_statements`), not only the extension named by
post-restore validation.

### Review Questions

- Does CI create a fresh clone-named database owned by the exact clone role and
  export the clone URL to the live suite?
- Does the anti-skip guard require that exact suite, rather than only generic
  live-Postgres suites?
- Does the administrative bootstrap cover every extension created by the source
  migrations/archive, not only extensions checked by post-restore validation?
- With those extensions preinstalled, does restore omit nonfunctional comments
  and prove actual read/write as the clone role?
