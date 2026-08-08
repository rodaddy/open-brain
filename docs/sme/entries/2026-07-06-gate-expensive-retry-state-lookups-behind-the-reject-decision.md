---
lane: quality
order: 4
---
## [2026-07-06] Gate expensive retry-state lookups behind the reject decision

**Severity:** MEDIUM
**Source:** PR #244 Phase 3 Claude cross-review for Issue #176
**Scope:** `src/tools/append-session-event.ts`, synchronous share-candidate
write path
**Status:** fixed in PR #244

### Pattern

Retry bookkeeping can accidentally add latency to the success path. In PR #244,
`effectiveResubmitAttempt` queried the database for every clean sanitized
resubmit that carried lineage metadata, even though the pure classifier would
accept it and no rejection detail was needed.

### Review Questions

- Does the write path run pure, cheap classifiers before DB-backed retry-state
  work?
- Are retry counters queried only for events that are actually rejected?
- Do tests assert clean resubmits avoid rejection-detail work and unnecessary
  retry-state queries?

### Prior Fix

PR #244 first runs the sync share-candidate gate without DB retry state. Only
after a hard reject does it derive effective attempt state and rebuild the safe
rejection detail. A regression test asserts clean sanitized resubmits do not run
the retry-state query.
