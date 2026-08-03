"""What the operator SEES, and what the gate remembers between events.

The status line is the gate's whole visible surface. If it reports "ok" for a
file it could not read, or drops a cleared-notice because the same call was
blocked for a different reason, the operator is being told the system is
healthier than it is -- which is the failure the line exists to prevent.

Ported from `context-budget-gate-lifecycle.test.ts`.
"""

from __future__ import annotations

import json
from pathlib import Path

from gate_harness import (
    SESSION,
    gate_paths,
    read_session_state,
    record_receipt,
    run_gate,
)


def _work_transcript(root: Path) -> str:
    """Write a transcript whose latest turn contains a successful Write."""
    path = root / "work.jsonl"
    path.write_text(
        "\n".join(
            [
                json.dumps({"type": "user", "message": {"content": "implement"}}),
                json.dumps(
                    {
                        "type": "assistant",
                        "message": {
                            "content": [{"type": "tool_use", "name": "Write"}]
                        },
                    }
                ),
            ]
        ),
        encoding="utf8",
    )
    return str(path)


def _policy_state(paths: object, refresh_required: object) -> None:
    """Write a policy state file the gate will read for this session."""
    assert hasattr(paths, "policy_state")
    paths.policy_state.write_text(  # type: ignore[attr-defined]
        json.dumps(
            {"sessions": {f"claude:{SESSION}": {"refreshRequired": refresh_required}}}
        ),
        encoding="utf8",
    )


def test_token_accounting_includes_cache_reads_and_creation(tmp_path: Path) -> None:
    # Counting only `input_tokens` under-reports a cached session by the size of
    # its cache, which is most of it -- so the advisory would fire far too late,
    # or never.
    paths = gate_paths(tmp_path)
    transcript = tmp_path / "tokens.jsonl"
    transcript.write_text(
        json.dumps(
            {
                "type": "assistant",
                "message": {
                    "usage": {
                        "input_tokens": 11_000,
                        "cache_read_input_tokens": 22_000,
                        "cache_creation_input_tokens": 33_000,
                    }
                },
            }
        )
        + "\n",
        encoding="utf8",
    )

    run_gate(paths, "status", {"transcript_path": str(transcript)})

    assert read_session_state(paths)["contextTokens"] == 66_000


def test_a_durable_spool_clears_capture_without_claiming_a_remote_write(
    tmp_path: Path,
) -> None:
    # A spooled write IS durable -- the spool replays it -- so it clears the
    # capture requirement. The notice says "durable write receipt", not
    # "verified remotely", because those are different claims and only one of
    # them is true here.
    paths = gate_paths(tmp_path)
    stopped = run_gate(paths, "stop", {"transcript_path": _work_transcript(tmp_path)})
    assert "OB Capture Gate" in stopped.stdout

    record_receipt(paths.receipts, "capture", "spooled", True)
    allowed = run_gate(
        paths,
        "pre-tool-use",
        {"tool_name": "Write", "tool_input": {"file_path": str(tmp_path / "a.ts")}},
    )

    assert '"decision"' not in allowed.stdout
    assert (
        allowed.json["systemMessage"]
        == "OB ✓ capture cleared · durable write receipt verified"
    )
    assert read_session_state(paths)["captureRequired"] is False


def test_the_status_line_reports_every_gate_every_turn(tmp_path: Path) -> None:
    paths = gate_paths(tmp_path)
    _policy_state(paths, False)

    clear = run_gate(paths, "user-prompt-submit")
    assert clear.json["systemMessage"] == (
        "OB ✓ recall ok · policy ok · capture ok · spool 0"
    )
    assert "hookSpecificOutput" not in clear.json

    run_gate(paths, "session-start", {"source": "compact"})
    # A truthy non-boolean must read as STALE: the policy gate itself enforces
    # on truthiness, so reading only `is True` here would disagree with the gate
    # that owns the field.
    _policy_state(paths, 1)
    # The unparseable line is not a pending entry. Counting it would report work
    # waiting that the spool will never replay.
    paths.spool.write_text('{"entry":1}\nnot-json\n{"entry":2}\n', encoding="utf8")

    armed = run_gate(paths, "user-prompt-submit")
    assert (
        armed.json["systemMessage"]
        == "OB ✗ recall DUE · policy STALE · capture ok · spool 2"
    )
    assert armed.json["hookSpecificOutput"]["hookEventName"] == "UserPromptSubmit"
    assert (
        "forced post-compact read-back"
        in armed.json["hookSpecificOutput"]["additionalContext"]
    )

    status = run_gate(paths, "status").json
    assert status["policyStale"] is True
    assert status["spoolPending"] == 2
    assert status["statusLine"] == (
        "OB ✗ recall DUE · policy STALE · capture ok · spool 2"
    )


