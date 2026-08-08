---
lane: correctness
order: 46
---
## [2026-07-27] Acceptance is a real-database run and observed rows, not a green test

**Severity:** HIGH
**Source:** Open Brain dogfood post-mortem; migrated from Claude harness private
memory 2026-08-01.
**Scope:** any lane/tool/pipeline where "done" is claimed
**Status:** active

### Pattern

The entire Open Brain dogfood quicksand traces to code that was unit-tested
correct while it had never executed against production. `graduateLaneEvent` is
correct and tested and has **never written a row** in the database's history,
while thousands of events sat eligible — every layer above it (recall,
`brain_answer`'s table list, the dream stages) was built assuming promotion
happens. All of them were broken by one step with no caller. A passing test file
is not evidence the thing runs; a green CI check is not a receipt.

Three standing rules follow:

1. **Pull back bad work before moving on.** Anything landed incorrectly gets
   reverted and redone; no new work starts on top of a bad landing in `main`.
2. **A building block is "known good" only when proven to actually run**, not
   when the code is written and not when tests pass.
3. **Adding a layer re-tests the whole ladder against the REAL database**, bottom
   to top, every level, every time — not unit-test files, not mocks, not a
   stubbed pool.

### Review Questions

- Is acceptance "does this function behave when called" (weak) or "did this run
  end to end against a real Postgres and did the expected rows appear" (required)?
- Before a change builds on an existing component, is there evidence that
  component has actually run — its output in the data, not its tests in the repo?
- If the claim cannot be demonstrated against live data, is it labeled
  UNVERIFIED rather than asserted as done?
