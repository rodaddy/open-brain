---
lane: gotcha-agent
order: 28
section: harvest-522
---
## [2026-08-03] Replacing a CI review workflow has a bootstrap and branch-protection problem

**Severity:** not stated in source
**Source:** https://github.com/rodaddy/open-brain/issues/231; harvested in #522
**Scope key:** `sme.workflow_replacement_bootstrap_and_branch_protection`
**Status:** active

### Pattern

A change that replaces a CI review workflow has a bootstrap problem: the new job's untriggered branches (here, the deep-review path) cannot be verified by the PR that introduces them, and the OLD job name may still be a required status check in branch protection — which blocks every future PR until an admin swaps it. Reviewing a workflow-replacement PR means checking branch-protection required-check names and either proving or explicitly waiving each untriggered branch.

Verbatim, from the source:

> Gauntlet call: do not merge yet as `Zero Known Issues`; Phase 3/deep-path verification is still unresolved. ... If `claude-code-review` is a required status check in branch protection, that requirement must be swapped to `codex-review` by an admin or this PR (and future PRs) cannot merge.
