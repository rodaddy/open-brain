---
lane: correctness
order: 44
---
## [2026-07-24] Legacy migration compatibility exceptions must be exact and non-mutating

**Severity:** MEDIUM
**Source:** issue #370 follow-up after PR #373 local activation
**Scope:** backup/applied-to-current-repo comparison and post-forward migration
head validation
**Status:** fixed in issue #370

Production `_migrations` history contains the historical duplicate markers
`005_fts_hybrid` alongside canonical `005_fts_hybrid.sql`, and
`010_chunking.sql` alongside canonical `011_chunking.sql`. Compatibility may
normalize or ignore only those exact legacy markers, only when the corresponding
canonical replacement is present in both applied history and the current repo,
and only during comparison to the current repo and post-forward head validation.
Pre-forward restored history must still match the backup manifest exactly.
Every other unknown, newer, missing, interleaved, or near-match marker remains
rejected; no migration row or file is renamed, removed, or mutated.

### Review Questions

- Is each legacy exception an exact allowlist entry with its canonical
  replacement required, rather than a prefix, suffix, or fuzzy match?
- Does pre-forward validation still compare restored history to the manifest
  exactly, before any compatibility normalization?
- Do unknown, newer, missing, interleaved, and near-match markers still fail
  closed, with no mutation of migration rows or files?
