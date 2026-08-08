---
lane: gotcha-agent
order: 31
section: harvest-522
---
## [2026-08-03] GIT_DIR/GIT_WORK_TREE leak into hooks and override git -C

**Severity:** not stated in source
**Source:** https://github.com/rodaddy/open-brain/pull/510 (with issue #483); harvested in #522
**Scope key:** `review.git_env_leaks_into_hooks`
**Status:** active

### Pattern

Git exports GIT_DIR and GIT_WORK_TREE into hook environments, and GIT_WORK_TREE overrides `git -C <path>`, so any code that shells out to git from inside a git hook resolves against the REAL repo regardless of the directory it was asked about. Strip GIT_DIR/GIT_WORK_TREE from a copy of the environment before spawning git children in hooks and hook-invoked tests. This class of defect is silent -- no raise, no log -- and issue #483 shows its worse form: a test that inherited GIT_DIR committed two 'reachable tag commit' junk commits onto the branch being pushed during a pre-push run, recovered only via reflog.

Verbatim, from the source:

> `git push` exports `GIT_DIR`/`GIT_WORK_TREE` to its hooks, and **`GIT_WORK_TREE` beats `git -C`** — `rev-parse --show-toplevel` answered `/Volumes/ThunderBolt/Development` for every directory asked about, so every project resolved to the slug `Development`.
