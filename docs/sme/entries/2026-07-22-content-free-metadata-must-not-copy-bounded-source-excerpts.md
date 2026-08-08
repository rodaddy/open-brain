---
lane: quality
order: 12
---
## [2026-07-22] Content-free metadata must not copy bounded source excerpts

**Severity:** P3
**Source:** PR #351 terminal audit (issue #337)
**Status:** fixed-pre-merge

A bounded title derived by copying the first source line is still raw source content. If a metadata surface is documented content-free, keep only non-reversible structural values or document the field honestly; add a marker regression proving no excerpt survives.
