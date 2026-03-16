---
phase: 07-data-curation
plan: 02
subsystem: tools
tags: [curation, archive, list, update, rate, embedding, permissions]
dependency_graph:
  requires: [archived_at columns, delete permission, canDelete function]
  provides: [archive_entry tool, list_recent tool, update_entry tool, rate_entry tool]
  affects: [tools/index.ts]
tech_stack:
  added: []
  patterns: [per-table field validation in update_entry, dynamic UPDATE SET clause construction, embeddable text builder per table type]
key_files:
  created:
    - src/tools/archive-entry.ts
    - src/tools/list-recent.ts
    - src/tools/update-entry.ts
    - src/tools/rate-entry.ts
    - src/tools/__tests__/archive-entry.test.ts
    - src/tools/__tests__/list-recent.test.ts
    - src/tools/__tests__/update-entry.test.ts
    - src/tools/__tests__/rate-entry.test.ts
  modified:
    - src/tools/index.ts
decisions:
  - "archive_entry uses canDelete (not canWrite) -- only admin and n8n can soft-delete"
  - "update_entry rejects updates to archived entries via SELECT guard, not SQL WHERE clause"
  - "update_entry idempotentHint=false because re-embedding changes embedded_at timestamp"
  - "rate_entry uses AND archived_at IS NULL in UPDATE WHERE for atomic archived guard"
  - "Tags-only updates skip re-embedding entirely (no content change = no new embedding)"
metrics:
  duration: "5m"
  completed: "2026-03-15T17:53:09Z"
  tasks: 2/2
  tests: 206 pass, 0 fail
---

# Phase 7 Plan 02: Curation Tools Summary

Four curation tools (archive_entry, list_recent, update_entry, rate_entry) with per-table field validation, re-embedding on content change, hash collision detection, and archived entry guards.

## Task Results

### Task 1: Implement archive_entry and list_recent tools with tests
- **Commit:** `2712001`
- **Status:** Complete
- **Files:** `src/tools/archive-entry.ts` (created), `src/tools/list-recent.ts` (created), plus test files
- **Details:**
  - archive_entry soft-deletes via `SET archived_at = NOW()` with `AND archived_at IS NULL` guard
  - Uses canDelete permission -- only admin and n8n roles can archive
  - Idempotent: returns "Already archived or not found" without isError when 0 rows
  - list_recent queries across all readable tables with UNION ALL, configurable days/limit/table filter
  - Supports include_archived flag (default false) to toggle archived_at IS NULL filtering
  - Uses same SOURCE_LABELS and CONTENT_PREVIEW maps as search_brain
  - 14 tests covering all permission roles, default params, custom params, table filter, archived toggle

### Task 2: Implement update_entry and rate_entry tools, wire all four into registerAllTools
- **Commit:** `53bacfa`
- **Status:** Complete
- **Files:** `src/tools/update-entry.ts` (created), `src/tools/rate-entry.ts` (created), `src/tools/index.ts` (modified), plus test files
- **Details:**
  - update_entry accepts flexible per-table fields via VALID_FIELDS map
  - Re-embeds only when content fields change (CONTENT_FIELDS map), skips for tags-only updates
  - Builds embeddable text per table type: thoughts=content, decisions=title+rationale, relationships=person_name+context, projects=name+description, sessions=summary
  - SELECT guard checks for archived_at before proceeding with update
  - Content hash collision check: SELECT WHERE content_hash=$1 AND id!=$2 before UPDATE
  - Dynamic UPDATE SET clause with parameterized query
  - Graceful degradation: updates content even if embedding fails (embedded=false)
  - rate_entry sets usefulness_score (0.0-1.0) with canWrite permission
  - rate_entry uses `AND archived_at IS NULL` in UPDATE WHERE for atomic guard
  - All four tools registered in registerAllTools
  - 16 new tests, 206 total pass across full suite

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] TypeScript type error on args indexing**
- **Found during:** Task 2
- **Issue:** `args[field]` indexing failed TypeScript type check because the Zod-inferred args type has no index signature
- **Fix:** Cast `args as Record<string, unknown>` for dynamic field access in the valid-fields filter loop
- **Files modified:** `src/tools/update-entry.ts`
- **Commit:** `53bacfa`

## Verification

```
bunx tsc --noEmit           -- PASS (clean compile)
bun test src/tools/ --bail  -- 96 tests pass
bun test --bail             -- 206 tests pass, 0 fail, 588 expect() calls
```

## Self-Check: PASSED

All 9 files verified present. Both commits (2712001, 53bacfa) found in git history. 206 tests pass, TypeScript compiles cleanly.
