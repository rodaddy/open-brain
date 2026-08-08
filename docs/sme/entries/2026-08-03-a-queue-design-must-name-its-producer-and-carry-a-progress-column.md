---
lane: domain-backend
order: 30
section: harvest-522
---
## [2026-08-03] A queue design must name its producer and carry a progress column

**Severity:** not stated in source
**Source:** issue #433 comment (root cause); harvested in #522
**Scope key:** `sme.queue_needs_a_named_producer_and_progress_column`
**Status:** active

### Pattern

Reusable review check for any queue/sweep design: name the producer explicitly. Open Brain shipped a correct consumer, correct classifier, and correct graduation function with no producer anywhere, and every layer above assumed promotion happened. Also require a processed-state column before landing any producer — `ob_session_events` had no `graduated_at`, so a sweep could not tell processed from unprocessed and would rescan all rows every run. That column is a prerequisite for the producer, not a follow-up.

Verbatim, from the source:

> `src/maintenance-bootstrap.ts` states it as intent, not accident: "The bootstrap enqueues nothing and defines no recurring sweep: the maintenance runner is a consumer." So the runner consumes a queue that no producer fills.
