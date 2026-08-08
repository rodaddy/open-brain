---
lane: correctness
order: 26
---
## [2026-07-22] Migration-set compatibility must be prefix-based, not subset-based

**Severity:** MEDIUM
**Source:** PR #318 review swarm, 2026-07-22
**Scope:** `scripts/backup-lib.ts` (`compareMigrationSets`), `scripts/restore.ts`
forward-migration path
**Status:** fixed-pre-merge

### Pattern

`compareMigrationSets` classified a backup as `restorable_with_migrations`
whenever its applied list was a SUBSET of the repo migration list. Subset
membership cannot see ordering: a backup with an interleaved / mid-sequence
gap (applied 001,003 against repo 001,002,003) passed as restorable, and the
forward-migration path would then apply 002 AFTER 003 had already run — an
ordering the migration authors never wrote or tested, which set-comparison
validation after the fact cannot detect either (the final sets are equal).
Compatibility for ordered, append-only sequences must require the sorted
backup list to be an exact PREFIX of the sorted repo list; any interleaved
gap is a distinct fail-closed verdict (`incompatible_interleaved`), not a
restorable one.

### Review Questions

- Is any "older but upgradable" check implemented as set/subset membership
  over an ORDERED sequence (migrations, event logs, schema revisions)? It
  must be a prefix check.
- Does the interleaved-gap case (missing middle element) have its own
  fail-closed verdict and unit test, distinct from unknown/newer elements?
- Would the post-upgrade validation catch an out-of-order application, or do
  both paths converge to identical final sets (making the ordering bug
  invisible after the fact)?
