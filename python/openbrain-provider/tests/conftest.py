"""Shared pytest fixtures.

Loguru installs a default stderr sink at import time. Under pytest that stream
is `capsys`-replaced per test and closed when the test ends, so a sink held
across tests writes to a closed file and loguru prints "Logging error in Loguru
Handler". The tests still pass, which is the problem: a logging error that
appears in every run gets read as normal and stops being informative.

Removing every sink around each test makes sink state per-test rather than
per-session.

This module also provisions the Development root the gate scopes by, BEFORE
`openbrain_provider` is imported anywhere -- see `_install_development_root`.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
from collections.abc import Iterator
from pathlib import Path

import pytest
from loguru import logger


def _install_development_root() -> None:
    """Point `OPENBRAIN_DEVELOPMENT_ROOT` at a real directory for this run.

    `resolve_development_scope` asks the FILESYSTEM: the root must exist, be a
    directory, and share a git object store with the cwd under test. On Rico's
    Mac `/Volumes/ThunderBolt/Development` satisfies that by accident of where
    the work happens, so the suite passed locally and 11 tests failed on the
    Linux CI runner where the path does not exist -- every scope resolved to
    None and the gate correctly fell silent, which reads as a broken gate.

    Depending on a machine-specific absolute path is the defect. When the real
    root is absent, this creates a git repository named `Development` and points
    the override at it, so the project slug and every banner string stay
    identical to the local run.

    Runs at import time because `DEVELOPMENT_ROOT` is read when
    `openbrain_provider.development_scope` is first imported, which a fixture
    would be too late for.
    """
    if os.environ.get("OPENBRAIN_DEVELOPMENT_ROOT"):
        return
    default = Path("/Volumes/ThunderBolt/Development")
    if default.is_dir():
        return

    # Not the temp-workspace rule's business: this is CI's own scratch, chosen
    # by the runner, and it must not be a path on Rico's machine.
    root = Path(tempfile.mkdtemp(prefix="openbrain-dev-root-")) / "Development"
    root.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["git", "init", "-q", str(root)],
        check=True,
        capture_output=True,
        timeout=30,
    )
    os.environ["OPENBRAIN_DEVELOPMENT_ROOT"] = str(root)


_install_development_root()


@pytest.fixture(autouse=True)
def _isolate_loguru_sinks() -> Iterator[None]:
    """Give each test a clean, empty loguru sink set.

    Yields:
        None. Sinks are cleared before and after every test.
    """
    logger.remove()
    yield
    logger.remove()
