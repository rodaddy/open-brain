---
lane: security
order: 14
---
## [2026-07-13] Inline transcript storage is a credential boundary

**Severity:** MEDIUM
**Source:** Issue #288 Full-tier security review
**Scope:** append_session_event transcript citations
**Status:** fixed in issue #288 implementation

Transcript payloads require the same synchronous secret rejection as other durable evidence. References use canonical host-neutral segments, empty transcript still requires a ref, and DB-error logs expose only allowlisted labels.
