---
phase: 04-operational-hardening
plan: 03
subsystem: infra
tags: [github-actions, ci, systemd, pgvector, bun]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: "package.json scripts (test, typecheck), tsconfig.json"
  - phase: 02-core-tools
    provides: "Tools and embedding infrastructure tested by CI"
provides:
  - "GitHub Actions CI pipeline with typecheck + tests on every push"
  - ".env.example documenting all required environment variables"
  - "systemd unit template for deployment"
affects: [deployment, onboarding]

# Tech tracking
tech-stack:
  added: [github-actions, pgvector/pgvector:pg16 service container]
  patterns: [CI-on-push for wip/feat/fix branches, PR gating on main]

key-files:
  created:
    - .github/workflows/ci.yml
    - deploy/open-brain.service
    - scripts/backfill.ts
  modified:
    - .env.example
    - src/middleware/request-logger.test.ts

key-decisions:
  - "pgvector/pgvector:pg16 image matches production Postgres 16"
  - "Bun pinned to 1.3.9 matching local dev environment"
  - "Safe placeholder values in .env.example -- no real IPs or tokens"

patterns-established:
  - "CI gating: typecheck + test on every push to wip/feat/fix, PR to main"
  - "Environment documentation: .env.example as source of truth for required vars"

requirements-completed: [SC-2, SC-4]

# Metrics
duration: 3min
completed: 2026-03-13
---

# Phase 4 Plan 3: CI Pipeline, Env Docs, and Deployment Template Summary

**GitHub Actions CI with pgvector:pg16 service container, .env.example with safe placeholders, and systemd unit template for deployment**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-13T21:48:10Z
- **Completed:** 2026-03-13T21:51:24Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- CI pipeline triggers on wip/feat/fix pushes and main PRs, running typecheck and tests with pgvector:pg16
- .env.example documents all 13 required environment variables with safe placeholder values (no real IPs or secrets)
- systemd unit template ready for deployment with EnvironmentFile, Restart=on-failure, and correct ExecStart

## Task Commits

Each task was committed atomically:

1. **Task 1: GitHub Actions CI pipeline** - `4e83ab4` (feat)
2. **Task 2: Environment documentation and deployment template** - `cf2a48a` (feat)

## Files Created/Modified
- `.github/workflows/ci.yml` - CI pipeline with Bun 1.3.9 + pgvector:pg16 service container
- `.env.example` - All required env vars with safe placeholder values (replaced real IPs)
- `deploy/open-brain.service` - systemd unit template for production deployment
- `scripts/backfill.ts` - Embedding backfill script (was missing, referenced by existing test)
- `src/middleware/request-logger.test.ts` - Fixed type assertions for noUncheckedIndexedAccess

## Decisions Made
- pgvector/pgvector:pg16 image matches production Postgres 16 on deployment target
- Bun pinned to 1.3.9 matching local dev environment for reproducibility
- Used clearly fake placeholder values in .env.example to avoid ggshield false positives
- systemd unit runs as root with /opt/open-brain working directory (matches deploy-service convention)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Replaced real IPs in existing .env.example**
- **Found during:** Task 2 (Environment documentation)
- **Issue:** Pre-existing .env.example contained real infrastructure IPs (10.71.20.49, 10.71.20.53)
- **Fix:** Replaced with generic placeholders (your-postgres-host, your-litellm-host)
- **Files modified:** .env.example
- **Verification:** grep for 10.71.* returns zero matches
- **Committed in:** cf2a48a (Task 2 commit)

**2. [Rule 3 - Blocking] Created missing scripts/backfill.ts**
- **Found during:** Task 2 (pre-commit hook blocked commit)
- **Issue:** backfill.test.ts imports ./backfill.ts which did not exist, causing tsc to fail and pre-commit hook to block
- **Fix:** Created backfill.ts implementing the backfill function matching the test expectations (5-table embedding backfill)
- **Files modified:** scripts/backfill.ts
- **Verification:** tsc --noEmit passes, all 170 tests pass including 11 backfill tests
- **Committed in:** cf2a48a (Task 2 commit)

**3. [Rule 3 - Blocking] Fixed request-logger.test.ts type assertions**
- **Found during:** Task 2 (pre-commit hook blocked commit)
- **Issue:** noUncheckedIndexedAccess made mock.calls[0] return `T | undefined`, causing TS2352 on 6 type assertions
- **Fix:** Extracted lastInfoCall() helper with runtime null check, replaced all 6 inline casts
- **Files modified:** src/middleware/request-logger.test.ts
- **Verification:** tsc --noEmit passes, all 7 request-logger tests pass
- **Committed in:** cf2a48a (Task 2 commit)

---

**Total deviations:** 3 auto-fixed (1 missing critical, 2 blocking)
**Impact on plan:** All auto-fixes necessary for security (real IPs) and ability to commit (pre-commit hook). No scope creep.

## Issues Encountered
None beyond the auto-fixed deviations documented above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- CI pipeline will validate all future pushes automatically
- .env.example available for onboarding new deployments
- systemd unit template ready for /deploy-service skill usage
- All 170 tests passing, typecheck clean

## Self-Check: PASSED

- All 5 files verified present on disk
- Commits 4e83ab4 and cf2a48a verified in git log
- 170 tests passing, typecheck clean

---
*Phase: 04-operational-hardening*
*Completed: 2026-03-13*
