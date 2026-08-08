---
lane: security
order: 32
---
## [2026-08-01] A post-insert recompute keyed on a client field crosses the namespace boundary

**Severity:** MEDIUM
**Source:** PR #455 adversarial lane, fixed on `rewrite/420-settings-cutover`
**Scope:** `src/tools/ingest-raw-turn.ts` (`session_seq` recompute), any
window/aggregate mutation partitioned on a client-supplied, non-namespace-unique
column
**Status:** active

### Pattern

`ingest_raw_turn`'s post-insert `session_seq` recompute ran
`row_number() OVER (PARTITION BY session_ref ...)` and `UPDATE ob_raw_turns`
with NO `namespace` predicate in either the ordering CTE or the UPDATE.
`session_ref` is client-supplied (`z.string().max(500)`) and is NOT
namespace-unique — the only uniqueness on the table is `(namespace, turn_uuid)`
(migration 032). Two namespaces can legitimately carry the same `session_ref`,
so a write in namespace A recomputed `session_seq` across the whole
`session_ref` partition and renumbered namespace B's rows by folding A's
`occurred_at` values into B's ordering — a cross-namespace WRITE from an
in-namespace call, violating the repo isolation rule (any ID-based mutation
carries an auth-derived namespace predicate).

Proven live: B ingests two turns on a shared `session_ref` (seq 0, 1); A then
writes one turn on the same `session_ref` whose `occurred_at` falls between B's
two; without the predicate B's second turn is pushed from seq 1 to seq 2. The
fix adds `namespace = $2` (the caller's resolved `ns`) to both the CTE source
and the UPDATE; the regression fails on the old code at exactly that assertion.
Note the migration 036 backfill has the same unscoped partition, correct only
because the historical corpus is single-namespace — the LIVE per-write path is
where the boundary must hold.

### Review Questions

- Does every window/aggregate/UPDATE that touches more than the just-inserted
  rows carry the auth-derived namespace predicate on BOTH the read side (the
  CTE/subquery) and the write side (the UPDATE/DELETE)?
- Is the partition/join key namespace-unique? If it is client-supplied and the
  only unique index is `(namespace, <id>)`, partitioning on the id alone reaches
  across the boundary.
- Is there a regression that writes the SAME client id in two namespaces and
  proves one namespace's write leaves the other's derived columns untouched?
