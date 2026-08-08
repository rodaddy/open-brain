---
lane: security
order: 38
section: harvest-522
---
## [2026-08-03] Citation provenance is a namespace-isolation surface

**Severity:** HIGH (stated in source)
**Source:** PR #112 / #113 (review findings and fixes); harvested in #522
**Scope key:** `review.provenance_in_citations_is_a_leak_surface`
**Status:** active

### Pattern

Citation and provenance metadata is a namespace-isolation surface: exposing a promoted row's source namespace and source id leaks private metadata to any caller who can read the promoted copy. Citation refs must carry only citation-safe identity for the row the caller can actually read. Related checks from the same lane: guard `new Date(row.created_at).toISOString()` against malformed timestamps so one bad row cannot break search, and require both source_ref metadata and usable preview text before rendering an answer bullet so malformed evidence cannot produce uncited output.

Verbatim, from the source:

> HIGH security: `source_ref.promoted_from` exposes raw source namespace and source id from promoted rows. A caller who can read a promoted `collab` row could learn private source namespace metadata they cannot otherwise read.
