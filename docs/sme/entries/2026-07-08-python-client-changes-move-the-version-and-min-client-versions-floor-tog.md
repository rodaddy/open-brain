---
lane: domain-backend
order: 15
---
## [2026-07-08] Python client changes move the version and min_client_versions floor together

**Severity:** MEDIUM
**Source:** PR #277 pre-merge gauntlet for Issue #270
**Scope:** `python/openbrain-memory/pyproject.toml`, `src/contract.ts`
`min_client_versions`, downstream rollout classification
**Status:** fixed in PR #277

### Pattern

Behavior changes in `python/openbrain-memory` require a package version bump
(0.1.6 set the precedent), and the server's advertised `min_client_versions`
floor must move in lockstep with the exact-version contract. Shipping client
behavior under an unchanged version, or bumping the package without moving the
advertised floor, breaks the contract downstream consumers pin against.

### Review Questions

- Does any change under `python/openbrain-memory/` ship without a version bump?
- Does the server's `min_client_versions` advertisement match the new exact
  version when the contract requires lockstep?
- Is the bump classified in `docs/downstream-rollout.md` terms before the PR is
  called complete?
