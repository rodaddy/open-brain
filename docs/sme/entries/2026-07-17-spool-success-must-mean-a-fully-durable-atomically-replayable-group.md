---
lane: gotcha-agent
order: 11
---
## [2026-07-17] Spool success must mean a fully durable, atomically replayable group

**Severity:** HIGH
**Source:** PR #294 Full-tier review
**Scope:** `python/openbrain-memory/src/openbrain_memory/spool.py`
**Status:** fixed in PR #294; recurrence of #80 spool durability

A spool append may report success only after checking the full write, flushing and `fsync`ing the file, and `fsync`ing the parent directory when a durable rename/create is involved. Replay must validate an entire logical group before dispatching any member; raw spool fields must satisfy their exact types before grouping, without coercing strings, booleans, or numerics into valid-looking records. One malformed record cannot allow a valid prefix from that group to partially replay. Tests must inject short writes, sync failures, wrong-typed raw fields, malformed middle records, and restart after durable replacement.
