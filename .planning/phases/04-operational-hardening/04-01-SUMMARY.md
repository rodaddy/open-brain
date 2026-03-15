---
phase: 04-operational-hardening
plan: 01
subsystem: logging
tags: [express-middleware, structured-logging, request-logging, observability]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: Express app with logger utility and auth middleware
  - phase: 02-core-tools
    provides: Write tool handlers (log_thought, log_decision)
  - phase: 03-secondary-tools
    provides: session_save tool handler
provides:
  - Structured JSON request logging middleware for all HTTP routes
  - Tool-level embedding outcome logging in all write handlers
affects: [04-operational-hardening, monitoring, debugging]

# Tech tracking
tech-stack:
  added: []
  patterns: [request-logger-middleware, tool-embedding-observability]

key-files:
  created:
    - src/middleware/request-logger.ts
    - src/middleware/request-logger.test.ts
  modified:
    - src/index.ts
    - src/tools/log-thought.ts
    - src/tools/log-decision.ts
    - src/tools/session-save.ts

key-decisions:
  - "Log only 5 fields (method, path, status, durationMs, consumerId) -- security-first, no body/headers"
  - "Use process.hrtime.bigint() with Math.round for clean integer millisecond durations"
  - "Place requestLogger after express.json() but before all routes for universal coverage"

patterns-established:
  - "Request logging middleware: res.on('finish') pattern for post-response logging"
  - "Tool embedding observability: logger.info('tool_embedding', { tool, embedded }) after every embedFn call"

requirements-completed: [SC-3]

# Metrics
duration: 3min
completed: 2026-03-13
---

# Phase 4 Plan 1: Request Logging Summary

**Structured JSON request logging middleware with security-safe field selection and tool-level embedding outcome observability**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-13T21:48:01Z
- **Completed:** 2026-03-13T21:51:00Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- Request logger middleware captures method, path, status, durationMs, consumerId on every HTTP request
- Security enforced: request bodies and authorization tokens are never logged
- All three write tools (log_thought, log_decision, session_save) now log embedding success/failure
- 7 TDD behavior tests with 100% coverage on the middleware

## Task Commits

Each task was committed atomically:

1. **Task 1: Request logger middleware with tests** - `b7effd1` (feat)
2. **Task 2: Wire request logger and add tool-level embedding logging** - `3f36bc5` (feat)

_Note: Task 1 was TDD -- RED+GREEN combined since implementation was minimal._

## Files Created/Modified
- `src/middleware/request-logger.ts` - Express middleware logging structured request metadata on res finish
- `src/middleware/request-logger.test.ts` - 7 behavior tests covering security, consumerId, duration format
- `src/index.ts` - Wired requestLogger middleware after express.json(), before all routes
- `src/tools/log-thought.ts` - Added logger import and tool_embedding info log
- `src/tools/log-decision.ts` - Added logger import and tool_embedding info log
- `src/tools/session-save.ts` - Added logger import and tool_embedding info log

## Decisions Made
- Log only 5 fields (method, path, status, durationMs, consumerId) -- security-first approach, no body or headers ever logged
- Use process.hrtime.bigint() with Math.round() for clean integer millisecond durations (not floats or BigInt)
- Place requestLogger after express.json() but before all routes (including /health) for universal coverage
- Anonymous consumerId for unauthenticated routes rather than null/undefined

## Deviations from Plan

None -- plan executed exactly as written.

## Issues Encountered
- Pre-existing test failures in `src/embedding.test.ts` (mock leaking between tests) and `src/db/migrations/001_init.test.ts` (requires live DB) -- not related to this plan's changes, out of scope
- Pre-existing typecheck error in `scripts/backfill.test.ts` (missing module) -- out of scope

## User Setup Required

None -- no external service configuration required.

## Next Phase Readiness
- Structured request logging is live for all routes
- Embedding outcome logging covers all write tools
- Ready for Phase 4 Plan 2 (health endpoint hardening or further operational work)

---
*Phase: 04-operational-hardening*
*Completed: 2026-03-13*
