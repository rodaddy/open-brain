"""Drive the gates the way a hook does, and write the receipts they read.

Purpose:
    The behaviour tests need three things the gates do not provide: a scratch
    state directory, a way to invoke a gate with one event and read its answer,
    and a way to PUT a provider receipt on disk so the gate has evidence to
    reconcile against.

Architecture:
    A helper module, not a test. ``record_receipt`` is the only writer of a
    receipt anywhere in this package -- the gates read receipts and never write
    one -- so it lives here, in the tests, rather than being a production
    function with only test callers.

Pattern/Convention:
    ``run_gate`` calls ``main()`` in-process with explicit streams rather than
    spawning a subprocess. Same code path, no interpreter start per case, and a
    failure surfaces as a Python traceback instead of an exit code.

See Also:
    - ``_ob/scripts/context-budget-gate-test-helpers.ts`` -- the TypeScript
      equivalent these are ported from
"""

from __future__ import annotations

import io
import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4

from openbrain_provider import context_budget_gate, policy_refresh_gate
from openbrain_provider.development_scope import development_root
from openbrain_provider.receipt_state import (
    MEMORY_CONTRACT,
    MEMORY_CONTRACT_SCHEMA_HASH,
    MEMORY_CONTRACT_SCHEMA_VERSION,
    RECEIPT_STATE_SCHEMA,
)

__all__ = [
    "PROJECT",
    "SESSION",
    "GatePaths",
    "GateResult",
    "arm_readback",
    "gate_paths",
    "iso",
    "read_session_state",
    "receipt_mode",
    "record_receipt",
    "run_gate",
    "run_policy_gate",
    "start_compact_cycle",
    "write_session_state",
]

#: The Development directory every test claims to run from, so the gate resolves
#: a real project rather than falling silent outside its lane.
#:
#: Read from the production constant rather than repeated as a literal: on a
#: machine without Rico's volume, `conftest.py` provisions a stand-in root and
#: points the override at it, and a second hardcoded copy here would send the
#: gate a cwd outside the root it actually resolved against.
DEVELOPMENT_CWD = str(development_root())
PROJECT = development_root().name
SESSION = "gate-session"


def iso(moment: datetime) -> str:
    """Render an instant the way the gates do."""
    utc = moment.astimezone(UTC)
    return f"{utc.strftime('%Y-%m-%dT%H:%M:%S')}.{utc.microsecond // 1000:03d}Z"


def minutes_ago(minutes: float) -> str:
    """Return an instant that many minutes in the past."""
    return iso(datetime.now(UTC) - timedelta(minutes=minutes))


@dataclass(frozen=True)
class GatePaths:
    """The scratch files one test's gate invocations share."""

    root: Path
    state: Path
    receipts: Path
    settings: Path
    policy_state: Path
    spool: Path


def gate_paths(root: Path) -> GatePaths:
    """Create a scratch directory with the files a gate expects.

    Args:
        root: A pytest tmp directory.

    Returns:
        The paths, with an empty settings file already written.
    """
    root.mkdir(parents=True, exist_ok=True)
    settings = root / "settings.json"
    settings.write_text("{}", encoding="utf8")
    return GatePaths(
        root=root,
        state=root / "gate.json",
        receipts=root / "receipts.json",
        settings=settings,
        policy_state=root / "policy-state.json",
        spool=root / "spool.jsonl",
    )


@dataclass(frozen=True)
class GateResult:
    """One gate invocation's answer."""

    stdout: str
    code: int

    @property
    def json(self) -> dict[str, Any]:
        """Return stdout parsed as JSON.

        Raises:
            AssertionError: If stdout is not JSON -- which in a test asserting
                on a verdict means the gate emitted something else entirely.
        """
        try:
            return dict(json.loads(self.stdout))
        except json.JSONDecodeError as error:
            raise AssertionError(f"stdout is not JSON: {self.stdout!r}") from error

    @property
    def blocked(self) -> bool:
        """Report whether this answer is a block verdict."""
        return '"decision":"block"' in self.stdout


