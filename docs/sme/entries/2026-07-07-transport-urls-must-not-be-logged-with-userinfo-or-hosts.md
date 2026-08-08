---
lane: security
order: 11
---
## [2026-07-07] Transport URLs must not be logged with userinfo or hosts

**Severity:** MEDIUM
**Source:** PR #260 initial swarm for Issue #223
**Scope:** `src/index.ts`, transport startup warnings, NATS/HTTP/stream config
**Status:** fixed in PR #260; keep as active checklist

### Pattern

Transport configuration often arrives as a URL. A NATS URL with userinfo carries
credentials in `username/password`, and even host/IP fields can be sensitive in
durable logs. Startup warnings and diagnostics should record only safe facts:
configured/not configured, protocol, and whether credentials were present.

### Review Questions

- Does any log include an env-sourced transport URL verbatim?
- If a URL may contain userinfo, tokens, hosts, or internal IPs, is the log
  reduced to safe booleans/enums rather than redacted text with residual shape?
- Do tests prove credential-bearing URLs do not appear in log helper output?
