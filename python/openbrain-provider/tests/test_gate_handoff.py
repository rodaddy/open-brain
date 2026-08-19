"""The one-compaction sprint boundary and its only permitted exit."""

from __future__ import annotations

import json
from pathlib import Path

from gate_harness import (
    DEVELOPMENT_CWD,
    PROJECT,
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

    assert "automatic compaction handles rollover" in prompted.stdout
    assert "handoff required" not in prompted.stdout
    assert not write.blocked
    assert read_session_state(paths) | {
        "compactBoundaryCount": 0,
        "handoffRequired": False,
    } == read_session_state(paths)


def test_first_compact_still_requires_its_exact_cycle_recall(tmp_path: Path) -> None:
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
    assert state["handoffRequired"] is False
    assert state["readbackRequired"] is False


def test_first_compact_plus_200k_blocks_task_mutation(tmp_path: Path) -> None:
    paths = gate_paths(tmp_path)
    transcript = _transcript(tmp_path, 1, 200_000)

    prompted = run_gate(paths, "user-prompt-submit", {"transcript_path": transcript})
    blocked = run_gate(
        paths,
        "pre-tool-use",
        {
            "tool_name": "Write",
            "tool_input": {"file_path": str(tmp_path / "blocked.py")},
        },
    )

    assert "handoff required" in prompted.stdout
    assert "_DOCS/_handoff/" in prompted.stdout
    assert blocked.blocked
    assert "this session does not reopen" in blocked.stdout
    state = read_session_state(paths)
    assert state["compactBoundaryCount"] == 1
    assert state["handoffRequired"] is True


def test_handoff_document_and_checkpoint_are_the_only_mutating_exit(
    tmp_path: Path,
) -> None:
    paths = gate_paths(tmp_path)
    transcript = _transcript(tmp_path, 1, 200_000)
    run_gate(paths, "user-prompt-submit", {"transcript_path": transcript})
    handoff = development_root() / "_DOCS" / "_handoff" / "session-handoff-test.md"

    read_state = run_gate(
        paths,
        "pre-tool-use",
        {"tool_name": "Read", "tool_input": {"file_path": str(paths.state)}},
    )
    document = run_gate(
        paths,
        "pre-tool-use",
        {"tool_name": "Write", "tool_input": {"file_path": str(handoff)}},
    )
    checkpoint = run_gate(
        paths,
        "pre-tool-use",
        {"tool_name": "Bash", "tool_input": {"command": _provider_command()}},
    )
    other_provider_events = [
        run_gate(
            paths,
            "pre-tool-use",
            {
                "tool_name": "Bash",
                "tool_input": {"command": _provider_command(event)},
            },
        )
        for event in ("capture", "wrap")
    ]
    non_markdown = run_gate(
        paths,
        "pre-tool-use",
        {
            "tool_name": "Write",
            "tool_input": {"file_path": str(handoff.with_suffix(".json"))},
        },
    )
    traversal = run_gate(
        paths,
        "pre-tool-use",
        {
            "tool_name": "Write",
            "tool_input": {"file_path": str(handoff.parent / ".." / "outside.md")},
        },
    )

    assert not read_state.blocked
    assert not document.blocked
    assert not checkpoint.blocked
    assert all(result.blocked for result in other_provider_events)
    assert non_markdown.blocked
    assert traversal.blocked


def test_second_precompact_is_refused_from_the_boundary_count(tmp_path: Path) -> None:
    paths = gate_paths(tmp_path)
    transcript = _transcript(tmp_path, 1, 40_000)

    blocked = run_gate(paths, "pre-compact", {"transcript_path": transcript})

    assert blocked.blocked
    assert "second compaction refused" in blocked.stdout
    state = read_session_state(paths)
    assert state["compactBoundaryCount"] == 1
    assert state["handoffRequired"] is True


def test_missing_transcript_never_forgets_an_observed_boundary(tmp_path: Path) -> None:
    paths = gate_paths(tmp_path)
    transcript = _transcript(tmp_path, 1, 40_000)
    run_gate(paths, "status", {"transcript_path": transcript})

    run_gate(paths, "status")
    blocked = run_gate(paths, "pre-compact")

    assert blocked.blocked
    assert "second compaction refused" in blocked.stdout
    assert read_session_state(paths)["compactBoundaryCount"] == 1


def test_second_postcompact_boundary_fails_safe(tmp_path: Path) -> None:
    paths = gate_paths(tmp_path)
    transcript = _transcript(tmp_path, 2, 20_000)
    run_gate(paths, "post-compact", {"transcript_path": transcript})

    blocked = run_gate(
        paths,
        "pre-tool-use",
        {
            "tool_name": "Write",
            "tool_input": {"file_path": str(tmp_path / "blocked.py")},
        },
    )

    assert blocked.blocked
    assert "handoff required" in blocked.stdout
    state = read_session_state(paths)
    assert state["compactBoundaryCount"] == 2
    assert state["handoffRequired"] is True


def test_boundary_count_reads_the_whole_append_only_transcript(tmp_path: Path) -> None:
    paths = gate_paths(tmp_path)
    transcript = _transcript(
        tmp_path,
        1,
        200_000,
        filler="x" * (2 * 1024 * 1024 + 128),
    )

    run_gate(paths, "user-prompt-submit", {"transcript_path": transcript})

    state = read_session_state(paths)
    assert state["compactBoundaryCount"] == 1
    assert state["handoffRequired"] is True


def test_fresh_session_resets_the_sprint(tmp_path: Path) -> None:
    paths = gate_paths(tmp_path)
    used = _transcript(tmp_path, 1, 200_000)
    run_gate(paths, "user-prompt-submit", {"transcript_path": used})

    fresh = tmp_path / "fresh.jsonl"
    fresh.write_text(
        json.dumps({"type": "assistant", "message": {"usage": {"input_tokens": 1_000}}})
        + "\n",
        encoding="utf8",
    )
    run_gate(
        paths,
        "session-start",
        {"source": "startup", "transcript_path": str(fresh)},
    )

    state = read_session_state(paths)
    assert state["compactBoundaryCount"] == 0
    assert state["handoffRequired"] is False
    assert state["contextTokens"] == 0


def test_checkpoint_receipt_never_reopens_a_required_handoff(tmp_path: Path) -> None:
    paths = gate_paths(tmp_path)
    transcript = _transcript(tmp_path, 1, 200_000)
    run_gate(paths, "user-prompt-submit", {"transcript_path": transcript})
    record_receipt(paths.receipts, "checkpoint", "saved", True)

    verified = run_gate(paths, "checkpoint-done")

    assert verified.code == 0
    assert "Handoff remains required" in verified.stdout
    assert read_session_state(paths)["handoffRequired"] is True
    assert PROJECT == development_root().name
