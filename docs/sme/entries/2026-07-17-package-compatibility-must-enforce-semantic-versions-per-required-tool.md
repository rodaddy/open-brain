---
lane: gotcha-agent
order: 14
---
## [2026-07-17] Package compatibility must enforce semantic versions per required tool

**Severity:** MEDIUM
**Source:** PR #294 Full-tier review
**Scope:** `python/openbrain-memory/src/openbrain_memory/contract.py` and contract fixtures
**Status:** fixed in PR #294; recurrence of #82 contract drift

Checking only that a required tool name exists lets an incompatible schema pass. Parse the advertised tool version, enforce the supported semantic range, fail closed on malformed declarations, and cover missing, older, newer, and malformed versions in fixtures.
