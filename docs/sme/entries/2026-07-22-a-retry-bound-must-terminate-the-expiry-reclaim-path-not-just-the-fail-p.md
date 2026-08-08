---
lane: correctness
order: 27
---
## [2026-07-22] A retry bound must terminate the expiry-reclaim path, not just the fail() path

**Severity:** P2
**Source:** PR #350 / issue #343 review swarm, 2026-07-22
**Scope:** `src/maintenance-queue.ts` `claimDueJobs` expired-lease reclaim
**Status:** fixed

### Pattern

`claimDueJobs` reclaimed *every* expired `running` row and incremented
`attempts` unconditionally, while only the explicit `fail()` path honored
`max_attempts`. A handler that keeps blowing its lease (hang/crash, never
calling complete/fail) was therefore reclaimed and re-executed forever, past
its bound — the retry cap was enforced on one exit but not the other. The fix
terminates in the same claim statement: an expired running row whose
already-consumed execution attempts (`attempts`, which counts leases) have
reached `max_attempts` is dead-lettered instead of reclaimed — lease cleared,
`terminal_at`/`dead_lettered_at` stamped, a content-free `lease_expired`
category stored — and is excluded from `RETURNING` so the runner never treats
it as claimed. `attempts` is left at the number of leases actually consumed,
never inflated past `max_attempts` by the sweep. Rows with budget remaining
still reclaim normally.

### Review Questions

- Does every path that consumes an attempt (explicit failure AND lease-expiry
  reclaim) enforce the same `max_attempts` bound, or can one path retry past
  it?
- When a bounded row terminates, is it moved to a real terminal state that
  satisfies every migration CHECK (lease cleared, terminal/dead-letter
  timestamps set, valid category) — or merely left un-selected and stuck
  `running`?
- Does the counter that gates the bound keep a stable meaning (executions
  consumed) across both paths, or does the reclaim path inflate it?
- Is there a real-database regression that fails on the pre-fix code by proving
  the exhausted row cannot be reclaimed again?
