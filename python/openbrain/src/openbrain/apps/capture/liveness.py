"""Decide whether the capture lane is still delivering, from counts alone.

Purpose:
    Raw capture is AUTOMATIC -- a ``Stop`` hook reads since the watermark and
    sends (``deliver``). Automatic is exactly what makes it dangerous: nobody
    notices it stopping, because nothing was ever asked to notice. This module
    answers one question, ``is that lane still alive``, and answers it in a
    shape a health endpoint can publish.

    It replaces an enforcement tier, not a test. Ledger item 25
    (``docs/issue-graph.md``) retired the capture MERGE-GATE on the reasoning
    that gating a human's PR is the wrong instrument for a background pipeline;
    what a background pipeline needs is LIVENESS, and that is #647.

Architecture:
    A PURE FUNCTION over an observation. It opens no file, holds no lock, runs
    no query, and takes no clock of its own -- the caller gathers the counts and
    passes them in, and ``now`` is a parameter.

    That shape is not fastidiousness. The three sources this reasons about are
    all things a ``Stop`` hook touches inside a 5-second deadline
    (``watermark.py``, ``outage.py``), and ``outage.py``'s module docstring
    records what happened the last time a capture-path component took a lock on
    a file another one waited for: a HEALTHY hook stalled 31.4 s, past the Stop
    deadline, and the turn delivered zero batches -- "the turn was DROPPED by
    its own telemetry". A liveness reader that could do that would be a defect
    strictly worse than the blindness it removes. Being pure makes that
    impossible by construction rather than by care.

    Composition therefore lives with the caller, and the reading travels to
    ``/health`` the way the maintenance producer's does
    (``server/transport/health.ts:72-78``, ``server/application/index.ts:159``).

Pattern/Convention:
    **PER ROLE, NOT PER LANE.** ``docs/decisions/capture-never-drops-a-turn.md``
    specifies this twice and explains why with a measurement (:188-200): the
    operator's numbers stayed healthy for six days while the assistant side sat
    at zero, and #447 went unnoticed for exactly that long. On 2026-08-02 the
    figures were 365 user rows against 13 assistant rows (:291) -- a lane-total
    counter reads 378 turns and reports a busy lane. Summing across roles
    rebuilds the blind spot this reader exists to remove, so a silent role is a
    fault even while the total looks healthy.

    **ABSENCE IS NOT STALENESS.** A process that composes no capture lane gets
    ``None``, never a stale reading and never a fabricated healthy one. A
    component that is not composed must not report itself broken, or every
    opted-out worker degrades itself (``docs/lane-contract.md`` Tightenings
    round 8, generalized from #625). ``None`` is what lets ``/health`` omit the
    block rather than assert a green it never measured.

    **COUNTS DECIDE; THE CLOCK ONLY DESCRIBES.** Every field of the verdict is
    derived from event counts -- sessions observed, turns delivered, bytes
    advanced, spool depth, announcements. ``now`` produces
    :attr:`CaptureLiveness.silence_seconds`, which is REPORTED and never
    compared against a threshold. A wall-clock verdict cannot tell a wedged
    pipeline from a busy machine or a quiet afternoon, which is why
    ``docs/lane-contract.md`` (Tightenings round 5) forbids the shape outright.

    **ONE QUIET SESSION IS NOT A DEAD LANE.** A single session can legitimately
    deliver nothing. :data:`MIN_SESSIONS_FOR_SILENCE` is the count below which
    silence is ordinary, because an alarm that fires on ordinary quiet is an
    alarm nobody reads.

Example:
    >>> healthy = read_capture_liveness(
    ...     CaptureObservation(
    ...         sessions_observed=9,
    ...         watermark_bytes_advanced=1048576,
    ...         spool_pending=0,
    ...         outage_announcements=0,
    ...         roles={
    ...             "user": RoleObservation(turns_delivered=120),
    ...             "assistant": RoleObservation(turns_delivered=118),
    ...         },
    ...         last_delivery_at=1000.0,
    ...     ),
    ...     now=lambda: 1001.0,
    ... )
    >>> healthy.stale, healthy.silent_roles
    (False, ())

    >>> half_dead = read_capture_liveness(
    ...     CaptureObservation(
    ...         sessions_observed=9,
    ...         watermark_bytes_advanced=1048576,
    ...         spool_pending=0,
    ...         outage_announcements=0,
    ...         roles={
    ...             "user": RoleObservation(turns_delivered=365),
    ...             "assistant": RoleObservation(turns_delivered=0),
    ...         },
    ...         last_delivery_at=1000.0,
    ...     ),
    ...     now=lambda: 1001.0,
    ... )
    >>> half_dead.stale, half_dead.silent_roles
    (True, ('assistant',))

    >>> read_capture_liveness(None, now=lambda: 1.0) is None
    True

See Also:
    - ``docs/decisions/capture-never-drops-a-turn.md`` - the health check this
      makes executable, and the measurement that forced the per-role rule
    - ``apps.capture.deliver`` - the lane whose liveness this reports
    - ``apps.capture.outage`` - the latch whose silence clause (b) detects
    - ``src/maintenance-sweep.ts`` - the #625 precedent this mirrors
"""

