---
lane: gotcha-agent
order: 99
---
## [2026-08-27] A phase-N lane verifies the previous phase by the shape of the file being split from

**Severity:** MEDIUM
**Source:** pull request #944 (pushed, not merged)
**Scope:** split-and-convert lanes under #878 and any multi-phase lane working on one clone

**Status:** active

### Pattern

Staged-path presence and lint-clean new files read as a completed phase while the edit to the pre-existing file never happened. `git status` shows every expected path staged and both new files pass lint, so every file-existence signal agrees the split landed — and the original file still holds all of its suites at its original length.

The next phase then either refuses on a shape it cannot reconcile, or commits duplicated suites: the same tests now exist in the source file and in the file they were supposedly moved to.

### Check

- Before the first edit of a phase-N lane, run `rg -n 'describe\(|^\s+it\('` and `wc -l` on the file being split FROM, and compare both numbers with the brief's expected counts.
- A real split makes both numbers fall. Neither the staged path list nor a lint pass on the new files can express that.
