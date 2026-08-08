---
lane: adversarial
order: 12
---
## [2026-07-21] Parity declarations need executable cross-runtime proof

**Severity:** MEDIUM
**Source:** PR #313 / PR development#44 review swarm 2026-07-21
**Scope:** `contracts/check-parity.ts`, `src/middleware/request-logger.ts`, CI warm-up/cache steps
**Status:** fixed-pre-merge

- The TS test pin, Python constant, and contract-declaration fixture carried the same schema_hash as three hand-copied literals with no executable TS-vs-fixture check; the parity validator must compute the live `buildContract()` schema_hash and fail on divergence, closing the triangle the pytest replay leaves open.
- The contract-mismatch tripwire warned on every request, so one stale client or attacker-supplied headers could amplify log volume; throttle to one warn per distinct declared (contract id, schema_hash) per 5-minute bucket with malformed headers collapsed to one key.
- Verified-artifact-vs-executed-artifact class: a warm-up or cache step (e.g. the uv cache) can validate one artifact while the gated job later executes another; gates must prove the executed artifact is the one that passed verification.
