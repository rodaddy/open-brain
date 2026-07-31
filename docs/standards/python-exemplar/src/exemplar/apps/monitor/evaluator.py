"""Turn observations into a health judgement. Pure functions, no I/O.

WHY THIS IS SEPARATE FROM THE CHECKER
    The checker observes; this decides what a series of observations means. One
    failed request is not an unhealthy service -- a network blip, a deploy, a
    momentary GC pause all produce a single failure that resolves immediately.
    Paging on the first one is how alerting gets muted.

    Keeping the judgement here means the threshold rule lives in one place,
    written once, and can be tested by feeding it observations without any
    network at all. Every function in this module is pure: same inputs, same
    outputs, no clock, no filesystem, no HTTP.

    That purity is the point. This is the logic most likely to be wrong, most
    likely to change, and most in need of exhaustive testing -- so it is
    deliberately the easiest thing in the app to test.

THE STATE MACHINE
    Four states, and the transitions between them are asymmetric on purpose::

        UNKNOWN ---first observation--> HEALTHY or DEGRADED
        HEALTHY ---failure-----------> DEGRADED       (immediately)
        DEGRADED --N more failures----> UNHEALTHY      (N = failure_threshold)
        DEGRADED --one success-------> HEALTHY        (immediately)
        UNHEALTHY -one success-------> HEALTHY        (immediately)

    **Failing is slow, recovering is fast.** A service must fail
    ``failure_threshold`` consecutive times to be declared UNHEALTHY, but one
    success restores it. That asymmetry is deliberate: a false UNHEALTHY wakes
    someone at 3am, while a slightly-early recovery costs nothing. Symmetric
    thresholds would flap in both directions.

    DEGRADED exists so a single failure is visible without being an alert. It is
    the state that says "something happened, watch it" -- which is exactly the
    signal that gets lost when a system has only healthy and unhealthy.

Key Components:
    - evaluate: fold one observation into the running status. Pure.
    - initial_status: the starting state for a target never yet checked.

Pattern/Convention:
    ``evaluate`` returns a NEW status rather than mutating the one passed in,
    even though ``HealthStatus`` is not frozen. A pure function that quietly
    mutates its argument is the worst of both -- it looks safe to call twice and
    is not.

Example:
    >>> from exemplar.models import CheckResult, HealthState
    >>> status = initial_status("api")
    >>> status.state
    <HealthState.UNKNOWN: 'unknown'>
    >>> ok = CheckResult(target_name="api", status_code=200, latency_ms=10.0)
    >>> evaluate(status, ok, failure_threshold=2).state
    <HealthState.HEALTHY: 'healthy'>

See Also:
    - exemplar.models.check: the three types this operates on
    - exemplar.apps.monitor.checker: produces the observations
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from exemplar.models import HealthState, HealthStatus

if TYPE_CHECKING:
    from exemplar.models import CheckResult


def initial_status(target_name: str) -> HealthStatus:
    """Return the starting status for a target that has never been checked.

    UNKNOWN rather than HEALTHY. A target nothing has ever reached is not
    healthy, and defaulting to healthy is how a dashboard shows green for a
    service that has never once responded -- the failure mode where the
    monitoring is broken and the monitoring cannot tell you.

    Args:
        target_name: Name of the target.

    Returns:
        A status in the UNKNOWN state with zeroed counters.
    """
    return HealthStatus(target_name=target_name, state=HealthState.UNKNOWN)


def evaluate(
    current: HealthStatus,
    result: CheckResult,
    *,
    failure_threshold: int,
) -> HealthStatus:
    """Fold one observation into the running status and return the new one.

    Pure: does not mutate ``current``, does not touch a clock, does no I/O.
    Everything it needs is in its arguments, which is what makes the state
    machine exhaustively testable.

    Args:
        current: Status before this observation.
        result: What was just observed.
        failure_threshold: Consecutive failures required to declare UNHEALTHY.

    Returns:
        A new status reflecting the observation.

    Example:
        >>> from exemplar.models import CheckResult
        >>> s = initial_status("api")
        >>> bad = CheckResult(target_name="api", error="refused")
        >>> s = evaluate(s, bad, failure_threshold=2)
        >>> s.state                                  # one failure: not yet unhealthy
        <HealthState.DEGRADED: 'degraded'>
        >>> s = evaluate(s, bad, failure_threshold=2)
        >>> s.state                                  # threshold reached
        <HealthState.UNHEALTHY: 'unhealthy'>
    """
    if result.ok:
        return _apply_success(current, result)
    return _apply_failure(current, result, failure_threshold=failure_threshold)


def _apply_success(current: HealthStatus, result: CheckResult) -> HealthStatus:
    """Fold a successful observation in.

    One success clears the failure streak and restores HEALTHY from any state.
    See the module docstring: recovery is deliberately fast.
    """
    return HealthStatus(
        target_name=current.target_name,
        state=HealthState.HEALTHY,
        consecutive_failures=0,  # reset, not decrement: the streak is broken
        consecutive_successes=current.consecutive_successes + 1,
        last_checked_at=result.checked_at,
        last_ok_at=result.checked_at,
        # last_error is deliberately preserved. It is the record of what went
        # wrong most recently, and clearing it on recovery destroys the only
        # clue available to whoever investigates after the fact.
        last_error=current.last_error,
        total_checks=current.total_checks + 1,
        total_failures=current.total_failures,
    )


def _apply_failure(
    current: HealthStatus,
    result: CheckResult,
    *,
    failure_threshold: int,
) -> HealthStatus:
    """Fold a failed observation in.

    DEGRADED on the first failure; UNHEALTHY once the streak reaches the
    threshold. Failing is deliberately slow -- see the module docstring.
    """
    failures = current.consecutive_failures + 1

    # >= not ==: a threshold change at runtime (config reload) could otherwise
    # step straight past the equality and leave a target DEGRADED forever while
    # its failure count climbed. Comparing with >= is correct under any
    # threshold change; == is correct only if the threshold never moves.
    state = (
        HealthState.UNHEALTHY if failures >= failure_threshold else HealthState.DEGRADED
    )

    return HealthStatus(
        target_name=current.target_name,
        state=state,
        consecutive_failures=failures,
        consecutive_successes=0,
        last_checked_at=result.checked_at,
        last_ok_at=current.last_ok_at,  # unchanged: this observation was not ok
        last_error=result.error,
        total_checks=current.total_checks + 1,
        total_failures=current.total_failures + 1,
    )
