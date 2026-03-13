# Deferred Items - Phase 04

## Pre-existing Typecheck Errors (Out of Scope)

Found during 04-03 verification. These exist prior to this plan's changes:

1. `scripts/backfill.test.ts:36` - Cannot find module './backfill.ts'
2. `src/middleware/request-logger.test.ts` - Multiple TS2352 type assertion errors (lines 65, 82, 94, 106, 122, 137)

These are test file type issues not introduced by 04-03 (config/docs only plan).
