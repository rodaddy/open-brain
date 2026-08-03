"""What counts as evidence, and what does not.

The gate's whole authority rests on one judgement: whether a receipt on disk
proves the thing the block is waiting for. These tests are the boundary of that
judgement -- the wrong session, the wrong project, the wrong compaction, or an
old one all look like receipts and none of them count.

Ported from `context-budget-gate.test.ts`.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from gate_harness import (
    PROJECT,
    SESSION,
    gate_paths,
    iso,
    read_session_state,
    record_receipt,
    run_gate,
    start_compact_cycle,
)

from openbrain_provider.development_scope import resolve_development_scope


def _usage_transcript(root: Path, tokens: int) -> str:
    """Write a one-line transcript reporting a token total."""
    path = root / "tokens.jsonl"
    path.write_text(
        json.dumps(
            {
                "type": "assistant",
                "message": {
                    "usage": {
                        "input_tokens": tokens,
                        "cache_read_input_tokens": 0,
                        "cache_creation_input_tokens": 0,
                    }
                },
            }
        )
        + "\n",
        encoding="utf8",
    )
    return str(path)


def test_the_project_comes_from_the_git_toplevel(tmp_path: Path) -> None:
    # The project scopes every piece of state and every receipt query, so a
    # nested directory inside Development must resolve to the SAME project as
    # its root -- otherwise a hook fired from a subdirectory would look at an
    # empty state file and enforce nothing.
    nested = "/Volumes/ThunderBolt/Development/_ob/scripts"
    scope = resolve_development_scope(nested)
    assert scope is not None
    assert scope.project == PROJECT

    paths = gate_paths(tmp_path)
    result = run_gate(
        paths, "status", {"session_id": "nested", "cwd": nested}, project=None
    )
    assert result.code == 0
    assert result.json["project"] == scope.project


def test_checkpoint_done_accepts_only_a_verified_remote_receipt(
    tmp_path: Path,
) -> None:
    paths = gate_paths(tmp_path)
    transcript = _usage_transcript(tmp_path, 260_000)

    warned = run_gate(paths, "user-prompt-submit", {"transcript_path": transcript})
    payload = warned.json
    assert str(payload["systemMessage"]).startswith("OB ")
    assert "automatic compaction" in payload["hookSpecificOutput"]["additionalContext"]
    assert "BLOCKED" not in warned.stdout
    assert read_session_state(paths)["lastNagAtTokens"] == 260_000

    # The same pressure does not nag twice: the count has to climb before the
    # advisory repeats, or one long session prints it every turn and it becomes
    # noise nobody reads.
    renagged = run_gate(paths, "user-prompt-submit", {"transcript_path": transcript})
    assert "hookSpecificOutput" not in renagged.json

    # Spooled, failed, and lost are all "we did not confirm a remote write".
    for status, durable in (("spooled", True), ("failed", False), ("lost", False)):
        record_receipt(paths.receipts, "checkpoint", status, durable)
        refused = run_gate(paths, "checkpoint-done")
        assert refused.code == 1, status
        assert "REFUSED" in refused.stdout, status

    record_receipt(paths.receipts, "checkpoint", "saved", True)
    accepted = run_gate(paths, "checkpoint-done")
    assert accepted.code == 0
    assert "verified remotely" in accepted.stdout
    assert read_session_state(paths)["checkpointRequired"] is False


def test_checkpoint_evidence_is_scoped_and_fresh(tmp_path: Path) -> None:
    # Three different receipts that all LOOK valid. Each is refused for its own
    # reason, and each reason is a real leak if it were accepted: another
    # session's work, another project's work, and work old enough that the
    # context it proved is gone.
    paths = gate_paths(tmp_path)
    cases = [
        {"session_id": "other-session", "project": PROJECT, "recorded_at": None},
        {"session_id": SESSION, "project": "other-project", "recorded_at": None},
        {
            "session_id": SESSION,
            "project": PROJECT,
            "recorded_at": iso(datetime.now(UTC) - timedelta(minutes=21)),
        },
    ]
    for case in cases:
        record_receipt(
            paths.receipts,
            "checkpoint",
            "saved",
            True,
            "explicit",
            case["recorded_at"],
            project=str(case["project"]),
            session_id=str(case["session_id"]),
        )
        refused = run_gate(paths, "checkpoint-done")
        assert refused.code == 1, case
        assert "REFUSED" in refused.stdout, case


def test_a_direct_recall_clears_the_readback_and_a_failed_one_does_not(
    tmp_path: Path,
) -> None:
    paths = gate_paths(tmp_path)
    armed = run_gate(paths, "session-start", {"source": "compact"})
    assert armed.stdout == ""
    correlation = read_session_state(paths)["readbackCorrelationId"]
    assert correlation

    # A FAILED recall is a receipt. It is not evidence of a recall.
    record_receipt(
        paths.receipts, "recall", "failed", False, "compact", None, correlation
    )
    blocked = run_gate(
        paths,
        "pre-tool-use",
        {"tool_name": "Write", "tool_input": {"file_path": str(tmp_path / "b.ts")}},
    )
    assert blocked.blocked

    record_receipt(
        paths.receipts, "recall", "direct", False, "compact", None, correlation
    )
    allowed = run_gate(
        paths,
        "pre-tool-use",
        {"tool_name": "Write", "tool_input": {"file_path": str(tmp_path / "a.ts")}},
    )
    assert '"decision"' not in allowed.stdout
    assert (
        allowed.json["systemMessage"]
        == "OB ✓ read-back cleared · direct recall receipt verified"
    )
    assert run_gate(paths, "status").json["readbackRequired"] is False


def test_a_recall_recorded_before_the_gate_ran_still_counts(tmp_path: Path) -> None:
    # Hook ordering is not guaranteed. The provider's recall can land before the
    # gate's own hook fires, and requiring the gate to observe the arming first
    # would block a session whose recall demonstrably succeeded.
    paths = gate_paths(tmp_path)
    correlation = start_compact_cycle(paths.receipts)
    record_receipt(
        paths.receipts, "recall", "direct", False, "compact", None, correlation
    )

    started = run_gate(paths, "session-start", {"source": "compact"})

    assert started.code == 0
    assert started.stdout == ""
    assert read_session_state(paths)["readbackRequired"] is False


def test_a_post_compact_gate_accepts_the_same_cycles_earlier_recall(
    tmp_path: Path,
) -> None:
    paths = gate_paths(tmp_path)
    correlation = start_compact_cycle(paths.receipts)
    record_receipt(
        paths.receipts, "recall", "direct", False, "compact", None, correlation
    )

    compacted = run_gate(paths, "post-compact")
    assert compacted.code == 0
    assert read_session_state(paths)["readbackRequired"] is True

    allowed = run_gate(
        paths,
        "pre-tool-use",
        {"tool_name": "Bash", "tool_input": {"command": "bun -e 'process.exit(0)'"}},
    )
    assert '"decision"' not in allowed.stdout
    assert "read-back cleared" in allowed.stdout
    assert read_session_state(paths)["readbackRequired"] is False


def test_a_legacy_correlation_is_recovered_only_from_the_matching_window(
    tmp_path: Path,
) -> None:
    # A state file written by an older revision can carry an armed read-back
    # with no correlation id. Adopting the live cycle is right ONLY when the
    # timings say it is the same compaction; adopting any recent cycle would let
    # an unrelated compaction's recall clear this block.
    paths = gate_paths(tmp_path)
    started_at = datetime.now(UTC) - timedelta(minutes=5)
    correlation = start_compact_cycle(paths.receipts, now=started_at)

    _write_legacy_state(paths.state, iso(started_at + timedelta(seconds=1)))
    prompted = run_gate(paths, "user-prompt-submit")
    command = _recovery_command(prompted.stdout)
    assert f'"correlation_id":"{correlation}"' in command

    allowed = run_gate(
        paths, "pre-tool-use", {"tool_name": "Bash", "tool_input": {"command": command}}
    )
    assert allowed.stdout == ""

    # Same command, but the stored arming instant no longer matches the cycle:
    # a different compaction, so the correlation is not adopted and the command
    # no longer proves anything.
    _write_legacy_state(paths.state, iso(datetime.now(UTC)))
    mismatched = run_gate(
        paths, "pre-tool-use", {"tool_name": "Bash", "tool_input": {"command": command}}
    )
    assert mismatched.blocked


def test_post_compact_blocks_until_the_exact_cycle_recall_arrives(
    tmp_path: Path,
) -> None:
    paths = gate_paths(tmp_path)
    correlation = start_compact_cycle(paths.receipts)
    run_gate(paths, "post-compact")

    blocked = run_gate(
        paths,
        "pre-tool-use",
        {"tool_name": "Write", "tool_input": {"file_path": str(tmp_path / "b.ts")}},
    )
    assert blocked.blocked

    record_receipt(
        paths.receipts, "recall", "direct", False, "compact", None, correlation
    )
    allowed = run_gate(
        paths,
        "pre-tool-use",
        {"tool_name": "Write", "tool_input": {"file_path": str(tmp_path / "a.ts")}},
    )
    assert '"decision"' not in allowed.stdout
    assert "read-back cleared" in allowed.stdout
    assert read_session_state(paths)["readbackRequired"] is False


def test_a_prior_cycles_verified_recall_does_not_satisfy_a_new_compaction(
    tmp_path: Path,
) -> None:
    # The exactness of the correlation id is the whole mechanism. If any recent
    # verified recall counted, a session that compacts twice in a minute would
    # have its second compaction cleared by its first, and the second context
    # would never actually be read back.
    paths = gate_paths(tmp_path)
    prior = start_compact_cycle(
        paths.receipts, now=datetime.now(UTC) - timedelta(seconds=9)
    )
    record_receipt(paths.receipts, "recall", "direct", False, "compact", None, prior)
    current = start_compact_cycle(paths.receipts)
    assert current != prior

    started = run_gate(paths, "session-start", {"source": "compact"})
    assert started.stdout == ""
    assert read_session_state(paths)["readbackRequired"] is True


def test_an_uncorrelated_recall_never_satisfies_a_compaction(tmp_path: Path) -> None:
    # A recall with no correlation id at all is the pre-compaction one. It
    # proves the OLD context was read, which is exactly the context the
    # compaction discarded.
    paths = gate_paths(tmp_path)
    record_receipt(
        paths.receipts,
        "recall",
        "direct",
        False,
        "compact",
        iso(datetime.now(UTC) - timedelta(seconds=30)),
    )
    armed = run_gate(paths, "session-start", {"source": "compact"})
    assert armed.stdout == ""

    blocked = run_gate(
        paths,
        "pre-tool-use",
        {"tool_name": "Write", "tool_input": {"file_path": str(tmp_path / "b.ts")}},
    )
    assert blocked.blocked


def test_token_pressure_is_advisory_and_never_blocks(tmp_path: Path) -> None:
    # Pre-compaction pressure used to block. It does not any more, and an old
    # state file still carrying `checkpointRequired` must not resurrect that:
    # automatic compaction handles rollover, so blocking on the way there just
    # stops work for no gain.
    paths = gate_paths(tmp_path)
    paths.state.write_text(
        json.dumps(
            {
                "sessions": {
                    SESSION: {
                        "checkpointRequired": True,
                        "checkpointRequiredAt": iso(datetime.now(UTC)),
                    }
                }
            }
        ),
        encoding="utf8",
    )
    transcript = _usage_transcript(tmp_path, 260_000)

    warned = run_gate(paths, "user-prompt-submit", {"transcript_path": transcript})
    assert "Continue task work" in warned.stdout

    write = run_gate(
        paths,
        "pre-tool-use",
        {"tool_name": "Write", "tool_input": {"file_path": str(tmp_path / "a.ts")}},
    )
    bash = run_gate(
        paths,
        "pre-tool-use",
        {"tool_name": "Bash", "tool_input": {"command": "bun -e 'process.exit(0)'"}},
    )
    assert write.stdout == ""
    assert bash.stdout == ""
    assert read_session_state(paths)["checkpointRequired"] is False

    status = run_gate(paths, "status").json
    assert status["nagAt"] == 200_000
    assert status["hardAt"] == 250_000
    assert status["checkpointRequired"] is False
    assert status["preCompactTaskBlocking"] is False


def test_a_fresh_session_start_clears_a_previous_sessions_block(
    tmp_path: Path,
) -> None:
    # A block belongs to a context. A genuinely new session -- source is not
    # `compact` -- inherits no requirement, because the work that armed it is
    # gone and there is nothing the new session could do to satisfy it.
    paths = gate_paths(tmp_path)
    run_gate(paths, "post-compact")
    assert read_session_state(paths)["readbackRequired"] is True

    run_gate(paths, "session-start", {"source": "startup"})

    state = read_session_state(paths)
    assert state["readbackRequired"] is False
    assert state["captureRequired"] is False
    allowed = run_gate(
        paths,
        "pre-tool-use",
        {"tool_name": "Write", "tool_input": {"file_path": str(tmp_path / "a.ts")}},
    )
    assert not allowed.blocked


def _write_legacy_state(state_path: Path, required_at: str) -> None:
    """Write an armed read-back carrying no correlation id."""
    state_path.write_text(
        json.dumps(
            {
                "sessions": {
                    SESSION: {
                        "sessionId": SESSION,
                        "project": PROJECT,
                        "readbackRequired": True,
                        "readbackRequiredAt": required_at,
                        "readbackCorrelationId": "",
                    }
                }
            }
        ),
        encoding="utf8",
    )


def _recovery_command(output: str) -> str:
    """Extract the executable recovery command from a gate answer.

    Args:
        output: The gate's stdout.

    Returns:
        The `printf … | bun …` line.

    Raises:
        AssertionError: If no such line is present -- which means the banner
            printed no way out, and a banner with no way out is the deadlock.
    """
    banner = output
    try:
        parsed = json.loads(output)
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, dict):
        if isinstance(parsed.get("reason"), str):
            banner = parsed["reason"]
        else:
            hook_output = parsed.get("hookSpecificOutput")
            if isinstance(hook_output, dict) and isinstance(
                hook_output.get("additionalContext"), str
            ):
                banner = hook_output["additionalContext"]
    for line in banner.split("\n"):
        stripped = line.strip()
        if stripped.startswith("printf '%s' ") and "ob-memory-provider.ts" in stripped:
            return stripped
    raise AssertionError(f"no executable recovery command in:\n{output}")
