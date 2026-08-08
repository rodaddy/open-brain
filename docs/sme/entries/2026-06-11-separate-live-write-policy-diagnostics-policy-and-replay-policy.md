---
lane: quality
order: 0
---
## [2026-06-11] Separate live-write policy, diagnostics policy, and replay policy

**Severity:** HIGH
**Source:** Issue #77, PR #74 follow-up; PR #319 documentation fix delta
**Scope:** `python/openbrain-memory/src/openbrain_memory/agent.py`,
`python/openbrain-memory/src/openbrain_memory/spool.py`
**Status:** active

### Pattern

PR #74 conflated live storage safety, diagnostics/log redaction, and offline
replay durability. Redacting before live writes protects secrets but can corrupt
legitimate memories. Redacting before spool persistence protects disk logs but
can make replay lossy.

### Review Questions

- Does live write use the original payload unless an explicit write policy says
  otherwise?
- Are diagnostic/log/spool protections separate from live storage behavior?
- Is the spool contract exact replay, encrypted replay, or audit-only?
- Does the public API make that contract obvious?
- Does the README distinguish persisted redacted replay bytes from the original
  caller payload, and describe the actual cross-process/durability behavior?
