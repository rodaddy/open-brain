---
lane: correctness
order: 7
---
## [2026-06-28] Cross-tool write/read shape coherence on shared rows

**Severity:** MEDIUM
**Source:** PR #228 full swarm (issue #227), correctness + domain lanes
**Scope:** any validator that reads fields off a row created by more than one tool
(`scopeConflicts` in `src/tools/append-session-event.ts`; lane writers
`session-start.ts`, `lane-upsert.ts`)
**Status:** fixed in PR #228

### Pattern

`append_session_event.create_if_missing` added a `scopeConflicts` check that
compared caller scope fields against an existing lane with strict `!==`. But
lanes are also created by `session_start` and `lane_upsert`, which do **not**
write the `source` column or `metadata.server_id`. So a lane created by
`session_start` (source `NULL`) hit `args.platform="discord" !== null` and the
legitimate first scoped append was **falsely rejected** with `scope_validation`
(retryable=false → a hard stall, since the contract tells Hermes to stop, not
retry). The adapter-contract doc compounded it: it mapped `source:
hermes-discord` + `metadata.platform: discord`, contradicting the code's
`platform → source` / compare-`args.platform`-vs-`lane.source` axis.

### Review Questions

- For every field a validator READS off a shared row, does EVERY tool that
  creates/updates that row write the same field in the same place (column vs
  JSONB key)?
- Does a strict-equality scope/identity check treat a NULL/absent stored value
  as a conflict? It should usually mean "unconstrained" (skip), with only a
  non-null mismatch rejected — otherwise partially-populated rows from a sibling
  tool false-deny.
- Does the contract doc's field placement match the field the comparison code
  actually reads?

### Prior Fix

PR #228 made `scopeConflicts` treat a null/absent existing value as
unconstrained (skip), so a non-null mismatch still conflicts and cross-scope
spill protection is preserved. Doc field mapping aligned with the comparison
axis. Regression tests: scoped append onto a `session_start`-shaped (null
source) lane succeeds; non-null channel mismatch still denies; live-Postgres
suite proves the real ON CONFLICT create/race + scope denial.
