---
lane: security
order: 21
---
## [2026-07-21] Spooled records replayed under config authority need origin provenance

**Severity:** MEDIUM
**Source:** PR #314 (open-brain#310 scope-aware drain) review swarm 2026-07-21
**Scope:** `python/openbrain-memory/src/openbrain_memory/_runtime_spool.py`, `runtime.py` `_drain_spool`
**Status:** fixed-pre-merge

### Pattern

Scope-aware drain rebuilds lane coordinates from the spooled record but binds
the namespace to the *draining* runtime's auth config. When two runtimes with
different namespaces share one spool file, a unit parked under namespace A
would drain into namespace B — a silent cross-namespace transplant. Any record
persisted under one authority and replayed under another must carry provenance
of the authority it was parked under (here: client-internal
`_parked_namespace`, stamped at append, stripped before dispatch, mismatch →
retain with zero live dispatches). Namespace isolation is a security boundary;
"the config decides at replay time" is not enough when the config can differ
from the one that accepted the write.

### Review Questions

- Can a persisted-then-replayed record cross an auth/namespace boundary because
  replay-time config differs from park-time config?
- Is the provenance marker client-internal (stripped before any server
  dispatch) so it never widens the wire contract?
- On mismatch, is the unit retained with *zero* dispatches (no wasted live
  call, no partial replay)?
