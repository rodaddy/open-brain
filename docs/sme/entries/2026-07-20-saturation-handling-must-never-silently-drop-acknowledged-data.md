---
lane: correctness
order: 22
---
## [2026-07-20] Saturation handling must never silently drop acknowledged data

**Severity:** HIGH
**Source:** Issue #300, PR #305 (#293-family review)
**Scope:** `python/openbrain-memory/src/openbrain_memory/spool.py`
**Status:** active

### Pattern

`append_batch` FIFO-evicted previously-spooled groups to admit a new batch and
then returned success — silently destroying records already acknowledged as
`durable=True`/`SPOOLED`. Capacity limits must surface as backpressure
(explicit rejection, e.g. `SpoolFullError`, with the store unchanged) or as an
observable loss receipt — never as evict-then-return-success.

### Review Questions

- Under saturation, does any path drop already-acknowledged data and still
  report success?
- Is rejection all-or-nothing (store byte-for-byte unchanged on failure)?
- Do tests cover both line-count and byte limits, and assert prior records
  remain intact AND replayable after a rejected append?
- Will a future replay/recovery consumer see the loss, or replay a queue that
  already lost records?
