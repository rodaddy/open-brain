"""Shared data models. Pydantic only, no behaviour.

WHAT BELONGS HERE
    Types used by more than one application, or types that cross an application
    boundary: something parsed from JSON, returned by an API, or written to
    disk. A type used by exactly one app and never serialized belongs next to
    that app, not here -- putting it here makes the floor a dumping ground and
    every app carries the cost of reading it.

WHY MODELS HOLD NO LOGIC
    These classes validate and describe shape. They do not fetch, write, retry,
    or schedule. A model that knows how to save itself has to know about
    storage, which means storage cannot be swapped in a test without also
    swapping the model, and the model's own validation tests start needing a
    filesystem.

    Validators are the exception, and they are not really logic: a validator
    rejects an impossible value, it does not perform work.

WHY PYDANTIC AND NOT @dataclass -- THE OPERATIONAL DIFFERENCE
    A dataclass is a struct with type *hints*. Nothing checks them at runtime,
    so ``CheckResult(status_code="200")`` builds happily and fails later, in
    arithmetic, hundreds of lines from the mistake.

    A Pydantic model validates and coerces at construction. The same call either
    coerces cleanly or raises naming the field. The value is not that errors
    exist -- it is that they happen at the boundary, where the fix is obvious.

    This matters most for data from outside: a webhook payload, a config file, a
    JSON state file written by an older version. Every one of those is untrusted
    input, and a model is the only place that assumption gets checked once
    rather than at each use.

Key Components:
    - Target: something to be checked. Shared by monitor and hook.
    - CheckResult: one observation of a Target at a point in time.
    - HealthStatus: rolled-up state across many CheckResults.
    - WatchJob / WatchManifest: the watch app's units of work and its output.
    - HookEvent: a validated inbound webhook payload.

Pattern/Convention:
    Import the model, construct it, let it raise. Never validate by hand before
    constructing -- that is duplicating the model's job in a place that will
    drift from it.

    Models are frozen where the value is an observation of a moment
    (``CheckResult``) and mutable where it is accumulated state
    (``HealthStatus``). Freezing an observation prevents the class of bug where
    a stored record is edited in place and the history silently rewrites itself.

Example:
    >>> from exemplar.models import Target
    >>> t = Target(name="docs", url="https://example.test/health")
    >>> t.name
    'docs'
    >>> Target(name="bad", url="not-a-url")        # doctest: +SKIP
    ValidationError: url -- Input should be a valid URL

See Also:
    - exemplar.config: settings models, which live there because they are
      configuration rather than domain data
    - _DOCS/STANDARDS-python.md ## LAW: Pydantic for every model
"""

from __future__ import annotations

from exemplar.models.check import CheckResult, HealthState, HealthStatus, Target
from exemplar.models.events import HookEvent, HookEventKind
from exemplar.models.watch import WatchJob, WatchManifest, WatchOutcome

# Explicit __all__: this is the package's public surface. Without it, every
# transitively imported name looks importable from here, and a later refactor
# that stops importing something becomes someone else's ImportError.
__all__ = [
    "CheckResult",
    "HealthState",
    "HealthStatus",
    "HookEvent",
    "HookEventKind",
    "Target",
    "WatchJob",
    "WatchManifest",
    "WatchOutcome",
]