def test_unknown_is_shown_as_unknown_and_the_gate_is_silent_outside_development(
    tmp_path: Path,
) -> None:
    # An absent policy state file is UNKNOWN, not healthy. Rendering it as "ok"
    # would report a check that never ran as a check that passed -- the same
    # class of defect as a test suite that skips silently.
    paths = gate_paths(tmp_path)

    no_policy = run_gate(paths, "user-prompt-submit")
    assert (
        no_policy.json["systemMessage"]
        == "OB ✓ recall ok · policy — · capture ok · spool 0"
    )

    outside = run_gate(
        paths,
        "user-prompt-submit",
        {"session_id": "outside", "cwd": "/"},
        project=None,
        session_id="outside",
    )
    assert outside.stdout == ""


def test_a_cleared_notice_waits_for_a_surface_that_displays_it(
    tmp_path: Path,
) -> None:
    # `status` observes the clear but must not consume the notice: it is a
    # diagnostic command, not something the operator is watching. Consuming it
    # there would mean the one turn that reported the clear was a debug run
    # nobody saw.
    paths = gate_paths(tmp_path)
    run_gate(paths, "session-start", {"source": "compact"})
    correlation = read_session_state(paths)["readbackCorrelationId"]
    record_receipt(
        paths.receipts, "recall", "direct", False, "compact", None, correlation
    )

    expected = ["read-back cleared · direct recall receipt verified"]
    assert run_gate(paths, "status").json["pendingClearedNotices"] == expected
    assert run_gate(paths, "status").json["pendingClearedNotices"] == expected

    prompted = run_gate(paths, "user-prompt-submit")
    assert prompted.json["systemMessage"] == (
        "OB ✓ read-back cleared · direct recall receipt verified\n"
        "OB ✓ recall ok · policy — · capture ok · spool 0"
    )
    assert read_session_state(paths)["pendingClearedNotices"] == []

    again = run_gate(paths, "user-prompt-submit")
    assert again.json["systemMessage"] == (
        "OB ✓ recall ok · policy — · capture ok · spool 0"
    )


def test_a_notice_queued_during_a_block_survives_to_the_next_allowed_call(
    tmp_path: Path,
) -> None:
    # Two independent gates can be armed at once. When one clears on a call the
    # OTHER still blocks, the clear must not be swallowed by the block path --
    # otherwise the operator fixes something and is never told it worked.
    paths = gate_paths(tmp_path)
    run_gate(paths, "stop", {"transcript_path": _work_transcript(tmp_path)})
    run_gate(paths, "session-start", {"source": "compact"})
    correlation = read_session_state(paths)["readbackCorrelationId"]
    record_receipt(
        paths.receipts, "recall", "direct", False, "compact", None, correlation
    )

    blocked = run_gate(
        paths,
        "pre-tool-use",
        {"tool_name": "Write", "tool_input": {"file_path": str(tmp_path / "b.ts")}},
    )
    assert blocked.blocked
    assert read_session_state(paths)["pendingClearedNotices"] == [
        "read-back cleared · direct recall receipt verified"
    ]

    record_receipt(paths.receipts, "capture", "spooled", True)
    allowed = run_gate(
        paths,
        "pre-tool-use",
        {"tool_name": "Write", "tool_input": {"file_path": str(tmp_path / "a.ts")}},
    )
    assert allowed.json["systemMessage"] == (
        "OB ✓ read-back cleared · direct recall receipt verified · "
        "capture cleared · durable write receipt verified"
    )
    assert read_session_state(paths)["pendingClearedNotices"] == []


def test_stop_does_not_arm_capture_when_the_turn_did_no_work(tmp_path: Path) -> None:
    # An advisory turn -- reading, answering a question -- has nothing to
    # capture. Arming there would block the next tool call over a turn that
    # produced nothing worth storing.
    paths = gate_paths(tmp_path)
    transcript = tmp_path / "idle.jsonl"
    transcript.write_text(
        "\n".join(
            [
                json.dumps({"type": "user", "message": {"content": "what is this"}}),
                json.dumps({"type": "assistant", "message": {"content": "a gate"}}),
            ]
        ),
        encoding="utf8",
    )

    stopped = run_gate(paths, "stop", {"transcript_path": str(transcript)})

    assert stopped.stdout == ""
    assert read_session_state(paths)["captureRequired"] is False
