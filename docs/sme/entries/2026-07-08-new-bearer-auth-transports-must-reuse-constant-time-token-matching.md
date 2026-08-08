---
lane: security
order: 8
---
## [2026-07-08] New bearer-auth transports must reuse constant-time token matching

**Severity:** MEDIUM
**Source:** PR #283 initial swarm for Issue #282
**Scope:** NATS request/reply bridges, alternate transports, and any non-HTTP
bearer-token auth path
**Status:** fixed in PR #283

### Pattern

Adding a second bearer-auth surface can accidentally bypass HTTP middleware's
constant-time token matching if it verifies tokens with direct `Map.get()` or
another early-exit lookup. Even when the transport is local-first, the server
auth semantics should match the HTTP path so timing and role behavior do not
diverge.

### Review Questions

- Does the new transport call the same constant-time token matching helper as
  HTTP auth?
- Is there a regression test that would fail if the transport used direct token
  lookup?
- Do startup/shutdown logs avoid raw exception messages that may include
  credential-bearing broker URLs or wrapped token material?
- Does the health endpoint redact internal error detail while still exposing
  machine-readable availability?
