---
phase: 02-core-tools
plan: 01
subsystem: api
tags: [mcp, tools, zod, pgvector, embedding, permissions]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: "McpServer, pool, permissions, embedding, types, transport"
provides:
  - "log_thought MCP tool -- writes to thoughts table with embedding + dedup"
  - "log_decision MCP tool -- writes to decisions table with permission enforcement"
  - "ToolDeps interface and registerAllTools orchestrator pattern"
  - "InMemoryTransport test pattern with auth injection"
affects: [02-core-tools, 03-resources]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Tool registration via registerTool() with Zod inputSchema and annotations"
    - "Dependency injection: ToolDeps { pool, embedFn } passed to registration functions"
    - "Auth propagation: extra.authInfo cast to AuthInfo with null guard"
    - "Graceful embedding degradation: NULL embedding on failure, embedded: false in response"
    - "Content dedup: contentHash + ON CONFLICT (content_hash) WHERE content_hash IS NOT NULL DO NOTHING"
    - "InMemoryTransport test pattern: monkey-patch clientTransport.send() to inject authInfo"

key-files:
  created:
    - src/tools/index.ts
    - src/tools/log-thought.ts
    - src/tools/log-decision.ts
    - src/tools/__tests__/log-thought.test.ts
    - src/tools/__tests__/log-decision.test.ts
    - src/tools/__tests__/protocol.test.ts
  modified:
    - src/index.ts

key-decisions:
  - "registerTool() over deprecated .tool() -- SDK v1.27+ API with title and annotations support"
  - "Embed title+newline+rationale for decisions -- better semantic match than title alone"
  - "toSql() from pgvector/pg for halfvec serialization -- handles format correctly"
  - "Combined TDD commit (test + impl) -- pre-commit type-check hook requires both to resolve imports"

patterns-established:
  - "Tool DI pattern: export registerXxx(server, deps) per tool, orchestrated by registerAllTools"
  - "Auth check pattern: const auth = extra.authInfo as AuthInfo | undefined; if (!auth || !canWrite(...))"
  - "Response format: { content: [{ type: 'text', text: JSON.stringify({id, embedded}) }] }"
  - "Protocol test setup: InMemoryTransport.createLinkedPair() with auth injection via send() patch"

requirements-completed: [TOOL-02, TOOL-03]

# Metrics
duration: 3min
completed: 2026-03-13
---

# Phase 2 Plan 01: Write Tools Summary

**log_thought and log_decision MCP tools with dependency injection, permission enforcement, embedding degradation, and content deduplication**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-13T20:38:57Z
- **Completed:** 2026-03-13T20:42:06Z
- **Tasks:** 1
- **Files modified:** 7

## Accomplishments
- log_thought tool: inserts to thoughts table with embedding, content_hash dedup, graceful degradation when embedding fails
- log_decision tool: inserts to decisions table with title+rationale embedding, permission enforcement (discord/readonly denied), alternatives as JSONB
- Tool orchestrator (registerAllTools) wires both tools into McpServer with shared ToolDeps
- src/index.ts wired: registerAllTools called between createBrainServer and createTransportHandlers
- 16 new tests (unit + protocol), all 108 project tests pass

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement log_thought, log_decision, and tool orchestrator (TDD)** - `58bb160` (feat)

_Note: TDD RED+GREEN combined in single commit due to pre-commit type-check hook requiring implementation for import resolution._

## Files Created/Modified
- `src/tools/index.ts` - ToolDeps interface and registerAllTools orchestrator
- `src/tools/log-thought.ts` - log_thought tool registration with embedding + dedup
- `src/tools/log-decision.ts` - log_decision tool registration with permission enforcement
- `src/tools/__tests__/log-thought.test.ts` - 5 unit tests for log_thought
- `src/tools/__tests__/log-decision.test.ts` - 7 unit tests for log_decision
- `src/tools/__tests__/protocol.test.ts` - 4 protocol tests via InMemoryTransport
- `src/index.ts` - Added registerAllTools wiring between createBrainServer and createTransportHandlers

## Decisions Made
- Used registerTool() over deprecated .tool() for SDK v1.27+ compatibility with title/annotations
- Embedded title+newline+rationale for decisions (better semantic search quality than title alone)
- Used toSql() from pgvector/pg for halfvec serialization instead of JSON.stringify
- Combined TDD commit because pre-commit type-check hook requires implementation files for import resolution

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Tool registration pattern established and ready for search_brain (Plan 02)
- ToolDeps interface extensible for additional tools
- InMemoryTransport test pattern documented and reusable
- All Phase 1 tests continue to pass (no regressions)

---
*Phase: 02-core-tools*
*Completed: 2026-03-13*

## Self-Check: PASSED

- All 6 created files: FOUND
- Commit 58bb160: FOUND
