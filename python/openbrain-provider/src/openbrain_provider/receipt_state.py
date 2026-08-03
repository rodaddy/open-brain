"""Read the provider receipt state both runtimes share.

`~/.local/state/agent-runtime/openbrain-memory/receipts.json` is the ONE file
the context-budget gate reads to decide whether a durable write or a
post-compact recall actually happened. Its schema is owned by
`_ob/scripts/ob-memory-provider/receipt-state.ts`; this module is a reader of
that same file, not a second definition of it.

**This module reads receipts and writes exactly one thing: the compact cycle
the gate itself participates in.** Receipts are written by the provider
capture/checkpoint/recall paths (PROV-6, #415), which are a different lane, and
nothing here constructs one. The gate must be able to OPEN a compact cycle
because the correlation id is what the read-back banner prints and what the
clear path compares against — arming with no id would print an uncorrelated
command that the allowance then refuses, which is the deadlock this port exists
to remove (`context-budget-gate.ts:280-286`, `gateCompactCycle`).

That one write uses the same exclusive-create lock protocol and the same atomic
temp-file rename as the TypeScript writer (`receipt-state.ts:466-498`), so the
two can run concurrently during the changeover without either seeing a partial
file.

The schema constants below are transcribed from the TypeScript with line
citations so a drift is a diff rather than a mystery.

What it does NOT do: it does not decide what the gate should do with the
evidence (that is `gate_state.py`), and it does not construct receipts.
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Final
from uuid import uuid4

__all__ = [
    "MEMORY_CONTRACT",
    "MEMORY_CONTRACT_SCHEMA_HASH",
    "MEMORY_CONTRACT_SCHEMA_VERSION",
    "RECEIPT_STATE_SCHEMA",
    "CompactCycle",
    "ReceiptEvidence",
    "current_compact_cycle",
    "default_receipt_state_path",
    "find_fresh_receipt",
    "gate_compact_cycle",
    "has_verified_compact_recall",
    "is_correlation_id",
    "parse_iso",
]

#: receipt-state.ts:417 — a file declaring any other schema is read as empty.
RECEIPT_STATE_SCHEMA: Final[str] = "development.openbrain-memory-receipts.v1"

#: receipt-state.ts:92-95. A receipt whose contract triple does not match
#: exactly is ignored (receipt-state.ts:337-339): an old receipt written under a
#: superseded contract is not evidence about the current one.
MEMORY_CONTRACT: Final[str] = "2026-07-23.memory-tools.v23"
MEMORY_CONTRACT_SCHEMA_VERSION: Final[int] = 1
MEMORY_CONTRACT_SCHEMA_HASH: Final[str] = (
    "4b69e9b437c96175531b049b6e3c2782f383334e9e1931e96e73835599e4a4a8"
)

#: receipt-state.ts:98 — a compact cycle older than this is not the current one.
COMPACT_CYCLE_MAX_AGE_SECONDS: Final[float] = 20 * 60.0
#: receipt-state.ts:99 — a verified recall older than this no longer clears.
VERIFIED_RECALL_MAX_AGE_SECONDS: Final[float] = 2 * 60.0
#: receipt-state.ts:328 — the default freshness window for a receipt query.
DEFAULT_RECEIPT_MAX_AGE_SECONDS: Final[float] = 20 * 60.0

#: receipt-state.ts:586. A correlation id that is not a v4 UUID is refused
#: rather than compared, so a hand-typed or truncated id can never accidentally
#: equal a cycle id.
_CORRELATION_ID_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)


def default_receipt_state_path(env: dict[str, str] | None = None) -> Path:
    """Return the receipt state path the TypeScript writer uses.

    Args:
        env: Environment mapping. Defaults to ``os.environ``.

    Returns:
        ``$XDG_STATE_HOME/agent-runtime/openbrain-memory/receipts.json``, falling
        back to ``~/.local/state`` — byte-identical to receipt-state.ts:105-108.
    """
    import os

    source = dict(os.environ) if env is None else env
    state_home = source.get("XDG_STATE_HOME", "").strip()
    root = Path(state_home) if state_home else Path.home() / ".local" / "state"
    return root / "agent-runtime" / "openbrain-memory" / "receipts.json"


def is_correlation_id(value: object) -> bool:
    """Report whether a value is a well-formed v4 correlation id.

    Args:
        value: Candidate id.

    Returns:
        True only for a lowercase v4 UUID string.
    """
    return isinstance(value, str) and bool(_CORRELATION_ID_PATTERN.match(value))


def parse_iso(value: object) -> datetime | None:
    """Parse an ISO-8601 timestamp the way ``Date.parse`` does for our writers.

    Args:
        value: Candidate timestamp, normally ``...Z``.

    Returns:
        An aware datetime, or None when the value is absent or unparseable. The
        TypeScript treats an unparseable timestamp as "not fresh" rather than
        raising, and every caller here does the same.
    """
    if not isinstance(value, str) or not value:
        return None
    text = value.replace("Z", "+00:00") if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


@dataclass(frozen=True)
class ReceiptEvidence:
    """One recorded provider receipt.

    Attributes:
        operation: ``recall``, ``capture``, ``checkpoint``, or ``wrap``.
        mode: ``verified-remote``, ``durable-spool``, or ``failed``.
        status: The writer's own status word.
        project: Development project slug the receipt belongs to.
        session_id: Session the receipt belongs to.
        trigger: What caused the write.
        recorded_at: When the writer recorded it.
        correlation_id: Compact-cycle id, when the receipt is part of one.
    """

    operation: str
    mode: str
    status: str
    project: str
    session_id: str
    trigger: str
    recorded_at: str
    correlation_id: str | None = None

    @property
    def recorded_at_time(self) -> datetime | None:
        """Return ``recorded_at`` parsed, or None when it is unusable."""
        return parse_iso(self.recorded_at)


@dataclass(frozen=True)
class CompactCycle:
    """One compaction, shared by every hook that participates in it.

    Attributes:
        id: The correlation id every participant quotes.
        project: Development project slug.
        session_id: Session the compaction happened in.
        started_at: When the cycle was opened.
        verified_recall_at: When a verified recall landed, if one has.
    """

    id: str
    project: str
    session_id: str
    started_at: str
    verified_recall_at: str | None = None


def _load_state(path: Path) -> dict[str, Any]:
    """Read the receipt state file, or an empty state.

    A corrupt, foreign-schema, or unreadable file reads as empty rather than
    raising: this state is evidence, and absent evidence is a normal answer
    (receipt-state.ts:410-434). The gate then keeps enforcing, which is the
    fail-closed direction for a gate.

    Args:
        path: Receipt state file.

    Returns:
        The parsed state, or ``{}`` when it cannot be used.
    """
    try:
        raw = path.read_text(encoding="utf8")
    except OSError:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    if not isinstance(parsed, dict):
        return {}
    if parsed.get("schema") != RECEIPT_STATE_SCHEMA:
        return {}
    if not isinstance(parsed.get("sessions"), dict):
        return {}
    return parsed


def _evidence_from(entry: object) -> ReceiptEvidence | None:
    """Build a :class:`ReceiptEvidence` from a raw JSON entry.

    Contract-triple and `fallbackAttempted` checks live here rather than at the
    query, so an entry that fails them is never constructed at all.

    Args:
        entry: A raw receipt object from the state file.

    Returns:
        The evidence, or None when the entry is malformed or off-contract.
    """
    if not isinstance(entry, dict):
        return None
    if entry.get("contract") != MEMORY_CONTRACT:
        return None
    if entry.get("contractSchemaVersion") != MEMORY_CONTRACT_SCHEMA_VERSION:
        return None
    if entry.get("contractSchemaHash") != MEMORY_CONTRACT_SCHEMA_HASH:
        return None
    # receipt-state.ts:336 — `!== false` rejects a missing field too, so a
    # receipt that never recorded the flag is not treated as if it had.
    if entry.get("fallbackAttempted") is not False:
        return None
    required = ("operation", "mode", "status", "project", "sessionId", "trigger")
    if any(not isinstance(entry.get(field), str) for field in required):
        return None
    recorded_at = entry.get("recordedAt")
    if not isinstance(recorded_at, str):
        return None
    correlation = entry.get("correlationId")
    return ReceiptEvidence(
        operation=str(entry["operation"]),
        mode=str(entry["mode"]),
        status=str(entry["status"]),
        project=str(entry["project"]),
        session_id=str(entry["sessionId"]),
        trigger=str(entry["trigger"]),
        recorded_at=recorded_at,
        correlation_id=correlation if isinstance(correlation, str) else None,
    )


def _session_candidates(
    state: dict[str, Any], session_id: str
) -> list[ReceiptEvidence]:
    """Collect every usable receipt recorded for one session.

    Both stores are read — the per-operation `sessions` map and the
    `triggerReceipts` map — because the writer records into both and the newer
    evidence can be in either (receipt-state.ts:320-324).

    Args:
        state: Parsed receipt state.
        session_id: Session to collect for.

    Returns:
        Every parseable receipt for that session, unsorted.
    """
    candidates: list[ReceiptEvidence] = []
    sessions = state.get("sessions")
    if isinstance(sessions, dict):
        operations = sessions.get(session_id)
        if isinstance(operations, dict):
            candidates.extend(
                evidence
                for entry in operations.values()
                if (evidence := _evidence_from(entry)) is not None
            )
    trigger_receipts = state.get("triggerReceipts")
    if isinstance(trigger_receipts, dict):
        session_triggers = trigger_receipts.get(session_id)
        if isinstance(session_triggers, dict):
            candidates.extend(
                evidence
                for entry in session_triggers.values()
                if (evidence := _evidence_from(entry)) is not None
            )
    return candidates


def find_fresh_receipt(
    path: Path,
    *,
    session_id: str,
    modes: tuple[str, ...],
    operations: tuple[str, ...],
    project: str | None = None,
    trigger: str | None = None,
    after: str | None = None,
    max_age_seconds: float = DEFAULT_RECEIPT_MAX_AGE_SECONDS,
    now: datetime | None = None,
) -> ReceiptEvidence | None:
    """Return the newest receipt matching every constraint, or None.

    Args:
        path: Receipt state file.
        session_id: Session the receipt must belong to.
        modes: Acceptable modes. A `failed` receipt is evidence of a failure,
            never of a write, so callers pass only the modes they accept.
        operations: Acceptable operations.
        project: Project the receipt must belong to, when scoping matters.
        trigger: Trigger the receipt must carry, when it matters.
        after: Only receipts recorded at or after this instant count. This is
            what stops a receipt written BEFORE the gate armed from clearing it.
        max_age_seconds: How old a receipt may be and still count.
        now: Reference time; defaults to the current instant.

    Returns:
        The newest qualifying receipt, or None when there is no evidence.
    """
    state = _load_state(path)
    reference = now or datetime.now(UTC)
    after_time = parse_iso(after) if after else None

    qualifying: list[tuple[datetime, ReceiptEvidence]] = []
    for evidence in _session_candidates(state, session_id):
        if evidence.operation not in operations:
            continue
        recorded = evidence.recorded_at_time
        if recorded is None:
            continue
        if after_time is not None and recorded < after_time:
            continue
        if (reference - recorded).total_seconds() > max_age_seconds:
            continue
        if project and evidence.project != project:
            continue
        if evidence.mode not in modes:
            continue
        if trigger and evidence.trigger != trigger:
            continue
        qualifying.append((recorded, evidence))

    if not qualifying:
        return None
    qualifying.sort(key=lambda pair: pair[0], reverse=True)
    return qualifying[0][1]


def _cycle_from(entry: object) -> CompactCycle | None:
    """Build a :class:`CompactCycle` from a raw JSON entry.

    Args:
        entry: Raw cycle object.

    Returns:
        The cycle, or None when the entry is malformed.
    """
    if not isinstance(entry, dict):
        return None
    required = ("id", "project", "sessionId", "startedAt")
    if any(not isinstance(entry.get(field), str) for field in required):
        return None
    verified = entry.get("verifiedRecallAt")
    return CompactCycle(
        id=str(entry["id"]),
        project=str(entry["project"]),
        session_id=str(entry["sessionId"]),
        started_at=str(entry["startedAt"]),
        verified_recall_at=verified if isinstance(verified, str) else None,
    )


def current_compact_cycle(
    path: Path,
    *,
    session_id: str,
    project: str,
    max_age_seconds: float = COMPACT_CYCLE_MAX_AGE_SECONDS,
    now: datetime | None = None,
) -> CompactCycle | None:
    """Return the session's live compact cycle, or None.

    Args:
        path: Receipt state file.
        session_id: Session to look up.
        project: Project the cycle must belong to; a cycle from another project
            is a different piece of work and never matches.
        max_age_seconds: How old the cycle may be and still be current.
        now: Reference time; defaults to the current instant.

    Returns:
        The cycle, or None when there is none, it belongs elsewhere, or it has
        aged out.
    """
    state = _load_state(path)
    cycles = state.get("compactCycles")
    if not isinstance(cycles, dict):
        return None
    cycle = _cycle_from(cycles.get(session_id))
    if cycle is None or cycle.project != project:
        return None
    started = parse_iso(cycle.started_at)
    if started is None:
        return None
    reference = now or datetime.now(UTC)
    if (reference - started).total_seconds() > max_age_seconds:
        return None
    return cycle


def has_verified_compact_recall(
    path: Path,
    *,
    session_id: str,
    project: str,
    correlation_id: str,
    max_age_seconds: float = VERIFIED_RECALL_MAX_AGE_SECONDS,
    now: datetime | None = None,
) -> bool:
    """Report whether the EXACT named compact cycle has a fresh verified recall.

    The exactness is the point. A previous compaction's verified recall must not
    satisfy a new one, which is why the correlation id is compared rather than
    just looking for any recent recall (receipt-state.ts:236-244).

    Args:
        path: Receipt state file.
        session_id: Session to look up.
        project: Project the cycle must belong to.
        correlation_id: The cycle id the gate is waiting on.
        max_age_seconds: How old the recall may be and still count.
        now: Reference time; defaults to the current instant.

    Returns:
        True only when this session's current cycle IS that id and carries a
        fresh ``verifiedRecallAt``.
    """
    if not is_correlation_id(correlation_id):
        return False
    state = _load_state(path)
    cycles = state.get("compactCycles")
    if not isinstance(cycles, dict):
        return False
    cycle = _cycle_from(cycles.get(session_id))
    if cycle is None or cycle.project != project or cycle.id != correlation_id:
        return False
    if cycle.verified_recall_at is None:
        return False
    recalled = parse_iso(cycle.verified_recall_at)
    if recalled is None:
        return False
    reference = now or datetime.now(UTC)
    return (reference - recalled).total_seconds() <= max_age_seconds


#: receipt-state.ts:100-102 — how long to wait for another writer's lock, and
#: when to treat a lock nobody released as abandoned. These are the TypeScript
#: writer's own values; both processes must agree or one will reclaim a lock the
#: other still holds.
_LOCK_WAIT_SECONDS: Final[float] = 5.0
_STALE_LOCK_SECONDS: Final[float] = 30.0
_LOCK_RETRY_SECONDS: Final[float] = 0.01


def _iso(moment: datetime) -> str:
    """Render an instant the way JavaScript's ``toISOString`` does.

    Args:
        moment: The instant.

    Returns:
        UTC, millisecond precision, ``Z`` suffix. The file is read by both
        runtimes, so the spelling has to agree.
    """
    utc = moment.astimezone(UTC)
    return f"{utc.strftime('%Y-%m-%dT%H:%M:%S')}.{utc.microsecond // 1000:03d}Z"


def _write_state(path: Path, state: dict[str, Any]) -> None:
    """Write the receipt state atomically and privately.

    Args:
        path: Receipt state file.
        state: The whole state to write.

    A temp file in the same directory, fsynced, then renamed: a reader either
    sees the old file or the new one, never a half-written one. Mode 0600
    throughout, matching receipt-state.ts:471-481, because this state names
    sessions and projects.
    """
    import os

    encoded = json.dumps(state, indent=2, ensure_ascii=False)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.parent.chmod(0o700)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.{time.time_ns()}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf8") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    temporary.replace(path)
    path.chmod(0o600)


@contextmanager
def _receipt_lock(path: Path) -> Iterator[None]:
    """Hold the receipt state's cross-process lock.

    Args:
        path: Receipt state file.

    Yields:
        Control, with the lock held.

    Raises:
        TimeoutError: When another writer holds the lock past
            :data:`_LOCK_WAIT_SECONDS`. The caller treats that as "no cycle",
            which keeps the gate blocking rather than arming with a wrong id.

    The lock is an exclusively-created sibling file holding an owner token, the
    same protocol as receipt-state.ts:483-498. A lock whose mtime is older than
    :data:`_STALE_LOCK_SECONDS` is reclaimed, because a process killed mid-write
    would otherwise wedge every later hook.
    """
    import os

    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_name(f"{path.name}.lock")
    token = f"{os.getpid()}:{time.time_ns()}:{uuid4()}"
    deadline = time.monotonic() + _LOCK_WAIT_SECONDS

    while not _create_owned_lock(lock_path, token):
        if _lock_is_stale(lock_path):
            lock_path.unlink(missing_ok=True)
            continue
        if time.monotonic() >= deadline:
            raise TimeoutError("receipt state lock timed out")
        time.sleep(_LOCK_RETRY_SECONDS)
    try:
        yield
    finally:
        _release_owned_lock(lock_path, token)


def _create_owned_lock(lock_path: Path, token: str) -> bool:
    """Create the lock file exclusively and stamp it with an owner token.

    Args:
        lock_path: The lock file.
        token: This process's owner token.

    Returns:
        True when this process created it; False when someone else holds it.
    """
    import os

    try:
        descriptor = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return False
    except OSError:
        return False
    with os.fdopen(descriptor, "w", encoding="utf8") as handle:
        handle.write(token)
        handle.flush()
        os.fsync(handle.fileno())
    return True


def _lock_is_stale(lock_path: Path) -> bool:
    """Report whether a lock has been held longer than any writer should need."""
    try:
        age = time.time() - lock_path.stat().st_mtime
    except OSError:
        return False
    return age > _STALE_LOCK_SECONDS


def _release_owned_lock(lock_path: Path, token: str) -> None:
    """Remove the lock only if this process still owns it.

    Args:
        lock_path: The lock file.
        token: This process's owner token.

    Checking the token first is what stops a process whose lock was reclaimed as
    stale from deleting the NEW owner's lock on its way out.
    """
    try:
        if lock_path.read_text(encoding="utf8") == token:
            lock_path.unlink(missing_ok=True)
    except OSError:
        return


def gate_compact_cycle(
    path: Path,
    *,
    session_id: str,
    project: str,
    now: datetime | None = None,
    max_age_seconds: float = COMPACT_CYCLE_MAX_AGE_SECONDS,
) -> CompactCycle | None:
    """Join the session's live compact cycle, or open one as the gate.

    This is the ONE write this module makes, and it exists because the
    correlation id is what the read-back banner prints and what the clear path
    compares. Arming a read-back with no id would print a command the allowance
    refuses (`gate_shell._valid_provider_payload`), which is precisely the
    self-inflicted deadlock #419 is about.

    Args:
        path: Receipt state file.
        session_id: Session opening or joining the cycle.
        project: Project the cycle belongs to.
        now: Reference time; defaults to the current instant.
        max_age_seconds: How old an existing cycle may be and still be joined.

    Returns:
        The joined or newly-opened cycle, or None when the lock could not be
        taken. None keeps the gate blocking without a correlation id rather than
        inventing one that no provider will ever match.
    """
    reference = now or datetime.now(UTC)
    try:
        with _receipt_lock(path):
            state = _load_state(path)
            if not state:
                state = {
                    "schema": RECEIPT_STATE_SCHEMA,
                    "sessions": {},
                    "compactCycles": {},
                }
            cycles = state.get("compactCycles")
            if not isinstance(cycles, dict):
                cycles = {}
                state["compactCycles"] = cycles

            existing = _cycle_from(cycles.get(session_id))
            if existing is not None and existing.project == project:
                started = parse_iso(existing.started_at)
                fresh = (
                    started is not None
                    and (reference - started).total_seconds() <= max_age_seconds
                )
                if fresh:
                    _record_attempt(cycles[session_id], "gate")
                    _write_state(path, state)
                    return existing

            cycle = CompactCycle(
                id=str(uuid4()),
                project=project,
                session_id=session_id,
                started_at=_iso(reference),
            )
            cycles[session_id] = {
                "id": cycle.id,
                "project": cycle.project,
                "sessionId": cycle.session_id,
                "startedAt": cycle.started_at,
                "participants": [],
                "attemptedParticipants": ["gate"],
            }
            _write_state(path, state)
            return cycle
    except (TimeoutError, OSError):
        return None


def _record_attempt(entry: object, participant: str) -> None:
    """Note that a participant tried to join an existing cycle.

    Args:
        entry: The raw cycle object being joined.
        participant: The participant name.

    The TypeScript tracks attempted participants separately from successful ones
    (receipt-state.ts:188-194), and the difference is diagnostic: a hook that
    attempted and never succeeded is exactly what a stuck cycle looks like.
    """
    if not isinstance(entry, dict):
        return
    attempted = entry.get("attemptedParticipants")
    if not isinstance(attempted, list):
        attempted = []
        entry["attemptedParticipants"] = attempted
    if participant not in attempted:
        attempted.append(participant)
