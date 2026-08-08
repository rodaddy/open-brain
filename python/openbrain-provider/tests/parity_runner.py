"""Replay recorded TypeScript-gate I/O through the Python gates.

Purpose:
    The parity bar for this port is not "similar behaviour", it is the SAME
    bytes on the same input. The fixtures in ``tests/fixtures/ts_gate_parity/``
    are recordings of the live TypeScript gates, so this replays each one and
    compares.

Architecture:
    A helper, not a test module -- ``test_ts_parity.py`` drives it. Kept
    separate because the normalisation rules below are the interesting part and
    they should be readable without the test scaffolding around them.

Pattern/Convention:
    NORMALISE ONLY WHAT IS GENUINELY NON-DETERMINISTIC. Timestamps and UUIDs
    differ between two runs of the SAME gate, so comparing them would prove
    nothing. Everything else -- every word, every separator, every exit code --
    is compared literally. A normaliser that reached further would hide exactly
    the drift these fixtures exist to catch.

See Also:
    - ``tests/fixtures/ts_gate_parity/README.md`` -- how the fixtures were made
"""

from __future__ import annotations

import io
import json
import re
from pathlib import Path
from typing import Any, Final

from openbrain_provider import context_budget_gate, policy_refresh_gate
from openbrain_provider.development_scope import (
    DEFAULT_DEVELOPMENT_ROOT,
    development_root,
)

__all__ = ["ParityCase", "load_cases", "normalise", "run_case"]

#: An ISO-8601 instant. Two runs of one gate differ here by construction.
_TIMESTAMP: Final[re.Pattern[str]] = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"
)

#: A v4 UUID -- the compact-cycle correlation id, freshly generated per cycle.
_UUID: Final[re.Pattern[str]] = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
)

#: Scratch paths baked into a recording's arguments.
_SCRATCH_PATH: Final[re.Pattern[str]] = re.compile(
    r"/path/to/open-brain/_tmp/open-brain/_scratch/gate[a-zA-Z0-9-]+"
)


class ParityCase(dict[str, Any]):
    """One recorded invocation: arguments, stdin, and the observed answer."""

    @property
    def name(self) -> str:
        """Return the case name."""
        return str(self["name"])

    @property
    def script(self) -> str:
        """Return which gate produced it: ``budget`` or ``policy``."""
        return str(self["script"])

    @property
    def argv(self) -> list[str]:
        """Return the recorded arguments, minus the script path."""
        return [str(item) for item in self["argv"]]

    @property
    def stdin(self) -> dict[str, Any]:
        """Return the recorded stdin object."""
        value = self["stdin"]
        return value if isinstance(value, dict) else {}

    @property
    def stdout(self) -> str:
        """Return the recorded stdout."""
        return str(self["stdout"])

    @property
    def status(self) -> int:
        """Return the recorded exit code."""
        return int(self["status"])


def load_cases(fixture: Path) -> list[ParityCase]:
    """Read the recorded cases.

    Args:
        fixture: The recordings file.

    Returns:
        Every recorded case, in order.
    """
    raw = json.loads(fixture.read_text(encoding="utf8"))
    return [ParityCase(entry) for entry in raw]


def normalise(text: str, scratch: Path) -> str:
    """Replace only the genuinely non-deterministic parts of an answer.

    Args:
        text: Recorded or produced output.
        scratch: The scratch directory this run used.

    Returns:
        The text with timestamps, UUIDs, scratch paths, and the Development root
        replaced by stable markers. Nothing else is touched.
    """
    replaced = _TIMESTAMP.sub("<TIME>", text)
    replaced = _UUID.sub("<UUID>", replaced)
    replaced = replaced.replace(str(scratch), "<SCRATCH>")
    replaced = _SCRATCH_PATH.sub("<SCRATCH>", replaced)
    # The recordings were made on Rico's Mac, where the Development root is
    # `/path/to/open-brain/Development`. On a machine without that volume the
    # suite runs against a provisioned stand-in root, so the root is environment
    # exactly like a scratch path is -- NOT behaviour. Both spellings collapse to
    # one marker, which keeps every other byte of the banner compared literally.
    replaced = replaced.replace(str(development_root()), "<DEV_ROOT>")
    replaced = replaced.replace(str(DEFAULT_DEVELOPMENT_ROOT), "<DEV_ROOT>")
    return replaced.replace("/path/to/open-brain/Development", "<DEV_ROOT>")


def _rewrite_argv(argv: list[str], scratch: Path) -> list[str]:
    """Point a recording's path arguments at this run's scratch directory.

    Args:
        argv: The recorded arguments.
        scratch: This run's scratch directory.

    Returns:
        The arguments with every recorded scratch path rewritten, and the
        TypeScript-only ``--gate-script-path`` default preserved so the repair
        allowances compare like for like.
    """
    return [_SCRATCH_PATH.sub(str(scratch), argument) for argument in argv]


def run_case(case: ParityCase, scratch: Path) -> tuple[str, int]:
    """Run one recorded case through the Python gate.

    Args:
        case: The recorded invocation.
        scratch: This run's scratch directory.

    Returns:
        ``(stdout, exit_code)`` from the Python gate.
    """
    argv = _rewrite_argv(case.argv, scratch)
    stdin = io.StringIO(json.dumps(case.stdin))
    stdout = io.StringIO()
    if case.script == "budget":
        code = context_budget_gate.main(
            argv, stdin=stdin, stdout=stdout, env={"HOME": str(scratch)}
        )
    else:
        code = policy_refresh_gate.main(argv, stdin=stdin, stdout=stdout)
    return stdout.getvalue(), code
