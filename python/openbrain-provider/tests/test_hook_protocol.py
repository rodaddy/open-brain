"""The wire protocol itself: stdin in, verdict out, exit code, and the scripts.

Separate from the behaviour tests because these are about the CONTRACT rather
than the policy: what happens with no stdin at all, and what an allow looks like
on the wire.

Whether every declared `[project.scripts]` target actually imports is checked ONCE,
generically, by `test_packaging.py::test_every_declared_console_script_resolves`.
This file asserts only that the two GATE commands are declared at all -- the fact
that specific to this port. A second generic resolver here would be a second
implementation of a rule that already exists, which is the defect the port plan
names on sight (`_plans/consolidation-2026-07-30.md:99`).
"""

from __future__ import annotations

import io
import json
import tomllib
from pathlib import Path

import pytest
from gate_harness import gate_paths, run_gate, run_policy_gate

from openbrain_provider import context_budget_gate, policy_refresh_gate
from openbrain_provider.hook_io import HookEvent, emit, emit_json, read_hook_event

PYPROJECT = Path(__file__).resolve().parents[1] / "pyproject.toml"


def test_both_gate_console_scripts_are_declared() -> None:
    # A hook registration names one of these commands. If the declaration were
    # dropped, `test_packaging.py` would still pass -- it checks that what IS
    # declared resolves, not that these two exist.
    data = tomllib.loads(PYPROJECT.read_text(encoding="utf8"))
    scripts = data.get("project", {}).get("scripts", {})

    assert scripts.get("openbrain-context-budget-gate") == (
        "openbrain_provider.context_budget_gate:_cli"
    )
    assert scripts.get("openbrain-policy-refresh-gate") == (
        "openbrain_provider.policy_refresh_gate:_cli"
    )


@pytest.mark.parametrize(
    "raw",
    ["", "   ", "not json", "[1,2,3]", '"a string"', "null", "{"],
)
def test_unusable_stdin_reads_as_an_empty_event(raw: str) -> None:
    # Fail-open. A hook that raised on bad stdin would take the agent's turn
    # down with it, and a gate exists to shape a turn, not to end one.
    event = read_hook_event(io.StringIO(raw))

    assert isinstance(event, HookEvent)
    assert event.session_id == ""
    assert event.tool_name == ""
    assert event.tool_input == {}


def test_a_closed_stdin_reads_as_an_empty_event() -> None:
    stream = io.StringIO("{}")
    stream.close()

    assert read_hook_event(stream) == HookEvent()


def test_both_tool_field_spellings_are_accepted() -> None:
    # Claude sends `tool_name`/`tool_input`; Codex sends `toolName`/`toolInput`.
    # Reading only one spelling makes the gate silently unenforced on the other
    # runtime -- which looks exactly like a gate that is working.
    claude = read_hook_event(
        io.StringIO(
            json.dumps({"tool_name": "Write", "tool_input": {"file_path": "a"}})
        )
    )
    codex = read_hook_event(
        io.StringIO(json.dumps({"toolName": "Write", "toolInput": {"file_path": "a"}}))
    )

    assert claude.tool_name == codex.tool_name == "Write"
    assert claude.tool_input == codex.tool_input == {"file_path": "a"}


def test_a_field_with_the_wrong_type_reads_as_absent() -> None:
    event = read_hook_event(
        io.StringIO(json.dumps({"session_id": 12, "tool_input": "not-a-dict"}))
    )

    assert event.session_id == ""
    assert event.tool_input == {}


def test_an_empty_emit_writes_nothing_at_all() -> None:
    # Not a newline. Both runtimes read empty stdout as allow, and a bare
    # newline is not empty.
    stream = io.StringIO()
    emit("", stream)

    assert stream.getvalue() == ""


def test_a_json_verdict_is_compact_and_newline_terminated() -> None:
    stream = io.StringIO()
    emit_json({"decision": "block", "reason": "x"}, stream)

    assert stream.getvalue() == '{"decision":"block","reason":"x"}\n'


