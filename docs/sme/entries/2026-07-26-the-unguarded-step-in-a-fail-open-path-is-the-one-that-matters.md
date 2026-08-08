---
lane: adversarial
order: 26
---
## [2026-07-26] The unguarded step in a fail-open path is the one that matters

**Provenance:** PR #424, adversarial + SME lanes independently. **Severity:** HIGH. **Status:** fixed.

`log()` in `src/logger.ts` guarded everything except one statement. `contextFields()`
caught a throwing reader, the file sink was guarded, every extra sink was
guarded — and `const output = JSON.stringify(entry)` sat between the entry
construction and all four destinations, unguarded.

`entry` is built from caller-supplied `extra` **and** from `withContext()`
fields, so a cycle, a `BigInt`, or a throwing `toJSON` in either was enough to
lose the line everywhere *and* throw into arbitrary application code.

The consequences ran well past logging, and each contradicted a documented
contract:

- `withLogging` documents "re-throws whatever fn throws, unchanged". It threw a
  serializer error instead, destroying the real root cause **on the failure
  path**.
- `withFallback` — the one function whose purpose is to never propagate — threw
  instead of returning its fallback.
- Worst: `withLogging` emits its entry line at `debug` *before* calling `fn`. At
  `info` that line is gated out and `fn` runs. At `debug` the same call threw and
  **`fn` was never invoked.** Raising the log level to investigate an incident
  silently stopped work from running — the exact scenario the runtime log-level
  setter exists for.

The repo already knew the hazard: `src/audit-log.ts` explicitly defends against
"a cycle, a BigInt anywhere". The module that *every* emitter routes through did
not.

### Review Questions

- In any path that deliberately catches everything, **list the statements that
  are not wrapped.** One unguarded step in an otherwise fail-open function is a
  stronger signal than an unguarded step anywhere else — the surrounding care
  proves the author intended it not to throw.
- Does a logging/telemetry wrapper emit a line *before* calling the wrapped
  function? Then a throw in the emit path is a **control-flow** bug, not a
  logging bug: the work never runs.
- Does the failure mode depend on the log level? A bug that only appears at
  `debug` surfaces exactly when someone is debugging.
- Does redaction cover the whole record, or one contributor? Redacting
  `error_message` while a caller field carries the identical credential on the
  same line is not redaction.
- Do observers (sinks, subscribers) receive the same redacted data the file and
  console get, or the raw object?

---
