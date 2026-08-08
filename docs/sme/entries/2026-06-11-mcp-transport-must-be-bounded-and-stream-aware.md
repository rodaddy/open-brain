---
lane: domain-backend
order: 0
---
## [2026-06-11] MCP transport must be bounded and stream-aware

**Severity:** HIGH
**Source:** Issue #81, PR #72 follow-up; PR #319 fix delta
**Scope:** `python/openbrain-memory/src/openbrain_memory/client.py`, `clients/ts/src/client.ts`
**Status:** active

### Pattern

Transport code that reads an entire HTTP response before parsing can hang on
long-lived Streamable HTTP/SSE responses or consume too much memory on bad
responses.

**PR #319:** TS `response.text()` defeated its byte cap and its SSE parser
waited for EOF. Bound bytes while reading chunks, cancel on overflow, and return
after a complete matching JSON-RPC SSE event; cover JSON, SSE, and open streams.

### Review Questions

- Is there a `max_response_bytes` or equivalent bounded read?
- Does SSE parsing return on the matching JSON-RPC response instead of requiring
  EOF?
- If non-streaming behavior is intentional, is it explicitly negotiated or
  documented?
- Are oversized JSON/SSE responses tested?
