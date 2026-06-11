# Adversarial SME Findings

Adversarial reviewers hunt for failure states: outages, partial writes, stuck
locks, oversized data, malformed responses, and tests that pass for the wrong
reason.

## [2026-06-11] Never hold spool locks across slow dispatch

**Severity:** HIGH
**Source:** Issue #80, PR #74 follow-up
**Scope:** `python/openbrain-memory/src/openbrain_memory/spool.py`
**Status:** active

### Pattern

`JsonlSpool.replay()` holding an exclusive file lock while calling a dispatcher
can block foreground writers for the duration of slow or down HTTP calls. This
is especially bad during outage recovery, when foreground writes are likely to
need spooling too.

### Review Questions

- Does replay claim/snapshot records under lock, then release the lock before
  network/slow dispatch?
- Are new appends preserved while replay is in progress?
- Is there a concurrent replay/append test proving append latency is bounded
  while a dispatcher blocks?

## [2026-06-11] Append success must mean the record is recoverable

**Severity:** HIGH
**Source:** Issue #80
**Scope:** `python/openbrain-memory/src/openbrain_memory/spool.py`
**Status:** active

### Pattern

An oversized single record larger than `max_bytes` can be written, trimmed away,
and still return success. That creates silent data loss in a recovery path.

### Review Questions

- What happens when one record exceeds `max_bytes`?
- Does `append()` reject, truncate with an explicit marker, or store separately?
- Is there a regression test proving `append()` cannot report success while
  storing nothing?

## [2026-06-11] Fixes need failure-mode tests, not just happy-path tests

**Severity:** MEDIUM
**Source:** Issues #77-#82
**Scope:** all Open Brain client/facade work
**Status:** active

### Pattern

The first package swarm had good happy-path coverage, but later reviews found
outage and malformed-input behavior: replay dispatch, live redaction, malformed
DreamEngine reports, unbounded responses, and missing in-process transport
contracts.

### Review Questions

- What fails if the server is slow, down, malformed, oversized, or partially
  successful?
- Does each recovery feature prove durability under its own failure mode?
- Are tests only asserting method names, or are they asserting state after
  failure?
