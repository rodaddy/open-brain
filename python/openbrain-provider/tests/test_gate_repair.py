"""The gate must not deadlock on the subsystem it gates. Issue #419's acceptance.

Two independent escapes are proven here, because one is not enough: the read-back
requirement self-releases on time WITHOUT anybody doing anything, and an operator
can open a bounded repair window to fix the recall plumbing by hand. Each is
tested for firing, for being recorded, and for ending.

Ported from `context-budget-gate-repair.test.ts`.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

from gate_harness import (
    PROJECT,
    SESSION,
    arm_readback,
    gate_paths,
    iso,
    read_session_state,
    record_receipt,
    run_gate,
    write_session_state,
)

TS_GATE = "/Volumes/ThunderBolt/Development/_ob/scripts/context-budget-gate.ts"


def test_a_stale_readback_self_releases_after_fifteen_minutes(tmp_path: Path) -> None:
    # THE #419 BUG. The documented fifteen-minute self-release did not fire, so
    # the gate blocked Write while the broken recall was the thing needing
    # repair. This asserts it fires, that it unblocks, and that it says so.
    paths = gate_paths(tmp_path)
    arm_readback(paths)

    state = read_session_state(paths)
    state["readbackRequiredAt"] = iso(
        datetime.now(UTC) - timedelta(minutes=15, seconds=1)
    )
    write_session_state(paths, state)

    allowed = run_gate(
        paths,
        "pre-tool-use",
        {"tool_name": "Write", "tool_input": {"file_path": str(tmp_path / "a.ts")}},
    )

    assert allowed.code == 0
    assert not allowed.blocked
    assert "self-released-after-timeout" in allowed.stdout

    released = read_session_state(paths)
    assert released["readbackRequired"] is False
    assert released["readbackCorrelationId"] == ""
    assert released["transitionLog"][-1]["name"] == "self-released-after-timeout"
    assert (
        released["transitionLog"][-1]["reason"] == "15-minute read-back timeout elapsed"
    )


def test_the_release_never_manufactures_a_recall_receipt(tmp_path: Path) -> None:
    # The release must not fake the evidence it never got. If it wrote a recall
    # receipt to unblock itself, the NEXT gate would read that receipt and
    # believe a recall happened -- a self-inflicted false clear that no later
    # check could distinguish from a real one.
    paths = gate_paths(tmp_path)
    arm_readback(paths)
    state = read_session_state(paths)
    state["readbackRequiredAt"] = iso(datetime.now(UTC) - timedelta(minutes=16))
    write_session_state(paths, state)

    answer = run_gate(paths, "pre-tool-use", {"tool_name": "Read", "tool_input": {}})

    # No recall receipt anywhere in the shared state.
    receipts = paths.receipts.read_text(encoding="utf8")
    assert '"operation": "recall"' not in receipts

    # And the release SAYS it did not manufacture one, on the surface that
    # displays it. The notice is consumed by this same allowed call, which is
    # why it is asserted on the output rather than on the stored queue.
    assert "no recall receipt manufactured" in answer.stdout
    released = read_session_state(paths)
    assert released["readbackRequired"] is False
    assert any(
        entry["name"] == "self-released-after-timeout"
        for entry in released["transitionLog"]
    )


def test_a_real_recall_clears_by_recall_not_by_timeout(tmp_path: Path) -> None:
    # A gate that cleared everything by timeout would look identical from the
    # outside. The transition name is what distinguishes "recall worked" from
    # "we gave up waiting", and only one of those is healthy.
    paths = gate_paths(tmp_path)
    correlation = arm_readback(paths)
    record_receipt(
        paths.receipts, "recall", "direct", False, "compact", None, correlation
    )

    allowed = run_gate(
        paths,
        "pre-tool-use",
        {"tool_name": "Write", "tool_input": {"file_path": str(tmp_path / "b.ts")}},
    )

    assert "read-back cleared" in allowed.stdout
    names = [entry["name"] for entry in read_session_state(paths)["transitionLog"]]
    assert "cleared-by-recall" in names
    assert "self-released-after-timeout" not in names


def test_the_blocked_gate_permits_the_exact_repair_enter_command(
    tmp_path: Path,
) -> None:
    # The escape hatch has to be REACHABLE from inside the block, or it is not
    # an escape hatch. And it has to be the exact command -- a repair-enter
    # naming some other gate script would open a window in a state file this
    # process does not own.
    paths = gate_paths(tmp_path)
    arm_readback(paths)
    command = (
        f"bun '{TS_GATE}' --event repair-enter --session-id {SESSION} "
        f"--project {PROJECT} --state-path '{paths.state}' "
        f"--receipt-state-path '{paths.receipts}' --repair-minutes 5 "
        "--repair-reason 'repair provider plumbing'"
    )

    allowed = run_gate(
        paths, "pre-tool-use", {"tool_name": "Bash", "tool_input": {"command": command}}
    )
    assert allowed.code == 0
    assert allowed.stdout == ""

    impostor = command.replace(TS_GATE, str(tmp_path / "context-budget-gate.ts"))
    blocked = run_gate(
        paths,
        "pre-tool-use",
        {"tool_name": "Bash", "tool_input": {"command": impostor}},
    )
    assert blocked.blocked


def test_repair_mode_admits_bash_write_and_edit(tmp_path: Path) -> None:
    paths = gate_paths(tmp_path)
    arm_readback(paths)

    for tool in ("Bash", "Write", "Edit"):
        blocked = run_gate(paths, "pre-tool-use", _tool_call(tool, tmp_path))
        assert blocked.blocked, tool

    entered = run_gate(
        paths,
        "repair-enter",
        None,
        ["--repair-minutes", "5", "--repair-reason", "repair provider plumbing"],
    )
    assert entered.code == 0
    assert "transition=repair-entered" in entered.stdout
    assert read_session_state(paths)["repairModeActive"] is True

    status = run_gate(paths, "status")
    assert status.json["repairModeActive"] is True
    assert "repair ACTIVE until" in status.json["statusLine"]

    for tool in ("Bash", "Write", "Edit"):
        allowed = run_gate(paths, "pre-tool-use", _tool_call(tool, tmp_path))
        assert not allowed.blocked, tool
        assert "repair-active-tool-allowed" in allowed.stdout, tool


def test_repair_mode_does_not_admit_everything(tmp_path: Path) -> None:
    # The window is bounded in WHAT as well as in time. A tool outside the
    # repair-capable set gets no free pass, because "repair the recall plumbing"
    # does not require arbitrary tool access.
    paths = gate_paths(tmp_path)
    arm_readback(paths)
    run_gate(
        paths,
        "repair-enter",
        None,
        ["--repair-minutes", "5", "--repair-reason", "repair provider plumbing"],
    )

    blocked = run_gate(
        paths, "pre-tool-use", {"tool_name": "NotebookEdit", "tool_input": {}}
    )
    assert blocked.blocked


def test_repair_expiry_restores_enforcement(tmp_path: Path) -> None:
    # An escape hatch that stays open is the gate switched off. Expiry is what
    # makes it an escape hatch rather than a disable switch.
    paths = gate_paths(tmp_path)
    arm_readback(paths)
    run_gate(
        paths,
        "repair-enter",
        None,
        ["--repair-minutes", "1", "--repair-reason", "repair provider plumbing"],
    )
    state = read_session_state(paths)
    state["repairModeExpiresAt"] = iso(datetime.now(UTC) - timedelta(seconds=1))
    write_session_state(paths, state)

    blocked = run_gate(
        paths,
        "pre-tool-use",
        {"tool_name": "Write", "tool_input": {"file_path": str(tmp_path / "c.ts")}},
    )

    assert blocked.blocked
    expired = read_session_state(paths)
    assert expired["repairModeActive"] is False
    assert expired["readbackRequired"] is True
    assert [entry["name"] for entry in expired["transitionLog"][-2:]] == [
        "repair-expired",
        "still-blocking-with-reason",
    ]


def test_repair_mode_can_be_exited_early(tmp_path: Path) -> None:
    paths = gate_paths(tmp_path)
    arm_readback(paths)
    run_gate(
        paths, "repair-enter", None, ["--repair-reason", "repair provider plumbing"]
    )

    exited = run_gate(
        paths, "repair-exit", None, ["--repair-reason", "repair complete"]
    )

    assert exited.code == 0
    assert "transition=repair-exited" in exited.stdout
    state = read_session_state(paths)
    assert state["repairModeActive"] is False
    assert state["transitionLog"][-1]["name"] == "repair-exited"


def test_repair_enter_refuses_without_a_reason_or_a_sane_window(
    tmp_path: Path,
) -> None:
    # A repair window with no stated reason is an untraceable disable. And a
    # window longer than the read-back timeout it escapes would outlive the
    # requirement entirely.
    paths = gate_paths(tmp_path)
    arm_readback(paths)

    no_reason = run_gate(paths, "repair-enter", None, ["--repair-minutes", "5"])
    assert no_reason.code == 1
    assert no_reason.stdout.startswith("REFUSED:")

    too_long = run_gate(
        paths, "repair-enter", None, ["--repair-minutes", "60", "--repair-reason", "x"]
    )
    assert too_long.code == 1
    assert read_session_state(paths)["repairModeActive"] is False


def _tool_call(tool: str, root: Path) -> dict[str, object]:
    """Build a representative call for a repair-capable tool."""
    if tool == "Bash":
        return {
            "tool_name": tool,
            "tool_input": {"command": "bun -e 'process.exit(0)'"},
        }
    return {
        "tool_name": tool,
        "tool_input": {"file_path": str(root / f"{tool.lower()}.ts")},
    }
