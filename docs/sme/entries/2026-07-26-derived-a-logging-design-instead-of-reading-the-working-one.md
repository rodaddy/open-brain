---
lane: gotcha-agent
order: 23
---
## [2026-07-26] Derived a logging design instead of reading the working one

**Severity:** MEDIUM (process, not code). **Status:** fixed — canonical rules now
in `_DOCS/CODING_STANDARDS.md` `### Logging (non-negotiable)`.

I built `openbrain-provider`'s loguru setup from the observability contract plus
first principles: a `_usable_log_dir` probe-and-fallback chain, sink reset on
every `configure_observability` call, and a **process-global SIGTERM/SIGINT
handler installed from library code**.

Rico: *"can you not look at my other python project to see how the
config/logging/etc work rather than guessing. i've NEVER had an issue with
logging via loguru in any other project."*

The reference — `WorkStuff/b1x-message-coordinator/src/message_coordinator/utils/logging_config.py`
— answers every question I had been deriving, and answers two of them
differently:

| | what I derived | what the working project does |
|---|---|---|
| repeat setup | `logger.remove()` every call | module-level `_logging_initialized` flag |
| unwritable sink | probe dir, fallback chain | `try/except` around each `logger.add`, degrade |
| signals | installed inside the logging module | **only in each service's `__main__`** |
| stdout vs stderr | stderr (agreed) | stderr |

### The technical content worth keeping

The record loss I measured was real and reproduces in the plain reference style
with no project code: **clean exit 200/200, abrupt SIGTERM ~100/200**, newest
records lost. But that reconciles with "never had an issue" rather than
contradicting it, and the reconciliation is the actual rule:

- A **long-running daemon** exits through its own `signal_handler` → normal exit
  → loguru's `atexit` drains the queue. It can run for years and never lose a
  line.
- A **short-lived hook** gets killed mid-run. No graceful shutdown, no `atexit`,
  so it needs an explicit drain — but as an **entrypoint opt-in**, not something
  `configure_observability` does to its caller.

So the fix was warranted; I had built it in the wrong layer. A separate review
lane independently flagged the same library-installed handler as a reentrancy
hazard.

### Review Questions

- Does this repo (or a sibling under `Development/`) already solve this exact
  problem in production? **Search before deriving.** A working implementation
  answers questions a spec cannot — especially "which layer owns this."
- Does a library function install a process-global signal handler, `atexit` hook,
  or other process-wide state? That belongs in the entrypoint. If it must be
  offered, offer it as an opt-in the entrypoint calls.
- Is `enqueue=True` used in a **short-lived** process? Then the queue can outlive
  it. Long-running services are fine; hooks and CLIs are not.
- Does the durability test give the async writer a drain window? A ready-file
  plus parent poll hands it ~10 ms and reports a clean pass with the fix
  reverted. The child must signal *itself* immediately after the last record.
- Is `signal.default_int_handler` treated as "already claimed"? It is a
  *callable*, so a plain `if callable(previous)` guard skips SIGINT every time.
