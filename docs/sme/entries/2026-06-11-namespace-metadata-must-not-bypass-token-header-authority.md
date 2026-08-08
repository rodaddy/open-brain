---
lane: security
order: 0
---
## [2026-06-11] Namespace metadata must not bypass token/header authority

**Severity:** HIGH
**Source:** Issue #78, PR #73 follow-up
**Scope:** `python/openbrain-memory/src/openbrain_memory/agent.py`
**Status:** active

### Pattern

`AgentMemory.remember_fact()` and `remember_decision()` accepted free-form
`namespace` metadata and forwarded it into tool arguments. That can conflict
with or attempt to override the server's token-derived namespace authority or
an explicit privileged `X-Namespace` delegation path.

### Review Questions

- Is `namespace` removed from generic metadata pass-through, or verified against
  the authenticated server-side namespace/delegation policy?
- If namespace override is required, is it an explicit privileged API rather
  than arbitrary metadata?
- Are there tests for `namespace="other"` on normal clients?
- Do docs explain bearer token, server policy, headers, and facade behavior?
