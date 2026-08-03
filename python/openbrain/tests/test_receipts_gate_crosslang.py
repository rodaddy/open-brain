"""The cross-language proof: the real TypeScript gate unblocks on a Python receipt.

This is the whole point of ``openbrain.receipts``, and it is the ONLY test here
that can prove it. Every other test of this package checks that Python writes the
JSON it meant to write -- which is worth nothing if the gate reads it differently.
So this one runs the ACTUAL gate, ``_ob/scripts/context-budget-gate.ts``, as a
subprocess under ``bun``, against a ``receipts.json`` that only Python has ever
touched, and asserts on the gate's own decision.

The existing TypeScript tests over this state
(``_ob/scripts/ob-memory-provider/receipt-state.test.ts``,
``.../claude-hook.test.ts``) all write the receipt from TypeScript, so none of
them can catch a Python writer that produces a file the gate silently skips. The
subprocess-with-every-path-redirected shape is borrowed from
``_ob/scripts/context-budget-gate-test-helpers.ts``; writing the receipt from
Python is the delta.

WHY THE RED HALF IS NOT OPTIONAL. A test that only shows the gate unblocking
proves nothing on its own: a gate that never blocks passes it. Each proof here
therefore runs the same gate, over the same state, twice -- once where it must
refuse and once where the Python receipt must release it -- so the pass is
evidence the receipt did the work rather than evidence the block was absent.

ISOLATION. Every path the gate touches is redirected into a temporary directory:
its session state, the receipt file, the settings it scans, the policy state, and
the spool. The live gate registrations and the real
``~/.local/state/agent-runtime/openbrain-memory/receipts.json`` are never read or
written by these tests, which matters because that file is the running session's
own unblock state.

See Also:
    - ``openbrain.receipts.state`` - the writer under test
    - ``_ob/scripts/context-budget-gate-state.ts`` - the reader being satisfied
"""

from __future__ import annotations

import json
import shutil
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from openbrain.receipts import (
    ProviderReceiptEvidence,
    receipt_mode,
    record_provider_receipt,
    start_compact_cycle,
)

#: The gate under test, in the Development checkout it is registered from. An
#: absolute path because that is where the LIVE hook runs it from -- pointing at a
#: copy would prove a copy works.
GATE_SCRIPT = Path(
    "/Volumes/ThunderBolt/Development/_ob/scripts/context-budget-gate.ts"
)

#: A directory the gate resolves to a Development project. It only has to exist
#: and be in scope; nothing is written to it.
GATE_CWD = Path("/Volumes/ThunderBolt/Development/open-brain")

#: The project slug the receipts are filed under. Passed to the gate explicitly
#: with ``--project`` so the assertion does not depend on the git layout of
#: whatever checkout the suite runs from.
PROJECT = "open-brain"

#: The session the proof runs under.
SESSION_ID = "receipts-crosslang-session"

#: How long to wait for the whole subprocess. Generous: this is a guard against a
#: wedged gate hanging the suite, not a performance assertion.
GATE_TIMEOUT_SECONDS = 60.0

pytestmark = pytest.mark.skipif(
    shutil.which("bun") is None or not GATE_SCRIPT.is_file(),
    reason=(
        "the cross-language proof needs bun and the Development checkout's "
        f"{GATE_SCRIPT.name}; without both there is no gate to prove against"
    ),
)


