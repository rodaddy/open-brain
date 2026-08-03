"""Read, merge, and atomically replace the receipt file the TypeScript gate reads.

Purpose:
    The write half of the shared state. A hook calls
    :func:`record_provider_receipt` when an operation completes, or one of the
    ``*_compact_cycle`` functions when it joins a compaction, and this module
    merges that into ``receipts.json`` without losing what another writer -- in
    either language -- put there.

Architecture:
    Read-modify-write under the shared lock, then replace the file atomically.

        ``filelock.receipt_lock``   nobody else writes while we read and merge
        ``os.replace``              a reader never sees a half-written file

    Both halves are required. The lock alone still lets a reader observe a
    partial write; the atomic replace alone still lets two writers each merge
    into a stale copy and one lose. ``os.replace`` is POSIX ``rename(2)``, the
    same call node's ``renameSync`` makes, so a TypeScript reader gets the same
    all-or-nothing guarantee a Python one does.

Pattern/Convention:
    A FOREIGN OR CORRUPT FILE READS AS EMPTY, NEVER AS AN ERROR. That is the
    TypeScript reader's behaviour (``loadReceiptState`` returns an empty state on
    a parse failure or an unrecognised ``schema``) and it has to be matched: a
    hook that raised on a malformed file would fail on every subsequent
    invocation, and the file is exactly what a crashed writer might have
    mangled.

    UNKNOWN KEYS SURVIVE A ROUND TRIP. The file carries sections this package
    does not model -- ``reflexSuppression`` is written by the TypeScript reflex
    path -- and dropping them on write would silently delete another component's
    state. They are read as opaque values and written straight back.

    THIS MODULE PRUNES NOTHING. The TypeScript writer discards entries older than
    its window on every write; Python does not, because the gate applies its own
    freshness windows when reading and an old entry is therefore already inert.
    Removing data is the operator's call, not a side effect of recording a
    receipt.

See Also:
    - ``openbrain.receipts.evidence`` - the shapes written here
    - ``openbrain.receipts.filelock`` - the cross-language lock
    - ``_ob/scripts/context-budget-gate-state.ts`` - the reader that unblocks
"""

from __future__ import annotations

import json
import os
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from openbrain.receipts.evidence import (
    RECEIPT_STATE_SCHEMA,
    CompactCycleEvidence,
    CompactCycleParticipant,
    ProviderReceiptEvidence,
)
from openbrain.receipts.filelock import ensure_private_parent, receipt_lock

#: How long a compaction cycle stays current, matching ``COMPACT_CYCLE_MAX_AGE_MS``
#: in ``receipt-state.ts``. A hook joining a cycle older than this opens a new one
#: instead, because the gate would not have accepted the old one anyway.
COMPACT_CYCLE_MAX_AGE_SECONDS = 20 * 60

#: The permissions the state file carries. Receipts name sessions and projects,
#: so the file is owner-only, as the TypeScript writer leaves it.
_PRIVATE_FILE = 0o600

#: The characters a session id or project slug may contain, matching
#: ``safeCoordinate``. These values become JSON object KEYS and are compared by
#: the gate, so anything outside this set is a coordinate that could not have
#: come from the harness.
_COORDINATE_ALPHABET = frozenset(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:@/-"
)

#: The longest a coordinate may be, matching ``safeCoordinate``.
_COORDINATE_LONGEST = 200


class ReceiptStateError(ValueError):
    """A receipt could not be recorded because its coordinates were unusable.

    Raised for a session id or project slug that could not have come from the
    harness -- empty, over-long, or carrying characters that have no place in a
    JSON key the gate matches on. The alternative is filing the receipt under a
    key the gate will never look up, which reads as "no receipt was written" and
    is far harder to diagnose than a named error the entrypoint swallows.
    """

    def __init__(self, name: str) -> None:
        """Name which coordinate was unusable.

        The VALUE is deliberately absent from the message. A session id is not a
        secret, but this error is raised from inside a hook whose logs are
        content-free by construction, and naming the field is enough to find the
        caller that passed it.
        """
        super().__init__(f"{name} is not a usable receipt coordinate")


