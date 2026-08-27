# Lane brief

budget: 972/8000 tokens (ceil chars/4)

## Task

Add a done-means check that proves every bash entrypoint in scripts/ is
bash-3.2 clean, and wire the node 24 runtime resolution into the wrapper so a
launchd job does not fall back to a stale PATH node binary.

## Done-means

path: fixtures/done-means.fixture.sh
invocation: `bash fixtures/done-means.fixture.sh`

```
# done-means: every bash entrypoint under scripts/ parses under bash 3.2 and
# declares `set -u`.
#
# Exit grammar:
#   0  pass
#   1  an entrypoint failed the check
#   3  harness error — bash 3.2 not available, no entrypoints found
```

## Standing rules

Full contract: fixtures/lane-contract.fixture.md

1. **Branch before work, never on `main`.**
2. **Done-means first, RED first.**
3. **The checker declares done, never the lane.**
4. **Truth grammar on every claim:** RUNNING / MERGED / WRITTEN / PROPOSED.

## Tightenings (ranked)

- **2026-08-23 — A bash entrypoint written on a Mac breaks on the cc-* boxes.**
  (provenance: lane report L-04.) Associative arrays and `mapfile` are bash 4; every entrypoint is bash-3.2 clean or it is broken on Linux.

- **2026-08-22 — Bare `node` off PATH resolves to nothing under launchd.**
  (provenance: PR #331.) System-invoked entrypoints exec the absolute node@24 keg path, never a bare name.

- **2026-08-24 — A skill's executables that live outside the repo drift silently.**
  (provenance: PR #329.) Executables a skill owns live in that skill's `scripts/`; runtime homes get copies, never originals.

- **2026-08-21 — A check that exits 0 having examined nothing reads as a pass.**
  (provenance: issue #302.) Empty input is exit 3, never exit 0.

- **2026-08-18 — A green that was never red proves nothing.**
  (provenance: controller contract.) Capture the RED transcript before the fix.

- **2026-08-17 — Staging with `git add -A` sweeps another session's files.**
  (provenance: ArmPros incident.) Stage by explicit path and diff --cached before commit.

- **2026-08-20 — Truncating a brief to fit a budget hides the omission.**
  (provenance: lane report L-11.) Fail closed and list what was excluded; never silently drop.

- **2026-08-19 — `git worktree remove` is the only correct teardown.**
  (provenance: audit 07-30.) A plain `rm -rf` strands the .git/worktrees registration.

## Decisions (ranked)

- #2 Node runtime: Node 24 keg absolute path for system-invoked entrypoints.
- #1 Shell dialect: All entrypoints are bash-3.2 clean; no bash-4 syntax.
- #3 Token estimator: Token budgets use ceil(chars/4), stated in the README.
- #4 Budget behaviour: Over budget refuses and writes nothing; never truncate.
- #5 Board fields: Status field is set at merge, not at dispatch.

## Loop policy

Wake on: a lane report landing in the ledger.
Stop on: two consecutive lanes reporting the same deviation.
Receipts: every check run is recorded with its exit code.
Human boundary: merge and issue closure are Rico's call, never the loop's.

## Report format

Every lane returns exactly these fields, nothing after them:

```
deliverable:   <what landed, one line>
claim-states:  <each artifact: RUNNING | MERGED | WRITTEN | PROPOSED>
verified:      <cmd> -> <exit and last line>, one per check run
deviations:    <none | what broke and where it stopped>
lessons:       <none | one line, becomes a Tightening>
```

A report missing a field goes back to the lane.

## Excluded (available on request)

- 2026-08-16 - **2026-08-16 — A localhost bind on 7141 shadows the librarian daemon.**   (pro
- 2026-08-15 - **2026-08-15 — Secrets leak through fixtures more often than through code.**  
- 2026-08-14 - **2026-08-14 — Token estimates diverge between tokenizers.**   (provenance: la
- 2026-08-13 - **2026-08-13 — A TypeScript enum cannot be type-stripped.**   (provenance: STA
- 2026-08-19 #6 Deletes: Agents move to _archive; removal is Rico's own hand.
