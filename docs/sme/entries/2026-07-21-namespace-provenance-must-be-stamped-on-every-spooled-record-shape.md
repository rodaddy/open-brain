---
lane: security
order: 23
---
## [2026-07-21] Namespace provenance must be stamped on EVERY spooled record shape

**Severity:** MEDIUM
**Source:** PR #317 review swarm, 2026-07-21
**Scope:** `python/openbrain-memory/src/openbrain_memory/_runtime_spool.py` (`TrackingSpool.append`/`_parked`), `runtime.py` `_drain_spool` dispatch
**Status:** fixed-pre-merge

### Pattern

#314 stamped `_parked_namespace` only on spooled `session_start` payloads.
Lone non-start units — records spooled after the lane was already established
live, so no `session_start` prerequisite was queued with them — carried no
provenance, so a runtime configured for another namespace would dispatch them
under its own namespace AND (once #296 added retry accounting) count their
failures and quarantine them into the wrong runtime's sidecar. Client-side
origin provenance must be stamped on EVERY spooled record shape that can
replay, not just the shape the original bug was reproduced with, and the
replay-side mismatch check must pop the marker from every record and retain
(never fail-count) on mismatch. Records already on disk without the marker
keep legacy behavior — an honest, documented carve-out
(`docs/memory-contract.md` spool-replay row).

### Review Questions

- Is origin provenance stamped on every persisted record shape that can
  replay, or only on the first-record/prerequisite marker from the original
  fix?
- Can a record with no provenance-bearing lead record (lone unit, partial
  batch, direct append) replay under a different authority than the one that
  accepted it?
- On mismatch, is the unit retained with zero dispatches AND zero
  retry/quarantine accounting in the foreign runtime's sidecars?
- Is the marker stripped before dispatch on the matching-namespace path, so
  it never reaches the router or the wire?
