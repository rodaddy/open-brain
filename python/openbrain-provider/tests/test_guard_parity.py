"""Prove the Python guard emits the same bytes as the TypeScript it replaces.

The fixture is a RECORDING, not a set of expectations someone wrote down: each
case was fed to the running ``_ob/scripts/ob-memory-provider/guard.ts`` as a
subprocess, exactly the way the ``PreToolUse`` hook feeds it, and its stdout
captured byte for byte. That is what makes this a parity test rather than a
restatement of the port's own logic.

The corpus reproduces every case named by ``guard.test.ts`` (27 block, 16
allow) and adds live-hook shapes that suite does not name: the ``Shell`` tool,
non-shell tools, malformed payload shapes, and raw byte payloads including the
oversized fast path.

Two recorded ALLOW cases -- ``( cmd )`` and ``if ...; then cmd; fi`` -- look
like gaps and are pinned deliberately. Byte-identical means identical including
the gaps; changing either would change live enforcement, which is
open-brain#451's decision and not this port's.
"""

from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any

import pytest

from openbrain_provider.cli_guard import main
from openbrain_provider.guard import BLOCK_REASON, guard_claude_command

FIXTURE = Path(__file__).parent / "fixtures" / "guard_parity.json"


def _rebuild_stdin(row: dict[str, Any]) -> str:
    """Reconstruct a case's exact stdin text.

    Long padding runs are stored as a repeat directive so the fixture stays
    readable; the reconstruction is byte-exact and was asserted equal to the
    original recording when the fixture was written.

    Args:
        row: One fixture record.

    Returns:
        The stdin text the TypeScript guard was fed.
    """
    if "stdin" in row:
        text: str = row["stdin"]
        return text
    parts: list[str] = []
    for part in row["stdin_parts"]:
        parts.append(part if isinstance(part, str) else part["repeat"] * part["count"])
    return "".join(parts)


def _load_cases() -> list[tuple[str, str, str]]:
    """Load the recorded cases as ``(name, stdin, expected_stdout)``."""
    rows = json.loads(FIXTURE.read_text())
    return [(row["name"], _rebuild_stdin(row), row["stdout"]) for row in rows]


CASES = _load_cases()


@pytest.mark.parametrize(
    ("name", "stdin_text", "expected"), CASES, ids=[c[0] for c in CASES]
)
def test_guard_matches_recorded_typescript_output(
    name: str, stdin_text: str, expected: str
) -> None:
    assert guard_claude_command(stdin_text.encode("utf-8")) == expected, name


@pytest.mark.parametrize(
    ("name", "stdin_text", "expected"), CASES, ids=[c[0] for c in CASES]
)
def test_cli_matches_recorded_typescript_output(
    name: str, stdin_text: str, expected: str
) -> None:
    out = io.StringIO()
    assert main(io.BytesIO(stdin_text.encode("utf-8")), out) == 0, name
    assert out.getvalue() == expected, name


def test_the_corpus_covers_both_verdicts() -> None:
    blocked = [c for c in CASES if c[2]]
    allowed = [c for c in CASES if not c[2]]
    assert len(blocked) == 60
    assert len(allowed) == 68


def test_every_block_is_the_same_single_payload() -> None:
    payloads = {c[2] for c in CASES if c[2]}
    assert payloads == {
        json.dumps({"decision": "block", "reason": BLOCK_REASON}, separators=(",", ":"))
        + "\n"
    }


def test_the_recorded_block_reason_is_the_live_one() -> None:
    """Pin the refusal text: the agent reads its replacement out of it."""
    recorded = next(c[2] for c in CASES if c[2])
    assert json.loads(recorded)["reason"] == BLOCK_REASON
    assert "qmd" in BLOCK_REASON


def test_the_fixture_reproduces_the_typescript_suite_labels() -> None:
    """A ``ts-block``/``ts-allow`` case disagreeing means the oracle is wrong."""
    for name, _stdin, expected in CASES:
        if name.startswith("ts-block"):
            assert expected, name
        if name.startswith("ts-allow"):
            assert expected == "", name
