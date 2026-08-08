---
lane: correctness
order: 21
---
## [2026-07-17] First-class lifecycle runtimes must gate on the live manifest

**Severity:** HIGH
**Source:** PR #294 terminal audit and focused verification
**Scope:** `python/openbrain-memory` lifecycle routers and compatibility caching
**Status:** fixed in PR #294

Before start, append, checkpoint, or wrap, a first-class runtime must validate the current live contract manifest rather than trust construction-time or stale cached compatibility. Compatibility must require exact `schema_version` and `schema_hash` agreement with the supported contract in addition to required-tool checks; a matching tool list does not make a differently hashed or versioned schema safe. Tests must mutate the advertised manifest between lifecycle calls and independently vary `schema_version` and `schema_hash`, proving an incompatible long-lived runtime is rejected before the operation.
