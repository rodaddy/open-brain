---
lane: correctness
order: 56
section: harvest-522
---
## [2026-08-03] A durable/spooled receipt needs a production drain caller

**Severity:** not stated in source
**Source:** issue #307; harvested in #522
**Scope key:** `review.durable_status_needs_a_production_drain_caller`
**Status:** active

### Pattern

A receipt status that promises eventual delivery (`spooled`/`durable`) is a lie unless a production caller actually drains the buffer. When reviewing durability features, trace the drain/replay entry point to a real runtime or adapter caller -- public API whose only callers are tests is a dead path, and green tests will certify it. Check the same way for quarantine, retry, and dead-letter paths.

Verbatim, from the source:

> `Spool.replay()` and `replay_records()` ... are public API with **only test callers**. Nothing in the runtime, adapter, or any CLI ever replays the spool in production. A record that gets spooled (receipt `status:"spooled"`, `durable:true`) is durable forever but never delivered. ... Without any production replay path, "durable" actually means "parked in a file nobody reads".
