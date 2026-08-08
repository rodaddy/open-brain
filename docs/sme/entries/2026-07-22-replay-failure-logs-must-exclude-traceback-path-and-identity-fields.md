---
lane: security
order: 26
---
## [2026-07-22] Replay failure logs must exclude traceback, path, and identity fields

**Severity:** HIGH (P1)
**Source:** PR #355 / issue #344 Terra terminal audit
**Scope:** `python/openbrain-memory/src/openbrain_memory/spool.py`, `runtime.py`, scheduled replay/drain paths
**Status:** fixed-pre-merge

### Pattern

A scheduler's own telemetry can be content-free while the reused replay path
below it still leaks. PR #355 routed scheduled replay through the existing spool
drain, whose dispatch-failure warning used `exc_info=True` and structured fields
for the spool path, operation, and idempotency key; the outer drain catch also
logged a traceback. `OpenBrainError` can carry a redacted-but-private server body,
so background logs could expose replayed content even though the scheduler log
itself emitted only status/counts. The fix uses stable category/status fields
only and preserves retry, quarantine, disposition, and receipt behavior.

### Review Questions

- For every reused layer beneath a new content-free scheduler surface, do dispatch
  and outer catch blocks avoid `exc_info`, raw exception messages, response
  bodies, paths, keys, namespaces, and payload identifiers?
- Does the leak test inject distinct private sentinels into the exception body,
  spool path, and idempotency key, then inspect message, args, structured extras,
  traceback state, and stderr?
- Are retry counts, quarantine thresholds, `error_category`, dispositions, and
  receipts unchanged after logging is reduced?
- Are malformed-file corruption diagnostics adjudicated separately from provider
  dispatch failures rather than silently treated as the same surface?
