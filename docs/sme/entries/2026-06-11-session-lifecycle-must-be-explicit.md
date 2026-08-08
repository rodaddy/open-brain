---
lane: domain-backend
order: 2
---
## [2026-06-11] Session lifecycle must be explicit

**Severity:** MEDIUM
**Source:** Issue #81; PR #319 terminal audit
**Scope:** Python and TypeScript `OpenBrainClient`
**Status:** active

### Pattern

MCP sessions can accumulate under churn if the client has no explicit close or
context-manager path and no documented TTL reliance. Concurrent first-use calls
can also create multiple sessions when initialization is not coalesced; a close
that overlaps initialization must invalidate and tear down the pending session
so no session is published after close returns. Concurrent expired-session
responses must be bound to the session ID each request used, so a delayed 404
from an older session cannot clear and leak a newer replacement session.

### Review Questions

- Does `OpenBrainClient` support `close()` and context manager behavior if the
  server supports termination?
- Are concurrent first-use calls coalesced onto one initialization attempt?
- Does close-during-initialize invalidate the pending operation, delete the
  pending server session, and still allow a later post-close call to reinitialize?
- When concurrent requests receive delayed expiry responses, does each response
  clear only the session ID used by that request and preserve any newer session?
- If explicit close is unsupported, do README/API docs state lifecycle and server
  TTL clearly?
- Are lifecycle concurrency tests included?