def run_gate(
    paths: GatePaths,
    event: str,
    payload: dict[str, Any] | None = None,
    extra: list[str] | None = None,
    *,
    project: str | None = PROJECT,
    session_id: str = SESSION,
) -> GateResult:
    """Invoke the context-budget gate once.

    Args:
        paths: The scratch paths.
        event: The gate event.
        payload: The hook stdin. Defaults to a Development session.
        extra: Extra arguments.
        project: Explicit project, or None to let the cwd decide.
        session_id: Session the event belongs to.

    Returns:
        The answer.
    """
    stdin_payload = payload if payload is not None else {}
    stdin_payload.setdefault("session_id", session_id)
    stdin_payload.setdefault("cwd", DEVELOPMENT_CWD)
    argv = [
        "--event",
        event,
        "--state-path",
        str(paths.state),
        "--receipt-state-path",
        str(paths.receipts),
        "--settings-path",
        str(paths.settings),
        "--policy-state-path",
        str(paths.policy_state),
        "--spool-path",
        str(paths.spool),
        "--session-id",
        str(stdin_payload["session_id"]),
        "--nag-tokens",
        "200000",
        "--hard-tokens",
        "250000",
    ]
    if project:
        argv += ["--project", project]
    argv += extra or []
    stdout = io.StringIO()
    code = context_budget_gate.main(
        argv,
        stdin=io.StringIO(json.dumps(stdin_payload)),
        stdout=stdout,
        env={"HOME": str(paths.root)},
    )
    return GateResult(stdout=stdout.getvalue(), code=code)


def run_policy_gate(
    state_path: Path,
    event: str,
    payload: dict[str, Any] | None = None,
    extra: list[str] | None = None,
    *,
    agent: str = "claude",
    runtime: str = "claude",
    session_id: str = SESSION,
) -> GateResult:
    """Invoke the policy-refresh gate once.

    Args:
        state_path: The policy gate's own state file.
        event: The gate event.
        payload: The hook stdin.
        extra: Extra arguments.
        agent: The agent key.
        runtime: The runtime.
        session_id: Session the event belongs to.

    Returns:
        The answer.
    """
    stdin_payload = payload if payload is not None else {}
    stdin_payload.setdefault("session_id", session_id)
    stdin_payload.setdefault("cwd", DEVELOPMENT_CWD)
    argv = [
        "--event",
        event,
        "--state-path",
        str(state_path),
        "--agent",
        agent,
        "--runtime",
        runtime,
        "--session-id",
        str(stdin_payload["session_id"]),
    ] + (extra or [])
    stdout = io.StringIO()
    code = policy_refresh_gate.main(
        argv, stdin=io.StringIO(json.dumps(stdin_payload)), stdout=stdout
    )
    return GateResult(stdout=stdout.getvalue(), code=code)


def read_session_state(paths: GatePaths, session_id: str = SESSION) -> dict[str, Any]:
    """Read one session's stored gate state.

    Args:
        paths: The scratch paths.
        session_id: Session to read.

    Returns:
        The raw stored entry.
    """
    stored = json.loads(paths.state.read_text(encoding="utf8"))
    return dict(stored["sessions"][session_id])


def write_session_state(
    paths: GatePaths, state: dict[str, Any], session_id: str = SESSION
) -> None:
    """Overwrite one session's stored gate state.

    Args:
        paths: The scratch paths.
        state: The entry to store.
        session_id: Session to write.

    This is how a test ages a timestamp: rewriting the stored instant is the
    only way to prove a fifteen-minute release without waiting fifteen minutes,
    and it exercises the same code path a real stale state would.
    """
    stored = json.loads(paths.state.read_text(encoding="utf8"))
    stored["sessions"][session_id] = state
    paths.state.write_text(json.dumps(stored, indent=2), encoding="utf8")


def receipt_mode(
    operation: str, status: str, durable: bool, direct_attempted: bool
) -> str:
    """Return the mode a receipt with these properties carries.

    Args:
        operation: The provider operation.
        status: The writer's status word.
        durable: Whether the write is durable.
        direct_attempted: Whether a direct send was attempted.

    Returns:
        ``verified-remote``, ``durable-spool``, or ``failed``. Ported from
        receipt-state.ts:110-124 so the tests build receipts the same way the
        real writer does, rather than hand-picking a mode that happens to pass.
    """
    if operation == "recall":
        direct = status == "direct" and direct_attempted
        return "verified-remote" if direct else "failed"
    if status == "saved" and durable and direct_attempted:
        return "verified-remote"
    if status == "spooled" and durable:
        return "durable-spool"
    return "failed"


