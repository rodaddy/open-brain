# Backend and Open Brain Domain SME Findings

The backend/domain lane checks MCP-over-HTTP behavior, Open Brain tool contracts,
namespace semantics, and package/runtime deployment boundaries.

## [2026-06-11] MCP transport must be bounded and stream-aware

**Severity:** HIGH
**Source:** Issue #81, PR #72 follow-up
**Scope:** `python/openbrain-memory/src/openbrain_memory/client.py`
**Status:** active

### Pattern

Transport code that reads an entire HTTP response before parsing can hang on
long-lived Streamable HTTP/SSE responses or consume too much memory on bad
responses.

### Review Questions

- Is there a `max_response_bytes` or equivalent bounded read?
- Does SSE parsing return on the matching JSON-RPC response instead of requiring
  EOF?
- If non-streaming behavior is intentional, is it explicitly negotiated or
  documented?
- Are oversized JSON/SSE responses tested?

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

## [2026-06-11] Session lifecycle must be explicit

**Severity:** MEDIUM
**Source:** Issue #81
**Scope:** `OpenBrainClient`
**Status:** active

### Pattern

MCP sessions can accumulate under churn if the client has no explicit close or
context-manager path and no documented TTL reliance.

### Review Questions

- Does `OpenBrainClient` support `close()` and context manager behavior if the
  server supports termination?
- If not supported, does README/API docs state lifecycle and server TTL clearly?
- Are lifecycle tests or docs included?

## [2026-06-11] Python package gates belong in CI

**Severity:** HIGH
**Source:** Issue #79
**Scope:** `.github/workflows/**`, `python/openbrain-memory/**`
**Status:** active

### Pattern

The root Bun/TypeScript gate does not protect Python package regressions,
packaging/import failures, or wheel/sdist build failures.

### Review Questions

- Does CI run `uv run pytest -q` in `python/openbrain-memory`?
- Does CI run `uv build` in `python/openbrain-memory`?
- Are these gates triggered for package changes?
- Are generated artifacts excluded from commits?

## [2026-06-11] Runtime placement and adapter boundary are architectural contracts

**Severity:** MEDIUM
**Source:** PR #76, issue #71
**Scope:** README, integration docs
**Status:** active

### Pattern

`openbrain-memory` installs on agent hosts. The Open Brain service stays remote
on the LXC. `rtech-hermes` owns the Hermes adapter/lifecycle integration and
should consume this package instead of reimplementing protocol logic.

### Review Questions

- Does a change preserve one-way dependency direction?
- Does open-brain avoid importing Hermes runtime code?
- Does Hermes-specific lifecycle logic stay out of the reusable package?
