---
lane: gotcha-agent
order: 100
---
## [2026-08-27] The manifest floor is the sum of minTests, not a count of executed tests

**Severity:** MEDIUM
**Source:** pull request #949
**Scope:** `scripts/assert-db-tests-ran.ts` and every #878 conversion brief

**Status:** active

### Pattern

`MIN_TOTAL_LIVE_TESTCASES` is the sum of the manifest's own `minTests` values, not a count of testcases observed executing. Converting a suite whose describe name ALREADY has a `REQUIRED_SUITES` entry therefore raises the floor by zero. Rounds 39-40 each raised it only because each registered a NEW entry.

A brief that says "floor +N" for a suite whose entry already exists sends the lane to raise a floor its own guard test refuses. In #949 the raise passed lint, tsc, and the done-means check, and failed only the guard's unit test.

### Check

- Before editing the floor, `rg` the describe name in `REQUIRED_SUITES`: present means change nothing, absent means add the entry at the measured JUnit count and raise by that count.
- Run `bun test scripts/assert-db-tests-ran.test.ts` after any edit to that file; it is the one-second discriminator and belongs in the check list of any lane touching it.
