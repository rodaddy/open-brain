---
lane: adversarial
order: 1
---
## [2026-06-11] Append success must mean the record is recoverable

**Severity:** HIGH
**Source:** Issue #80
**Scope:** `python/openbrain-memory/src/openbrain_memory/spool.py`
**Status:** active

### Pattern

An oversized single record larger than `max_bytes` can be written, trimmed away,
and still return success. That creates silent data loss in a recovery path.

### Review Questions

- What happens when one record exceeds `max_bytes`?
- Does `append()` reject, truncate with an explicit marker, or store separately?
- Is there a regression test proving `append()` cannot report success while
  storing nothing?
