---
lane: correctness
order: 57
section: harvest-522
---
## [2026-08-03] The read path's table list must include where the writes land

**Severity:** not stated in source
**Source:** issue #433 (brain_answer cannot see session events); harvested in #522
**Scope key:** `sme.recall_read_path_must_cover_write_path`
**Status:** active

### Pattern

Reusable review check: when a pipeline has a write path, a promotion step, and a read path, verify that the read path's table list actually includes where the writes land, and that something automatically calls the promotion step. `graduateLaneEvent` had never written a row in the database's entire history while 7,676 events sat eligible, and `ALL_TABLES` omitted `ob_session_events` — each defect alone would degrade gracefully, together they were silent and total. Ask on any recall surface: does it report 'newest evidence is N days old' rather than confidently answering from the oldest thing it can see?

Verbatim, from the source:

> Together they are silent and total: capture succeeds and returns a receipt, the operator believes the system remembered, and retrieval answers from whatever last made it into `thoughts` before promotion stopped. **The system reports success at every step while the knowledge is unreachable.**
