---
lane: security
order: 17
---
## [2026-07-20] Client-side persistence paths must redact before disk

**Severity:** HIGH
**Source:** Issue #304, PR #305 (#293-family review)
**Scope:** `python/openbrain-memory/src/openbrain_memory/spool.py`
**Status:** active

### Pattern

The JSONL spool persisted `"payload": dict(payload)` raw to disk, with
`redact_value` applied only to a diagnostic view — and a test explicitly
asserted the secret WAS on disk. Any client-side persistence surface (spool,
cache, export file) must apply redaction before the bytes hit disk, and replay
must deliberately replay the redacted form rather than pretend raw fidelity.

### Review Questions

- Does every disk write of caller payloads pass through `redact_value` (or
  equivalent) before serialization, not just before display?
- Do tests assert the secret is absent from the RAW file content
  (`path.read_text()`), not merely from a redacted accessor?
- Is there a test locking the OPPOSITE (bad) behavior that should be flipped?
- Do pre-fix artifacts on disk (written before the redaction change) get
  retro-scrubbed or aged out, and is replay of old artifacts considered?
