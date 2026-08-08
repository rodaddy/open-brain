---
lane: security
order: 12
---
## [2026-07-07] Transport error logs must not copy raw dependency messages

**Severity:** MEDIUM
**Source:** PR #262 Claude/Opus cross-review for Issue #223
**Scope:** `src/nats-bridge.ts`, secondary transport request handlers, subscription loops
**Status:** fixed in PR #262; keep as active checklist

### Pattern

Dependency error messages can embed user content, tokens, broker URLs, internal
hosts, or headers. Returning generic errors to callers is not enough if
server-side logs still write `err.message` verbatim. Transport diagnostics
should log stable classes/codes and safe context such as subject or operation,
not raw dependency messages.

### Review Questions

- Do request, handler, and subscription error logs avoid raw `err.message`?
- Are diagnostics limited to safe error type/code plus safe routing metadata?
- If an error type is logged, is it derived from allowlisted instance checks
  rather than mutable `Error.name`?
- Do tests throw sensitive-looking dependency errors and prove logs omit the
  sensitive fragments?