from __future__ import annotations

import time
from collections.abc import Callable, Mapping

from pydantic import BaseModel, Field

#: Sessions that must be observed before total silence counts as a fault.
#:
#: Below this, silence is ordinary: one session can genuinely produce no
#: operator turns, and a reader that called that a dead lane would fire on every
#: quiet afternoon. An alarm with a false-positive rate that high stops being
#: read, which costs more than the blindness it replaced.
#:
#: Two, not a larger round number, because the evidence this guards against is
#: strong: the #447 measurement showed a lane at literal zero across a full day
#: of sessions. Waiting for a big sample to call that dead would delay the
#: signal for no gain in confidence.
MIN_SESSIONS_FOR_SILENCE = 2


class RoleObservation(BaseModel):
    """What one speaker delivered in the observed window.

    A role is observed separately because the failure this module exists to
    catch is single-role: ``docs/decisions/capture-never-drops-a-turn.md:291``
    records 365 user turns beside 13 assistant turns, a lane that looked busy in
    total and was half dead.
    """

    model_config = {"frozen": True}

    turns_delivered: int = Field(ge=0)


class CaptureObservation(BaseModel):
    """The counts a caller gathered about the capture lane.

    Every field is a COUNT or an identifier, never a duration. The one
    timestamp, :attr:`last_delivery_at`, is used solely to describe how long the
    silence has lasted; no verdict is computed from it.
    """

    model_config = {"frozen": True}

    #: Sessions seen delivering in the window -- the denominator that makes
    #: "zero turns" meaningful. Zero turns across zero sessions is not silence.
    sessions_observed: int = Field(ge=0)
    #: Total transcript bytes the watermark advanced across those sessions.
    #: Zero while sessions ran is the wedged-watermark shape: the lane is being
    #: invoked and reading nothing.
    watermark_bytes_advanced: int = Field(ge=0)
    #: Records waiting in the durability spool (``outage.spool_pending``).
    spool_pending: int = Field(ge=0)
    #: Outage notices the latch actually emitted in the window.
    #: ``OutageLatch.note_spooled`` returns ``None`` for three distinct reasons
    #: (outage.py:411), so a latch that never fires is indistinguishable from a
    #: healthy one at the call site. This count is what separates them.
    outage_announcements: int = Field(ge=0)
    #: Per-speaker delivery counts. Keyed by role as ``ob_raw_turns.role`` uses
    #: it, so the reading lines up with the SQL the decision document already
    #: publishes (``capture-never-drops-a-turn.md:193-197``).
    roles: Mapping[str, RoleObservation]
    #: When the lane last delivered anything, in ``time.monotonic``-comparable
    #: seconds. Describes the silence; never decides it.
    last_delivery_at: float


