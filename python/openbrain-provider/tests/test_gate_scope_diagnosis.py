"""The gate's remediation text on a machine whose configured root is absent.

Field-proved on the Air, 2026-08-04: the context-budget gate blocked tool calls
and printed remediation text quoting the shipped default path as though it were
the session's directory. The operator pasted a `cd` into a directory that does
not exist on that machine, so the block could not be cleared from inside the
session.

`_development_cwd` is where that string is produced, so that is where this is
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

    recovery = _gate(tmp_path, here)._development_cwd()

    assert recovery == str(here)
    assert str(absent_root) not in recovery


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
