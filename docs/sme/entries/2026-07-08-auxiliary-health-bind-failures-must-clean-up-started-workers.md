---
lane: adversarial
order: 8
---
## [2026-07-08] Auxiliary health bind failures must clean up started workers

**Severity:** HIGH
**Source:** PR #283 initial swarm for Issue #282
**Scope:** dedicated worker entrypoints that start subscriptions/pools before a
health or monitoring listener
**Status:** fixed in PR #283

### Pattern

A worker can successfully start its core subscription and database pool, then
throw while binding an auxiliary health endpoint. If that bind failure is
outside the guarded startup path, launchd/systemd restarts the process while the
startup path skips orderly bridge/pool cleanup. This turns a monitoring-port
collision into a noisy worker restart loop.

### Review Questions

- Are pool creation, bridge/subscription startup, and health-server bind inside
  one guarded startup path?
- If a later startup step fails, are already-started subscriptions, health
  servers, and pools closed before exit?
- Does the worker log a redacted startup failure instead of a raw exception?
- Is there a regression test where health bind throws after subscription startup
  and cleanup still closes both bridge and pool?
