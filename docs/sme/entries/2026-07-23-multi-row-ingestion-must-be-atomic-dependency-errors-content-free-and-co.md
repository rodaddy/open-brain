---
lane: adversarial
order: 23
---
## [2026-07-23] Multi-row ingestion must be atomic, dependency errors content-free, and concurrent evidence merges row-locked

**Severity:** HIGH
**Source:** PR #363 review swarm, 2026-07-23
**Scope:** multi-row ingestion/observation writers and their content-dedupe +
citation/evidence merge paths
**Status:** fixed-pre-merge

### Pattern

Three coupled failure classes in one ingestion path:

1. **Non-atomic multi-row ingest.** One ingest call wrote multiple durable rows
   without a single transaction, so a mid-batch failure left partial rows with an
   error returned to the caller — the ambiguous-apply contract from the
   [2026-07-06] domain entry (multi-row-explicit-apply-paths-need-atomicity),
   recurring on a new surface. Wrap the whole row set in `BEGIN`/`COMMIT`/
   `ROLLBACK` (or return explicit recoverable partial progress); one call → all
   rows or none.
2. **Raw dependency errors on the failure path.** The catch path surfaced raw
   pg/driver `err.message`, which can carry row/COPY/constraint content across the
   MCP boundary — the RECURRING content-free-surface class (see the security lane's
   [2026-07-22] child-process/validation-catch entries). Every catch on the
   surface must be a stable class + `err.code`/`err.name` only, with a leak test
   injecting a sentinel-bearing dependency error.
3. **Content-dedupe that silently drops new citation/evidence, and unlocked
   concurrent evidence merges.** Content-hash dedupe treated a matching body as a
   harmless duplicate even when the incoming record carried NEW citation/evidence
   the stored row lacked — a false success (the [2026-07-13] duplicate-facts entry:
   return an explicit citation-not-stored rejection, do not claim a harmless
   duplicate). Worse, two concurrent same-content ingests could each read the row
   and each merge their evidence from a stale snapshot, so one clobbered the
   other's citation (the snapshot-clobber shape from the [2026-07-22] source-registry
   entry). Concurrent evidence merges must take a row lock (`SELECT ... FOR UPDATE`)
   or merge onto the LIVE column in SQL, so evidence is preserved (or explicitly
   rejected), never lost to a lost-update race.

### Review Questions

- Does one ingest call produce multiple durable writes? If so, are they one
  transaction (all-or-nothing), or does the tool return explicit recoverable
  partial progress — and is there a mid-batch-failure rollback test?
- Do all catch paths on the ingest surface emit a stable class + `err.code`/
  `err.name` only, with a sentinel leak test proving no row/constraint content
  escapes?
- When content-hash dedupe fires, does the path preserve or EXPLICITLY REJECT new
  citation/evidence the stored row lacks, rather than reporting a harmless
  duplicate that silently discards it?
- Do concurrent same-content evidence merges take a row lock or merge onto the
  live column in SQL, with a regression proving two interleaved merges both
  survive (no lost update)?
