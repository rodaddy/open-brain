---
phase: 02-core-tools
plan: 02
subsystem: api
tags: [mcp, pgvector, semantic-search, cosine-distance, cte, zod]

# Dependency graph
requires:
  - phase: 02-core-tools/01
    provides: ToolDeps interface, registerAllTools orchestrator, registerTool pattern
  - phase: 01-foundation
    provides: permissions (canRead), embedding (generateEmbedding), types (AuthInfo, Table, Role)
provides:
  - search_brain MCP tool for cross-table semantic search
  - registerSearchBrain function following ToolDeps dependency injection pattern
  - Dynamic CTE SQL builder with permission-based table filtering
affects: [03-integration, 04-quality, 05-deploy]

# Tech tracking
tech-stack:
  added: []
  patterns: [dynamic-cte-sql-builder, permission-filtered-query-construction, read-only-tool-annotations]

key-files:
  created:
    - src/tools/search-brain.ts
    - src/tools/__tests__/search-brain.test.ts
  modified:
    - src/tools/index.ts
    - src/tools/__tests__/protocol.test.ts

key-decisions:
  - "Dynamic SQL construction over parameterized table filter -- permissions enforced at query build time, not database level"
  - "Per-CTE ORDER BY + LIMIT for HNSW index efficiency before UNION ALL merge"
  - "readOnlyHint: true and idempotentHint: true annotations for search tool (unlike write tools)"

patterns-established:
  - "Dynamic CTE builder: buildTableCTE() generates per-table CTE blocks from config maps"
  - "Permission-at-construction: accessible tables filtered before SQL generation, preventing data leakage"

requirements-completed: [TOOL-01]

# Metrics
duration: 3min
completed: 2026-03-13
---

# Phase 2 Plan 2: search_brain Tool Summary

**Cross-table semantic search via CTE UNION ALL with cosine distance ranking, permission-filtered by caller role using dynamic SQL construction**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-03-13T20:45:21Z
- **Completed:** 2026-03-13T20:47:53Z
- **Tasks:** 1
- **Files modified:** 4

## Accomplishments
- search_brain tool searches across all 5 brain tables (thoughts, decisions, relationships, projects, sessions) with a single query
- Permission filtering at SQL construction time prevents data leakage -- discord role gets zero results, all other roles see only their readable tables
- Optional table filter narrows search to a single table with permission check
- Embedding failure returns isError since search requires a query vector (unlike writes which degrade gracefully)
- 15 new tests (12 unit + 3 protocol) with 100% coverage on search-brain.ts

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement search_brain tool with cross-table CTE search** - `b5d5954` (feat)

## Files Created/Modified
- `src/tools/search-brain.ts` - search_brain tool with dynamic CTE builder, permission filtering, cosine distance ranking
- `src/tools/__tests__/search-brain.test.ts` - 12 unit tests covering all roles, table filter, embedding failure, empty results, limit defaults
- `src/tools/__tests__/protocol.test.ts` - 3 protocol tests added for search_brain (admin results, empty query validation, discord permission denied)
- `src/tools/index.ts` - Added registerSearchBrain import and call in registerAllTools

## Decisions Made
- Dynamic SQL construction over parameterized `$3 IS NULL OR $3 = 'tablename'` filter -- permissions are enforced at query build time, not database level, which prevents any possibility of data leakage to unauthorized roles
- Per-CTE `ORDER BY distance LIMIT $2` before UNION ALL for HNSW iterative index scan efficiency, with outer `ORDER BY distance LIMIT $2` for final merge ranking
- Tool annotated with `readOnlyHint: true` and `idempotentHint: true` (unlike write tools) to correctly signal search semantics to MCP clients
- Plan stated agent role cannot read relationships/projects, but permissions.ts gives agent RO access to both -- followed the source code (permissions.ts) as the source of truth

## Deviations from Plan

None - plan executed exactly as written. One note: the plan's behavior description incorrectly stated agent role cannot read relationships or projects, but the actual permissions matrix (permissions.ts) grants agent RO access to both tables. Tests follow the source code, not the plan's incorrect description.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All three core tools (log_thought, log_decision, search_brain) are registered and callable via MCP protocol
- Full test suite passes (123 tests across 9 files)
- TypeScript compiles cleanly
- Ready for Phase 3: Integration (end-to-end wiring, if applicable)

## Self-Check: PASSED

All files verified present, all commits verified in git log.

---
*Phase: 02-core-tools*
*Completed: 2026-03-13*