class Gate:
    """The real gate, wired to a throwaway state directory.

    Args:
        root: A temporary directory. Every file the gate reads or writes is
            placed inside it.
    """

    def __init__(self, root: Path) -> None:
        """Lay out the isolated state files the gate will be pointed at."""
        self.root = root
        self.state_path = root / "gate.json"
        self.receipts_path = root / "receipts.json"
        self.settings_path = root / "settings.json"
        self.settings_path.write_text("{}", encoding="utf-8")

    def run(self, event: str, **payload: object) -> subprocess.CompletedProcess[str]:
        """Invoke the gate for one event and return its completed process.

        Args:
            event: The ``--event`` value, e.g. ``post-compact`` or
                ``pre-tool-use``.
            **payload: Extra fields for the hook's stdin JSON. ``session_id`` and
                ``cwd`` are supplied.

        Returns:
            The completed process, whose stdout is the gate's decision.
        """
        argv = [
            "bun",
            str(GATE_SCRIPT),
            "--event",
            event,
            "--state-path",
            str(self.state_path),
            "--receipt-state-path",
            str(self.receipts_path),
            "--settings-path",
            str(self.settings_path),
            "--policy-state-path",
            str(self.root / "policy.json"),
            "--spool-path",
            str(self.root / "spool.jsonl"),
            "--session-id",
            SESSION_ID,
            "--project",
            PROJECT,
        ]
        stdin = json.dumps({"session_id": SESSION_ID, "cwd": str(GATE_CWD), **payload})
        return subprocess.run(  # noqa: S603 -- fixed argv built here, no shell
            argv,
            input=stdin,
            capture_output=True,
            text=True,
            timeout=GATE_TIMEOUT_SECONDS,
            check=False,
        )

    def attempt_edit(self) -> dict[str, object]:
        """Ask the gate to permit an ``Edit``, and return its decoded answer.

        ``Edit`` is used because it is a plain mutating tool with no special
        handling: the gate's checkpoint-activity allowance recognises certain
        Bash commands, and using one of those would prove the allowance rather
        than the receipt.
        """
        completed = self.run(
            "pre-tool-use",
            tool_name="Edit",
            tool_input={"file_path": str(GATE_CWD / "x")},
        )
        if not completed.stdout.strip():
            return {}
        decoded = json.loads(completed.stdout)
        assert isinstance(decoded, dict)
        return decoded

    def correlation_id(self) -> str:
        """The cycle id the gate is currently waiting on a recall for."""
        correlation = self._session_state()["readbackCorrelationId"]
        assert isinstance(correlation, str)
        return correlation

    def readback_required(self) -> bool:
        """Whether the gate still considers the post-compaction read-back open."""
        return bool(self._session_state()["readbackRequired"])

    def transitions(self) -> list[str]:
        """The names of the gate's recorded state transitions, in order."""
        log = self._session_state()["transitionLog"]
        assert isinstance(log, list)
        return [str(entry["name"]) for entry in log]

    def _session_state(self) -> dict[str, object]:
        """The gate's own persisted state for this session."""
        document = json.loads(self.state_path.read_text(encoding="utf-8"))
        session = document["sessions"][SESSION_ID]
        assert isinstance(session, dict)
        return session


def _iso(moment: datetime) -> str:
    """A timestamp in the shape the gate parses, matching ``toISOString``."""
    return (
        moment.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    )


def _write_recall_receipt(
    receipts_path: Path,
    correlation_id: str,
    *,
    recorded_at: datetime | None = None,
) -> ProviderReceiptEvidence:
    """Write, from PYTHON ONLY, the receipt the gate's read-back waits for.

    Args:
        receipts_path: The isolated receipt file.
        correlation_id: The cycle the gate is waiting on.
        recorded_at: When the recall happened, defaulting to now. Overridden by
            the staleness proof to place it outside the gate's window.

    Returns:
        The receipt as filed.

    ``mode`` is derived through :func:`receipt_mode` rather than written as a
    literal, because that is the call a real hook makes and grading is the part
    that can lie.
    """
    moment = recorded_at if recorded_at is not None else datetime.now(UTC)
    return record_provider_receipt(
        receipts_path,
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
            project=PROJECT,
            session_id=SESSION_ID,
            trigger="compact",
            direct_attempted=True,
            recorded_at=_iso(moment),
            correlation_id=correlation_id,
        ),
    )


def _armed_gate(tmp_path: Path) -> Gate:
    """A gate that has seen a compaction and is blocking on the read-back.

    The cycle is opened by :func:`start_compact_cycle` -- the PYTHON writer -- so
    even the correlation id the gate ends up waiting on came from this package,
    which is the ``PostCompact`` half of the lifecycle.
    """
    gate = Gate(tmp_path)
    cycle = start_compact_cycle(
        gate.receipts_path, session_id=SESSION_ID, project=PROJECT
    )
    gate.run("post-compact")

    assert gate.readback_required(), "the gate should block after a compaction"
    assert gate.correlation_id() == cycle.id, (
        "the gate must adopt the cycle Python opened, not open its own -- "
        "if it opens its own, PostCompact wrote a cycle the gate cannot see"
    )
    return gate


