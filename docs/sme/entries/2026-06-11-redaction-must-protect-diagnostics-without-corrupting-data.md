---
lane: security
order: 1
---
## [2026-06-11] Redaction must protect diagnostics without corrupting data

**Severity:** HIGH
**Source:** Issue #77
**Scope:** `python/openbrain-memory/src/openbrain_memory/agent.py`,
`python/openbrain-memory/src/openbrain_memory/policy.py`,
`python/openbrain-memory/src/openbrain_memory/spool.py`
**Status:** active

### Pattern

Redacting the payload before calling Open Brain can silently persist legitimate
memory content as `[REDACTED]`. Redacting before durable spool persistence can
make replay unable to restore the original write.

**2026-07-20 update (Issue #304, PR #305):** the spool half of this stance is
superseded. The contract decision is that secrets never land on disk: the spool
now redacts before persistence and replay deliberately replays the redacted
form. The live-write half (successful live writes preserve caller content)
remains active.

**2026-07-22 update (PR #319):** runtime receipts must not re-expose remote
HTTP/tool response bodies after transport redaction. Remote errors need bounded
class/status/context evidence only; persisted spool replay is explicitly the
redacted representation, not exact original payload replay.

### Review Questions

- Are live writes preserving caller content?
- Are logs/errors redacted separately?
- Is spool data protected without pretending lossy redacted data is exact replay?
- Do remote-error receipt tests use a sentinel body and prove it cannot escape?
- Do tests prove successful live writes are not silently redacted?
