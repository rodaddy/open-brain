"""Write the gate's unblock receipts at the lifecycle moments that earn them.

Purpose:
    The capabilities in ``apps.hooks.session`` do the WORK -- read canon, record a
    compaction summary, deliver a turn. This module records the EVIDENCE that the
    work happened, in the file the TypeScript context-budget gate reads. Keeping
    it separate means a capability's own logic never has to know a gate exists,
    and a change to the gate's protocol touches one file.

Architecture:
    Three functions, one per lifecycle moment the gate cares about.

        ``note_compaction``      PostCompact opens the cycle
        ``note_verified_recall`` SessionStart's successful canon read closes it
        ``note_capture``         Stop's delivery clears the capture block

    ``note_verified_recall_for_current_cycle`` is the form the ``SessionStart``
    capability actually calls: it JOINS the session's live cycle to learn the id
    the gate is waiting on, then records the recall against it, so the caller does
    not have to carry a correlation id across two separate hook processes.

    Each takes the hook payload's ``cwd`` and derives the project slug the same
    way the gate does (``receipts.scope``). A ``cwd`` that is not Development work
    resolves to nothing and nothing is written -- correctly, because the gate
    tracks no block for such a session either.

Pattern/Convention:
    A RECEIPT IS NEVER WORTH BREAKING A HOOK FOR. Every function here returns
    quietly on any failure and logs content-free. The receipt is evidence of work
    that has ALREADY succeeded; failing the hook because the evidence could not be
    filed would discard the work to protect the note about it. The worst case of a
    swallowed failure is a gate that stays blocked, which self-releases on its own
    timer and which the operator can clear explicitly.

    THE RECEIPT IS WRITTEN AFTER THE WORK, NEVER BEFORE. Each caller invokes these
    only on a path where the operation already returned successfully. A receipt
    written first would be a claim rather than evidence, and the gate exists
    precisely because claims were being trusted.

See Also:
    - ``openbrain.receipts`` - the writer and the schema
    - ``openbrain.apps.hooks.session`` - the capabilities these observe
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING

from loguru import logger

from openbrain.receipts import (
    ProviderReceiptEvidence,
    default_receipt_state_path,
    ensure_compact_cycle,
    receipt_mode,
    record_provider_receipt,
    resolve_development_scope,
    start_compact_cycle,
)

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path


def note_compaction(
    session_id: str | None,
    cwd: str | Path | None,
    *,
    state_path: Path | None = None,
) -> str | None:
    """Open the compaction cycle a later recall must name, after ``PostCompact``.

    Args:
        session_id: The session that was compacted.
        cwd: The hook payload's working directory, used to derive the project.
        state_path: The receipt file, defaulting to the shared one. Injected by
            tests so they never touch the running session's state.

    Returns:
        The cycle's correlation id, or ``None`` when nothing was written.

    This is the half of the lifecycle that ARMS the gate rather than releasing it:
    the gate reads the cycle this opens, stores its id, and then blocks task
    mutation until a recall naming that exact id arrives.
    """
    return _guarded(
        "PostCompact",
        lambda project, path: start_compact_cycle(
            path, session_id=_required(session_id), project=project
        ).id,
        cwd,
        state_path,
    )


def note_verified_recall(
    session_id: str | None,
    cwd: str | Path | None,
    correlation_id: str,
    *,
    state_path: Path | None = None,
) -> None:
    """Record that ``SessionStart`` read canon back, releasing the gate's read-back.

    Args:
        session_id: The session that read canon.
        cwd: The hook payload's working directory.
        correlation_id: The compaction cycle this read belongs to. It MUST be the
            id the gate is waiting on; a recall naming any other cycle is
            correctly ignored.
        state_path: The receipt file, defaulting to the shared one.

    This is THE unblock. The receipt is graded through
    :func:`~openbrain.receipts.receipt_mode` rather than asserted, so a read that
    did not actually reach the service cannot present as a verified one.
    """
    _guarded(
        "SessionStart",
        lambda project, path: _record_recall(
            path, project, _required(session_id), correlation_id
        ),
        cwd,
        state_path,
    )


def _record_recall(
    path: Path, project: str, session_id: str, correlation_id: str
) -> str:
    """File the verified-recall receipt that releases the gate's read-back.

    ``mode`` is derived through :func:`~openbrain.receipts.receipt_mode` rather
    than written as the literal ``verified-remote``. The grading is what makes the
    receipt honest, and this is the one receipt whose only job is to say a read
    really reached the service.
    """
    return record_provider_receipt(
        path,
        ProviderReceiptEvidence(
            operation="recall",
            mode=receipt_mode(
                "recall",
                "direct",
                durable=False,
                direct_attempted=True,
                fallback_attempted=False,
            ),
            status="direct",
            project=project,
            session_id=session_id,
            trigger="compact",
            direct_attempted=True,
            recorded_at=_now(),
            correlation_id=correlation_id,
        ),
    ).recorded_at


def note_verified_recall_for_current_cycle(
    session_id: str | None,
    cwd: str | Path | None,
    *,
    state_path: Path | None = None,
) -> None:
    """Join the session's live compaction cycle and record the recall against it.

    Args:
        session_id: The session that read canon.
        cwd: The hook payload's working directory.
        state_path: The receipt file, defaulting to the shared one.

    The ``SessionStart`` hook is a SEPARATE PROCESS from the ``PostCompact`` that
    opened the cycle, so it cannot be handed the correlation id -- it has to read
    it back out of the shared file. :func:`~openbrain.receipts.ensure_compact_cycle`
    is exactly that read: it returns the live cycle when one exists and opens a
    fresh one when it does not.

    Opening one when none exists is deliberate rather than a fallback. If the gate
    has not armed a block, the cycle and receipt are simply unread and cost
    nothing; if the gate armed one from its own side without a ``PostCompact``
    hook having run, this is what lets the session clear it.
    """
    _guarded(
        "SessionStart",
        lambda project, path: _record_recall(
            path, project, _required(session_id), _joined_cycle_id(path, project, session_id)
        ),
        cwd,
        state_path,
    )


def _joined_cycle_id(path: Path, project: str, session_id: str | None) -> str:
    """The id of the session's live compaction cycle, joining or opening one."""
    return ensure_compact_cycle(
        path, session_id=_required(session_id), project=project
    ).id


