---
lane: domain-backend
order: 23
---
## [2026-07-31] Client defaults must fit inside the harness deadline; sessions must be closed

**Severity:** HIGH (timeout) / MEDIUM (session leak)
**Source:** Step-8 review swarm (Sol terminal audit), fixed in `967a3be`
**Scope:** `python/openbrain/src/openbrain/apps/hooks/session.py`,
`python/openbrain-memory` client construction sites
**Status:** active

### Pattern

Constructing `OpenBrainClient` without a timeout inherits the sibling's 30s
default inside a 5s Stop-hook deadline: a stalled-but-accepting endpoint
blocks past the deadline and the harness kills the process -- the always-
exit-0 contract dies with it, unlogged. And a client that is never `close()`d
leaks a server session slot (100/worker) until idle expiry; a Stop burst can
exhaust the cap. The fix names the structural TIME budget
(`STOP_HOOK_DEADLINE_SECONDS`, a bound on an external harness deadline, NOT a
content bound), pins retries so worst-case wall time fits, and closes the
client in a `finally` on both paths.

### Review Questions

- Does every client constructed on a deadline-bound path receive an explicit
  timeout and retry budget whose worst case fits the deadline, with a
  stalled-endpoint test proving it?
- Is `close()` guaranteed on success AND failure? Fake-client test?
- Is any new numeric limit documented as whose deadline it is, so it cannot be
  mistaken for a content bound?
