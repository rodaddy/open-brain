"""The Claude Code hook entrypoints -- one module per event, and one that is real.

Purpose:
    Claude Code runs a command per lifecycle event and hands it the event as
    JSON on stdin. This package is that command's Python side: one module per
    VERIFIED event (the set the fixtures actually captured), each reading stdin
    and exiting. Exactly one of them, ``stop``, does real work today -- it is the
    production invoker of the capture spine.

Key Components:
    - stop: THE REAL ONE. On every ``Stop`` it delivers the turns written since
      the watermark to the raw lane, through ``openbrain_memory``. It can never
      block or break a session, so every failure is logged and swallowed and the
      process always exits 0 with empty stdout.
    - dispatch: a table from a verified event name to its module's entrypoint.
      Nothing else lives here -- no branching, no per-event logic.
    - session_start, user_prompt, session_end, pre_tool_use, post_tool_use,
      subagent_stop, pre_compact, post_compact: explicit stubs. Each parses stdin
      and exits 0, and its docstring names the open question -- what capability it
      should serve is NOT decided for the Python app
      (``_plans/rewrite-gotchas.md``).

Architecture:
    ONE MODULE PER EVENT, not one dispatcher holding a branch per event. The
    adapter being replaced was a 633-line file whose event branches shared a
    namespace, so a change for one event could reach the helpers of another. A
    module per file cannot do that. ``dispatch`` is only the name-to-callable
    table; it holds no event logic of its own.

    NO BUSINESS LOGIC IN AN ENTRYPOINT (``_plans/418-prov-9-hook-entrypoints.md``).
    An entrypoint parses stdin, calls one capability, and writes stdout. The
    capability that builds the client, starts the session, and runs the delivery
    lives beside them in ``session`` -- so the wiring is testable without a
    process, and ``stop`` stays a parse-and-exit shell.

Pattern/Convention:
    The verified event set comes from CAPTURED stdin
    (``tests/fixtures/captured_hooks/``), not from docs prose. A module is
    added here only when a real fixture proves the event fires and names its
    fields. ``PostCompact`` was the last event to be captured -- a real
    compaction was forced on 2026-07-31 and it fired, so it now has a module
    like every other verified event
    (``tests/fixtures/captured_hooks/README.md``).

    An entrypoint NEVER raises to its exit code on a capture failure. Empty
    stdout with exit 0 is Claude Code's "proceed normally", and a hook that
    crashes or prints is a hook that disrupts the session it was meant to
    observe.

Example:
    >>> from openbrain.apps.hooks.dispatch import ENTRYPOINTS
    >>> "Stop" in ENTRYPOINTS
    True

See Also:
    - ``_plans/418-prov-9-hook-entrypoints.md`` - scope and acceptance criteria
    - ``_plans/python-port-sequence.md`` - step 8, the layout
    - ``openbrain.apps.capture.deliver`` - the spine ``stop`` invokes
"""
