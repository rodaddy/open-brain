---
lane: adversarial
order: 0
---
## [2026-06-11] Never hold spool locks across slow dispatch

**Severity:** HIGH
**Source:** Issue #80, PR #74 follow-up; PR #319 fix delta
**Scope:** `python/openbrain-memory/src/openbrain_memory/spool.py`, `clients/ts/src/spool.ts`
**Status:** active

### Pattern

`JsonlSpool.replay()` holding an exclusive file lock while calling a dispatcher
can block foreground writers for the duration of slow or down HTTP calls. This
is especially bad during outage recovery, when foreground writes are likely to
need spooling too.

**PR #319:** a portable lock must cover each local snapshot and reconciliation
transaction across processes, but must be released before dispatcher/network
calls; test independently opened spool instances, not only same-instance races.

### Review Questions

- Does replay claim/snapshot records under lock, then release the lock before
  network/slow dispatch?
- Are new appends preserved while replay is in progress?
- Is there a concurrent replay/append test proving append latency is bounded
  while a dispatcher blocks?
- Does a failed directory durability sync restore prior bytes (or absence) and
  avoid acknowledging the append?
