---
lane: domain-backend
order: 25
---
## [2026-07-31] A factory owns cleanup of what it constructed until ownership is handed off

**Severity:** MEDIUM
**Source:** Sol round-2 review, fixed in `42ccf0c`
**Scope:** `python/openbrain/src/openbrain/apps/hooks/session.py`
**Status:** active

### Pattern

`close()` in the caller's `finally` only protects resources AFTER the factory
returns. `start_session()` failing after `initialize` allocated the server
slot but before `StartedLane` was returned leaked the slot — the exact leak
the `finally` was added to fix, alive on the startup path. The factory now
closes-and-reraises on construction failure; the caller's `finally` covers
everything after handoff.

### Review Questions

- Between resource allocation and the return of its owning handle, what
  failure paths exist, and who closes on each?
- Is there a test where construction fails AFTER allocation but BEFORE
  handoff, proving the resource is released?
