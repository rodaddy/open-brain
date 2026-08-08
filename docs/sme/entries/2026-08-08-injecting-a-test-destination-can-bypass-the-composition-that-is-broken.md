---
lane: gotcha-agent
order: 41
---
## [2026-08-08] Injecting a test destination can bypass the very composition that is broken

**Severity:** HIGH
**Source:** issue #612, PR #609 self-review (residual risk that became this issue)
**Scope key:** `sme.injected_destination_bypasses_broken_composition`
**Status:** active

### Pattern

A seam that exists so tests can inject a fake — `createLogger(config, destination)`,
`createClient(config, transport)`, any `fn(config, dep = realDefault())` — splits
the code into a tested path and a shipped path. When the defect lives in
`realDefault()`, every test passes and production is broken, and the test suite
reports confidence it never earned.

Measured instance: `server/logging/logger.ts` composed its destination with a
MULTI-TARGET `pino.transport` (stdout + `pino-roll`). `loggerOptions` set
`formatters.level` to emit the level as the string `"info"` rather than pino's
numeric `30`, as the shared envelope requires. Multi-target transports route on
that serialized value — `pino-abstract-transport` sets
`stream.lastLevel = value.level` unmapped, and `pino/lib/multistream.js` selects
with `dest.level <= level` — so every line evaluated `30 <= "info"`, false for
every destination, and was written nowhere. No error, no warning, no
dropped-line counter.

Every test in `server/logging/logging.test.ts` passed, because all five called
`createLogger(CONFIG, stream)` with an in-memory `Writable`. A SINGLE
destination returns its stream directly with no level routing
(`pino/lib/worker.js:126`), so the injected path never executed the broken
composition. The service logged into a void for the entire life of the server
path while its logging tests were green.

It surfaced only as an incidental observation — "no `component` line reaches the
clone logs" in a PR self-review — and read as a child-logger quirk, because the
3,465 lines that DID land came from the unrelated legacy `src/logger.ts` module
logger writing `LOG_FILE` itself. The surviving lines disguised total loss as
partial loss.

Checks for the next swarm:

- For any `fn(config, dep = buildRealDep())` signature, ask which tests exercise
  the DEFAULT. If every caller in the test file passes an explicit `dep`, the
  default is untested code shipping to production — flag it regardless of the
  suite's pass count or coverage number.
- Coverage does not catch this: `logger.ts` reported 100% line and function
  coverage while emitting nothing, because `createLogTransport` was *called* and
  its return value merely discarded everything downstream.
- At least one test per output boundary must use the production composition and
  observe the real destination — read the file back off disk, not a spy.
- Treat "logs are missing" as a routing question before a formatting one, and
  confirm which logger emits a surviving line before concluding a subset is
  dropped. Two logging systems in one process (`src/logger.ts` and
  `server/logging/`) make partial-looking evidence normal.
- A library option that is legal in one composition and fatal in another
  (`formatters.level` here) deserves a comment at the composition site saying
  so. It was reintroduced-safe only because the constraint is now written down.
