---
lane: correctness
order: 28
gap: 0
---
## [2026-07-22] The state-machine transition must derive from the durable row, not the caller's job object

**Severity:** P2
**Source:** PR #350 / issue #343 Terra terminal audit, 2026-07-22
**Scope:** `src/maintenance-queue.ts` `MaintenanceQueue.fail`, `MaintenanceQueueRunner.execute/fail`
**Status:** fixed

### Pattern

`fail()` decided the terminal state (`attempts >= $3`) and the retry schedule
(`nextRunAfter = now + maintenanceBackoffMs(input.job)`) from the caller-supplied
`input.job` retry fields — `maxAttempts`, `attempts`, `backoffBaseMs`,
`backoffMaxMs`. The runner hands the **same** `MaintenanceJob` object to the
registered handler (`handler(job)`), so a handler could mutate those fields
before throwing and thereby override the persisted policy: inflate
`maxAttempts` to dodge the terminal bound (dead-letter → indefinite requeue),
or shrink `backoffBaseMs`/`backoffMaxMs` to collapse the schedule. The durable
row's policy was authoritative on disk but ignored by the transition.

The fix moves the whole decision to the persisted columns inside the
lease-token-guarded UPDATE: terminal state is `attempts >= max_attempts`, and
`run_after` is computed in SQL from the row's own `attempts`, `backoff_base_ms`,
`backoff_max_ms` — `now + LEAST(backoff_base_ms * 2 ^ LEAST(GREATEST(attempts-1,
0), 30), backoff_max_ms)` — mirroring `maintenanceBackoffMs()` exactly (first
retry uses base, exponent bounded, cap preserved). No caller-supplied
retry-policy value reaches the transition; `input.job` is used only for the
id + lease-token guard, which `claimDueJobs` minted. The runner additionally
captures immutable claim identity (`id`, `kind`, `leaseToken`) before invoking
the handler and binds `complete`/`fail` to it, so handler mutation of
`job.id`/`job.leaseToken` cannot redirect the guard to another row or make the
regression vacuous. Content-free category and stale-lease no-op semantics are
unchanged. See also [2026-07-22] retry-bound-must-terminate-the-expiry-reclaim
above — both paths now honor `max_attempts` from the row, not from any object.

### Rule

A durable state-machine transition (terminal decision, next-run time, any
policy gate) must be derived from persisted row columns inside the guarded
UPDATE — never from a mutable in-memory object that untrusted or handler code
holds a reference to. The passed object may supply only opaque identity used in
the WHERE guard (here id + lease token), and even that identity should be
snapshotted before handler code runs.

### Review Questions

- Does a state transition read retry/policy values from a caller-passed object,
  or from the row's own columns? If the same object is handed to a handler that
  runs before the transition, mutation of those fields silently rewrites policy.
- Is the terminal bound and the schedule computed in SQL over persisted columns,
  or in JS over the input job? A JS computation over the input is caller-owned.
- Is the claim identity used in the lease-token guard snapshotted before handler
  code runs, so mutation of `id`/`leaseToken` cannot redirect or void the guard?
- Does a real-database regression enqueue a known policy, mutate the retry
  fields via the handler (or the returned job) before failing, and prove the
  persisted row still dead-letters/schedules per the durable policy — failing on
  the pre-fix code?
