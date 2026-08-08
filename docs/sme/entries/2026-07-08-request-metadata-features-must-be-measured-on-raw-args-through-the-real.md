---
lane: gotcha-agent
order: 8
---
## [2026-07-08] Request-metadata features must be measured on raw args through the real dispatch path

**Severity:** BLOCKER
**Source:** PR #275 pre-merge gauntlet for Issue #269
**Scope:** `src/audit-log.ts`, `src/tools/__tests__/mcp-audit-log.test.ts`, any
feature that records request metadata (unknown keys, payload size, declared
parameters) from tool arguments
**Status:** fixed in PR #275

### Pattern

The audit wrapper initially measured arguments after Zod parsing had already
stripped unknown keys, so `unknown_parameter_count` was provably 0 through the
real dispatch path. The tests were green anyway: a unit test "proved" the
counting helper against raw args it constructed itself, and the integration
test certified 0 as the correct answer. Green tests over a runtime shape the
SDK never produces.

### Review Questions

- Is the metadata measurement taken from the raw client-sent arguments, before
  any schema parse/strip layer runs?
- Is the feature tested through the real client dispatch path (in-process MCP
  client -> server), not only via a helper called on hand-built raw args?
- Does at least one test send an argument the schema does not declare and
  assert a nonzero unknown count -- an assertion that would fail if the
  raw-vs-parsed layer is wrong?
- Would the integration test still pass if the measurement point silently moved
  behind the parser? If yes, the test certifies the bug.
