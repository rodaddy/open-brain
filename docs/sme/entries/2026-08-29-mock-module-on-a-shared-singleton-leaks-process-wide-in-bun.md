---
lane: gotcha-agent
order: 103
---
## [2026-08-29] mock.module on a shared singleton leaks process-wide in bun

**Severity:** MEDIUM
**Source:** #924
**Scope:** any `*.test.ts` that calls `mock.module` on a module other test files import (`src/logger.ts`, config readers, sinks)
**Status:** active

### Pattern

bun keys the mock by resolved specifier for the whole process, and
`mock.restore()` does not undo it, so a later file gets the stub and fails on a
missing export or a silent sink. `scripts/__tests__/bulk-import.test.ts:17`
replaces `src/logger.ts`, and `server/observability/langfuse-tracing.test.ts`
then fails to load or never reaches `console.warn` (`src/logger.ts:539`).

### Check

- Run `rg -n 'mock\.module' --glob '*.test.ts'` on the touched files.
- Any hit on a shared module is replaced by `addLogSink` or a parameter
  injection, as `src/observability/observability.test.ts:19-25` documents.
