---
lane: security
order: 34
section: harvest-522
---
## [2026-08-03] Session reuse must bind the effective delegated identity, not just the token

**Severity:** not stated in source
**Source:** rodaddy/open-brain#90 (issue body); harvested in #522
**Scope key:** `sme.security.session_reuse_must_bind_effective_identity`
**Status:** active

### Pattern

Where identity can be delegated per-request (headers) but sessions are cached by token, check that session reuse keys on the EFFECTIVE identity, not just the bearer-token identity — otherwise one long-lived session is reusable across tenants. A test that asserts the permissive behavior is itself the finding: it must be replaced with a denial test covering POST, GET, and DELETE reuse paths.

Verbatim, from the source:

> MCP session reuse is bound to token identity and role, but not to the effective delegated namespace or agent id. ... `src/server.test.ts:188` explicitly asserts that the same token can initialize a session under `X-Namespace: bilby` and then reuse the same `Mcp-Session-Id` under `X-Namespace: skippy`.