def default_receipt_state_path() -> Path:
    """Where the shared receipt file lives, resolved exactly as TypeScript does.

    Returns:
        ``$XDG_STATE_HOME/agent-runtime/openbrain-memory/receipts.json``, falling
        back to ``~/.local/state`` when the variable is unset or empty.

    An empty ``XDG_STATE_HOME`` falls back rather than resolving to the current
    directory: ``defaultReceiptStatePath`` uses a JavaScript ``||``, which treats
    the empty string as absent, and a Python ``os.environ.get`` default would
    not. Two languages disagreeing about this would put the writer and the reader
    on different files, which presents as the gate simply never unblocking.
    """
    state_home = os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local" / "state")
    return Path(state_home) / "agent-runtime" / "openbrain-memory" / "receipts.json"


def open_compact_cycle(
    path: Path, *, session_id: str, project: str, now: datetime | None = None
) -> CompactCycleEvidence:
    """Open a compaction cycle from ``PreCompact``, the first participant.

    Args:
        path: The receipt state file.
        session_id: The Claude Code session id.
        project: The Development project slug.
        now: The moment to record, defaulting to the current UTC time.

    Returns:
        The cycle this hook is part of -- a fresh one, or the current one it
        joined.

    ``PreCompact`` is the only participant that runs while the full pre-loss
    context still exists, so it opens the cycle the later participants join. A
    SECOND ``PreCompact`` attempt means a second compaction rather than a retry,
    and starts a new cycle.
    """
    return attach_compact_cycle(
        path, session_id=session_id, project=project, participant="pre-compact", now=now
    )


def start_compact_cycle(
    path: Path, *, session_id: str, project: str, now: datetime | None = None
) -> CompactCycleEvidence:
    """Join or open a compaction cycle from ``PostCompact``.

    Args:
        path: The receipt state file.
        session_id: The Claude Code session id.
        project: The Development project slug.
        now: The moment to record, defaulting to the current UTC time.

    Returns:
        The cycle this hook is part of.

    ``PostCompact`` fires once per completed compaction. When it joins a cycle a
    ``SessionStart`` has already completed, that cycle is finished and this is a
    new compaction, so a new cycle is opened.
    """
    return attach_compact_cycle(
        path, session_id=session_id, project=project, participant="post-compact", now=now
    )


def ensure_compact_cycle(
    path: Path, *, session_id: str, project: str, now: datetime | None = None
) -> CompactCycleEvidence:
    """Join or open a compaction cycle from ``SessionStart``.

    Args:
        path: The receipt state file.
        session_id: The Claude Code session id.
        project: The Development project slug.
        now: The moment to record, defaulting to the current UTC time.

    Returns:
        The cycle whose ``id`` a following recall receipt must carry to clear the
        gate's post-compaction read-back.

    This is the call that matters most to the unblock: the gate stores the
    cycle's id as its ``readbackCorrelationId``, and clears only when a
    ``recall``/``compact``/``verified-remote`` receipt names that exact id.
    """
    return attach_compact_cycle(
        path,
        session_id=session_id,
        project=project,
        participant="session-start",
        now=now,
    )


def attach_compact_cycle(
    path: Path,
    *,
    session_id: str,
    project: str,
    participant: CompactCycleParticipant,
    now: datetime | None = None,
) -> CompactCycleEvidence:
    """Record ``participant`` against the session's cycle, opening one if needed.

    Args:
        path: The receipt state file.
        session_id: The Claude Code session id.
        project: The Development project slug.
        participant: Which lifecycle hook is joining.
        now: The moment to record, defaulting to the current UTC time.

    Returns:
        The cycle the participant is now attached to.

    Raises:
        ReceiptStateError: ``session_id`` or ``project`` is not a usable
            coordinate.
    """
    session_id = _safe_coordinate(session_id, "session_id")
    project = _safe_coordinate(project, "project")
    moment = now if now is not None else datetime.now(UTC)

    with receipt_lock(path):
        state = _load(path)
        cycles = _mapping(state.get("compactCycles"))
        existing = _existing_cycle(cycles.get(session_id), project, moment)
        cycle = (
            existing.with_participant(participant, attempted=True)
            if existing is not None and not _starts_new_cycle(existing, participant)
            else _fresh_cycle(session_id, project, participant, moment)
        )
        cycles[session_id] = cycle.model_dump(by_alias=True, exclude_none=True)
        state["compactCycles"] = cycles
        _write(path, state)
        return cycle


