"""Timezone-aware datetime helpers. The only sanctioned way to get "now".

WHY THIS MODULE EXISTS AT ALL
    ``datetime.now()`` returns a NAIVE datetime -- one with no timezone attached.
    It looks correct, prints correctly, and works in every test written on the
    same machine that produced it. Then:

    - Comparing a naive datetime to an aware one raises ``TypeError``, at
      runtime, in whatever code path first mixes them. Usually that is the code
      comparing a freshly-created timestamp against one loaded from storage.
    - Serializing a naive datetime loses the offset permanently. Nothing later
      can recover which zone it meant, so a timestamp read back six months from
      now is a guess.
    - Two hosts in different zones write timestamps that are silently
      incomparable while looking identical in format.

    None of these fail at the point of the mistake. They fail later, somewhere
    else, which is what makes the naive call worth banning outright rather than
    reviewing case by case.

WHY IT IS ENFORCED AND NOT JUST DOCUMENTED
    ``datetime.now()`` is the obvious thing to type, it is what every tutorial
    shows, and it is what an LLM will produce unless told otherwise. Prose does
    not survive that. The pre-commit hook rejects ``datetime.now()`` without
    ``timezone.utc``, and ruff's DTZ rule family flags the same class of call --
    two independent mechanisms, because this one is reached for by reflex.

    Evidence it needs both: the reference repo documents this rule, ships a
    pre-commit hook written to block it, and still has naive calls in committed
    code at ``router/routers/threads.py:70`` and
    ``integrations/slack/poster_service.py:90`` -- because that repo's hooks are
    shadowed by a global ``core.hooksPath`` and never run. The rule was right;
    the mechanism was not running; the naive calls landed anyway.

WHY UTC AND NOT LOCAL
    Store and compute in UTC always. Convert to a local zone only at the point
    of display, never before. Local time is a presentation concern, and a stored
    local timestamp is ambiguous twice a year, for one hour, in a way that is
    undetectable after the fact.

Key Components:
    - utc_now: the replacement for datetime.now(). Use this everywhere.
    - ensure_aware: repair a naive datetime arriving from outside the app.
    - iso: canonical string form for storage and API responses.

Pattern/Convention:
    Never import ``datetime.now`` anywhere else in the codebase. Import
    ``utc_now`` from here. Data crossing an application boundary -- parsed JSON,
    a database row, a third-party client -- goes through ``ensure_aware`` before
    it is compared or stored.

Example:
    >>> from exemplar.utils.datetime_helpers import utc_now, iso
    >>> now = utc_now()
    >>> now.tzinfo is not None
    True
    >>> iso(now).endswith("+00:00")
    True

See Also:
    - _DOCS/STANDARDS-python.md ## Timezone-aware datetimes only
    - _githooks/pre-commit (the check that blocks the naive call)
"""

from __future__ import annotations

from datetime import UTC, datetime


def utc_now() -> datetime:
    """Return the current time as a timezone-aware UTC datetime.

    The single sanctioned replacement for ``datetime.now()``.

    Returns:
        Current UTC time, always with ``tzinfo`` set.

    Example:
        >>> stamp = utc_now()
        >>> stamp.tzinfo is not None
        True
    """
    # datetime.now(UTC), never datetime.utcnow(). utcnow() returns a naive
    # datetime holding UTC values -- the most dangerous variant, because it is
    # correct in value and wrong in type, so it passes review and fails on
    # comparison. It is deprecated in 3.12+ for exactly this reason.
    return datetime.now(UTC)


def ensure_aware(value: datetime) -> datetime:
    """Attach UTC to a naive datetime; return an aware one unchanged.

    For data arriving from outside the application, where the type system cannot
    guarantee what a parser produced. ``json.loads`` of an ISO string with no
    offset, an older database row, a third-party client -- all can hand back
    naive values.

    Assuming UTC for a naive input is a deliberate, documented choice, not a
    guess: everything this application writes is UTC, so a naive value that
    reached storage came from a code path that predates or bypassed
    ``utc_now``.

    Args:
        value: A datetime that may or may not carry timezone information.

    Returns:
        The same instant, guaranteed aware.

    Example:
        >>> from datetime import datetime
        >>> ensure_aware(datetime(2026, 1, 1)).tzinfo is not None
        True
    """
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value


def iso(value: datetime) -> str:
    """Serialize to ISO 8601 with an explicit offset.

    The canonical string form for storage and API responses. Always includes the
    offset, so the value round-trips without relying on a convention the reader
    has to know.

    Args:
        value: A datetime. Made aware first if it is not already, so this can
            never emit an offset-less string.

    Returns:
        ISO 8601 string, e.g. ``2026-07-30T15:04:05.123456+00:00``.
    """
    return ensure_aware(value).isoformat()
