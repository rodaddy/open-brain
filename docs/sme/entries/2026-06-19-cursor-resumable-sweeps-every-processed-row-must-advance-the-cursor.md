---
lane: adversarial
order: 3
---
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
