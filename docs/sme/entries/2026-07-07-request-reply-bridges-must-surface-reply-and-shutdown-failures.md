---
lane: quality
order: 8
---
## [2026-07-07] Request/reply bridges must surface reply and shutdown failures

**Severity:** MEDIUM
**Source:** PR #262 initial swarm for Issue #223
**Scope:** `src/nats-bridge.ts`, `src/index.ts`, request/reply bridge drivers and server shutdown
**Status:** fixed in PR #262; keep as active checklist

### Pattern

Request/reply adapters can silently lose responses if the driver return value is
discarded. Shutdown paths can also skip later cleanup when an optional transport
close hangs or rejects. In PR #262, the NATS bridge discarded
`message.respond()` and awaited bridge close before database cleanup without a
separate error boundary. Fix verification also caught that reply failures must
be isolated per message and subscription iterator failures must be supervised;
a thrown handler or fatal iterator error in a background subscription loop must
not silently stop future request processing.

### Review Questions

- Does the driver surface failed reply delivery, missing inboxes, or rejected
  response promises to the bridge handler?
- Are per-message handler failures caught/logged inside background subscription
  loops so the bridge continues processing later requests?
- Are top-level subscription iterator failures caught/logged and followed by a
  resubscribe/recovery path or an explicit degraded/unavailable state?
- Do tests cover reply failure rather than only the happy-path response?
- Does server shutdown isolate optional transport close failures from database
  and process cleanup?
- Is shutdown bounded when an optional bridge can hang?