def test_non_ascii_survives_the_verdict_encoding() -> None:
    # The status line uses `✓`, `✗`, and `·`. Escaping them would still be valid
    # JSON but would put `✓` in front of the operator.
    stream = io.StringIO()
    emit_json({"systemMessage": "OB ✓ recall ok · spool 0"}, stream)

    assert "OB ✓ recall ok · spool 0" in stream.getvalue()


@pytest.mark.parametrize(
    "event",
    [
        "status",
        "user-prompt-submit",
        "pre-tool-use",
        "pre-compact",
        "post-compact",
        "session-start",
        "stop",
    ],
)
def test_the_budget_gate_survives_an_empty_event(tmp_path: Path, event: str) -> None:
    # Every event, with nothing on stdin. None of them may raise: a hook that
    # throws is a hook failure the harness reports, on a turn the operator was
    # in the middle of.
    paths = gate_paths(tmp_path / event)
    stdout = io.StringIO()
    code = context_budget_gate.main(
        [
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
        ],
        stdin=io.StringIO(""),
        stdout=stdout,
        env={"HOME": str(paths.root)},
    )

    assert code == 0


@pytest.mark.parametrize(
    "event",
    [
        "session-start",
        "user-prompt-submit",
        "pre-tool-use",
        "pre-compact",
        "post-compact",
        "refresh",
    ],
)
def test_the_policy_gate_survives_an_empty_event(tmp_path: Path, event: str) -> None:
    stdout = io.StringIO()
    code = policy_refresh_gate.main(
        ["--event", event, "--state-path", str(tmp_path / f"{event}.json")],
        stdin=io.StringIO(""),
        stdout=stdout,
    )

    assert code == 0


def test_an_unknown_event_name_is_refused_at_the_boundary(tmp_path: Path) -> None:
    # Not silently treated as `status`. A registration with a typo would then
    # look like it worked while enforcing nothing, and the exit code is the only
    # place that mistake can surface.
    with pytest.raises(SystemExit) as raised:
        context_budget_gate.main(
            ["--event", "post-compct", "--state-path", str(tmp_path / "s.json")],
            stdin=io.StringIO("{}"),
            stdout=io.StringIO(),
        )
    assert raised.value.code != 0

    with pytest.raises(SystemExit) as policy_raised:
        policy_refresh_gate.main(
            ["--event", "sesion-start", "--state-path", str(tmp_path / "p.json")],
            stdin=io.StringIO("{}"),
            stdout=io.StringIO(),
        )
    assert policy_raised.value.code != 0


def test_a_corrupt_state_file_does_not_break_the_turn(tmp_path: Path) -> None:
    # State is a cache of belief, not a source of truth. A file half-written by
    # a killed process must rebuild, because the alternative is a session that
    # cannot run a single tool until somebody deletes a file by hand.
    paths = gate_paths(tmp_path)
    paths.state.write_text("{ this is not json", encoding="utf8")

    result = run_gate(paths, "status")

    assert result.code == 0
    assert result.json["readbackRequired"] is False


def test_a_corrupt_policy_state_file_does_not_break_the_turn(tmp_path: Path) -> None:
    state_path = tmp_path / "state.json"
    state_path.write_text("{ this is not json", encoding="utf8")

    result = run_policy_gate(
        state_path,
        "pre-tool-use",
        {"tool_name": "Read", "tool_input": {"file_path": "a"}},
    )

    assert result.code == 0
    assert result.stdout == ""


def test_a_corrupt_receipt_file_keeps_the_gate_blocking(tmp_path: Path) -> None:
    # Absent evidence is not evidence of a write. A receipt file that cannot be
    # read must leave the block standing -- failing OPEN here would mean any
    # session could clear a gate by corrupting a file.
    paths = gate_paths(tmp_path)
    run_gate(paths, "post-compact")
    paths.receipts.write_text("{ not json", encoding="utf8")

    blocked = run_gate(
        paths,
        "pre-tool-use",
        {"tool_name": "Write", "tool_input": {"file_path": str(tmp_path / "a.ts")}},
    )

    assert blocked.blocked
