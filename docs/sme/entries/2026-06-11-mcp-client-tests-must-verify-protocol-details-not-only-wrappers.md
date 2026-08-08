---
lane: correctness
order: 2
---
## [2026-06-11] MCP client tests must verify protocol details, not only wrappers

**Severity:** MEDIUM
**Source:** Issue #82, PR #72 review loop
**Scope:** `python/openbrain-memory/src/openbrain_memory/client.py`
**Status:** active

### Pattern

Fake transports can prove wrapper behavior but miss HTTP/MCP contract drift:
headers, JSON-RPC ids, initialized notification, session id reuse, protocol
version, and request body shape.

### Review Questions

- Is there an in-process HTTP/MCP test using real `OpenBrainClient` and
  `UrllibTransport`?
- Does the test observe `Authorization`, default omission of `X-Namespace`,
  explicit delegated `X-Namespace` when enabled, `X-Agent-Id`, `X-Role`,
  `Mcp-Session-Id`, `MCP-Protocol-Version`, JSON-RPC ids, and bodies?
- Does it cover `/health`, initialize, initialized notification, and
  `tools/call`?
