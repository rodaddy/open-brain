---
lane: domain-backend
order: 12
---
## [2026-07-07] Subscription liveness must not stay green on empty iterator churn

**Severity:** MEDIUM
**Source:** PR #262 Claude/Opus cross-review for Issue #223
**Scope:** `src/nats-bridge.ts`, streaming/subscription loops, runtime health
**Status:** fixed in PR #262; keep as active checklist

### Pattern

A clean iterator completion is not always healthy. If a broker or driver returns
empty subscriptions repeatedly, the bridge can resubscribe forever without ever
processing a request while `/health` and `get_contract()` still advertise the
transport as available. One clean completion can be a normal recycle; repeated
zero-message completions need a bounded degradation rule.

### Review Questions

- Does the subscription loop distinguish a single clean recycle from repeated
  empty completions?
- Is health degraded after a bounded number or duration of no-message
  completions?
- Do tests cover both a successful resubscribe after one clean completion and
  repeated empty completions that must not stay healthy?
