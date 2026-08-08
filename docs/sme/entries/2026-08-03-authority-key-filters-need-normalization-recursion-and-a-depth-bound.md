---
lane: security
order: 35
section: harvest-522
---
## [2026-08-03] Authority-key filters need normalization, recursion, and a depth bound

**Severity:** not stated in source
**Source:** rodaddy/open-brain#86 (comment by rodaddy); harvested in #522
**Scope key:** `sme.security.authority_key_filters_need_normalization_and_depth_bound`
**Status:** active

### Pattern

A reserved/authority-key rejection filter must normalize case and underscore-vs-dash before matching, and must recurse into nested metadata — otherwise `Authorization` or `headers: {"X-Namespace": "other"}` slips through a filter that only blocks `namespace`. Balance it the other way too: scope the recursive scan to authority/control keys so semantic keys like `source`, `summary`, `title`, and `rationale` are not blocked, and bound the recursion depth so user-controlled nesting cannot raise RecursionError.

Verbatim, from the source:

> Final gotcha lane found nested authority checks were case-sensitive and missed header-shaped values like `Authorization` or `headers: {"X-Namespace": "other"}`. Fixed by normalizing key names with lowercase and underscore-to-dash handling
