---
lane: security
order: 43
section: harvest-522
---
## [2026-08-06] Trace session identity must come from the server-resolved binding, never the unauthenticated wire

**Severity:** HIGH
**Source:** PR #600 review swarm, finding H2
**Scope key:** `review.trace_session_identity_binds_after_auth`
**Status:** active

### Pattern

Any observability record that carries a session/user identity must derive it AFTER the request passes auth and binding — never from a caller-declared field read off the wire before any control has run. PR #600 built the NATS trace recorder from `envelope.payload.identity.session_key` at the top of the subscription callback, before the size/kind/auth/namespace checks, and emitted the trace even for REJECTED requests — so any publisher could stamp another tenant's session key onto traces, and the field bypassed masking entirely (sessionId/userId spread through untouched). Fix shape: identity flows from the resolved binding via a post-auth callback; a wire-declared value may appear only as masked metadata under an explicitly untrusted name. Regression shape: forged key + no valid bearer → emitted body has no sessionId.
