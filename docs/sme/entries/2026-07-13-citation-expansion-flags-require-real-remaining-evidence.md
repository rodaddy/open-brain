---
lane: correctness
order: 17
---
## [2026-07-13] Citation expansion flags require real remaining evidence

**Severity:** MEDIUM
**Source:** Issue #288 Full-tier initial review
**Scope:** citation recall bounds and response truth
**Status:** fixed in issue #288 implementation

A bounded citation response must not hardcode `expandable`. Query one extra neighbor and derive it from unseen rows or transcript truncation; tests must cover both true and false cases.
