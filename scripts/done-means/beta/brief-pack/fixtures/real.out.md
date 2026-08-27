# Lane brief

budget: 907/8000 tokens (ceil chars/4)

## Task

Harden the exemplar battery so a missing uv exits 3 rather than 1.
Add a fixture proving the python exemplar RED path.

## Done-means

path: ../../../../../scripts/done-means/exemplar-battery.sh
invocation: `bash ../../../../../scripts/done-means/exemplar-battery.sh`

```
# done-means: the Python exemplar (_DOCS/python-exemplar) passes its own
# battery — pytest, ruff, mypy — from the tree under judgment.
#
# The exemplar is the reference implementation every fleet Python service is
# measured against (STANDARDS-python.md), and the swarm arbiter app
# (rodaddy/development#315, PR #319) lives inside it. "Merged" says nothing
# about whether the battery still passes on main; this check is the receipt.
#
# Exit grammar (Development-wide, see scripts/done-means/README.md):
#   0  pass
#   1  the thing under test failed (a test, a lint, or a type error)
#   3  harness error — we could not look (uv missing, project dir absent)
#
# Overrides, for RED proofs only:
#   EXEMPLAR_BATTERY_PROJECT   path to the exemplar project (default: repo copy)
#   EXEMPLAR_BATTERY_PYTEST    extra pytest args (e.g. "-k no_such_test")
#
# env bash, kept bash-3.2 clean: this repo is also checked out on the cc-*
# boxes where Homebrew's bash path does not exist.
```

## Standing rules

Full contract: ../../../../../_DOCS/lane-contract.md

1. **Branch before work, never on `main`.** PR work runs from a clone under
   `{temp_workspace}/development/_scratch/`, never a worktree of the live
   checkout and never by switching the live checkout's branch.
2. **Done-means first, RED first.** The lane's check in `scripts/done-means/`
   exists and has been seen to fail before the work starts. A green that was
   never red is not evidence.
3. **The checker declares done, never the lane.** Report evidence; the
   controller re-runs the check in its own clone before merge.
4. **Truth grammar on every claim:** RUNNING / MERGED / WRITTEN / PROPOSED.
   A claim inherits the weakest state in its chain.
5. **Umbrella rules bind lanes:** `AGENTS.md` core rules, `_DOCS/GIT_STANDARDS.md`,
   `_DOCS/CODING_STANDARDS.md`. Stage by explicit path, `git diff --cached
   --name-only` before every commit, no `/tmp`, no recursive or forced
   deletes, no secrets in git or logs.
6. **Deviations are flagged, never absorbed.** A step that breaks fails hard
   and comes back to the controller the same turn.
7. **Self-report everything:** refusals hit, gates tripped, workarounds
   considered. These become Tightenings. Burying one is the offense.
8. **Teardown in the same session:** the clone moves to `_archive/`, the
   branch dies local and remote after merge.
9. **Report in the schema** in `_DOCS/controller-contract.md`.

## Tightenings (ranked)

- **2026-08-24 — A skill's executables that live outside the repo drift
  silently.** (provenance: PR #329.) The three fusion `.workflow.js` scripts
  sat in `~/.claudex/workflows/`, no git, and missed the v3 router change
  until `claudex doctor` caught it. Executables a skill owns live in that
  skill's `scripts/`; runtime homes get copies, never originals.

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

(none)
