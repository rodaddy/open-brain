---
lane: correctness
order: 77
---
## [2026-08-08] A repaired or rewritten check has never failed in its current form

**Severity:** HIGH
**Source:** PR #640 (#625 sweep-heartbeat lane), PR #639 (#563 bounded-recall lane), PR #642 (#451 tiered-coverage lane)
**Scope:** every `scripts/done-means/*.sh` and its `.driver.ts`; any acceptance clause edited after its first RED run
**Status:** active

### Pattern

RED is a property of a specific version of a check, not of the check's name. Edit a clause — repair it, rewrite its instrument, swap a matcher — and the RED transcript you captured belongs to the old text. The new text has never been observed failing, so nothing distinguishes "this clause discriminates" from "this clause measures nothing and reports PASS."

Three independent lanes hit this in one week, each by a different mechanism:

- **Optional chaining on an API that does not exist.** #625's clause (a) called `sweep.runOnce?.()` on a method the subject never defined. The call short-circuited to `undefined`, the clause attempted nothing, and the aggregate verdict would have read PASS while proving zero.
- **A rewritten instrument.** #563's clause 5 was rewritten after its first RED and re-run only green. A correct-looking aggregate FAIL from the other clauses hid the fact that clause 5 measured nothing.
- **A negative match whose command was broken.** #451's clause used `rg -E`, which is `--encoding` and errors out. Inside an `if/elif` verdict chain the non-zero exit is indistinguishable from "pattern not found," so the chain advanced to PASS. This is the second `rg -E` incident in the ratchet and the first that manufactured a false GREEN rather than a visible error.

### What to do

- Re-prove RED after ANY edit to a check, including a one-line repair. The clause is new; treat it as new.
- When a clause drives a subject, assert that the drive actually happened — a return value, a counter, an observable side effect — not merely that nothing threw.
- Mutation-test every clause whose PASS comes from a NEGATIVE match. Such a clause passes both when the thing is genuinely absent and when the check itself is broken; only injecting the violation separates the two.
- Never read an aggregate FAIL as evidence that each clause ran. Read WHY each individual clause reported what it reported.

### Corollary

Every check with an exception or allowlist mechanism needs a negative control: inject a real violation into an excepted path and confirm the check still fails. The #636 gate piped violations into `| while read`, which cannot count across the subshell — it printed its own VIOLATION lines and exited 0. A gate that reports failure and passes anyway is worse than no gate.
