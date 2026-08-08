---
lane: quality
order: 2
---
## [2026-06-11] PR comments are training data for the next swarm

**Severity:** MEDIUM
**Source:** User process feedback after PRs #72-#76
**Scope:** review process
**Status:** active

### Pattern

PR comments that list findings and fixes are not optional bookkeeping. They are
the source material for SME updates and future gotcha-agent prompts.

### Review Questions

- Does the PR comment say what each lane found?
- Does it say what was fixed and what was intentionally deferred?
- Are new review misses promoted into `docs/sme/` before the next related PR?
