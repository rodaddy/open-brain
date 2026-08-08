---
lane: quality
order: 9
---
## [2026-07-08] Operational runbooks must separate implemented tests from release proof

**Severity:** MEDIUM
**Source:** PR #283 initial swarm for Issue #282
**Scope:** rollout/runbook docs for live service workers and transport bridges
**Status:** fixed in PR #283

### Pattern

A runbook can accidentally overclaim readiness by saying "install after tests
for X" when the PR only adds a subset of those tests and leaves some checks as
release-time live proof. That trains future operators to treat aspirational
checks as already covered and weakens the deploy gate.

### Review Questions

- Does the runbook distinguish automated tests already present from live
  release proof still required on the host?
- Does verification document both success and expected error envelopes?
- Are no-reply, shutdown, and close failures described as log/health conditions
  to inspect, not successful request/reply smokes?
- Are PR comments and release notes explicit about what remains deferred?
