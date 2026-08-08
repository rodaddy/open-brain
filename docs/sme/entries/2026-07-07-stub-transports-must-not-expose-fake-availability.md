---
lane: gotcha-agent
order: 4
---
## [2026-07-07] Stub transports must not expose fake availability

**Severity:** MEDIUM
**Source:** PR #261 initial swarm for Issue #223
**Scope:** `python/openbrain-memory/src/openbrain_memory/client.py`, optional transport facades
**Status:** fixed in PR #261; recurrence of #82 wrapper contract drift

### Pattern

An opt-in transport stub can be useful, but it must not let callers report the
transport as runtime-available before any runtime path exists. PR #261 initially
exported an `AVAILABLE` enum value and accepted it in `NatsTransport` even
though all non-fallback calls still raised unavailable, and the fallback test
only checked method names rather than the full HTTP/MCP request contract.

### Review Questions

- Does a planned/stub transport derive availability from real runtime behavior
  instead of caller-supplied labels?
- Does the no-fallback error avoid claiming a fallback exists?
- Do fallback tests assert headers, session reuse, JSON-RPC ids, protocol
  version, URL, timeout, and tool-call body, not just method names?