def record_provider_receipt(
    path: Path, receipt: ProviderReceiptEvidence
) -> ProviderReceiptEvidence:
    """File one receipt, and credit its compaction cycle when it names one.

    Args:
        path: The receipt state file.
        receipt: The evidence to record. Build its ``mode`` with
            :func:`~openbrain.receipts.evidence.receipt_mode` rather than by
            hand -- an over-stated mode is a receipt that lies to the gate.

    Returns:
        The receipt as filed.

    Raises:
        ReceiptStateError: The receipt's session id or project is not a usable
            coordinate.

    The receipt lands in three places, all of which the gate reads:
    ``sessions[sessionId][operation]`` (the latest of each operation),
    ``triggerReceipts[sessionId][key]`` (kept per trigger and correlation, so a
    compaction recall is not overwritten by an unrelated one), and -- when it
    names a live cycle -- that cycle's ``participants``. A
    ``recall``/``compact``/``verified-remote`` receipt additionally stamps the
    cycle's ``verifiedRecallAt``, which IS the post-compaction unblock.
    """
    session_id = _safe_coordinate(receipt.session_id, "session_id")
    project = _safe_coordinate(receipt.project, "project")
    filed = receipt.model_copy(update={"session_id": session_id, "project": project})
    encoded = filed.model_dump(by_alias=True, exclude_none=True)

    with receipt_lock(path):
        state = _load(path)
        _file_receipt(state, filed, encoded)
        _credit_cycle(state, filed)
        _write(path, state)

    return filed


def _file_receipt(
    state: dict[str, Any], receipt: ProviderReceiptEvidence, encoded: dict[str, Any]
) -> None:
    """Store the receipt under both the per-operation and per-trigger keys.

    Two indexes because the gate asks two different questions. ``sessions`` keeps
    only the newest receipt per operation, which answers "has anything been
    captured lately"; ``triggerReceipts`` keeps one per operation/trigger/cycle,
    which answers "did THIS compaction's recall happen" without an unrelated
    later recall overwriting the answer.
    """
    sessions = _mapping(state.get("sessions"))
    session = _mapping(sessions.get(receipt.session_id))
    session[receipt.operation] = encoded
    sessions[receipt.session_id] = session
    state["sessions"] = sessions

    trigger_receipts = _mapping(state.get("triggerReceipts"))
    per_session = _mapping(trigger_receipts.get(receipt.session_id))
    per_session[receipt.trigger_key()] = encoded
    trigger_receipts[receipt.session_id] = per_session
    state["triggerReceipts"] = trigger_receipts


def _credit_cycle(state: dict[str, Any], receipt: ProviderReceiptEvidence) -> None:
    """Add the receipt's participant to its cycle, and stamp a verified recall.

    Does nothing unless the receipt carries a ``correlation_id`` matching a
    stored cycle of the same project. That guard is the point of the correlation
    id: a recall from an EARLIER compaction must not clear the read-back the
    current one armed, and without the id check it would.
    """
    cycles = _mapping(state.get("compactCycles"))
    stored = cycles.get(receipt.session_id)
    cycle = _decode_cycle(stored)
    if cycle is None or receipt.correlation_id != cycle.id:
        return
    if receipt.project != cycle.project:
        return

    participant = _compact_participant(receipt)
    if participant is not None:
        cycle = cycle.with_participant(participant, attempted=False)

    if (
        receipt.operation == "recall"
        and receipt.trigger == "compact"
        and receipt.mode == "verified-remote"
    ):
        cycle = cycle.model_copy(update={"verified_recall_at": receipt.recorded_at})

    cycles[receipt.session_id] = cycle.model_dump(by_alias=True, exclude_none=True)
    state["compactCycles"] = cycles


