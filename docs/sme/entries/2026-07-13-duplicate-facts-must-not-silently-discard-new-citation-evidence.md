---
lane: adversarial
order: 10
---
## [2026-07-13] Duplicate facts must not silently discard new citation evidence

**Severity:** MEDIUM
**Source:** Issue #288 Full-tier antagonist review
**Scope:** append_session_event dedupe and citation recall
**Status:** fixed in issue #288 implementation

Content-hash dedupe can turn citation backfill into a false success. When an existing event lacks or differs from supplied citation fields, return an explicit citation-not-stored error instead of claiming a harmless duplicate.
