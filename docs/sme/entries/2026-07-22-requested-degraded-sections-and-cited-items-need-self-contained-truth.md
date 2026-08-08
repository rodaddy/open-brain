---
lane: correctness
order: 33
---
## [2026-07-22] Requested degraded sections and cited items need self-contained truth

**Severity:** MEDIUM (P2)
**Source:** PR #353 / issue #327 Terra terminal audit
**Scope:** `src/tools/agent-context-pack-durable-memory.ts`, context-pack section/citation contracts
**Status:** fixed-pre-merge

### Pattern

A requested section that fails internally must not disappear into the same shape
as an unrequested section. PR #353 initially omitted `durable_memory` when recall
threw, leaving only a degraded warning; callers could not distinguish "not
requested" from "requested but unavailable." It also put `source_ref` only on
the separate citation even though each recalled item claimed item-level
resolvability. The fix returns a truthful empty `recall_failed` envelope and
builds one bounded `source_ref` per row, attaching the same value to both item and
citation. Whole-pack trimming then prunes citations by retained `citation_id`,
keeping an item/citation/source-ref bijection.

### Review Questions

- Does every explicitly requested degraded section return a stable empty envelope
  with zero counts and a specific content-free reason, while an unrequested
  section remains absent?
- If an item contract promises `source_ref`, is it present on the item itself and
  equal to the matching citation's reference?
- After partial trim, all-item trim, or whole-section starvation, are there any
  dangling citations or source refs?
- Is duplicated item/citation provenance charged to the serialized hard budget,
  and do higher-priority sections still survive unchanged?
