---
lane: correctness
order: 4
---
## [2026-06-19] Sync and async gates on the same flag must share truthiness

**Severity:** MEDIUM
**Source:** Issue #161, PR #171 (share_candidate nomination, hybrid timing)
**Scope:** any field validated both inline (TS) and in SQL (`->>'x' = 'true'`)
**Status:** active

### Pattern

`append_session_event`'s sync gate checked `metadata.share_candidate !== true`
(strict boolean), but the async promoter nominated on
`metadata->>'share_candidate' = 'true'` — which also matches the JSON string
`"true"`. A mistyped string nomination skipped the inline secret/private check
yet was still swept async, voiding the sync gate's security guarantee.
Defense-in-depth (the async re-classify) prevented an actual promotion hole, but
the sync rationale was void and the agent got no rejection feedback.

### Review Questions

- When the same flag is gated in two places (inline code + SQL `->>`), do both
  accept the same set of truthy values?
- Is the inline check at least as permissive as the SQL one, so nothing the
  async path will act on bypasses the sync guard?

### Prior Fix

PR #171 made the sync gate accept `=== true || === "true"` to match the SQL
truthiness; regression test asserts a string `"true"` nomination with secret
content is still rejected inline.
