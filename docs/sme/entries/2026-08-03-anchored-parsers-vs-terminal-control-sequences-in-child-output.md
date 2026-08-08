---
lane: gotcha-agent
order: 27
---
## Anchored parsers vs. terminal control sequences in child output

**Provenance:** issue #537, PR `fix/537-local-test-env`. Severity: MEDIUM.
Status: active.

Two `scripts/` sanitization tests failed ONLY on the dev machine and passed in
every CI run. The divergence was a single environment variable: the dev shell
exports `FORCE_COLOR=3`, CI exports nothing. `runPgDump`/`runPgRestore` pass the
ambient environment to the child, so a `bun`-based fake tool inherited
`FORCE_COLOR` and colorized `console.error` *even though stderr was a pipe*.
The bytes on the pipe were `ESC[0mESC[31mpg_dump: error: query failed: ...`.

`summarizeChildStderr` stripped the tool/severity prefix with a `^`-anchored
regex. The leading escapes sat before `pg_dump`, so the anchor never matched,
no prefix was removed, and the cut-at-first-colon step returned
`ESC[0mESC[31mpg_dump` instead of `query failed`. Every downstream assertion
about the error CLASS silently degraded to an assertion about the tool name.

The test was the messenger, not the defect. A real `pg_dump` attached to a
terminal — or run under any wrapper that sets `FORCE_COLOR`/`CLICOLOR_FORCE` —
emits the same bytes, so production receipts had the same blind spot. Control
characters are also non-printable payload: an escape sequence surviving into a
receipt can reposition a cursor or recolor the terminal of whoever displays it.

### Review Questions

- **Does a parser anchored at `^` run against raw child output?** Any
  `^`-anchored strip, `startsWith`, or leading-token match applied to another
  process's stdout/stderr must normalize control sequences FIRST. Colorized
  output puts bytes in front of the token the anchor expects.
- **Does the test harness inherit the ambient environment?** A fake tool spawned
  with the parent's env inherits `FORCE_COLOR`, `NO_COLOR`, `TERM`, and locale —
  none of which CI sets. A test that passes in CI and fails locally (or the
  reverse) is an environment-dependence bug in the harness or the code, never
  "known noise" to be waived.
- **Is "it's green in CI" being used to dismiss a local failure?** CI is one
  environment, not the union of them. A green CI run is evidence the code works
  under CI's env, and says nothing about a developer machine or a production
  host with a TTY.
- **Would a control character be allowed to reach a receipt, log, or error
  message?** Treat C0/C1 bytes as untrusted payload in anything an operator will
  display, on the same footing as row content and secrets.
