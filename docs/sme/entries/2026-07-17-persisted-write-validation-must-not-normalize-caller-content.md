---
lane: security
order: 15
---
## [2026-07-17] Persisted-write validation must not normalize caller content

**Severity:** HIGH
**Source:** PR #294 Full-tier review
**Scope:** `openbrain-memory` live writes, spool validation, and replay validation
**Status:** fixed in PR #294

Validation may inspect a normalized copy for emptiness, bounds, or safety, but the accepted durable payload must remain byte-for-byte caller content. Trimming or rewriting during validation silently changes memory evidence and can make live and replayed writes disagree. Regression tests must use leading/trailing whitespace and sensitive-looking legitimate text and assert exact persisted and replayed content.
