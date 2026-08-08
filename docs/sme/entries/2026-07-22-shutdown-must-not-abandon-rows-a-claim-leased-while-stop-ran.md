---
lane: domain-backend
order: 19
---
## [2026-07-22] Shutdown must not abandon rows a claim leased while stop() ran

**Severity:** P2
**Source:** PR #350 / issue #343 review swarm, 2026-07-22
**Scope:** `src/maintenance-queue.ts` `MaintenanceQueueRunner` tick/stop lifecycle
**Status:** fixed

### Pattern

`stop()` could flip `stopping` while a `claimDueJobs` call was in flight. The
claim then committed — leasing rows to this runner in the database — but the
dispatch loop's mid-iteration `if (this.stopping) return` abandoned them: no
handler ran, `complete()`/`fail()` was never called, and the rows sat
`running` with a live lease, outside `active`, so `stop()` (which only waits on
`active`) resolved without draining them. They stayed stuck until lease expiry.
The lease-boundary rule for a claim-then-dispatch runner: refuse to *begin* a
new claim once stopping is observed (a claim mutates durable state), but treat
every row returned by a claim already in flight as owned work — dispatch and
track each in `active`, and have `stop()` await the in-flight tick before
draining `active`, so no leased row is ever dropped on the floor.

### Review Questions

- Can a shutdown flag be observed *between* a claim committing its leases and
  those jobs being tracked, leaving leased rows dispatched by neither path?
- Is the stop guard placed before the state-mutating claim (correct) or in the
  post-claim dispatch loop (drops already-leased work)?
- Does `stop()` await the in-flight tick so its claim's jobs land in the
  tracked set before the drain wait begins?
- Is there a deterministic test with a claim that resolves *after* stop begins,
  asserting the handler runs, complete/fail is invoked, and stop does not
  resolve until that work drains?
