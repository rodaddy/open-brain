"""Per-session context-budget gate state, and every transition it can make.

This module owns WHAT THE GATE BELIEVES: whether a post-compact read-back is
still owed, whether an uncaptured turn is still owed, whether repair mode is
open, and the log of how it got there. It reads receipt evidence through
:mod:`openbrain_provider.receipt_state` and never writes it.

Two properties here are the reason issue #419 exists, and both are asserted by
tests rather than left to a comment:

* **The read-back requirement self-releases.** After
  :data:`READBACK_TIMEOUT_SECONDS` the gate stops blocking on its own, because a
  gate that waits forever on a subsystem is a gate that blocks the repair of
  that subsystem. It releases by RECORDING that it released — it never
  manufactures a recall receipt that did not happen.
* **Repair mode expires.** An escape hatch that stays open is not an escape
  hatch, it is the gate being off.

What this module does NOT do: it does not read stdin, decide a verdict, or
render a banner. Those are `gate_shell`, `gate.py`, and `gate_presentation`.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Final

from .receipt_state import (
    ReceiptEvidence,
    current_compact_cycle,
    find_fresh_receipt,
    has_verified_compact_recall,
    parse_iso,
)

__all__ = [
    "CHECKPOINT_MAX_AGE_SECONDS",
    "READBACK_TIMEOUT_SECONDS",
    "GateTransition",
    "SessionState",
    "StateFile",
    "enter_repair_mode",
    "exit_repair_mode",
    "fresh_session_state",
    "hydrate_session_state",
    "load_state",
    "queue_notice",
    "reconcile_gate_state",
    "record_transition",
    "repair_mode_is_active",
    "save_session_state",
    "verified_checkpoint",
]

#: context-budget-gate-state.ts:10. THE self-release. The documented 15 minutes
#: did not actually fire in the revision issue #419 was filed against; here the
#: release is a named transition with its own test, so a regression is a failing
#: test rather than a session that silently never unblocks.
READBACK_TIMEOUT_SECONDS: Final[float] = 15 * 60.0

#: context-budget-gate.ts:76 — how fresh a checkpoint receipt must be to satisfy
#: an explicit `checkpoint-done`.
CHECKPOINT_MAX_AGE_SECONDS: Final[float] = 20 * 60.0

#: context-budget-gate-state.ts:172 — the window for "has this session written
#: anything durable lately", used only to date `lastWriteAt`.
LATEST_WRITE_MAX_AGE_SECONDS: Final[float] = 24 * 60 * 60.0

#: context-budget-gate-state.ts:217 — how far back a legacy correlation may be
#: recovered from.
LEGACY_CORRELATION_MAX_AGE_SECONDS: Final[float] = 24 * 60 * 60.0

#: context-budget-gate-state.ts:223 — how closely a recovered cycle's start must
#: match the moment the read-back was armed to be the SAME compaction.
LEGACY_CORRELATION_SKEW_SECONDS: Final[float] = 2 * 60.0

#: context-budget-gate-state.ts:204 — a verified recall older than this does not
#: clear the read-back.
VERIFIED_RECALL_MAX_AGE_SECONDS: Final[float] = 2 * 60.0

#: Every transition the gate can make. A closed set, because "silence is a
#: signal" (#419 acceptance): an unnamed state change is one nobody can grep
#: for after the fact.
TRANSITION_NAMES: Final[frozenset[str]] = frozenset(
    {
        "armed",
        "long-sprint",
        "cleared-by-recall",
        "cleared-by-capture",
        "repair-entered",
        "repair-exited",
        "repair-expired",
        "self-released-after-timeout",
        "still-blocking-with-reason",
    }
)

_WRITE_OPERATIONS: Final[tuple[str, ...]] = ("capture", "checkpoint", "wrap")
_DURABLE_MODES: Final[tuple[str, ...]] = ("verified-remote", "durable-spool")


@dataclass(frozen=True)
class GateTransition:
    """One recorded state change.

    Attributes:
        name: One of :data:`TRANSITION_NAMES`.
        at: When it happened, ISO-8601.
        reason: Why, in operator-readable prose.
    """

    name: str
    at: str
    reason: str

    def to_json(self) -> dict[str, str]:
        """Return the on-disk shape the TypeScript reader expects."""
        return {"name": self.name, "at": self.at, "reason": self.reason}


@dataclass
class SessionState:
    """Everything the gate remembers about one session.

    Field names mirror the on-disk camelCase keys through
    :meth:`to_json`/:meth:`from_json`, because the state file is shared with the
    TypeScript gate during the changeover and must stay readable by both.
    """

    session_id: str
    project: str = ""
    context_tokens: int = 0
    compact_boundary_count: int = 0
    long_sprint_noted: bool = False
    last_nag_at_tokens: int = 0
    checkpoint_required: bool = False
    checkpoint_required_at: str = ""
    readback_required: bool = False
    readback_required_at: str = ""
    readback_correlation_id: str = ""
    capture_required: bool = False
    capture_required_at: str = ""
    pending_cleared_notices: list[str] = field(default_factory=list)
    last_write_at: str = ""
    checkpoint_at_tokens: int = 0
    checkpoint_at: str = ""
    repair_mode_active: bool = False
    repair_mode_entered_at: str = ""
    repair_mode_expires_at: str = ""
    transition_log: list[GateTransition] = field(default_factory=list)
    updated_at: str = ""

    def to_json(self) -> dict[str, Any]:
        """Return the camelCase on-disk representation."""
        return {
            "sessionId": self.session_id,
            "project": self.project,
            "contextTokens": self.context_tokens,
            "compactBoundaryCount": self.compact_boundary_count,
            "longSprintNoted": self.long_sprint_noted,
            "lastNagAtTokens": self.last_nag_at_tokens,
            "checkpointRequired": self.checkpoint_required,
            "checkpointRequiredAt": self.checkpoint_required_at,
            "readbackRequired": self.readback_required,
            "readbackRequiredAt": self.readback_required_at,
            "readbackCorrelationId": self.readback_correlation_id,
            "captureRequired": self.capture_required,
            "captureRequiredAt": self.capture_required_at,
            "pendingClearedNotices": list(self.pending_cleared_notices),
            "lastWriteAt": self.last_write_at,
            "checkpointAtTokens": self.checkpoint_at_tokens,
            "checkpointAt": self.checkpoint_at,
            "repairModeActive": self.repair_mode_active,
            "repairModeEnteredAt": self.repair_mode_entered_at,
            "repairModeExpiresAt": self.repair_mode_expires_at,
            "transitionLog": [entry.to_json() for entry in self.transition_log],
            "updatedAt": self.updated_at,
        }


@dataclass
class StateFile:
    """The whole state file: one entry per session.

    Attributes:
        sessions: Session id to state.
    """

    sessions: dict[str, SessionState] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        """Return the on-disk representation."""
        return {
            "sessions": {
                key: value.to_json() for key, value in sorted(self.sessions.items())
            }
        }


def _string(value: object, fallback: str = "") -> str:
    """Return a string field, or the fallback when the stored value is not one."""
    return value if isinstance(value, str) else fallback


def _integer(value: object, fallback: int = 0) -> int:
    """Return an int field, or the fallback for a non-numeric stored value."""
    if isinstance(value, bool):
        return fallback
    return value if isinstance(value, int) else fallback


def _boolean(value: object, fallback: bool = False) -> bool:
    """Return a bool field, or the fallback for a non-boolean stored value."""
    return value if isinstance(value, bool) else fallback


def _string_list(value: object) -> list[str]:
    """Return only the string members of a stored list."""
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str)]


def _transition_list(value: object) -> list[GateTransition]:
    """Return only the well-formed transitions from a stored list."""
    if not isinstance(value, list):
        return []
    transitions: list[GateTransition] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        name, at, reason = item.get("name"), item.get("at"), item.get("reason")
        if not (
            isinstance(name, str) and isinstance(at, str) and isinstance(reason, str)
        ):
            continue
        transitions.append(GateTransition(name=name, at=at, reason=reason))
    return transitions


def hydrate_session_state(
    stored: dict[str, Any] | None, session_id: str, now: str
) -> SessionState:
    """Build a session state from whatever the file held.

    Every field is read defensively: a state file half-written by a killed
    process, or written by an older revision, must produce a usable state rather
    than an exception, because an exception here would break the session the
    gate is supposed to protect.

    ``checkpointRequired`` is deliberately forced to False regardless of what is
    stored (context-budget-gate-state.ts:78-80): pre-compact token pressure is
    advisory now, and an old state file still carrying a required checkpoint
    would otherwise resurrect a retired block.

    Args:
        stored: Raw stored entry, or None for a session with no history.
        session_id: The session this state belongs to.
        now: Current instant, ISO-8601.

    Returns:
        A usable session state.
    """
    source: dict[str, Any] = stored if isinstance(stored, dict) else {}
    return SessionState(
        session_id=session_id,
        project=_string(source.get("project")),
        context_tokens=_integer(source.get("contextTokens")),
        compact_boundary_count=_integer(source.get("compactBoundaryCount")),
        long_sprint_noted=_boolean(source.get("longSprintNoted")),
        last_nag_at_tokens=_integer(source.get("lastNagAtTokens")),
        checkpoint_required=False,
        checkpoint_required_at="",
        readback_required=_boolean(source.get("readbackRequired")),
        readback_required_at=_string(source.get("readbackRequiredAt")),
        readback_correlation_id=_string(source.get("readbackCorrelationId")),
        capture_required=_boolean(source.get("captureRequired")),
        capture_required_at=_string(source.get("captureRequiredAt")),
        pending_cleared_notices=_string_list(source.get("pendingClearedNotices")),
        last_write_at=_string(source.get("lastWriteAt")),
        checkpoint_at_tokens=_integer(source.get("checkpointAtTokens")),
        checkpoint_at=_string(source.get("checkpointAt")),
        repair_mode_active=_boolean(source.get("repairModeActive")),
        repair_mode_entered_at=_string(source.get("repairModeEnteredAt")),
        repair_mode_expires_at=_string(source.get("repairModeExpiresAt")),
        transition_log=_transition_list(source.get("transitionLog")),
        updated_at=now,
    )


def load_state(state_path: Path) -> tuple[StateFile, dict[str, Any]]:
    """Read the gate state file.

    Args:
        state_path: The gate's own state file.

    Returns:
        A tuple of the parsed state file and the raw sessions mapping. The raw
        mapping is returned because :func:`hydrate_session_state` needs the
        untouched entry, and re-serialising a hydrated one first would lose any
        field this revision does not know about.
    """
    try:
        raw = json.loads(state_path.read_text(encoding="utf8"))
    except (OSError, json.JSONDecodeError):
        # A corrupt state file must not break the session; the gate rebuilds it.
        return StateFile(), {}
    if not isinstance(raw, dict):
        return StateFile(), {}
    sessions = raw.get("sessions")
    if not isinstance(sessions, dict):
        return StateFile(), {}
    return StateFile(), sessions


def save_session_state(
    state_path: Path, raw_sessions: dict[str, Any], state: SessionState
) -> None:
    """Write the state file with this session's entry replaced.

    Other sessions' raw entries are written back untouched. Rehydrating them
    would silently rewrite state the running TypeScript gate owns for a
    different session, which during the changeover is somebody else's data.

    Args:
        state_path: The gate's own state file.
        raw_sessions: The raw sessions mapping as it was read.
        state: The session state to store.
    """
    raw_sessions[state.session_id] = state.to_json()
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(
        json.dumps({"sessions": raw_sessions}, indent=2, ensure_ascii=False),
        encoding="utf8",
    )


def record_transition(state: SessionState, name: str, now: str, reason: str) -> None:
    """Append one named transition to the session's log.

    Args:
        state: Session state to record into.
        name: One of :data:`TRANSITION_NAMES`.
        now: When, ISO-8601.
        reason: Why, in operator-readable prose.

    Raises:
        ValueError: If the name is not a declared transition. An invented name
            is a silent hole in the audit trail, so it fails loudly here rather
            than being written and never found.
    """
    if name not in TRANSITION_NAMES:
        raise ValueError(f"unknown gate transition {name!r}")
    state.transition_log.append(GateTransition(name=name, at=now, reason=reason))


def queue_notice(state: SessionState, notice: str) -> None:
    """Queue a one-time notice for the next surface that can display one.

    Deduped, because the same clear can be reconciled on several consecutive
    events before anything is displayed.

    Args:
        state: Session state.
        notice: The message.
    """
    if notice not in state.pending_cleared_notices:
        state.pending_cleared_notices.append(notice)


def repair_mode_is_active(state: SessionState, now: str) -> bool:
    """Report whether repair mode is open right now.

    Expiry is evaluated on read as well as on reconcile, so a stale
    ``repairModeActive`` flag left by a killed process cannot keep the gate open.

    Args:
        state: Session state.
        now: Current instant, ISO-8601.

    Returns:
        True only when the flag is set AND the expiry is in the future.
    """
    if not state.repair_mode_active:
        return False
    expires = parse_iso(state.repair_mode_expires_at)
    current = parse_iso(now)
    if expires is None or current is None:
        return False
    return current < expires


def enter_repair_mode(
    state: SessionState, now: str, duration: timedelta, reason: str
) -> None:
    """Open a bounded repair window.

    Args:
        state: Session state.
        now: Current instant, ISO-8601.
        duration: How long the window stays open.
        reason: Operator-supplied reason, required by the caller.
    """
    entered = parse_iso(now) or datetime.now(UTC)
    state.repair_mode_active = True
    state.repair_mode_entered_at = now
    state.repair_mode_expires_at = _iso(entered + duration)
    record_transition(state, "repair-entered", now, reason)


def exit_repair_mode(state: SessionState, now: str, reason: str) -> None:
    """Close the repair window explicitly.

    Recording the exit even when nothing was open is deliberate: an operator who
    runs `repair-exit` gets a receipt either way, so "did that take effect" is
    answerable from the transition log.

    Args:
        state: Session state.
        now: Current instant, ISO-8601.
        reason: Why it was closed.
    """
    was_active = state.repair_mode_active
    _clear_repair_mode(state)
    record_transition(
        state,
        "repair-exited",
        now,
        reason if was_active else f"{reason}; already inactive",
    )


def verified_checkpoint(
    state: SessionState,
    receipt_state_path: Path,
    max_age_seconds: float = CHECKPOINT_MAX_AGE_SECONDS,
    now: datetime | None = None,
) -> ReceiptEvidence | None:
    """Return a fresh verified-remote checkpoint receipt for this session.

    ``verified-remote`` only. A spooled checkpoint is durable but has not been
    confirmed by the server, and `checkpoint-done` is the one place the operator
    is explicitly asserting the remote write happened.

    Args:
        state: Session state.
        receipt_state_path: Shared receipt state file.
        max_age_seconds: Freshness window.
        now: Reference time; defaults to the current instant.

    Returns:
        The receipt, or None when no qualifying evidence exists.
    """
    return find_fresh_receipt(
        receipt_state_path,
        session_id=state.session_id,
        project=state.project or None,
        operations=("checkpoint",),
        modes=("verified-remote",),
        after=state.checkpoint_required_at or None,
        max_age_seconds=max_age_seconds,
        now=now,
    )


def reconcile_gate_state(
    state: SessionState, *, receipt_state_path: Path, now: str
) -> None:
    """Bring the gate's beliefs in line with the evidence on disk.

    Runs before every verdict. Order matters only in that expiry and self-release
    come last, so a requirement cleared by real evidence is recorded as cleared
    by that evidence rather than as a timeout.

    Args:
        state: Session state to update in place.
        receipt_state_path: Shared receipt state file.
        now: Current instant, ISO-8601.
    """
    reference = parse_iso(now) or datetime.now(UTC)
    _reconcile_latest_write(state, receipt_state_path, reference)
    _reconcile_capture(state, receipt_state_path, now, reference)
    _reconcile_compact_recall(state, receipt_state_path, now, reference)
    _expire_repair_mode(state, now, reference)
    _release_timed_out_readback(state, now, reference)


def fresh_session_state(previous: SessionState) -> SessionState:
    """Return a reset state for a brand-new session.

    Project, last write, and the transition log survive; every requirement and
    every counter is cleared. A fresh session inherits no block from the last
    one — that block belonged to a context that no longer exists.

    Args:
        previous: The state being reset.

    Returns:
        A new state with requirements cleared.
    """
    return SessionState(
        session_id=previous.session_id,
        project=previous.project,
        context_tokens=0,
        compact_boundary_count=0,
        long_sprint_noted=False,
        last_nag_at_tokens=0,
        checkpoint_required=False,
        checkpoint_required_at="",
        readback_required=False,
        readback_required_at="",
        readback_correlation_id="",
        capture_required=False,
        capture_required_at="",
        pending_cleared_notices=[],
        last_write_at=previous.last_write_at,
        checkpoint_at_tokens=previous.checkpoint_at_tokens,
        checkpoint_at=previous.checkpoint_at,
        repair_mode_active=False,
        repair_mode_entered_at="",
        repair_mode_expires_at="",
        transition_log=list(previous.transition_log),
        updated_at=previous.updated_at,
    )


def _iso(moment: datetime) -> str:
    """Render an instant the way the TypeScript writer does.

    Args:
        moment: The instant.

    Returns:
        ISO-8601 in UTC with millisecond precision and a Z suffix, matching
        JavaScript's `toISOString()`. The state file is read by both runtimes
        during the changeover, so the spelling has to agree.
    """
    utc = moment.astimezone(UTC)
    return f"{utc.strftime('%Y-%m-%dT%H:%M:%S')}.{utc.microsecond // 1000:03d}Z"


def _clear_readback(state: SessionState) -> None:
    """Clear the read-back requirement and its correlation."""
    state.readback_required = False
    state.readback_required_at = ""
    state.readback_correlation_id = ""


def _clear_repair_mode(state: SessionState) -> None:
    """Clear repair mode and its timestamps."""
    state.repair_mode_active = False
    state.repair_mode_entered_at = ""
    state.repair_mode_expires_at = ""


def _reconcile_latest_write(
    state: SessionState, receipt_state_path: Path, now: datetime
) -> None:
    """Advance ``lastWriteAt`` to the newest durable write receipt."""
    latest = find_fresh_receipt(
        receipt_state_path,
        session_id=state.session_id,
        project=state.project or None,
        operations=_WRITE_OPERATIONS,
        modes=_DURABLE_MODES,
        max_age_seconds=LATEST_WRITE_MAX_AGE_SECONDS,
        now=now,
    )
    if latest is None:
        return
    recorded = latest.recorded_at_time
    known = parse_iso(state.last_write_at)
    if recorded is not None and known is not None and recorded <= known:
        return
    state.last_write_at = latest.recorded_at


def _reconcile_capture(
    state: SessionState, receipt_state_path: Path, now: str, reference: datetime
) -> None:
    """Clear the capture requirement when a durable write landed after it armed."""
    if not state.capture_required:
        return
    captured = find_fresh_receipt(
        receipt_state_path,
        session_id=state.session_id,
        project=state.project or None,
        operations=_WRITE_OPERATIONS,
        modes=_DURABLE_MODES,
        after=state.capture_required_at or None,
        now=reference,
    )
    if captured is None:
        return
    state.capture_required = False
    state.capture_required_at = ""
    state.last_write_at = captured.recorded_at
    record_transition(
        state, "cleared-by-capture", now, "durable write receipt verified"
    )
    queue_notice(state, "capture cleared · durable write receipt verified")


def _reconcile_compact_recall(
    state: SessionState, receipt_state_path: Path, now: str, reference: datetime
) -> None:
    """Clear the read-back when the EXACT cycle has a fresh verified recall."""
    if not state.readback_required:
        return
    _recover_legacy_correlation(state, receipt_state_path, reference)
    if not state.readback_correlation_id:
        return
    verified = has_verified_compact_recall(
        receipt_state_path,
        session_id=state.session_id,
        project=state.project,
        correlation_id=state.readback_correlation_id,
        max_age_seconds=VERIFIED_RECALL_MAX_AGE_SECONDS,
        now=reference,
    )
    if not verified:
        return
    _clear_readback(state)
    record_transition(state, "cleared-by-recall", now, "direct recall receipt verified")
    queue_notice(state, "read-back cleared · direct recall receipt verified")


def _recover_legacy_correlation(
    state: SessionState, receipt_state_path: Path, reference: datetime
) -> None:
    """Adopt the live cycle id when a stored state armed without one.

    Only from the MATCHING compaction window: the cycle's start must be within
    :data:`LEGACY_CORRELATION_SKEW_SECONDS` of when the read-back armed.
    Adopting any recent cycle would let an unrelated compaction's verified
    recall clear this one.
    """
    if state.readback_correlation_id:
        return
    cycle = current_compact_cycle(
        receipt_state_path,
        session_id=state.session_id,
        project=state.project,
        max_age_seconds=LEGACY_CORRELATION_MAX_AGE_SECONDS,
        now=reference,
    )
    if cycle is None:
        return
    required = parse_iso(state.readback_required_at)
    started = parse_iso(cycle.started_at)
    if required is None or started is None:
        return
    if abs((required - started).total_seconds()) > LEGACY_CORRELATION_SKEW_SECONDS:
        return
    state.readback_correlation_id = cycle.id
    state.readback_required_at = cycle.started_at


def _expire_repair_mode(state: SessionState, now: str, reference: datetime) -> None:
    """Close repair mode once its window has elapsed."""
    if not state.repair_mode_active:
        return
    expires = parse_iso(state.repair_mode_expires_at)
    if expires is not None and reference < expires:
        return
    _clear_repair_mode(state)
    record_transition(state, "repair-expired", now, "bounded repair window elapsed")
    queue_notice(state, "repair-expired · normal enforcement resumed")


def _release_timed_out_readback(
    state: SessionState, now: str, reference: datetime
) -> None:
    """Self-release the read-back after :data:`READBACK_TIMEOUT_SECONDS`.

    THE fix behind #419. The gate stops blocking on its own, and says so — it
    does not fabricate the recall receipt it never got, because that would make
    the next gate believe a recall happened.
    """
    if not state.readback_required:
        return
    required = parse_iso(state.readback_required_at)
    if required is None:
        return
    if (reference - required).total_seconds() < READBACK_TIMEOUT_SECONDS:
        return
    _clear_readback(state)
    record_transition(
        state,
        "self-released-after-timeout",
        now,
        "15-minute read-back timeout elapsed",
    )
    queue_notice(state, "self-released-after-timeout · no recall receipt manufactured")
