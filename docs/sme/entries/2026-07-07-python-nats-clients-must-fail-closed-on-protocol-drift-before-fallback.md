---
lane: gotcha-agent
order: 5
---
## [2026-07-07] Python NATS clients must fail closed on protocol drift before fallback

**Severity:** MEDIUM
**Source:** PR #263 initial swarm for Issue #223
**Scope:** `python/openbrain-memory/src/openbrain_memory/client.py`, Python
request/reply transport facades
**Status:** fixed in PR #263; keep as active checklist

### Pattern

A Python secondary transport can preserve HTTP fallback while still hiding the
exact regressions the realtime path needs to surface. In PR #263, the first
Python request/reply pass caught every exception from the NATS path, so response
schema/id/operation/status mismatches and local envelope validation errors could
silently retry over HTTP. It also left NATS availability open after later
successful `get_contract` responses stopped advertising a valid NATS state,
sent oversized envelopes to the driver before the server-side 64 KiB cap could
reject them, and re-raised raw driver exceptions when fallback was disabled.

### Review Questions

- Does fallback catch only transport-unavailable/request failures, not local
  validation or protocol-conversion errors?
- Are concrete driver exceptions wrapped in a sanitized Open Brain exception
  before escaping fallback-disabled canary/debug paths?
- Does a later successful `get_contract` without explicit valid NATS
  availability close the NATS gate instead of preserving stale availability?
- Does the client enforce the server's NATS request-size cap before sending to
  the driver, falling back to HTTP when configured?
- Do tests prove malformed NATS responses, missing required envelope fields,
  oversized payloads, stale contract responses, and sensitive driver exception
  strings behave correctly?
