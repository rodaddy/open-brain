---
lane: domain-backend
order: 11
---
## [2026-07-07] Runtime availability must distinguish active transport from configured fallback

**Severity:** HIGH
**Source:** PR #262 initial swarm for Issue #223
**Scope:** `src/nats-runtime.ts`, `src/contract.ts`, `src/index.ts`, optional second-transport metadata
**Status:** fixed in PR #262; keep as active checklist

### Pattern

Optional second transports can over-advertise readiness when configuration is
present but the runtime path is not active. In PR #262, setting NATS bridge env
and a URL could make `get_contract()` advertise NATS availability while the
server was still running the default HTTP transport. The contract also listed
planned request/reply subjects in the same bucket as the one implemented
subject.

### Review Questions

- Does runtime availability require the transport to be requested and actually
  started, not merely configured?
- Are available subjects separated from planned/not-yet-implemented subjects in
  machine-readable contract metadata?
- Do fallback/client paths continue to fail closed when the second transport is
  configured but not active?
- Do docs and tests cover default HTTP behavior, active second-transport
  behavior, and configured-but-inactive behavior?
