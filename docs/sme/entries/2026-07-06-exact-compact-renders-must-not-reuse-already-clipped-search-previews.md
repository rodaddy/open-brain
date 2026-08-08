---
lane: correctness
order: 10
---
## [2026-07-06] Exact compact renders must not reuse already-clipped search previews

**Severity:** MEDIUM
**Source:** PR #246 initial swarm for Issue #192
**Scope:** `src/tools/get-entry.ts`, `src/tools/table-constants.ts`, any bounded exact-fetch projection
**Status:** fixed in PR #246

### Pattern

Search/list preview expressions can be intentionally display-clipped. In PR
#246, compact `get_entry` initially reused `CONTENT_PREVIEW[table]` for
`content_length` and `content_truncated`. For `sessions`, `CONTENT_PREVIEW`
already applied `LEFT(s.summary, 300)`, so compact exact fetch could report a
shorter length and `content_truncated=false` for a long stored session summary.

### Review Questions

- Is a compact/exact-fetch render measuring the underlying readable content, or
  a search/list preview that may already be clipped?
- Do `content_length` and `content_truncated` reflect the same unbounded text
  that `content_preview` is truncating?
- Does the test suite include a long-row regression for any source family whose
  search preview is intentionally abbreviated?
- Is novel SQL projection covered by a real Postgres-gated test when a mock pool
  cannot execute the query?

### Prior Fix

PR #246 gave compact `get_entry` its own full-readable-content expression for
`sessions`, computed normalized content once in a subquery, added a mock SQL
shape guard, and added an `OPENBRAIN_TEST_DATABASE_URL`-gated live Postgres
test for long session compact length/truncation.
