---
lane: gotcha-agent
order: 69
---
## [2026-08-09] `bun -e` shifts argv, so an inline mutation step can silently mutate nothing

**Severity:** MEDIUM
**Source:** #678 lane, self-caught by the check's own prove-the-prover clause
**Scope key:** done-means checks, mutation testing, any inline `bun -e` / `node -e` script taking arguments
**Status:** active

### Pattern

Under `bun -e '<script>' ARG`, the first user argument is `process.argv[1]`, not `process.argv[2]` — there is no script path occupying slot 1 the way there is for `bun script.ts ARG`. An inline mutation step written with the familiar `process.argv[2]` therefore received `undefined`.

What made it dangerous was the combination, not the indexing bug:

- `readFileSync(undefined)` threw, so the mutation never happened;
- the surrounding check ran under `set -uo pipefail` without `-e`, so execution continued;
- the guard tested only the exit code, and the throw's own stderr was never asserted on;
- the "mutated" run of the parity test then PASSED — correctly, because the file was untouched.

So a mutation-testing clause whose entire purpose is to prove a test can fail reported "the test stayed green under a deleted key" when no key had been deleted. The clause's verdict was wrong in the direction that *looks* like a real finding, which is the good case; had the polarity been reversed it would have been a false GREEN certifying a decorative test.

This is the round-8 measures-its-own-harness family with a new mechanism: not an optional-chained call on a missing method, but an argument that silently is not there.

### Review checks

- Any `bun -e` / `node -e` taking arguments: verify the argv index against a one-line `console.log(process.argv)`, or move the script into a FILE where the ordinary contract applies. A file also gets syntax checking, types, and a diff that reviewers can read.
- A mutation/setup step must be gated on **three** independent signals, because the exit code alone has now demonstrably failed: non-zero exit, an explicit `MUTATION-APPLIED`-style marker the script itself prints, and observable evidence the world changed (`cmp -s` against the pre-mutation backup).
- Assert that a setup step ANNOUNCED success — never infer it from the absence of an error. Silence from a step that should be loud is the signal.
- A verdict clause built on "I changed X, then observed Y" is only as strong as the proof that X changed. Prove the change, then read the observation.
