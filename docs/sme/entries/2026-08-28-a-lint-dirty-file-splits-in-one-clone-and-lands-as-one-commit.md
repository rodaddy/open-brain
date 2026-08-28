---
lane: gotcha-agent
order: 102
---
## [2026-08-28] A lint-dirty file splits in one clone and lands as one commit

**Severity:** MEDIUM. **Status:** active.

**Source:** PR #957 (the session-12 append-session-event split).

**Scope:** any split or conversion of a test or source file that carries
pre-existing oxlint findings.

### Pattern

`_githooks/pre-commit` checks out the index and lints every staged file WHOLE,
and a deleted path is never linted. A plan that gives each extracted piece its
own pull request therefore stages the shrinking original at every step, with
all of its pre-existing findings attached, and every one of those commits is
refused — right up until the final step deletes the file and the findings go
with it. The split is not the thing that fails; the intermediate states are.
The working shape is sequenced steps on one branch with nothing committed until
the end, each step verified on the working tree, and a single landing commit
carrying the new files plus the deletion.

Because nothing is committed between steps, the tree has no undo: a lane that
reaches for `git stash`, `git checkout HEAD -- <file>`, `git restore`, or
`git reset` to back out its own bad edit reverts the original to origin/main
and discards every earlier step's deletions. The head's own snapshot of the
tree after each step is the only recovery.

### Check

Before planning a multi-lane split, run
`./node_modules/.bin/oxlint --deny-warnings <file>` on the origin/main copy of
the file. Findings mean: sequenced steps on one branch, one landing commit, a
head snapshot of the split files and a `git diff` of the original after every
step, and an explicit instruction in each step brief that no lane runs stash,
checkout, restore, or reset in that clone — a shortened file is derived into
scratch, diffed, and copied over.
