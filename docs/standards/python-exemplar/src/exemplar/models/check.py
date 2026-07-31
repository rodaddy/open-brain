"""Models for health checking: what to check, what was observed, what it means.

The three types here form a deliberate progression, and keeping them separate is
the design rather than an accident of file layout:

    Target        configuration -- what we were told to watch
    CheckResult   observation   -- what happened once, at one instant
    HealthStatus  judgement     -- what a series of observations means

Collapsing them into one "target with a status field" is the obvious shortcut
and it destroys the distinction between *observed* and *concluded*. A single
failed request is not an unhealthy service; the threshold logic that turns
observations into a judgement needs both kinds of value present at once to do
its job.

See Also:
    - exemplar.apps.monitor.checker: produces CheckResult
    - exemplar.apps.monitor.evaluator: turns CheckResult into HealthStatus
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, field_validator

from exemplar.utils.datetime_helpers import utc_now

#: Cap on target names. Not arbitrary: names appear in log lines and filenames,
#: and an unbounded name from a config file is how a log line becomes unreadable
#: or a path becomes invalid.
MAX_NAME_LENGTH = 64


class HealthState(StrEnum):
    """Health of a target, as concluded from its recent observations.

    ``StrEnum`` rather than a bare ``str``: the member set is closed, so a typo
    is a validation error instead of a state nothing ever matches. It still
    serializes as a plain string, so JSON output is unchanged.

    UNKNOWN is a real state, not a placeholder. A target that has never been
    checked is genuinely not "healthy", and conflating the two is how a
    dashboard reports green for something that has never once responded.
    """

    UNKNOWN = "unknown"
    HEALTHY = "healthy"
    DEGRADED = "degraded"
    UNHEALTHY = "unhealthy"


class Target(BaseModel):
    """A thing to be checked. Configuration, supplied by the operator.

    Frozen: a target is what we were told to watch. Mutating one at runtime
    means the config on disk and the config in memory disagree, with no record
    of when they diverged.
    """

    model_config = ConfigDict(frozen=True)

    name: str = Field(min_length=1, max_length=MAX_NAME_LENGTH)
    url: HttpUrl

    #: Status codes counted as success. A default of {200} would be wrong for
    #: any endpoint that redirects or returns 204.
    expect_status: frozenset[int] = frozenset({200, 201, 202, 204})

    #: Per-target override of the global timeout, for a known-slow endpoint.
    #: None means "use the configured default" -- distinct from 0, which would
    #: mean "time out immediately".
    timeout_seconds: float | None = Field(default=None, gt=0, le=120)

    @field_validator("name")
    @classmethod
    def _name_is_filename_safe(cls, value: str) -> str:
        """Reject names that cannot appear in a filename or a log field.

        Target names end up in state-file keys and log lines. A name containing
        a path separator or whitespace produces either a broken path or a log
        line that cannot be parsed by field position.
        """
        if any(ch in value for ch in "/\\\t\n\r"):
            msg = (
                f"target name {value!r} contains a path separator or whitespace. "
                f"ACTION REQUIRED: use letters, digits, dashes, or underscores -- "
                f"names appear in filenames and log fields."
            )
            raise ValueError(msg)
        return value


class CheckResult(BaseModel):
    """One observation of one target, at one instant.

    Frozen. An observation is a historical fact: it happened, at a time, with an
    outcome. Editing one in place rewrites history, and the resulting state file
    describes something that never occurred.
    """

    model_config = ConfigDict(frozen=True)

    target_name: str
    checked_at: datetime = Field(default_factory=utc_now)

    #: None when the request never completed -- connection refused, DNS
    #: failure, timeout. Distinct from a 500, which IS a response and means the
    #: service is reachable but broken.
    status_code: int | None = None

    #: None for the same reason. A failed request has no meaningful latency, and
    #: recording 0 would pull every latency average toward zero, making an
    #: outage look like an improvement.
    latency_ms: float | None = Field(default=None, ge=0)

    #: Present only on failure. Kept short: it goes into logs and state files,
    #: and an unbounded upstream error body is both noise and a disclosure risk.
    error: str | None = Field(default=None, max_length=500)

    @property
    def ok(self) -> bool:
        """Whether this observation counts as a success.

        A property rather than a stored field: storing it would let ``ok`` and
        ``status_code`` disagree after a partial update, and there would be no
        way to tell which was right.
        """
        return self.status_code is not None and self.error is None

    @field_validator("checked_at")
    @classmethod
    def _must_be_timezone_aware(cls, value: datetime) -> datetime:
        """Reject a naive datetime outright.

        The default factory is ``utc_now``, so this only fires for an explicitly
        passed value -- typically JSON parsed from an older state file. Repairing
        it silently would hide the fact that something upstream is still
        producing naive timestamps.
        """
        if value.tzinfo is None:
            msg = (
                "checked_at must be timezone-aware. "
                "ACTION REQUIRED: build it with "
                "exemplar.utils.datetime_helpers.utc_now(), never datetime.now()."
            )
            raise ValueError(msg)
        return value


class HealthStatus(BaseModel):
    """Rolled-up health of one target, concluded from consecutive observations.

    NOT frozen, unlike the two above: this is accumulated state that is updated
    in place as new observations arrive. That is exactly why it is a separate
    type -- so the mutable judgement can never be confused with the immutable
    facts it was derived from.
    """

    target_name: str
    state: HealthState = HealthState.UNKNOWN

    consecutive_failures: int = Field(default=0, ge=0)
    consecutive_successes: int = Field(default=0, ge=0)

    last_checked_at: datetime | None = None
    last_ok_at: datetime | None = None
    last_error: str | None = Field(default=None, max_length=500)

    total_checks: int = Field(default=0, ge=0)
    total_failures: int = Field(default=0, ge=0)

    @property
    def failure_rate(self) -> float:
        """Fraction of all checks that failed, in ``0.0``-``1.0``.

        Returns 0.0 when nothing has been checked yet. Guarding the division
        here rather than at each call site is the point of putting it on the
        model: one place to get the zero case right.
        """
        if self.total_checks == 0:
            return 0.0
        return self.total_failures / self.total_checks
