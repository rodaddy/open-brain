---
lane: correctness
order: 14
---
## [2026-07-06] Deduplicating apply batches must distinguish prior rows from self-collisions

**Severity:** HIGH
**Source:** PR #254 Claude/Opus cross-review for Issue #247
**Scope:** `src/tools/decompose-entry.ts`, any batch writer using
`ON CONFLICT DO NOTHING` plus fallback duplicate lookup
**Status:** fixed in PR #254; keep as active checklist

### Pattern

When a mutating batch writes rows with a normalized uniqueness key, a later item
in the same batch can collide with an earlier item just inserted by the current
transaction. If the fallback duplicate lookup reports that new row as a
pre-existing duplicate, audit/provenance output lies about where the duplicate
came from.

### Review Questions

- Does the writer track unique keys inserted earlier in the same batch?
- Are intra-batch duplicate collapses reported separately from pre-existing
  duplicate rows?
- Do apply tests include repetitive or highly-overlapped content that can
  produce duplicate normalized hashes inside one request?
