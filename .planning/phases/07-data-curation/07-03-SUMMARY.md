---
phase: 07-data-curation
plan: 03
subsystem: search-brain, curation
tags: [usage-tracking, usefulness-ranking, curation, llm-judge, duplicate-detection]
dependency_graph:
  requires: [07-01]
  provides: [usage-weighted-search, curation-script]
  affects: [search-brain]
tech_stack:
  added: []
  patterns: [fire-and-forget-tracking, hnsw-nearest-neighbor, llm-as-judge]
key_files:
  created:
    - scripts/curate.ts
  modified:
    - src/tools/search-brain.ts
    - src/tools/__tests__/search-brain.test.ts
    - package.json
decisions:
  - "Composite ranking formula: 80% vector distance + 20% usefulness score (inverted for ASC ordering)"
  - "COALESCE(usefulness_score, 0.5) as neutral default -- new entries neither boosted nor penalized"
  - "HNSW nearest-neighbor for duplicate detection (O(n log n)) instead of cross-join (O(n^2))"
  - "LLM judge errors return SKIP -- never crash the curation script"
metrics:
  duration: "~6 min"
  completed: "2026-03-15"
  tasks: 2
  tests_added: 5
  tests_total: 206
---

# Phase 07 Plan 03: Usage-Weighted Search + Curation Script Summary

Usage-weighted search with composite ranking (80% distance, 20% usefulness) and fire-and-forget access tracking, plus standalone LLM-as-judge curation script with HNSW duplicate detection.

## Tasks Completed

| Task | Name | Commit | Key Changes |
|------|------|--------|-------------|
| 1 | Usage tracking + usefulness-weighted ranking | `08b6736`, `be1b27f` | search-brain.ts: composite ORDER BY, fire-and-forget tracking, LABEL_TO_TABLE reverse map |
| 2 | Curation script + package.json | `c640d79` | scripts/curate.ts (303 lines), package.json curate entry |

## Implementation Details

### Task 1: Usage Tracking + Usefulness-Weighted Ranking

**Usage tracking:** After a successful search returns results, fire-and-forget UPDATEs increment `access_count` and set `last_accessed_at = NOW()` for all returned rows. Rows are grouped by source table via a `LABEL_TO_TABLE` reverse map to minimize UPDATE calls. Tracking never blocks the search response -- uses `void Promise.allSettled(promises).catch(() => {})`.

**Usefulness ranking:** The CTE SELECT now includes `COALESCE(usefulness_score, 0.5) AS usefulness`. The final ORDER BY uses a composite formula: `(distance * 0.8 + (1.0 - COALESCE(usefulness, 0.5)) * 0.2) ASC`. This means:
- 80% weight on vector similarity (lower distance = better)
- 20% weight on usefulness (higher score = lower penalty)
- `usefulness_score = 1.0` gets 0.0 penalty (best)
- `usefulness_score = 0.0` gets 0.2 penalty (worst, but still returned)
- `NULL` defaults to 0.5 (neutral -- 0.1 penalty)

**Tests added:** 5 new tests across 2 describe blocks (usage tracking, usefulness-weighted ranking). Existing ORDER BY assertion updated to check composite formula components instead of raw `ORDER BY distance`.

### Task 2: Curation Script

**scripts/curate.ts** (303 lines) -- standalone brain maintenance script with three detection modes:

1. **Duplicate detection:** HNSW nearest-neighbor search per entry (O(n log n) via existing index). Entries with cosine distance < 0.08 are duplicates. Older entry is archived. Pair deduplication via sorted ID set.

2. **Stale detection:** Entries older than 90 days with `access_count = 0`. LLM judge (gpt-4o-mini via LiteLLM) evaluates each: KEEP (no-op), ARCHIVE (soft delete), DOWNGRADE (set `usefulness_score = 0.2`).

3. **Vague content detection:** Entries with no tags and low/null usefulness_score. LLM judge rates quality 0.0-1.0 and sets `usefulness_score`.

**Safety features:**
- `--dry-run` flag logs proposed actions without mutations
- Idempotent: `archived_at IS NULL` guards prevent re-processing
- LLM judge errors return "SKIP" -- never crash
- 200ms delay between LLM calls to avoid overloading LiteLLM
- Direct SQL operations (no MCP tools) for performance

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated existing queryCalls.length assertions**
- **Found during:** Task 1 GREEN phase
- **Issue:** Two existing tests asserted `queryCalls.length` to be exactly 1, but fire-and-forget tracking adds additional query calls
- **Fix:** Changed to `toBeGreaterThanOrEqual(1)` for tests that return results (tracking UPDATEs fire)
- **Files modified:** src/tools/__tests__/search-brain.test.ts
- **Commit:** be1b27f

## Verification

- All 206 tests pass across 18 files
- TypeScript compiles cleanly (`bunx tsc --noEmit`)
- search-brain tests: 18/18 pass (14 existing + 4 new passing after implementation)
- Curation script: 303 lines (under 400 limit)
- `bun run curate` entry added to package.json

## Self-Check: PASSED

- All 4 key files exist on disk
- All 3 task commits verified (08b6736, be1b27f, c640d79)
- curate script entry present in package.json
- 206/206 tests pass, tsc clean
