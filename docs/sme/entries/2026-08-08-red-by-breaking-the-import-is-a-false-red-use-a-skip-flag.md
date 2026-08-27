---
lane: correctness
order: 93
---
## [2026-08-08] RED by breaking the import is a false RED — use a SKIP flag

**Severity:** HIGH
**Source:** #655 eval-teardown lane, Tightenings round 16
**Scope:** `scripts/done-means/655-eval-teardown.sh` and every check whose RED must stay regenerable after the fix ships
**Status:** active

### Pattern

Moving a module aside to produce RED killed the driver AT IMPORT. Clause (a) measured nothing, and the transcript was indistinguishable from a real RED.

A `SKIP_*` env flag reproduces the pre-fix world with everything else intact, and keeps RED regenerable FOREVER without deleting the fix.

### What to do

- Reproduce the pre-fix world by an env flag the shipped code reads, not by damaging the module graph.
- **A guard needs a CANARY, not just an exception.** "Throws on a bad name" and "refuses BEFORE mutating" are different claims. Only planting a row under each refused name and checking it SURVIVES distinguishes them — an exception thrown after the mutation looks identical from the outside.
- **Assert a row COUNT from OUTSIDE the run.** A teardown that reports success is not evidence of removal: the RED run showed `failed=0` while two rows leaked, because the tally is the thing under test and can never be its own proof.

### Corollary: the design-lookup window is session-scoped, not lane-scoped

A sibling CONCURRENT lane's lookup can occupy the recent-lookup window and make a correct denial look spurious. The gate is working as designed. Know the shape before reporting it as a misfire — a false gate-defect report costs the operator loop more than the denial cost the lane.
