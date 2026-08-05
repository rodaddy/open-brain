"""A missing Development root must not be a silent no-op on the receipt side.

Field-proved on the Air, 2026-08-04 (open-brain#556): on a machine where the
configured root does not exist, the provider exited CLEAN with no receipt and no
output, so an operator could not tell "worked" from "did nothing". The guarded
writer returned None for an unresolved scope without logging anything -- unlike
the failure path directly below it, which does log.

The distinction these pin: out of scope stays silent (it is somebody else's
repository), while an absent configured root speaks up (it is a misconfiguration
that makes EVERY directory out of scope).
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

import pytest
from loguru import logger

from openbrain.apps.hooks import receipts as hook_receipts

if TYPE_CHECKING:
    from collections.abc import Iterator

from openbrain.receipts.scope import (
    development_root,
    development_root_missing,
    development_root_origin,
)


@pytest.fixture
def warnings() -> Iterator[list[str]]:
    """Collect loguru warnings as text.

    loguru does not write through the stdlib logging tree, so `caplog` sees
    nothing, and its default sink holds a stderr reference that `capsys` cannot
    intercept. A sink of our own asserts the MESSAGE rather than the transport,
    which is what these tests are actually about.
    """
    captured: list[str] = []
    sink_id = logger.add(lambda message: captured.append(str(message)), level="WARNING")
    try:
        yield captured
    finally:
        logger.remove(sink_id)


@pytest.fixture
def absent_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Configure a Development root that does not exist on this machine."""
    missing = tmp_path / "absent-volume" / "Development"
    monkeypatch.setenv("OPENBRAIN_DEVELOPMENT_ROOT", str(missing))
    return missing


def test_absent_root_is_detected_and_attributed(absent_root: Path) -> None:
    """The root is reported missing and attributed to the variable that set it."""
    assert development_root_missing() is True
    assert development_root() == absent_root
    assert development_root_origin() == "OPENBRAIN_DEVELOPMENT_ROOT"


def test_present_root_reports_the_shipped_default_origin(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With no override, the origin is named as the shipped default."""
    monkeypatch.delenv("OPENBRAIN_DEVELOPMENT_ROOT", raising=False)
    assert development_root_origin() == "shipped default"


def test_absent_root_logs_a_diagnosis_naming_the_measured_cwd(
    absent_root: Path, warnings: list[str]
) -> None:
    """The warning names the root, its origin, the measured cwd, and the fix.

    The cwd is the one the caller reported, never a path composed from the
    absent root -- that substitution is the Air symptom.
    """
    measured = "/Users/rico/some-real-directory"

    hook_receipts._warn_missing_development_root("stop", measured)

    text = "".join(warnings)
    assert str(absent_root) in text
    assert "OPENBRAIN_DEVELOPMENT_ROOT" in text
    assert measured in text


def test_out_of_scope_cwd_stays_silent_when_the_root_exists(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, warnings: list[str]
) -> None:
    """Somebody else's repository logs nothing at all.

    This is the behaviour the scope module exists to provide. If a diagnosis
    ever fired here, every hook in every unrelated repo would start warning.
    """
    root = tmp_path / "Development"
    root.mkdir(parents=True)
    monkeypatch.setenv("OPENBRAIN_DEVELOPMENT_ROOT", str(root))

    hook_receipts._warn_missing_development_root("stop", str(tmp_path / "other"))

    assert warnings == []


def test_guarded_write_is_skipped_but_diagnosed(
    absent_root: Path, tmp_path: Path, warnings: list[str]
) -> None:
    """No receipt is written, and the reason is now visible.

    The write still does not happen -- an absent root means there is no resolved
    project to file under. What changes is that the skip is no longer silent.
    """
    calls: list[str] = []

    def _write(project: str, path: Path) -> str:
        calls.append(project)
        return "written"

    result = hook_receipts._guarded(
        "stop",
        _write,
        str(tmp_path),
        tmp_path / "receipts.json",
    )

    assert result is None
    assert calls == []
    assert "OPENBRAIN_DEVELOPMENT_ROOT" in "".join(warnings)