def _compact_participant(
    receipt: ProviderReceiptEvidence,
) -> CompactCycleParticipant | None:
    """Which cycle participant a SUCCESSFUL receipt proves ran.

    Returns:
        The participant, or ``None`` when the receipt proves nothing -- a failed
        write, or an operation that is not part of a compaction.

    A straight port of ``compactParticipant``. A failed receipt credits nobody:
    ``participants`` records what actually happened, and the attempt is already
    in ``attemptedParticipants``.
    """
    if receipt.mode == "failed":
        return None
    if receipt.operation == "checkpoint" and receipt.trigger == "pre-compact":
        return "pre-compact"
    if receipt.operation == "checkpoint" and receipt.trigger == "post-compact":
        return "post-compact"
    if receipt.operation == "recall" and receipt.trigger == "compact":
        return "session-start"
    return None


def _existing_cycle(
    stored: object, project: str, now: datetime
) -> CompactCycleEvidence | None:
    """The session's current cycle, or ``None`` when there is nothing to join.

    ``None`` covers all four ways a stored cycle is not joinable: absent,
    undecodable, belonging to another project, and older than the window the gate
    would accept.
    """
    cycle = _decode_cycle(stored)
    if cycle is None or cycle.project != project:
        return None

    started = _parse_moment(cycle.started_at)
    if started is None:
        return None
    if (now - started).total_seconds() > COMPACT_CYCLE_MAX_AGE_SECONDS:
        return None

    return cycle


def _starts_new_cycle(
    existing: CompactCycleEvidence, participant: CompactCycleParticipant
) -> bool:
    """Whether this participant's arrival means a SECOND compaction, not a retry.

    Two cases, both ported from ``attachCompactCycle``. A repeat ``pre-compact``
    is a new compaction, because that hook fires once before each one. A repeat
    ``post-compact`` is a new compaction only once a ``session-start`` has
    succeeded in the current cycle -- until then the cycle is still mid-flight
    and the repeat is the same compaction being re-observed.
    """
    if participant == "pre-compact":
        return "pre-compact" in existing.attempted_participants
    if participant == "post-compact":
        return (
            "post-compact" in existing.attempted_participants
            and "session-start" in existing.participants
        )
    return False


def _fresh_cycle(
    session_id: str,
    project: str,
    participant: CompactCycleParticipant,
    now: datetime,
) -> CompactCycleEvidence:
    """A newly opened cycle with this participant recorded as having run."""
    return CompactCycleEvidence(
        id=str(uuid.uuid4()),
        project=project,
        session_id=session_id,
        started_at=_iso(now),
        participants=[],
        attempted_participants=[participant],
    )


def _decode_cycle(stored: object) -> CompactCycleEvidence | None:
    """Parse a stored cycle, treating anything unrecognisable as absent.

    A cycle written by a future version, or mangled by a crashed writer, must not
    raise here: the caller would then be unable to open a NEW cycle and the
    session would stay blocked on unreadable state forever. Returning ``None``
    lets a fresh cycle replace it.
    """
    if not isinstance(stored, dict):
        return None
    try:
        return CompactCycleEvidence.model_validate(stored)
    except ValueError:
        return None


def _load(path: Path) -> dict[str, Any]:
    """Read the state file, or an empty state when it is absent or unusable.

    Mirrors ``loadReceiptState``: a missing file, unparseable JSON, a non-object
    document, or a ``schema`` value this version does not recognise all read as
    empty. Failing loudly instead would turn one bad write into a permanently
    broken hook, and the file is exactly what a crashed writer may have mangled.

    Keys this package does not model are kept as they were found, so a section
    another component owns survives being written back.
    """
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return _empty()

    if not isinstance(document, dict):
        return _empty()
    if document.get("schema") != RECEIPT_STATE_SCHEMA:
        return _empty()

    state: dict[str, Any] = dict(document)
    state["sessions"] = _mapping(state.get("sessions"))
    state["compactCycles"] = _mapping(state.get("compactCycles"))
    return state


