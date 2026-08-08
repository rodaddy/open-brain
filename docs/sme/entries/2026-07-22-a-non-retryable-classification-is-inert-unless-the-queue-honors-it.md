---
lane: correctness
order: 36
---
## [2026-07-22] A "non-retryable" classification is inert unless the queue honors it

**Severity:** MEDIUM
**Source:** Issue #346 (MAINT-4), graph-derivation queue integration
**Scope:** `src/maintenance-queue.ts` (`fail`, runner dispatch), any handler that
throws a terminal/non-retryable error
**Status:** active

### Pattern

The graph-derivation handler classified drift (revoked approval, retired,
content re-observed, stale revision) as a `GraphDerivationTerminalError` — but
the class was only a plain `Error`, and `MaintenanceQueue.fail` dead-lettered
solely on `attempts >= max_attempts`. So a "terminal" failure was correctly
*named* yet still burned the full bounded-retry budget (N backoff attempts)
before dead-lettering. A classification that no code branches on is a comment,
not behavior. The mirror of this on the write side is equally easy to miss: a
handler must not be able to force an *immediate* dead-letter for a genuinely
retryable failure either — the terminal decision has to be a distinct,
queue-owned signal, not something derivable from a handler-mutable field.

### Rule

When a handler can declare a failure non-retryable, the queue must (1) own the
marker type at its own boundary (handlers depend on the queue, never the
reverse — a handler's terminal subclass `extends` the queue marker so the queue
imports nothing from the handler), (2) identify it by *type* at the dispatch
boundary and pass an explicit `terminal` flag into `fail`, and (3) fork the
persisted-row UPDATE so a terminal failure dead-letters on THIS attempt
regardless of remaining budget, while an ordinary error keeps the exact bounded
backoff/retry policy. Derive the decision from the durable row + the flag, never
from the handler-supplied job object. Store a distinct content-free category
(`terminal`) so dead-letter analysis can tell a policy-driven immediate
dead-letter apart from retry-exhaustion and expired-lease. If the category is
CHECK-constrained, ship the migration (fresh inline + a named re-derive for
already-upgraded DBs, mirroring the `lease_expired` compat migration) or the
first terminal write fails on upgraded databases.

### Review Questions

- Is the terminal/non-retryable error a queue-owned type the handler extends, or
  a bare `Error` the queue can't distinguish from a retryable one?
- Does `fail` actually branch on a terminal signal, or only on
  `attempts >= max_attempts`? Is there a test with `attempts < max_attempts`
  proving dead-letter-on-attempt-1 for terminal AND bounded retry for ordinary?
- Is the terminal decision derived from the durable row + an explicit flag, not
  from a handler-mutable `job` field a handler could set to force a dead-letter?
- Is a NEW `last_error_category` value added to BOTH the fresh inline CHECK and a
  named re-derive migration for already-upgraded DBs, with a drift-guard test?
- Is the failure log content-free (stable category only, never the reason text)?