def note_capture(
    session_id: str | None,
    cwd: str | Path | None,
    *,
    state_path: Path | None = None,
) -> None:
    """Record that a turn was written durably, clearing the gate's capture block.

    Args:
        session_id: The session whose turn was delivered.
        cwd: The hook payload's working directory.
        state_path: The receipt file, defaulting to the shared one.

    Called only after the lane has ACCEPTED the delivery, which is what makes
    ``saved`` and ``durable`` honest here. A delivery that raised never reaches
    this, so a failed write leaves the block standing -- which is the behaviour
    the gate is for.
    """
    _guarded(
        "Stop",
        lambda project, path: record_provider_receipt(
            path,
            ProviderReceiptEvidence(
                operation="capture",
                mode=receipt_mode(
                    "capture",
                    "saved",
                    durable=True,
                    direct_attempted=True,
                    fallback_attempted=False,
                ),
                status="saved",
                project=project,
                session_id=_required(session_id),
                trigger="explicit",
                direct_attempted=True,
                recorded_at=_now(),
            ),
        ).recorded_at,
        cwd,
        state_path,
    )


def _guarded(
    event: str,
    write: Callable[[str, Path], str],
    cwd: str | Path | None,
    state_path: Path | None,
) -> str | None:
    """Resolve the project, run ``write``, and swallow every failure.

    Args:
        event: The hook name, for the log line only.
        write: Takes the project slug and the state path and performs the write.
        cwd: The hook payload's working directory.
        state_path: The receipt file, or ``None`` for the shared default.

    Returns:
        Whatever ``write`` returned, or ``None`` when the directory was out of
        scope or the write failed.

    The whole swallow lives in one place so no caller can forget it and so the
    log line is identical for every event.
    """
    scope = resolve_development_scope(cwd)
    if scope is None:
        return None

    try:
        path = state_path if state_path is not None else default_receipt_state_path()
        return write(scope.project, path)
    except Exception as error:  # noqa: BLE001 -- evidence must never break the work
        # Content-free BY CONSTRUCTION: only the class name is passed, never the
        # exception object, so no payload text or path reaches the sink even under
        # loguru's diagnose (the rule ``stop.capture_stop_with`` documents).
        logger.warning(
            "{} receipt not recorded ({}); the context-budget gate may stay blocked",
            event,
            type(error).__name__,
        )
        return None


class _NoSessionError(ValueError):
    """The hook payload carried no session id, so there is nothing to file against.

    Raised inside :func:`_guarded` rather than checked by each caller, so every
    "nothing was written" outcome takes the one swallowed path instead of being
    split across two shapes.
    """

    def __init__(self) -> None:
        """State the missing field. There is no value to name."""
        super().__init__("the hook payload carried no session id")


def _required(session_id: str | None) -> str:
    """The session id, or raise so :func:`_guarded` swallows it as one failure."""
    if session_id is None:
        raise _NoSessionError
    return session_id


def _now() -> str:
    """The current moment in the shape the gate parses.

    UTC with an explicit ``Z``, milliseconds -- matching JavaScript's
    ``toISOString``. Every freshness window the gate applies is measured from this
    value, so a naive datetime here would read as an arbitrarily old receipt.
    """
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