class CaptureLiveness(BaseModel):
    """The capture lane's liveness, as ``/health`` reports it.

    Mirrors ``MaintenanceSweepLiveness`` (``src/maintenance-sweep.ts:275``)
    deliberately: a second background lane reporting its health in a second
    shape would make the two impossible to read side by side.
    """

    model_config = {"frozen": True}

    #: True when any fault below fired. The single field a health status reads.
    stale: bool
    #: Sessions ran and the watermark advanced zero bytes.
    watermark_wedged: bool
    #: The spool holds records and the latch announced nothing.
    spool_unannounced: bool
    #: Roles that delivered nothing while the lane as a whole was active.
    silent_roles: tuple[str, ...]
    sessions_observed: int
    turns_delivered: int
    spool_pending: int
    #: How long the lane has been silent. REPORTED for an operator's benefit;
    #: no verdict is derived from it (see the module's counts-decide rule).
    silence_seconds: float
    #: A content-free sentence naming which fault fired, for a log line and a
    #: health body. Never carries transcript text, a path, or an endpoint --
    #: the same rule ``outage.py``'s notices follow.
    reason: str


def read_capture_liveness(
    observation: CaptureObservation | None,
    *,
    now: Callable[[], float] = time.monotonic,
) -> CaptureLiveness | None:
    """Judge the capture lane from one observation.

    Args:
        observation: The gathered counts, or ``None`` when this process
            composes no capture lane at all.
        now: The clock, injected. Used only to describe the silence's length.

    Returns:
        A :class:`CaptureLiveness`, or ``None`` when ``observation`` is ``None``
        -- absence is not staleness, and a caller must be able to publish
        nothing rather than publish a green it did not measure.
    """
    if observation is None:
        return None

    turns_delivered = sum(
        role.turns_delivered for role in observation.roles.values()
    )
    active = observation.sessions_observed >= MIN_SESSIONS_FOR_SILENCE

    # A wedged watermark: sessions are being processed and the read position is
    # not moving. The lane is running and ingesting nothing, which is precisely
    # the shape a crashed reader or a permission error produces.
    watermark_wedged = active and observation.watermark_bytes_advanced == 0

    # A spool that is filling while the latch stays quiet. Depth alone is not a
    # fault -- an ANNOUNCED outage is the system working loudly, which is what
    # outage.py was built for. Depth with zero announcements is the failure.
    spool_unannounced = (
        observation.spool_pending > 0 and observation.outage_announcements == 0
    )

    silent_roles = _silent_roles(observation, active=active)

    faults: list[str] = []
    if watermark_wedged:
        faults.append(
            f"watermark advanced 0 bytes across {observation.sessions_observed} "
            "session(s)"
        )
    if spool_unannounced:
        faults.append(
            f"spool holds {observation.spool_pending} record(s) with no outage "
            "announced"
        )
    if silent_roles:
        faults.append(
            f"role(s) delivered nothing: {', '.join(silent_roles)}"
        )

    return CaptureLiveness(
        stale=bool(faults),
        watermark_wedged=watermark_wedged,
        spool_unannounced=spool_unannounced,
        silent_roles=silent_roles,
        sessions_observed=observation.sessions_observed,
        turns_delivered=turns_delivered,
        spool_pending=observation.spool_pending,
        silence_seconds=max(0.0, now() - observation.last_delivery_at),
        reason="; ".join(faults) if faults else "capture lane delivering",
    )


def _silent_roles(
    observation: CaptureObservation, *, active: bool
) -> tuple[str, ...]:
    """Which speakers delivered nothing while the lane was active.

    The per-role rule from ``capture-never-drops-a-turn.md:188-200``. Returned
    sorted so the reading is stable between calls -- an unstable field turns
    every health poll into a spurious diff for anything watching it.

    A role is silent only when the lane is ACTIVE; below
    :data:`MIN_SESSIONS_FOR_SILENCE` every role reads zero and the answer is
    "not enough happened to tell", not "everything is dead".
    """
    if not active:
        return ()
    return tuple(
        sorted(
            role
            for role, counts in observation.roles.items()
            if counts.turns_delivered == 0
        )
    )
