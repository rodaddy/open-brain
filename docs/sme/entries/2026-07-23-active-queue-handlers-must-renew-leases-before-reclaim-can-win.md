---
lane: adversarial
order: 22
---
## [2026-07-23] Active queue handlers must renew leases before reclaim can win

**Severity:** MEDIUM (P2)
**Source:** PR #358 exact-head terminal audit (issue #346)
**Scope:** `src/maintenance-queue.ts`, long-running or lock-waiting maintenance handlers
**Status:** fixed-pre-merge

### Pattern

A claimed job had a bounded lease but no heartbeat. A live graph handler could
wait on a source-row lock or execute enough statements to cross the 30-second
window. Another runner could then reclaim the job repeatedly and eventually mark
it `lease_expired`, while the original handler still committed valid graph state
but could no longer complete its stale queue token. The durable graph and queue
receipt contradicted each other, and the current hash could suppress repair.

### Rule

The queue runner renews each active lease at a bounded cadence under the immutable
claimed job ID and lease token. Renewal calls never overlap, stop on lost
ownership, and are cleared and awaited before complete/fail so a heartbeat cannot
race a terminal transition. The lease duration itself remains bounded; ownership
is extended only while the live handler is tracked. Real-PostgreSQL coverage must
hold a handler across multiple short lease windows while a competing queue tries
to reclaim it, then prove one attempt completes without dead-lettering.

### Review Questions

- Can a valid handler exceed its lease through work or lock contention without a
  renewal path?
- Is renewal guarded by the immutable claimed ID/token rather than a handler-
  mutable job object?
- Can heartbeat calls overlap, outlive completion/failure, or keep renewing after
  ownership is lost?
- Does a real-database test cross multiple lease windows with a competing claimer
  and prove attempts stay at one and the row finishes succeeded?
