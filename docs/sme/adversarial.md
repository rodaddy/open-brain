# Adversarial SME Findings

Adversarial reviewers hunt for failure states: outages, partial writes, stuck
locks, oversized data, malformed responses, and tests that pass for the wrong
reason.

## [2026-06-11] Never hold spool locks across slow dispatch

**Severity:** HIGH
**Source:** Issue #80, PR #74 follow-up
**Scope:** `python/openbrain-memory/src/openbrain_memory/spool.py`
**Status:** active

### Pattern

`JsonlSpool.replay()` holding an exclusive file lock while calling a dispatcher
can block foreground writers for the duration of slow or down HTTP calls. This
is especially bad during outage recovery, when foreground writes are likely to
need spooling too.

### Review Questions

- Does replay claim/snapshot records under lock, then release the lock before
  network/slow dispatch?
- Are new appends preserved while replay is in progress?
- Is there a concurrent replay/append test proving append latency is bounded
  while a dispatcher blocks?

## [2026-06-11] Append success must mean the record is recoverable

**Severity:** HIGH
**Source:** Issue #80
**Scope:** `python/openbrain-memory/src/openbrain_memory/spool.py`
**Status:** active

### Pattern

An oversized single record larger than `max_bytes` can be written, trimmed away,
and still return success. That creates silent data loss in a recovery path.

### Review Questions

- What happens when one record exceeds `max_bytes`?
- Does `append()` reject, truncate with an explicit marker, or store separately?
- Is there a regression test proving `append()` cannot report success while
  storing nothing?

## [2026-06-11] Fixes need failure-mode tests, not just happy-path tests

**Severity:** MEDIUM
**Source:** Issues #77-#82
**Scope:** all Open Brain client/facade work
**Status:** active

### Pattern

The first package swarm had good happy-path coverage, but later reviews found
outage and malformed-input behavior: replay dispatch, live redaction, malformed
DreamEngine reports, unbounded responses, and missing in-process transport
contracts.

### Review Questions

- What fails if the server is slow, down, malformed, oversized, or partially
  successful?
- Does each recovery feature prove durability under its own failure mode?
- Are tests only asserting method names, or are they asserting state after
  failure?

## [2026-06-19] Cursor-resumable sweeps: every processed row must advance the cursor

**Severity:** HIGH
**Source:** Issue #161, PR #171 (lane→shared-kb promoter)
**Scope:** `scripts/promote-lane-shared.ts` and any `(created_at, id) > cursor` resumable batch runner
**Status:** active

### Pattern

A resumable promoter sweeps rows ordered by `(created_at, id)` and persists a
cursor. Two ways a row can pin the cursor and cause an infinite re-sweep (and,
for the events path, a wasted embedding call every tick):

1. **Non-terminal classification (manual-review):** the row is not promoted and
   its nomination flag is intentionally left set. If the cursor only advances on
   `share`/terminal-reject, a trailing manual-review row is re-fetched forever.
2. **Deterministic write failure (poison pill):** a row whose INSERT always
   throws hits the catch block. If the catch `break`s without advancing the
   cursor, that row blocks every row behind it on every subsequent run.

### Review Questions

- In apply mode, does the cursor advance for EVERY processed row, including
  manual-review and caught-failure rows (recording the failure in the receipt
  rather than pinning)?
- Is there a real-DB test seeding a trailing manual-review row AND a
  deterministically-failing row, asserting a second run makes forward progress?
- Does dry-run intentionally NOT advance the cursor, and is `--loop` dry-run's
  full re-scan understood as intended (not a bug)?

### Prior Fix

PR #171 advances the cursor for manual-review and for caught failures in both
the thoughts/decisions and events loops; nomination flag left set + failure in
`receipt.failures` for human follow-up. Regression tests use a test-managed
`BEFORE INSERT` trigger to force a deterministic failure.
