---
phase: 01-foundation
plan: 03
subsystem: api
tags: [mcp, express, cors, health-check, streamable-http, bearer-auth]

# Dependency graph
requires:
  - phase: 01-foundation-01
    provides: "Database pool, migration runner, types"
  - phase: 01-foundation-02
    provides: "Auth middleware, token map, embedding client, permissions"
provides:
  - "MCP server factory (createBrainServer)"
  - "StreamableHTTPServerTransport session dispatch (createTransportHandlers)"
  - "Express application with health + auth-gated MCP routes (createApp)"
  - "Testable app factory with dependency injection"
affects: [phase-2-tools, phase-3-search]

# Tech tracking
tech-stack:
  added: []
  patterns: [mcp-session-map, transport-dispatch, dependency-injected-app-factory]

key-files:
  created:
    - src/server.ts
    - src/transport.ts
    - src/index.ts
    - src/server.test.ts
  modified: []

key-decisions:
  - "createApp takes pool and tokenMap as injected dependencies for testability"
  - "Transport map keyed by session ID with onsessioninitialized/onclose lifecycle hooks"
  - "Health endpoint checks both database connectivity and LiteLLM /health with 3s timeout"

patterns-established:
  - "App factory pattern: createApp(pool, tokenMap) returns Express app without listen()"
  - "Transport session lifecycle: onsessioninitialized stores, onclose removes from map"
  - "MCP routes auth-gated, health endpoint public"

requirements-completed: [SRV-01]

# Metrics
duration: 3min
completed: 2026-03-13
---

# Phase 1 Plan 3: MCP Server & Express App Summary

**Express app with MCP StreamableHTTPServerTransport session dispatch, health endpoint, and auth-gated /mcp routes**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-13T20:03:18Z
- **Completed:** 2026-03-13T20:07:02Z
- **Tasks:** 2
- **Files created:** 4

## Accomplishments
- MCP server factory wrapping @modelcontextprotocol/sdk McpServer
- StreamableHTTPServerTransport session management with POST/GET/DELETE handlers
- Express app with CORS, JSON parsing, public /health, auth-gated /mcp
- 6 HTTP-level integration tests covering health, auth rejection, and MCP initialization

## Task Commits

Each task was committed atomically:

1. **Task 1: MCP server, transport dispatch, and Express app** - `256be1b` (feat)
2. **Task 2: HTTP-level tests** - `318cee1` (test)

## Files Created/Modified
- `src/server.ts` - McpServer factory (createBrainServer)
- `src/transport.ts` - Session transport map and POST/GET/DELETE dispatch handlers
- `src/index.ts` - Express app factory (createApp) with health + MCP routes, startup entry point
- `src/server.test.ts` - 6 HTTP-level integration tests

## Decisions Made
- createApp takes injected pool and tokenMap for testability -- no real database needed in tests
- Transport map keyed by session ID, lifecycle managed via onsessioninitialized/onclose constructor options
- Health endpoint checks both database (pool.query SELECT 1) and LiteLLM (/health with 3s AbortSignal.timeout)
- Fetch mock in tests distinguishes localhost (pass-through) from LiteLLM URLs (intercepted)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed fetch mock intercepting test's own health requests**
- **Found during:** Task 2 (HTTP-level tests)
- **Issue:** Mock matching any URL with "/health" also intercepted the test's fetch to localhost Express server, returning empty JSON instead of the real health response
- **Fix:** Added `!url.includes("127.0.0.1")` guard to only mock non-localhost /health URLs
- **Files modified:** src/server.test.ts
- **Verification:** All 6 tests pass, health endpoint returns correct shape
- **Committed in:** 318cee1 (Task 2 commit)

**2. [Rule 1 - Bug] Fixed TypeScript strict mode errors on res.json() return type**
- **Found during:** Task 2 (HTTP-level tests)
- **Issue:** `res.json()` returns `unknown` in strict mode, accessing properties caused TS18046 errors
- **Fix:** Cast `await res.json()` to `HealthStatus` type
- **Files modified:** src/server.test.ts
- **Verification:** `bunx tsc --noEmit` passes with zero errors
- **Committed in:** 318cee1 (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (2 bugs)
**Impact on plan:** Both fixes necessary for test correctness and type safety. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Full Express application with MCP transport ready for tool registration in Phase 2
- Health monitoring endpoint operational for infrastructure checks
- All 92 project tests passing (across 5 test files)

## Self-Check: PASSED

- [x] src/server.ts exists
- [x] src/transport.ts exists
- [x] src/index.ts exists
- [x] src/server.test.ts exists
- [x] Commit 256be1b found (Task 1)
- [x] Commit 318cee1 found (Task 2)
- [x] TypeScript compiles with zero errors
- [x] All 92 tests pass across 5 files

---
*Phase: 01-foundation*
*Completed: 2026-03-13*
