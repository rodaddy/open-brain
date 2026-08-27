---
lane: quality
order: 88
---
## [2026-08-08] PIPESTATUS outside the pipeline's shell prints empty and reads as exit 0

**Severity:** MEDIUM
**Source:** #653 branch-sync lane, Tightenings round 21; sibling of round 19's tee-masking finding
**Scope:** `scripts/done-means/*.sh`, verify-lane runs, any clause whose whole claim is a non-zero exit
**Status:** active

### Pattern

`PIPESTATUS` evaluated OUTSIDE the pipeline's own shell prints EMPTY. At a glance that is indistinguishable from exit 0, so a clause whose entire claim is "this refusal exits non-zero" reports success on a run that captured nothing.

It bit twice in one lane: once on a refusal path and once on `tsc`. It is the second spelling of round 19's finding that piping a driver through `tee` masks the exit code.

### What to do

- Redirect to a file and read `$?` directly, or set `pipefail` and re-run clean. Do not read a status through a pipeline you did not construct in the same shell.
- **Guard the arithmetic.** Empty shell variables in numeric tests abort under `set -u` and truncate every remaining clause, producing a transcript that reads as a crash rather than a verdict. Give JSON reads a sentinel value and test against it.
- **Write message files in a SEPARATE tool call before a guarded command.** A git-guard refusal aborts the ENTIRE compound command, so heredocs and file writes earlier in the chain never execute — the next step then fails on a missing file and reads as an unrelated bug. Verified as standing practice one round later, with no compound-chain aborts.

### Corollary: record the NEGATIVE results of a rule too

Round 11's "a conflict-free merge is not a clean merge" re-run cost about a minute and came back clean. Reporting only the CATCHES makes a cheap rule look expensive, and a rule that looks expensive gets retired. Log the clean re-runs as deliberately as the ones that found something.

### Corollary: prove the refusal, never the credentialed path

For an uncredentialed continuation lane this is a viable standing split. The gate's refusal enumerates every missing coordinate BY NAME, so a lane with no credentials fully exercises the refusal branch at zero harvest risk; the credentialed leg stays with the controller-dispatched verifier. Brief the ENUMERATED SET, never a count — the briefed "8" went stale the moment two capture fallbacks joined the enumeration and made it 10.
