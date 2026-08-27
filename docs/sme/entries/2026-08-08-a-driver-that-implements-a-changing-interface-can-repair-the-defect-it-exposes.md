---
lane: correctness
order: 85
---
## [2026-08-08] A driver that implements a changing interface can repair the defect it exposes

**Severity:** HIGH
**Source:** PR #673 (#671 verdict-channel lane), Tightenings round 24
**Scope:** `scripts/done-means/*.driver.ts` where the driver implements an interface the fix changes; residue and leak readers
**Status:** active

### Pattern

The #671 driver returned only the POST-fix shape. Handed to the pre-fix gate, that object had no `failed` field, and `undefined > 0` is false — so the broken gate reported PASS and the RED was false.

This is a new spelling of the false-RED family (round 18's broken import, round 22's env mutant): a CONTRACT-SHAPE mismatch that reads as legitimate green rather than as an error.

### What to do

- When a fix changes a driver-implemented signature, return BOTH shapes, and assert the RED went red for the defect's OWN reason — not merely that it went red.
- **When a fix changes WHICH SIGNAL produces a failure, the control clause must assert the SIGNAL, not the outcome.** "Gate failed" was satisfied pre-fix by the old tally verdict, certifying a mechanism that did not exist yet. Round 9/17's negative-match family, extended.
- **"Not observed" must fail closed.** A verdict moved onto a query inherits that query's failure modes; unchecked and partially-read readings both fail, or the false-red fix becomes a false-green one.

### Corollary: a residue reader shares the remover's resource list

A residue or leak reader must read the REMOVER'S list of tables, never a parallel copy. Two lists drift, and the drift fails GREEN: the table the purge stops clearing also stops being counted, so the leak becomes invisible at exactly the moment it starts.

Enforce with a unit test asserting the reader names exactly the remover's tables.

### Corollary: a lane that cannot see the live path says so

The #671 lane was constrained away from the live path and could only observe its own stub label. It reported instrumentation shipped, not findings observed, and filed #672 for the real one. "NOT OBSERVED — structurally cannot observe" is a complete, correct answer; a fabricated observation is not.
