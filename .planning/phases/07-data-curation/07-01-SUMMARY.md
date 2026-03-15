---
phase: 07-data-curation
plan: 01
subsystem: database, permissions, tools
tags: [curation, migration, permissions, filtering]
dependency_graph:
  requires: []
  provides: [archived_at columns, access_count columns, usefulness_score columns, partial indexes, delete permission, canDelete function]
  affects: [search-brain, session-load, find-person, permissions]
tech_stack:
  added: []
  patterns: [partial indexes for active-only queries, permission set composition (RWD)]
key_files:
  created:
    - src/db/migrations/002_curation.sql
  modified:
    - src/types.ts
    - src/permissions.ts
    - src/tools/search-brain.ts
    - src/tools/session-load.ts
    - src/tools/find-person.ts
    - src/tools/__tests__/search-brain.test.ts
    - src/tools/__tests__/session-load.test.ts
decisions:
  - "Only admin and n8n get delete permission -- agents must not self-archive knowledge"
  - "RWD permission set composes with existing RW/RO/WO/NONE pattern"
  - "Partial indexes on (created_at DESC) WHERE archived_at IS NULL for active-only query performance"
metrics:
  duration: "2m 20s"
  completed: "2026-03-15T17:45:06Z"
  tasks: 2/2
  tests: 171 pass, 0 fail
---

# Phase 7 Plan 01: Curation Foundation Summary

Curation migration adding archived_at/access_count/last_accessed_at/usefulness_score to all 5 tables with partial indexes, delete permission for admin/n8n only, and archived-row filtering in all existing read paths.

## Task Results

### Task 1: Create 002_curation.sql migration and update permission system
- **Commit:** `09432bf`
- **Status:** Complete
- **Files:** `src/db/migrations/002_curation.sql` (created), `src/types.ts`, `src/permissions.ts`
- **Details:**
  - Migration adds 4 columns to all 5 tables: archived_at, access_count, last_accessed_at, usefulness_score
  - Partial index `idx_{table}_active` on each table for active-only query performance
  - Sessions table gets missing `updated_at` column + update trigger (was absent from 001_init.sql)
  - Permission type extended: `"read" | "write" | "delete"`
  - New RWD permission set for admin and n8n roles
  - `canDelete()` function exported from permissions.ts
  - Agent, discord, readonly roles unchanged -- no delete access

### Task 2: Add archived_at filtering to search_brain, session_load, and find_person
- **Commit:** `a9adb61`
- **Status:** Complete
- **Files:** `src/tools/search-brain.ts`, `src/tools/session-load.ts`, `src/tools/find-person.ts`, `src/tools/__tests__/search-brain.test.ts`, `src/tools/__tests__/session-load.test.ts`
- **Details:**
  - search_brain: `AND ${alias}.archived_at IS NULL` added to every table CTE WHERE clause
  - session_load: `AND archived_at IS NULL` in project query, `WHERE archived_at IS NULL` in global query
  - find_person: `AND archived_at IS NULL` in both name (ILIKE) and semantic (embedding) search
  - New test: "archived filtering" describe block verifying SQL contains `archived_at IS NULL`
  - Updated session-load global test: assertion changed from "no WHERE" to "WHERE archived_at IS NULL without project filter"

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated session-load test assertion for global query**
- **Found during:** Task 2
- **Issue:** Existing test asserted `expect(sql).not.toContain("WHERE")` for global session load, which failed after adding `WHERE archived_at IS NULL`
- **Fix:** Changed assertion to `expect(sql).toContain("WHERE archived_at IS NULL")` and `expect(sql).not.toContain("project = $1")` to verify archived filtering without project filter
- **Files modified:** `src/tools/__tests__/session-load.test.ts`
- **Commit:** `a9adb61`

## Verification

```
bunx tsc --noEmit           -- PASS (clean compile)
bun test src/tools/ --bail  -- 61 tests pass
bun test --bail             -- 171 tests pass, 0 fail, 465 expect() calls
```

## Self-Check: PASSED

All 9 files verified present. Both commits (09432bf, a9adb61) found. All 6 key content patterns confirmed in target files.
