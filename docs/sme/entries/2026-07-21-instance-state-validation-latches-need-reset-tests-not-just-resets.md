---
lane: correctness
order: 24
---
## [2026-07-21] Instance-state validation latches need reset tests, not just resets

**Severity:** MEDIUM
**Source:** PR #314 (open-brain#310 scope-aware drain) review swarm 2026-07-21
**Scope:** `python/openbrain-memory/src/openbrain_memory/runtime.py` (`_replay_scope`, `_drain_spool`)
**Status:** fixed-pre-merge

### Pattern

`_drain_spool` latches `self._replay_scope` so replayed `session_start` results
validate against the parked unit's scope. The `finally` reset was correct, but
no test failed when it was deleted — the entire suite stayed green while the
regression (stale foreign scope failing every subsequent live `session_start`,
degrading all writes to SPOOLED) went undetected. Any instance-state latch that
changes validation behavior needs a test that exercises the *next* operation
after the latch should have cleared, and the test should be mutation-verified
(delete the reset, watch the test fail) before it counts as coverage.

### Review Questions

- Does any instance attribute temporarily change validation/dispatch behavior?
  If so, is there a test asserting the behavior *after* the temporary window?
- Was the guard test proven against the mutant (reset removed → test fails with
  the predicted failure mode)?
- Is the latch also reset per iteration inside loops, so later items cannot
  inherit a stale value if new code paths skip the tail reset?
