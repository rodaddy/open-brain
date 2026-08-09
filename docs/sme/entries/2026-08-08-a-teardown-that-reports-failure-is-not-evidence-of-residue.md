---
lane: correctness
order: 66
---
## [2026-08-08] A teardown that reports FAILURE is not evidence of residue

**Severity:** HIGH
**Source:** issue #671 (found by the third credentialed #653 verify, head d9d3712)
**Scope:** `eval/open-brain/live/gate.ts`, `eval/open-brain/live/scenario-gate.ts`, `eval/open-brain/live/scenario-transport.ts`
**Status:** active

### Pattern

Round 16's SME rule — "a teardown that reports success is not evidence of
removal" — has a mirror that cost a full credentialed verify run. The scenario
gate's teardown verdict read `teardown.failed`, a tally of cleanup CALLS, and
treated it as a claim about ROWS. Those are different facts.

The receipt read `attempted=6 archived=4 already_absent=0 failed=2`. All three
scenarios passed live, delegation was confirmed in the service logs, and a
12-purge-table residue query for the run's namespaces returned ZERO rows. The
gate exited 1 anyway: two `archive_entry` calls had thrown, the composed
namespace purge then removed every row, and nothing corrected the count.

Two things to check in any teardown, cleanup, or reconcile verdict:

1. **The verdict reads the OBSERVABLE, not the attempt log.** If the claim is
   "nothing was left behind," the assertion is a row count queried after the
   fact, not a counter incremented by the code doing the removing. A tally is a
   diagnostic; it explains a result, it is not the result. Note the arithmetic
   tell in the receipt above: `4+0+2=6` proves the two failures were record-loop
   throws, because a purge failure increments `failed` WITHOUT touching
   `attempted` — a tally that mixes two populations cannot be read as one.

2. **"Not observed" is not "clean."** A residue reading that could not run must
   fail the verdict, not pass it. Otherwise the fix trades a false red for a
   false green, which is strictly worse. Same for a PARTIAL reading: a residue
   counter that could not read some tables reports `checked: false`, because the
   rows it failed to count are exactly where residue would hide.

Companion defect in the same code, worth checking separately: the cleanup error
was discarded into a bare `catch {}`, so when `failed=2` appeared the label of
the throw was unrecoverable from the receipt, the log, or anywhere else — the
dead-end-error class inside our own eval tooling. Keep the catch (one bad record
must not strand the rest) and capture a CONTENT-FREE label per failure: a
transport error's already-redacted label, or otherwise the error's class name
only. Never an arbitrary `Error.message`, which can echo row content, a
namespace, or a token fragment into an artifact that gets pasted into issues.

### Reviewer check

- Does any pass/fail decision rest on a counter maintained by the code being
  judged? Ask what independent observation would confirm it.
- If a residue/leak/orphan check exists, can it distinguish "zero" from "did not
  look"? Trace the unchecked branch to a verdict.
- Does the residue reader share its table/resource list with the remover, or
  maintain a parallel one? A parallel list drifts silently and GREEN — the table
  the remover stopped clearing also stops being counted.
- Does every swallowed error contribute a label somewhere an operator can read?
