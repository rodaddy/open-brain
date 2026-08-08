---
lane: gotcha-agent
order: 19
gap: 0
---
## PR #421 — a regression test with a drain window proves nothing

**Provenance:** PR #421 (openbrain-provider, PROV-2). Severity: HIGH (the test,
not the code). Status: fixed.

`enqueue=True` on a loguru sink means `logger.info()` returns before the bytes
reach disk. loguru's `atexit` hook drains the queue on a clean exit, so a naive
durability test passes. It does **not** run on a signal: measured with no drain
window, SIGTERM landed **133 of 200 records**, and the 67 lost were the newest
ones. For a hook process that is backwards — the records worth having are the
ones written just before something tore it down.

The gotcha is the first regression test written for it. The child wrote a
`ready` file and slept; the parent polled for that file, then sent SIGTERM. The
polling loop handed the writer thread ~10ms — enough to finish the queue — so
the test reported **200/200 with the fix reverted**. It would have been
committed as proof of a fix it never exercised. Rewritten so the child signals
*itself* immediately after the last record, it reports 133/200 without the fix
and 200/200 with it.

This is the same shape as the earlier finding in this PR where
`test_unwritable_log_file_is_not_fatal` asserted the process kept running but
never captured stdout, so a 436-byte leak onto the hook's response channel
survived every green run. **Both tests asserted the process was alive rather
than that the data arrived.**

Second issue found while verifying: `configure_observability` installs a real
SIGTERM/SIGINT handler on whatever process calls it — under pytest, that is the
pytest process. The autouse fixture removed sinks but not signal dispositions,
leaking this module's handler into later tests and into the path of a CI job
cancellation.

Also note `signal.default_int_handler` is a *callable*. A `if callable(previous)`
guard meant to detect "someone else already owns this signal" skips SIGINT
every single time, because the interpreter's own default satisfies it.

### Review Questions

- Does the regression test actually fail with the fix reverted? Neuter the fix
  in place (keep the symbol importable so the test runs) and measure. An
  `ImportError` red is not a red.
- Does a durability test give the async writer a drain window before killing the
  process? Any `sleep`, poll loop, or file-based handshake between the last
  write and the signal can hide the bug entirely.
- Does the test assert the *data arrived*, or only that the process survived /
  exited cleanly? The second is the recurring failure in this repo.
- Does a library function install a process-global signal handler? If so: does
  it refuse to stomp a caller's handler, does it treat
  `signal.default_int_handler` as unclaimed, does it re-raise so the process
  still dies, and does SIGINT keep `KeyboardInterrupt` semantics instead of
  becoming a hard kill?
- Do tests that call such a function restore signal dispositions afterward?
