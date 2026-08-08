"""A configured Development root that does not exist must be loud.

`resolve_development_scope` answers None for two unrelated reasons: the cwd is
somebody else's repository (correct, and silent by design), or the configured
root does not exist on this machine (a misconfiguration of the operator's own
box). Field-proved on the Air, 2026-08-04: those two were indistinguishable, so
the memory provider exited clean with no output and the context-budget gate
printed the shipped default path in the position where an operator reads a cwd.

These tests pin the distinction, the diagnosis text, and — equally load-bearing
— that the diagnosis does NOT introduce a new blocking posture. The gate's own
docstring forbids deadlocking on what it gates (#419), so a root the operator
cannot reach must never gate the command that repairs it.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from openbrain_provider.development_scope import (
    DEFAULT_DEVELOPMENT_ROOT,
    ScopeDiagnosis,
    describe_development_root,
    development_root_missing,
    render_scope_diagnosis,
    resolve_development_scope,
)


@pytest.fixture
def absent_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point the override at a path that does not exist."""
    missing = tmp_path / "not-on-this-machine" / "Development"
    monkeypatch.setenv("OPENBRAIN_DEVELOPMENT_ROOT", str(missing))
    return missing


def test_absent_configured_root_is_reported_as_missing(absent_root: Path) -> None:
    """The misconfiguration answers True, and scope still resolves to None."""
    assert development_root_missing() is True
    assert resolve_development_scope(Path.cwd()) is None


def test_present_root_outside_lane_is_not_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Somebody else's repository stays silent: the root exists, so nothing is wrong.

    This is the case the module docstring protects. If it ever started reporting
    a diagnosis, every hook in an unrelated repository would start talking.
    """
    root = tmp_path / "Development"
    root.mkdir(parents=True)
    monkeypatch.setenv("OPENBRAIN_DEVELOPMENT_ROOT", str(root))

    elsewhere = tmp_path / "someone-elses-repo"
    elsewhere.mkdir()

    assert development_root_missing() is False
    assert resolve_development_scope(elsewhere) is None


def test_diagnosis_names_the_configured_root_and_its_source(absent_root: Path) -> None:
    """The override case names the environment variable it came from."""
    diagnosis = describe_development_root(cwd=Path("/private/var/somewhere"))

    assert diagnosis is not None
    assert diagnosis.configured_root == absent_root
    assert diagnosis.source == "OPENBRAIN_DEVELOPMENT_ROOT"
    assert diagnosis.cwd == Path("/private/var/somewhere")


def test_diagnosis_names_the_shipped_default_when_no_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With no override set, the diagnosis says the value is the shipped default.

    Only meaningful when the default is genuinely absent, which is the machine
    this bug was found on; where it exists there is nothing to diagnose.
    """
    monkeypatch.delenv("OPENBRAIN_DEVELOPMENT_ROOT", raising=False)
    if DEFAULT_DEVELOPMENT_ROOT.is_dir():
        pytest.skip("the shipped default exists here, so there is no misconfiguration")

    diagnosis = describe_development_root(cwd=Path("/private/var/somewhere"))

    assert diagnosis is not None
    assert diagnosis.configured_root == DEFAULT_DEVELOPMENT_ROOT
    assert diagnosis.source == "default"


def test_no_diagnosis_when_the_root_exists(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A reachable root produces no diagnosis at all."""
    root = tmp_path / "Development"
    root.mkdir(parents=True)
    monkeypatch.setenv("OPENBRAIN_DEVELOPMENT_ROOT", str(root))

    assert describe_development_root(cwd=tmp_path) is None


def test_rendered_text_prints_the_measured_cwd_not_the_default() -> None:
    """The operator-facing text must never substitute the default for the cwd.

    This is the exact Air symptom: remediation text quoted the hardcoded default
    in the position where the reader expects the directory they are standing in.
    """
    diagnosis = ScopeDiagnosis(
        configured_root=Path("/path/to/open-brain/Development"),
        source="default",
        cwd=Path("/Users/rico/somewhere-real"),
    )

    text = render_scope_diagnosis(diagnosis)

    assert "/Users/rico/somewhere-real" in text
    assert "OPENBRAIN_DEVELOPMENT_ROOT" in text
    assert "/path/to/open-brain/Development" in text
    # The measured cwd is quoted after the word that introduces it, so the
    # default cannot be read as the session's directory.
    assert "cwd: /Users/rico/somewhere-real" in text


def test_rendered_text_distinguishes_override_from_default() -> None:
    """An operator who already set the variable is told the value they set."""
    diagnosis = ScopeDiagnosis(
        configured_root=Path("/opt/dev"),
        source="OPENBRAIN_DEVELOPMENT_ROOT",
        cwd=Path("/opt/work"),
    )

    text = render_scope_diagnosis(diagnosis)

    assert "/opt/dev" in text
    assert "OPENBRAIN_DEVELOPMENT_ROOT" in text
    assert "cwd: /opt/work" in text
