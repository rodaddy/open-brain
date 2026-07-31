"""Check one target once. The smallest testable unit of the monitor app.

WHY THIS IS ITS OWN MODULE
    Checking a target is one job: make a request, observe what happened, return
    an immutable record of it. It decides nothing about health, stores nothing,
    and schedules nothing -- those are the evaluator's, the store's, and the
    scheduler's jobs.

    That separation is what makes it testable without a network, a clock, or a
    filesystem. A checker that also updated health state would need all three to
    test the one thing it is actually for.

THE DESIGN RULE THIS FILE DEMONSTRATES
    **A failed request is not an exception here.** ``check()`` returns a
    ``CheckResult`` describing the failure rather than raising, because for a
    health monitor an unreachable target is the expected case, not an error. It
    is the observation the whole application exists to make.

    Raising would force every caller into a try/except whose except branch
    reconstructs the same result object -- and the first caller to forget it
    kills the scheduler on the first unreachable target.

    This is the counterpart to the rule in ``utils/http.py``: exceptions are for
    conditions the caller cannot have anticipated, not for outcomes that are
    part of the domain.

Key Components:
    - check: one target, one observation, never raises for a check failure.

Pattern/Convention:
    The caller owns the ``httpx.AsyncClient`` and passes it in, so connections
    are pooled across every target in a round.

Example:
    >>> result = await check(client, target, default_timeout=10.0)  # doctest: +SKIP
    >>> result.ok
    True

See Also:
    - exemplar.apps.monitor.evaluator: turns these observations into health
    - exemplar.utils.http: the retry policy applied to each attempt
"""

from __future__ import annotations

import time
from typing import TYPE_CHECKING

from loguru import logger

from exemplar.models import CheckResult
from exemplar.utils.http import RetryPolicy, TransportError, request_with_retry

if TYPE_CHECKING:
    import httpx

    from exemplar.models import Target

#: Cap on stored error text. The full text is logged; the truncated form goes
#: into the CheckResult, which is written to the state file and returned by the
#: API. An unbounded upstream error body would bloat both.
MAX_STORED_ERROR = 300


async def check(
    client: httpx.AsyncClient,
    target: Target,
    *,
    default_timeout: float,
    policy: RetryPolicy | None = None,
) -> CheckResult:
    """Check one target and return what was observed.

    Never raises for a check failure -- an unreachable target produces a
    ``CheckResult`` with ``error`` set. See the module docstring for why.

    Args:
        client: Caller-owned HTTP client, so connections are pooled.
        target: What to check.
        default_timeout: Per-request timeout, used when the target does not
            override it.
        policy: Retry configuration. Defaults to ``RetryPolicy()``.

    Returns:
        An observation. ``result.ok`` is True only if the request completed AND
        the status code was in ``target.expect_status``.

    Example:
        >>> result = await check(client, target, default_timeout=5.0)  # doctest: +SKIP
        >>> result.latency_ms is not None
        True
    """
    timeout = target.timeout_seconds or default_timeout

    # perf_counter, not time.time(): it is monotonic, so an NTP correction or a
    # DST change mid-request cannot produce a negative or wildly wrong latency.
    # This is the same class of bug as naive datetimes -- correct almost always,
    # and silently wrong exactly when you are trying to diagnose something.
    started = time.perf_counter()

    try:
        response = await request_with_retry(
            client,
            "GET",
            str(target.url),
            policy=policy,
            label="CHECK",
            request_timeout=timeout,
        )
    except TransportError as exc:
        # Every attempt failed at the transport level: the target is
        # unreachable. A normal, expected observation for a health monitor.
        elapsed_ms = (time.perf_counter() - started) * 1000
        logger.warning(
            f"CHECK: unreachable target={target.name} url={target.url} "
            f"after={elapsed_ms:.0f}ms error={type(exc.last_error).__name__}"
        )
        return CheckResult(
            target_name=target.name,
            status_code=None,
            latency_ms=None,  # no meaningful latency for a request that never completed
            error=str(exc)[:MAX_STORED_ERROR],
        )

    elapsed_ms = (time.perf_counter() - started) * 1000
    expected = response.status_code in target.expect_status

    if expected:
        logger.info(
            f"CHECK: ok target={target.name} status={response.status_code} "
            f"latency={elapsed_ms:.0f}ms"
        )
        return CheckResult(
            target_name=target.name,
            status_code=response.status_code,
            latency_ms=elapsed_ms,
        )

    # The service answered, but not acceptably. Distinct from unreachable:
    # status_code is set AND error is set, so `ok` is False while the response
    # detail is preserved for diagnosis.
    logger.warning(
        f"CHECK: unexpected status target={target.name} "
        f"status={response.status_code} expected={sorted(target.expect_status)} "
        f"latency={elapsed_ms:.0f}ms"
    )
    return CheckResult(
        target_name=target.name,
        status_code=response.status_code,
        latency_ms=elapsed_ms,
        error=(
            f"unexpected status {response.status_code}, "
            f"expected one of {sorted(target.expect_status)}"
        )[:MAX_STORED_ERROR],
    )
