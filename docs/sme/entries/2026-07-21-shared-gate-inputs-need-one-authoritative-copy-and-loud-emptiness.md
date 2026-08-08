---
lane: quality
order: 10
---
## [2026-07-21] Shared gate inputs need one authoritative copy and loud emptiness

**Severity:** MEDIUM
**Source:** PR #313 / PR development#44 review swarm 2026-07-21
**Scope:** `contracts/parity-paths.txt`, `.githooks/pre-push`, `.github/workflows/ci.yml`, `.github/workflows/pr-body.yml`, `python/openbrain-memory/tests/test_contract_fixtures.py`
**Status:** fixed-pre-merge

- The parity path filter was hand-copied across four sites (pre-push hook plus the CI and PR-body change-detection steps); centralize it in `contracts/parity-paths.txt`, have every consumer read it, and have the validator assert it exists and is non-empty.
- A moved or emptied fixture directory made the parametrized Python replay silently collect zero tests; the suite must assert the discovered python-consumable fixture set is non-empty and matches the manifest's expectation.
