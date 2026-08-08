---
lane: domain-backend
order: 21
---
## [2026-07-23] A new required public tool capability moves the whole compatibility set in one change

**Severity:** MEDIUM
**Source:** PR #361 review swarm, 2026-07-23 (issue #334 cited reflex pointers)
**Scope:** `src/contract.ts` (`schema_version`/`schema_hash`, required-tool list,
`min_client_versions`), the required clients/wrappers
(`python/openbrain-memory`, `rtech-hermes-runtime` stdlib transport),
`python/openbrain-memory/pyproject.toml`, `contracts/memory/parity-manifest.json`
+ parity fixtures, and compatibility docs
**Status:** fixed-pre-merge

### Pattern

Adding `agent_reflex_pointers` as a NEW REQUIRED public tool is a contract-set
change, not a single-file add. Shipping the server tool while any of the
following lag creates a split-brain contract: the server advertises a tool/
schema that a pinned client cannot see, or a client floor that no longer matches
the emitted schema. The full set that must move together in one change:

- the server contract's `schema_version` AND `schema_hash` (a new required tool
  changes the emitted schema — see the [2026-07-17] correctness entry: a matching
  tool LIST does not make a differently-hashed schema compatible);
- every required client/wrapper that must now know the tool
  (`python/openbrain-memory` and the independent `rtech-hermes-runtime` stdlib
  transport — see [2026-06-11] two-MCP-client-implementations: the contract is
  the only thing keeping them in sync);
- the package version bump AND the server's `min_client_versions` floor, in
  lockstep (see [2026-07-08] Python-client-changes-move-the-version-and-floor);
- the parity manifest's pinned fixture-id set and the parity fixtures themselves
  (see the quality/adversarial lanes: fixture discovery without a pinned expected
  set silently shrinks; parity needs an executable live-`buildContract()` check);
- the compatibility docs / downstream-rollout classification.

The failure mode when one lags: a required client that predates the tool fails
the live-manifest gate, or a version floor that advertises the new capability
while the emitted schema hash was never moved lets a stale client pass a check it
should fail.

### Review Questions

- Does the PR that adds/requires a new public tool move ALL of: `schema_version`,
  `schema_hash`, `min_client_versions`, every required client/wrapper, the package
  version, the pinned parity fixtures, and the compatibility docs — in the same
  change?
- Is BOTH independent client implementation (`python/openbrain-memory` and the
  `rtech-hermes-runtime` stdlib transport) updated to the new required tool, since
  only the server contract keeps them in sync?
- Did `schema_hash` actually move (not just the tool list), and does an executable
  parity check compute the live `buildContract()` hash rather than trusting a
  hand-copied literal?
- Is the change classified under `docs/downstream-rollout.md` before the PR is
  called complete?
