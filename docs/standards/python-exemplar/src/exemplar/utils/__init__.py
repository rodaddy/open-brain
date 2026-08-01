"""The shared floor: helpers every app is expected to use rather than reinvent.

A module earns a place here when the alternative is each app writing its own
slightly different version -- which is how a codebase ends up with four retry
implementations that back off differently and one that does not jitter at all.

Contents:
    - ``datetime_helpers``: aware UTC time. The only sanctioned replacement for
      ``datetime.now()``, which the pre-commit hook blocks outright.
    - ``http``: an httpx wrapper with retry and backoff supplied by ``tenacity``.
      The hand-rolled version it replaced was ~90 lines of attempt counters and
      jitter arithmetic -- a solved problem, solved worse.
    - ``logging_config``: three sinks (console, file, structured), configured in
      one place so every app logs the same way.

Nothing here imports from ``exemplar.apps``. The dependency runs one way: apps
build on utils, never the reverse. A util that knows about an app is no longer
shared, it is that app's code living in the wrong directory.

See Also:
    - _DOCS/STANDARDS-python.md ## LAW: do not hand-roll a solved problem
"""
