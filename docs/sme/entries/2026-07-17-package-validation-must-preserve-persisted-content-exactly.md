---
lane: gotcha-agent
order: 13
---
## [2026-07-17] Package validation must preserve persisted content exactly

**Severity:** HIGH
**Source:** PR #294 Full-tier review
**Scope:** `python/openbrain-memory` live writes, spool writes, and replay
**Status:** fixed in PR #294; recurrence of #77 live-write mutation

Validation can reject content but must not normalize accepted caller payloads. Use normalized copies only for checks, then persist and replay the original string; exact-content tests must include leading/trailing whitespace and sensitive-looking legitimate values.
