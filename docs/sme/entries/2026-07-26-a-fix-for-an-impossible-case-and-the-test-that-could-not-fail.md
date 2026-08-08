---
lane: gotcha-agent
order: 21
---
## [2026-07-26] A "fix" for an impossible case, and the test that could not fail

**Provenance:** PR #424, SME lane. **Severity:** MEDIUM. **Status:** fixed.

Self-review "fixed" an unguarded `FILE_SINK?.write` by wrapping it in
`try/catch`, reasoning that a full disk must not take the log line down with it.
The reasoning was sound; the guard was redundant.

The SME lane applied this file's own instruction — *neuter the fix in place and
measure* — and found **0 tests failed** with the guard removed, across 151 tests
in every logger-touching suite. Two layers of why:

1. The whole suite runs with `LOG_FILE` unset, so `FILE_SINK` is `undefined` and
   `?.` short-circuits before reaching the guarded block.
2. Deeper: `createRotatingFileSink` documents *"Never throws on write"* and
   already wraps `appendFileSync` in its own `try/catch`. **The throw being
   guarded cannot occur.**

A guard for an impossible case is not free. It tells the next reader this sink
can throw, which is false, and it is untestable by construction — so it reads as
a coverage gap forever.

What replaced it: the guard was removed with the rationale recorded inline, and
a test was added for the behaviour *neither* version covered — an unwritable
`LOG_FILE` must still produce the line on console. It runs through a subprocess,
because `FILE_SINK` resolves once at module load and an in-process test can
never reach it.

### Review Questions

- For each fix in a PR: **revert it in place and run the tests.** If nothing
  fails, either the test is missing or the fix is unnecessary. Both are worth
  knowing, and they are distinguishable only by looking.
- Before guarding a call, check whether the callee already guarantees it does
  not throw. Read the callee's contract, do not infer it from the call site.
- Is the fixture even reachable? A module-level `const` resolved from env at
  import time (`FILE_SINK`, `HOST_NAME`, `SERVICE_NAME`) cannot be exercised by
  a suite that does not set that env — a subprocess is the honest way in.
- Does the suite's default env silently disable the code path under test?
