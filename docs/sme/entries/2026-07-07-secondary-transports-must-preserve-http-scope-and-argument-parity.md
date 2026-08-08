---
lane: gotcha-agent
order: 6
---
## [2026-07-07] Secondary transports must preserve HTTP scope and argument parity

**Severity:** HIGH
**Source:** PR #263 Claude/Opus cross-review for Issue #223
**Scope:** `python/openbrain-memory/src/openbrain_memory/client.py`, optional
secondary transport facades for existing MCP tools
**Status:** fixed in PR #263; keep as active checklist

### Pattern

An opt-in secondary transport can pass happy-path tests while silently changing
the caller's scope or request arguments. In PR #263, the Python NATS path first
used authorization-derived namespace only, even when the HTTP client would send
`X-Namespace` for delegated namespace clients. It also copied only the current
known `agent_context_pack` body keys into the NATS envelope, so any unsupported
or future argument would be dropped instead of preserving HTTP behavior.

### Review Questions

- Does the secondary transport preserve the same namespace/source-of-authority
  as HTTP, or intentionally fall back/fail closed when the secondary server
  contract cannot represent that scope?
- Does it preserve the caller's tool arguments, or explicitly fall back to HTTP
  when arguments are outside the secondary envelope contract?
- Do tests cover delegated namespace clients and unexpected/future tool
  arguments, not only the default happy-path scope?
- Does a failed contract refresh close stale secondary-transport availability
  unless the response affirmatively advertises that transport as available?
