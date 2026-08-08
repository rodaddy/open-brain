---
lane: correctness
order: 52
section: harvest-522
---
## [2026-08-03] Delete the registry entry before close(), and guard close()

**Severity:** not stated in source
**Source:** rodaddy/open-brain#17 (issue body); harvested in #522
**Scope key:** `sme.correctness.delete_before_close_in_cleanup`
**Status:** active

### Pattern

In resource-registry cleanup, delete the registry entry BEFORE calling close(), and wrap close() in try/catch — a rejecting close in a timer callback skips the delete and leaks the slot permanently until restart. Pair the per-entry timer with an independent sweeper as a safety net.

Verbatim, from the source:

> Timer callbacks in `transport.ts` call `transport.close()` without `await` or `try/catch`. If `close()` rejects (e.g., transport already dead from a dropped SSE connection), `sessions.delete()` never executes and the session leaks permanently.
