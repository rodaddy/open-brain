---
lane: domain-backend
order: 5
---
## [2026-06-11] Two MCP client implementations exist -- protocol changes must check both

**Severity:** MEDIUM
**Source:** rtech-hermes feat/openbrain-http-transport (decision: Rico, 2026-06-11)
**Scope:** `src/transport.ts`, MCP tool schemas, session lifecycle semantics
**Status:** active

### Pattern

Open Brain's MCP Streamable HTTP contract has two independent client
implementations: `python/openbrain-memory` (this repo) and
`rtech-hermes-runtime/openbrain/http_transport.py` (stdlib, no shared code --
deliberate, to keep agent LXC deploys dependency-free). The server contract is
the only thing keeping them in sync.

### Review Questions

- Does a change to `src/transport.ts`, tool input/output schemas, the
  initialize handshake, SSE framing, or MCP session TTL behavior get verified
  against BOTH clients?
- Is a breaking protocol change flagged to rtech-hermes before deploy?
- Session TTL is 30 minutes -- do long-lived clients re-initialize cleanly?
