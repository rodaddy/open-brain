---
lane: adversarial
order: 7
---
## [2026-07-08] Promise.race timeouts leave detached DB writes holding pool connections

**Severity:** HIGH
**Source:** PR #275 pre-merge gauntlet for Issue #269
**Scope:** `src/audit-log.ts`, any fail-open/fire-and-forget DB write wrapped in
a timeout race
**Status:** fixed in PR #275

### Pattern

Racing a DB write against a timeout does not cancel the write: the losing
`pool.query` keeps running detached and holds its pool connection until the
server responds. Under a slow or wedged database, fail-open audit writes can
accumulate detached queries until user-facing operations starve on the shared
pool. Write concurrency caps must sit below the pool size, and new fail-open
writes must skip when `pool.waitingCount > 0` so background telemetry never
outbids foreground work.

### Review Questions

- Does any timeout race assume the losing promise stops consuming resources?
- Is the background write concurrency cap strictly below the pool size?
- Does the write path skip (not queue) when the pool already has waiters?
- Do tests wedge the fake pool and prove foreground queries still get
  connections while audit writes shed load?