def test_python_written_recall_receipt_unblocks_the_real_gate(tmp_path: Path) -> None:
    """RED then GREEN: the gate refuses, Python writes a receipt, the gate releases.

    This is the deliverable. Nothing in this test executes the TypeScript writer:
    the compaction cycle and the recall receipt are both produced by
    ``openbrain.receipts``, and the only TypeScript that runs is the gate itself,
    reading them.
    """
    gate = _armed_gate(tmp_path)

    blocked = gate.attempt_edit()
    assert blocked.get("decision") == "block", (
        "RED half failed: the gate did not block, so a later pass would prove "
        "nothing about the receipt"
    )

    _write_recall_receipt(gate.receipts_path, gate.correlation_id())

    released = gate.attempt_edit()
    assert released.get("decision") != "block"
    assert not gate.readback_required()
    assert "cleared-by-recall" in gate.transitions()


def test_absent_python_receipt_leaves_the_gate_blocking(tmp_path: Path) -> None:
    """The red on its own: with no receipt written at all, the gate stays shut.

    Separate from the round trip above so a regression that makes the gate
    permissive -- rather than one that makes the receipt unreadable -- is
    distinguishable in the failure output.
    """
    gate = _armed_gate(tmp_path)

    first = gate.attempt_edit()
    second = gate.attempt_edit()

    assert first.get("decision") == "block"
    assert second.get("decision") == "block"
    assert gate.readback_required()
    assert "cleared-by-recall" not in gate.transitions()


def test_stale_python_receipt_does_not_unblock_the_gate(tmp_path: Path) -> None:
    """A correctly-shaped receipt from too long ago is still a blocked gate.

    The gate accepts a compaction recall only within a short window, because the
    recall has to be evidence that THIS session just read Open Brain back -- an
    hour-old one is not. This proves the Python writer's timestamp lands somewhere
    the gate actually measures: a receipt written with a naive or wrongly-offset
    ``recorded_at`` would read as fresh here and would pass a test that only ever
    wrote "now".
    """
    gate = _armed_gate(tmp_path)
    long_ago = datetime.now(UTC) - timedelta(hours=1)

    _write_recall_receipt(
        gate.receipts_path, gate.correlation_id(), recorded_at=long_ago
    )

    blocked = gate.attempt_edit()
    assert blocked.get("decision") == "block"
    assert gate.readback_required()


def test_receipt_for_another_cycle_does_not_unblock_the_gate(tmp_path: Path) -> None:
    """A recall belonging to a DIFFERENT compaction leaves this one blocked.

    The correlation id is the reason the gate stores one at all: a recall from an
    earlier compaction must not satisfy the read-back the current one armed. This
    proves Python's ``correlation_id`` reaches the field the gate compares, rather
    than being written somewhere it is merely present.
    """
    gate = _armed_gate(tmp_path)
    foreign_cycle = "00000000-0000-4000-8000-000000000000"
    assert foreign_cycle != gate.correlation_id()

    _write_recall_receipt(gate.receipts_path, foreign_cycle)

    blocked = gate.attempt_edit()
    assert blocked.get("decision") == "block"
    assert gate.readback_required()


def test_python_capture_receipt_clears_the_gates_capture_block(tmp_path: Path) -> None:
    """The other unblock path: a capture receipt releases the post-work capture block.

    The gate arms ``captureRequired`` after a turn that did mutating work and
    clears it on any durable write receipt -- a different query from the
    compaction read-back (no correlation id, a wider set of operations, and
    ``durable-spool`` accepted alongside ``verified-remote``). Proving only the
    recall path would leave this one unproven, and it is the path a ``Stop`` hook
    exercises on every turn.
    """
    gate = Gate(tmp_path)
    gate.state_path.write_text(
        json.dumps(
            {
                "sessions": {
                    SESSION_ID: {
                        "sessionId": SESSION_ID,
                        "project": PROJECT,
                        "captureRequired": True,
                        "captureRequiredAt": _iso(
                            datetime.now(UTC) - timedelta(seconds=5)
                        ),
                    }
                }
            }
        ),
        encoding="utf-8",
    )

    blocked = gate.attempt_edit()
    assert blocked.get("decision") == "block", "RED half failed: capture not blocking"

    record_provider_receipt(
        gate.receipts_path,
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
            project=PROJECT,
            session_id=SESSION_ID,
            trigger="explicit",
            direct_attempted=True,
            recorded_at=_iso(datetime.now(UTC)),
        ),
    )

    released = gate.attempt_edit()
    assert released.get("decision") != "block"
    assert "cleared-by-capture" in gate.transitions()
