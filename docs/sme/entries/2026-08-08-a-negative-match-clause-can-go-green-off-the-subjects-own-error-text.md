---
lane: adversarial
order: 86
---
## [2026-08-08] A negative-match clause can go green off the subject's own error text

**Severity:** HIGH
**Source:** PRs #668, #669 (#667 bootstrap-continuation lane), Tightenings round 23
**Scope:** `scripts/done-means/*.sh` announce-assertions; any clause matching prose the subject prints
**Status:** active

### Pattern

A clause asserted that `lane-bootstrap` announced `already exists`. On the exact run where the script announced NOTHING and died, git's own `fatal: a branch named 'x' already exists` satisfied the match. The clause was green off the crash it was written to catch.

Round-9/17 family, new spelling — and it was caught by round 18's read-WHY rule, not by the tally.

### What to do

- Anchor announce-assertions on a marker the script OWNS — its `[ok]` step prefix, a structured field it emits — never on prose that the failure mode also produces.
- **When the subject IS a script, resolve the script from the check's OWN tree** (a `BASH_SOURCE`-derived root), so the check structurally cannot reach across trees into a different revision. Make this the default shape for tooling done-means; round 12's which-tree-runs rule, sharpened into a mechanism.
- **Plant-and-survive on worktree refusals needs the REGISTRY check, not just the directory check.** A created-then-cleaned worktree leaves a `.git/worktrees` registration that a `-d` test alone would miss, so the refusal path reads as untested when it in fact fired.

### Corollary: a summary line hardcoding one path's provenance

`(from origin/main)` became a lie in the same commit that added a continuation path. When you add a branch to a function, search the REPORTING strings, not just the logic — a report that describes only the original path misreports the new one silently, from the first run.
