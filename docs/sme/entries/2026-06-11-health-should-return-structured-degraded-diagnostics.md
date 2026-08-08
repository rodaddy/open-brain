---
lane: domain-backend
order: 1
---
## [2026-06-11] Health should return structured degraded diagnostics

**Severity:** MEDIUM
**Source:** Issue #81
**Scope:** `OpenBrainClient.health()`
**Status:** active

### Pattern

`/health` can legitimately return degraded status such as HTTP 503 with a useful
JSON body. Treating that as opaque HTTP failure hides diagnostics from callers.

### Review Questions

- Does `health()` return structured bodies for expected degraded health
  responses?
- Does it still raise for non-health failures and malformed health bodies?
- Are degraded health responses tested?