def record_receipt(
    receipts_path: Path,
    operation: str,
    status: str,
    durable: bool,
    trigger: str = "explicit",
    recorded_at: str | None = None,
    correlation_id: str | None = None,
    *,
    project: str = PROJECT,
    session_id: str = SESSION,
) -> None:
    """Write one provider receipt into the shared receipt state.

    Args:
        receipts_path: The receipt state file.
        operation: The provider operation.
        status: The writer's status word.
        durable: Whether the write is durable.
        trigger: What caused it.
        recorded_at: When, defaulting to now.
        correlation_id: Compact cycle id, when it belongs to one.
        project: Project the receipt belongs to.
        session_id: Session the receipt belongs to.

    A verified compact recall also stamps ``verifiedRecallAt`` on the matching
    cycle, mirroring recordProviderReceipt (receipt-state.ts:293-297). Without
    that the gate would have a receipt and still no cleared read-back, which is
    a state the real writer cannot produce.
    """
    direct_attempted = status != "failed"
    mode = receipt_mode(operation, status, durable, direct_attempted)
    moment = recorded_at or iso(datetime.now(UTC))

    try:
        state = json.loads(receipts_path.read_text(encoding="utf8"))
    except (OSError, json.JSONDecodeError):
        state = {}
    if not isinstance(state, dict) or state.get("schema") != RECEIPT_STATE_SCHEMA:
        state = {"schema": RECEIPT_STATE_SCHEMA, "sessions": {}, "compactCycles": {}}
    state.setdefault("sessions", {})
    state.setdefault("compactCycles", {})

    evidence: dict[str, Any] = {
        "operation": operation,
        "mode": mode,
        "status": status,
        "project": project,
        "sessionId": session_id,
        "trigger": trigger,
        "directAttempted": direct_attempted,
        "fallbackAttempted": False,
        "recordedAt": moment,
        "contract": MEMORY_CONTRACT,
        "contractSchemaVersion": MEMORY_CONTRACT_SCHEMA_VERSION,
        "contractSchemaHash": MEMORY_CONTRACT_SCHEMA_HASH,
    }
    if correlation_id:
        evidence["correlationId"] = correlation_id

    session = state["sessions"].setdefault(session_id, {})
    session[operation] = evidence

    triggers = state.setdefault("triggerReceipts", {}).setdefault(session_id, {})
    triggers[f"{operation}:{trigger}:{correlation_id or 'uncorrelated'}"] = evidence

    cycle = state["compactCycles"].get(session_id)
    if (
        isinstance(cycle, dict)
        and correlation_id
        and cycle.get("id") == correlation_id
        and cycle.get("project") == project
        and operation == "recall"
        and trigger == "compact"
        and mode == "verified-remote"
    ):
        cycle["verifiedRecallAt"] = moment

    receipts_path.parent.mkdir(parents=True, exist_ok=True)
    receipts_path.write_text(json.dumps(state, indent=2), encoding="utf8")


def start_compact_cycle(
    receipts_path: Path,
    *,
    project: str = PROJECT,
    session_id: str = SESSION,
    now: datetime | None = None,
) -> str:
    """Open a compact cycle as the PROVIDER, before the gate ever runs.

    Args:
        receipts_path: The receipt state file.
        project: Project the cycle belongs to.
        session_id: Session the cycle belongs to.
        now: When the cycle opened, defaulting to the current instant.

    Returns:
        The new cycle's correlation id.

    Distinct from ``gate_compact_cycle``: this models the ordering where the
    provider's PostCompact hook opens the cycle first and the gate joins it,
    which is the normal live sequence and the one the ordering tests exercise.
    """
    moment = now or datetime.now(UTC)
    try:
        state = json.loads(receipts_path.read_text(encoding="utf8"))
    except (OSError, json.JSONDecodeError):
        state = {}
    if not isinstance(state, dict) or state.get("schema") != RECEIPT_STATE_SCHEMA:
        state = {"schema": RECEIPT_STATE_SCHEMA, "sessions": {}, "compactCycles": {}}
    state.setdefault("sessions", {})
    cycles = state.setdefault("compactCycles", {})
    cycle_id = str(uuid4())
    cycles[session_id] = {
        "id": cycle_id,
        "project": project,
        "sessionId": session_id,
        "startedAt": iso(moment),
        "participants": [],
        "attemptedParticipants": ["post-compact"],
    }
    receipts_path.parent.mkdir(parents=True, exist_ok=True)
    receipts_path.write_text(json.dumps(state, indent=2), encoding="utf8")
    return cycle_id


def arm_readback(paths: GatePaths) -> str:
    """Fire a post-compact so the read-back requirement is armed.

    Args:
        paths: The scratch paths.

    Returns:
        The correlation id the gate armed against.
    """
    result = run_gate(paths, "post-compact")
    assert result.code == 0
    return str(read_session_state(paths)["readbackCorrelationId"])