def _empty() -> dict[str, Any]:
    """A state document carrying nothing but the schema the gate recognises."""
    return {"schema": RECEIPT_STATE_SCHEMA, "sessions": {}, "compactCycles": {}}


def _write(path: Path, state: dict[str, Any]) -> None:
    """Replace the state file atomically, owner-only, with the caller's lock held.

    Writes a staging file beside the target, flushes it to disk, then
    ``os.replace``s it over the target. ``os.replace`` is POSIX ``rename(2)``:
    within a filesystem it is atomic, so a concurrent reader -- in either
    language -- sees either the whole old file or the whole new one and never a
    truncated document.

    The staging name carries the pid and the moment so two writers cannot collide
    on it, matching the TypeScript writer's ``${path}.${pid}.${now}.tmp``, and it
    is opened exclusively so an existing file is never silently overwritten.
    """
    ensure_private_parent(path)
    staging = path.with_name(f"{path.name}.{os.getpid()}.{int(time.time() * 1000)}.tmp")
    encoded = json.dumps(state, indent=2)

    descriptor = os.open(
        staging, os.O_CREAT | os.O_EXCL | os.O_WRONLY, _PRIVATE_FILE
    )
    try:
        os.write(descriptor, encoded.encode("utf-8"))
        os.fsync(descriptor)
    finally:
        os.close(descriptor)

    # The open mode is masked by the umask, so the explicit chmod is what
    # actually makes the file owner-only -- before it is put in place, so the
    # target is never briefly readable.
    staging.chmod(_PRIVATE_FILE)
    os.replace(staging, path)
    path.chmod(_PRIVATE_FILE)


def _mapping(value: object) -> dict[str, Any]:
    """A stored sub-object as a mutable dict, or an empty one when it is not one."""
    return dict(value) if isinstance(value, dict) else {}


def _iso(moment: datetime) -> str:
    """Format a moment the way the gate parses it: UTC, ``Z``-suffixed, millis.

    ``Date.parse`` on the reader side accepts a ``+00:00`` offset too, but the
    whole existing file is written with ``Z`` and matching it keeps a
    hand-inspected file uniform. Millisecond precision matches
    ``toISOString()``; Python's default microseconds would still parse, but the
    two languages writing visibly different shapes into one file is the kind of
    difference that gets mistaken for a bug later.
    """
    return (
        moment.astimezone(UTC)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _parse_moment(value: str) -> datetime | None:
    """Parse a stored ISO timestamp, or ``None`` when it is not one.

    Accepts the ``Z`` suffix that ``toISOString`` produces, which
    ``datetime.fromisoformat`` handles natively from 3.11. A value that does not
    parse is treated as absent rather than as an error, matching the reader's
    ``Number.isFinite(Date.parse(...))`` guard.
    """
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None

    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def _safe_coordinate(value: str, name: str) -> str:
    """Validate a value that becomes a JSON key the gate matches on.

    Args:
        value: The session id or project slug.
        name: Which one, for the error message.

    Returns:
        The value, trimmed.

    Raises:
        ReceiptStateError: It is empty, over-long, or carries a character outside
            the alphabet ``safeCoordinate`` allows.

    The alphabet is not decoration. These strings are object keys the gate looks
    up by exact match; one carrying a newline or a quote would either be filed
    where nothing looks for it or make the document awkward to inspect by hand.
    """
    text = value.strip()
    if not text or len(text) > _COORDINATE_LONGEST:
        raise ReceiptStateError(name)
    if not set(text) <= _COORDINATE_ALPHABET:
        raise ReceiptStateError(name)
    return text
