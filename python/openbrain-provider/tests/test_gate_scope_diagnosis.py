"""The gate's remediation text on a machine whose configured root is absent.

Field-proved on the Air, 2026-08-04: the context-budget gate blocked tool calls
and printed remediation text quoting the shipped default path as though it were
the session's directory. The operator pasted a `cd` into a directory that does
not exist on that machine, so the block could not be cleared from inside the
session.

`_project_root` is where that string is produced, so that is where this is
pinned. The companion assertion is that the diagnosis does not make the gate
newly blocking: `context_budget_gate`'s own docstring forbids deadlocking on
what it gates (#419), and a root the operator cannot reach is precisely the
state in which the repair command must still run.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from gate_harness import gate_paths, run_gate

from openbrain_provider import context_budget_gate
from openbrain_provider.hook_io import HookEvent


@pytest.fixture
def absent_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Configure a Development root that does not exist on this machine."""
    missing = tmp_path / "absent-volume" / "Development"
    monkeypatch.setenv("OPENBRAIN_DEVELOPMENT_ROOT", str(missing))
    return missing


def _gate(paths_root: Path, cwd: Path) -> context_budget_gate._Gate:
    """Build a gate whose event reports a real cwd outside the lane."""
    args = context_budget_gate._build_parser({"HOME": str(paths_root)}).parse_args(
        [
            "--event",
            "status",
            "--session-id",
            "scope-diagnosis",
            "--state-path",
            str(paths_root / "gate.json"),
            "--project",
            "open-brain",
        ]
    )
    event = HookEvent({"session_id": "scope-diagnosis", "cwd": str(cwd)})
    return context_budget_gate._Gate(args, event, None)


def test_recovery_cwd_is_the_measured_directory_not_the_absent_root(
    tmp_path: Path, absent_root: Path
) -> None:
    """The recovery command carries where the operator actually is.

    Old behaviour composed `<configured root>/<project>` — a path that cannot
    exist when the configured root itself does not. The measured cwd is a real
    directory, so the command it produces can actually run.
    """
    here = tmp_path / "real-working-directory"
    here.mkdir(parents=True)

    recovery = _gate(tmp_path, here)._project_root()

    assert recovery == here
    assert str(absent_root) not in str(recovery)


def test_gate_still_answers_when_the_configured_root_is_absent(
    tmp_path: Path, absent_root: Path
) -> None:
    """A misconfigured root must not become a new block.

    #419: the gate must not deadlock on what it gates. The remediation for an
    absent root is an environment variable the operator sets in a shell, so a
    gate that blocked here would gate its own repair.
    """
    paths = gate_paths(tmp_path / "gate")
    result = run_gate(paths, "status", payload={"cwd": str(tmp_path)}, project=None)

    assert result.code == 0
    assert not result.blocked


def test_absent_root_diagnoses_on_stderr_through_the_gate_entrypoint(
    tmp_path: Path, absent_root: Path
) -> None:
    """A full `main()` run tells the operator what is wrong and how to fix it.

    The two tests above pin the pieces -- the recovery path and the non-blocking
    posture -- but neither runs the entrypoint that decides whether the operator
    ever SEES a diagnosis. Deleting the `_warn_missing_development_root` call
    from `main()` leaves both of them passing and restores the Air's silence
    verbatim, which is the gap this closes.

    Four facts are asserted because all four were wrong or missing in the field
    report: the root consulted, where that value came from, the directory
    actually measured, and the variable that repairs it.
    """
    here = tmp_path / "real-working-directory"
    here.mkdir(parents=True)
    paths = gate_paths(tmp_path / "gate")

    result = run_gate(paths, "status", payload={"cwd": str(here)}, project=None)

    assert str(absent_root) in result.stderr
    assert "set via OPENBRAIN_DEVELOPMENT_ROOT" in result.stderr
    assert str(here) in result.stderr
    assert "export OPENBRAIN_DEVELOPMENT_ROOT" in result.stderr


def test_present_root_with_out_of_lane_cwd_says_nothing_on_stderr(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Somebody else's repository stays silent.

    The gate runs in every directory the agent visits. A diagnosis that fired on
    an out-of-lane cwd -- rather than only on an absent root -- would put this
    text in front of the operator constantly, and noise that appears everywhere
    is read as normal and stops carrying information. Silence here is what makes
    the loud case worth reading.
    """
    root = tmp_path / "Development"
    root.mkdir(parents=True)
    monkeypatch.setenv("OPENBRAIN_DEVELOPMENT_ROOT", str(root))
    elsewhere = tmp_path / "somebody-elses-repository"
    elsewhere.mkdir(parents=True)
    paths = gate_paths(tmp_path / "gate")

    result = run_gate(paths, "status", payload={"cwd": str(elsewhere)}, project=None)

    assert result.stderr == ""


@pytest.mark.parametrize("root_exists", [False, True])
def test_stdout_stays_the_untouched_verdict_channel(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, root_exists: bool
) -> None:
    """The diagnosis never contaminates the JSON a hook reader parses.

    stdout is consumed by a JSON parser on the other end of the hook. Prose
    written there would not be a cosmetic problem -- it would make the verdict
    unreadable and the gate's answer indeterminate. Parsed rather than
    pattern-matched, because parsing is the assertion that actually matches what
    the reader does.
    """
    root = tmp_path / "Development"
    if root_exists:
        root.mkdir(parents=True)
    monkeypatch.setenv("OPENBRAIN_DEVELOPMENT_ROOT", str(root))
    here = tmp_path / "real-working-directory"
    here.mkdir(parents=True)
    paths = gate_paths(tmp_path / "gate")

    result = run_gate(paths, "status", payload={"cwd": str(here)}, project=None)

    assert result.code == 0
    assert isinstance(result.json, dict)
