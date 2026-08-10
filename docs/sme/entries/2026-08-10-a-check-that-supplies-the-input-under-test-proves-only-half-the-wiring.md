---
lane: gotcha-agent
order: 69
---
## [2026-08-10] A check that supplies the input under test proves the consumer, never that anything feeds it

**Severity:** HIGH
**Source:** Issue #709 (the unreachable half of #706); lane `lane/709-pr-head-ref`
**Scope:** any done-means check, unit test, or acceptance gate for a fix that spans a PRODUCER and a CONSUMER — hooks feeding validators, callers feeding resolvers, CI feeding scripts
**Status:** active

### Pattern

#706 fixed `scripts/validate-pr-body.ts` to resolve a `Done-means` path in
three tiers, the third being `git cat-file -e <PR_HEAD_REF>:<path>` — the tier
the issue asked for BY NAME, so a lane could cite a check existing only on its
own branch. That half was correct and is still correct.

The other half never shipped. `.claude/hooks/pr-body-gate.ts` is the only
caller that runs at the boundary, and it set `PR_REPO_DIR` from the payload's
`cwd` and **never set `PR_HEAD_REF`**, nor parsed `--head` from the intercepted
`gh pr create`. The tier was dead code from the only live caller.

`scripts/done-means/706-done-means-resolves-pr-head.sh` was **5/5 GREEN before,
during, and after** the defect. It calls the validator DIRECTLY and sets
`PR_HEAD_REF` itself. It therefore proved the consumer works WHEN FED, and
never that anything feeds it. The sibling check that DOES drive the hook
(`pr-body-gate-fires.sh`) asserted on neither `cwd` nor `PR_HEAD_REF`.

This is `docs/lane-contract.md` round 28's own first bullet — *a seam added to
make a gate testable is not the path that runs* — recurring in the very next
lane. Writing the rule did not prevent the recurrence; only a clause driving
the real entry point did.

### The second, sharper trap

Even a check that drives the real entry point can prove only half. Here TWO
independent things were wrong and either alone explains the observed refusal:

1. the payload `cwd` is the SESSION's directory (a `cd <worktree> && gh pr
   create` in one Bash call does not move it), and
2. `PR_HEAD_REF` was never supplied.

A fix for (1) alone passes the obvious clause — "the cd-into-worktree call is
accepted" — while the branch tier stays as dead as it ever was. The clause that
forces (2) has to remove the file from every reachable working tree while
leaving it committed on the branch, so that ONLY a supplied head ref can answer.

### Review checks

- For any fix spanning a producer and a consumer, ask: **does any clause fail
  if the producer's wiring is reverted?** If every clause sets the disputed
  input itself, the check covers the consumer only. Name the untested side.
- Grep a done-means check for the environment variable or argument the fix is
  about. If the check EXPORTS it, the check is downstream of the defect.
- A hook payload's `cwd` is the session's, not the command's. Any gate reading
  `input.cwd` as "where this command runs" is wrong whenever the command `cd`s.
  Prose in the source asserting otherwise (#706's comment said exactly that) is
  not evidence.
- Gate inputs must be printed on the REFUSAL path, not only on the allow path.
  #709 was diagnosed from a refusal naming the tree it searched but not where
  that tree came from, so it read as "your path does not exist" when the truth
  was "the gate looked in the wrong place".
- A widened resolution must keep a MUTANT CONTROL clause: a path in no tree and
  on no ref stays refused. Otherwise "fix the false refusal" and "turn the gate
  off" are the same diff.

### Related

Same family as the round-28 entry
(`2026-08-09-a-gate-that-judges-from-a-tree-other-than-the-one-under-review.md`):
a gate resolving its tree or base from something other than the change under
review. #709 is that family's producer-side spelling — the tree was resolvable,
and nobody handed it over.
