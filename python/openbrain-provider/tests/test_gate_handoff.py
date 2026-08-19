"""Compact-boundary counting, and the proof it never blocks the session.

Claudex is Claude Code and compacts natively. The gate observes how many
compactions a session has taken and may ADVISE a fresh one, but it must
never latch the session closed or veto compaction -- doing so force-feeds a
second discipline onto the one that already works, and the veto makes the
very number it complains about unable to fall (dev 2026-08-19).
"""

from __future__ import annotations

import json
from pathlib import Path

from gate_harness import (
    DEVELOPMENT_CWD,
    SESSION,
    gate_paths,
    read_session_state,
    record_receipt,
    run_gate,
)

from openbrain_provider.development_scope import development_root
from openbrain_provider.gate_shell import shell_quote

_COMPACT_BOUNDARY = {"type": "system", "subtype": "compact_boundary"}
_PROVIDER_SCRIPT = development_root() / "_ob" / "scripts" / "ob-memory-provider.ts"


def _transcript(
    root: Path, compact_count: int, context_tokens: int, filler: str = ""
) -> str:
    """Write one transcript carrying boundaries and the latest usage record."""
    lines = [
        json.dumps(_COMPACT_BOUNDARY, separators=(",", ":"))
        for _ in range(compact_count)
    ]
    if filler:
        lines.append(filler)
    lines.append(
        json.dumps(
            {
                "type": "assistant",
                "message": {"usage": {"input_tokens": context_tokens}},
            }
        )
    )
    path = root / "transcript.jsonl"
    path.write_text("\n".join(lines) + "\n", encoding="utf8")
    return str(path)


def _provider_command(event: str = "checkpoint") -> str:
    """Build a valid direct provider command for this test session."""
    payload = json.dumps(
        {
            "cwd": DEVELOPMENT_CWD,
            "session_id": SESSION,
            "distilled": {
                "summary": "Handoff written to _DOCS/_handoff/session-handoff-test.md.",
                "key_decisions": [],
                "next_steps": ["Start a fresh session."],
                "receipt_refs": ["_DOCS/_handoff/session-handoff-test.md"],
            },
        },
        separators=(",", ":"),
    )
    provider = shell_quote(str(_PROVIDER_SCRIPT))
    return (
        f"printf '%s' {shell_quote(payload)} | bun {provider} "
        f"--runtime claude --event {event}"
    )


def test_zero_compacts_keeps_first_sprint_advisory_only(tmp_path: Path) -> None:
    """A session with no compaction is untouched by the sprint advisory."""
    paths = gate_paths(tmp_path)
    transcript = _transcript(tmp_path, 0, 260_000)

    prompted = run_gate(paths, "user-prompt-submit", {"transcript_path": transcript})
    write = run_gate(
        paths,
        "pre-tool-use",
        {
            "transcript_path": transcript,
            "tool_name": "Write",
            "tool_input": {"file_path": str(tmp_path / "allowed.py")},
        },
    )

    assert "handoff required" not in prompted.stdout
    assert not write.blocked
    state = read_session_state(paths)
    assert state["compactBoundaryCount"] == 0
    assert state["longSprintNoted"] is False


def test_first_compact_still_requires_its_exact_cycle_recall(tmp_path: Path) -> None:
    """The pre-existing post-compact read-back is untouched by this change."""
    paths = gate_paths(tmp_path)
    transcript = _transcript(tmp_path, 1, 80_000)
    run_gate(
        paths,
        "session-start",
        {"source": "compact", "transcript_path": transcript},
    )
    correlation = str(read_session_state(paths)["readbackCorrelationId"])
    record_receipt(
        paths.receipts, "recall", "direct", False, "compact", None, correlation
    )

    allowed = run_gate(
        paths,
        "pre-tool-use",
        {
            "tool_name": "Write",
            "tool_input": {"file_path": str(tmp_path / "allowed.py")},
        },
    )

    assert "read-back cleared" in allowed.stdout
    state = read_session_state(paths)
    assert state["compactBoundaryCount"] == 1
    assert state["readbackRequired"] is False


def test_long_sprint_advises_but_never_blocks(tmp_path: Path) -> None:
    """Past the band the gate advises; task mutation still runs."""
    paths = gate_paths(tmp_path)
    transcript = _transcript(tmp_path, 1, 200_000)

    prompted = run_gate(paths, "user-prompt-submit", {"transcript_path": transcript})
    write = run_gate(
        paths,
        "pre-tool-use",
        {
            "tool_name": "Write",
            "tool_input": {"file_path": str(tmp_path / "still-allowed.py")},
        },
    )

    assert "automatic compaction handles rollover" in prompted.stdout
    assert "handoff required" not in prompted.stdout
    assert not write.blocked
    state = read_session_state(paths)
    assert state["compactBoundaryCount"] == 1
    assert state["longSprintNoted"] is True


def test_second_precompact_is_allowed(tmp_path: Path) -> None:
    """Compaction is the relief valve and is never vetoed."""
    paths = gate_paths(tmp_path)
    transcript = _transcript(tmp_path, 1, 300_000)

    run_gate(paths, "user-prompt-submit", {"transcript_path": transcript})
    compacting = run_gate(paths, "pre-compact", {"transcript_path": transcript})

    assert not compacting.blocked
    assert "second compaction refused" not in compacting.stdout


def test_missing_transcript_never_forgets_an_observed_boundary(
    tmp_path: Path,
) -> None:
    """A boundary already observed survives a later unreadable transcript."""
    paths = gate_paths(tmp_path)
    transcript = _transcript(tmp_path, 1, 10_000)
    run_gate(paths, "user-prompt-submit", {"transcript_path": transcript})
    assert read_session_state(paths)["compactBoundaryCount"] == 1

    run_gate(
        paths,
        "user-prompt-submit",
        {"transcript_path": str(tmp_path / "missing.jsonl")},
    )
    assert read_session_state(paths)["compactBoundaryCount"] == 1


def test_boundary_count_reads_the_whole_append_only_transcript(
    tmp_path: Path,
) -> None:
    """Markers are counted past the token tail, not only in the last lines."""
    paths = gate_paths(tmp_path)
    filler = "\n".join(
        json.dumps({"type": "assistant", "message": {"content": f"line {index}"}})
        for index in range(500)
    )
    transcript = _transcript(tmp_path, 2, 120_000, filler)

    run_gate(paths, "user-prompt-submit", {"transcript_path": transcript})

    assert read_session_state(paths)["compactBoundaryCount"] == 2


def test_fresh_session_resets_the_sprint(tmp_path: Path) -> None:
    """A genuinely new session starts with a clean sprint record."""
    paths = gate_paths(tmp_path)
    transcript = _transcript(tmp_path, 1, 200_000)
    run_gate(paths, "user-prompt-submit", {"transcript_path": transcript})
    assert read_session_state(paths)["longSprintNoted"] is True

    run_gate(paths, "session-start", {"source": "startup"})

    state = read_session_state(paths)
    assert state["longSprintNoted"] is False
    assert state["compactBoundaryCount"] == 0


def test_status_reports_the_sprint_without_blocking(tmp_path: Path) -> None:
    """Status exposes the count and never claims pre-compact blocking."""
    paths = gate_paths(tmp_path)
    transcript = _transcript(tmp_path, 1, 200_000)
    run_gate(paths, "user-prompt-submit", {"transcript_path": transcript})

    status = run_gate(paths, "status", {"transcript_path": transcript})

    payload = json.loads(status.stdout)
    assert payload["compactBoundaryCount"] == 1
    assert payload["preCompactTaskBlocking"] is False
    assert "handoffRequired" not in payload
