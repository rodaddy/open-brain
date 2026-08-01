"""Monitor - polls URLs on an interval and tracks whether each one is healthy.

The richest of the three example applications. It exercises async I/O with
bounded retry, a periodic scheduler with graceful shutdown, durable state across
restarts, and an HTTP surface -- the shape most network services actually have.

Architecture:
    Five modules, split by the question each one answers. The split is the
    lesson: each piece is testable alone, and none of them needs the others'
    dependencies to prove it works.

        checker.py    "what happened when I asked?"     -> CheckResult
        evaluator.py  "what does a run of those mean?"  -> HealthStatus
        store.py      "what did we know before?"        -> disk
        service.py    "do all of that, on a loop"       -> orchestration
        api.py        "show me"                         -> HTTP

    Observation is separated from judgement deliberately. A single failed
    request is not an unhealthy service, and the threshold logic that decides
    otherwise needs both kinds of value present to do its job. Collapsing them
    into "target with a status field" destroys that distinction and is the most
    common design mistake in this kind of tool.

    Only ``evaluator.py`` holds the health rules, and every function in it is
    pure -- no clock, no network, no filesystem. That is on purpose: it is the
    logic most likely to be wrong and most in need of exhaustive tests, so it is
    made the easiest thing in the app to test.

Key Components:
    - check: one target, one observation. Never raises for a failed check --
      an unreachable target is the expected case for a monitor, not an error.
    - evaluate: folds an observation into running health. Pure and total.
    - StatusStore: atomic writes, tolerant reads, quarantines corrupt files.
    - MonitorService: bounded concurrency, save-per-round, survives a bad round.
    - build_app: /health (this process) and /status (the targets), kept apart.

Pattern/Convention:
    Dependencies are injected, never fetched. ``MonitorService`` receives its
    settings section, its store, and its HTTP client; it reads no globals and
    imports no config. A test constructs it with a fake store and a mock
    transport and needs nothing else.

    To add a check type -- TCP, ICMP, a database ping -- add a function beside
    ``check`` and dispatch on a target field. Do not add branches inside
    ``check``; see the dict-dispatch rule in the standard.

Example:
    >>> # One round, no loop, no server -- how the tests drive it:
    >>> results = await service.run_once()          # doctest: +SKIP
    >>> [r.ok for r in results]
    [True, False]

    >>> # Or from a shell:
    >>> # uv run python -m exemplar.apps.monitor --env test --once

See Also:
    - exemplar.utils.http: the retry policy every check goes through
    - exemplar.models.check: Target, CheckResult, HealthStatus
    - _DOCS/STANDARDS-python.md ## Error handling
"""

from __future__ import annotations
