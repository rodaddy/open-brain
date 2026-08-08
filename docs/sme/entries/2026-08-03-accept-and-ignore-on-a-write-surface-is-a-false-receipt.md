---
lane: correctness
order: 59
section: harvest-522
---
## [2026-08-03] Accept-and-ignore on a write surface is a false receipt

**Severity:** not stated in source
**Source:** https://github.com/rodaddy/open-brain/issues/464; harvested in #522
**Scope key:** `review.no_silent_drop_on_successful_write`
**Status:** active

### Pattern

Accept-and-ignore on a write surface is a false receipt: the openbrain-memory JSON-stdin CLI dropped the three promotion fields while returning status:saved, so any scripted canon promotion would report success and seed nothing promotable. A write API must either forward the full vocabulary or reject unknown keys loudly with a named error and non-zero exit -- never accept and ignore. Regression test shape: pipe the field through the real console path and assert either the metadata lands or the call fails loud.

Verbatim, from the source:

> Passing `candidate_type`, `memory_lifecycle_action`, or `candidate_scope` — the exact fields the #445 promotion mechanism requires — gets them **silently dropped**: the write succeeds, returns `status:saved`, and the row lands without the metadata.
