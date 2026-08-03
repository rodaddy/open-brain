"""The allowance boundary: exactly what a blocked session may still run.

This is the highest-risk surface in the gate. Every case here is an attempt to
get a mutating command past a block by dressing it as the escape hatch, and each
one must be refused -- while the REAL escape hatch, the exact command the gate
itself printed, must be allowed. Both halves matter: an allowance that is too
tight is the deadlock #419 names, and one that is too loose is no gate at all.

Ported from `context-budget-gate-provider.test.ts`.
"""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from gate_harness import (
    PROJECT,
    SESSION,
    GatePaths,
    gate_paths,
    iso,
    read_session_state,
    record_receipt,
    run_gate,
    start_compact_cycle,
)
from test_gate_receipts import _recovery_command

from openbrain_provider.gate_shell import shell_quote

SIBLING_PROVIDER = "/Volumes/ThunderBolt/Development/_ob/scripts/ob-memory-provider.ts"
DEVELOPMENT_CWD = "/Volumes/ThunderBolt/Development"


def _bash(command: str) -> dict[str, object]:
    """Build a Bash tool call."""
    return {"tool_name": "Bash", "tool_input": {"command": command}}


def _recall_command(provider_path: str, correlation: str) -> str:
    """Build the exact correlated recall command for a provider path."""
    payload = json.dumps(
        {
            "cwd": DEVELOPMENT_CWD,
            "session_id": SESSION,
            "source": "compact",
            "correlation_id": correlation,
        },
        separators=(",", ":"),
    )
    return (
        f"printf '%s' {shell_quote(payload)} | bun {shell_quote(provider_path)} "
        "--runtime claude --event session-start"
    )


def _activated_adapter(root: Path, create_provider: bool = True) -> tuple[str, Path]:
    """Write a settings file naming an installed sha256 adapter generation.

    Args:
        root: Scratch directory.
        create_provider: Whether the provider file actually exists on disk.

    Returns:
        ``(provider_path, settings_path)``.
    """
    adapter_dir = root / "adapters" / "versions" / f"sha256-{'a' * 64}"
    provider = adapter_dir / "ob-memory-provider.ts"
    if create_provider:
        adapter_dir.mkdir(parents=True, exist_ok=True)
        provider.write_text("// test provider stub\n", encoding="utf8")
    settings = root / "settings.json"
    settings.write_text(
        json.dumps(
            {
                "hooks": {
                    "PreToolUse": [
                        {
                            "matcher": "Bash",
                            "hooks": [
                                {
                                    "type": "command",
                                    "command": (
                                        f"bun run '{adapter_dir}"
                                        "/context-budget-gate.ts' "
                                        "--event pre-tool-use"
                                    ),
                                }
                            ],
                        }
                    ]
                }
            }
        ),
        encoding="utf8",
    )
    return str(provider), settings


def test_the_printed_recovery_command_is_the_one_the_gate_accepts(
    tmp_path: Path,
) -> None:
    # The single most important property in this file. If the banner printed a
    # command the allowance then refused, the operator would be told to run the
    # one thing that cannot work -- a deadlock with an instruction attached.
    paths = gate_paths(tmp_path)
    record_receipt(paths.receipts, "recall", "failed", False, "compact")

    started = run_gate(paths, "session-start", {"source": "compact"})
    assert started.stdout == ""

    prompted = run_gate(paths, "user-prompt-submit")
    command = _recovery_command(prompted.stdout)

    # Exactly ONE command is offered. Two would make the operator choose, and a
    # retired one (`mcp2cli open-brain`) is blocked for Claude entirely.
    assert len(re.findall(r"ob-memory-provider\.ts", prompted.stdout)) == 1
    assert "mcp2cli open-brain" not in prompted.stdout
    assert f'"session_id":"{SESSION}"' in command
    assert '"source":"compact"' in command
    assert re.search(r'"correlation_id":"[0-9a-f-]{36}"', command)
    assert shell_quote(SIBLING_PROVIDER) in command
    assert command.endswith("--runtime claude --event session-start")

    assert run_gate(paths, "pre-tool-use", _bash(command)).stdout == ""


def test_the_recovery_command_is_accepted_in_every_equivalent_spelling(
    tmp_path: Path,
) -> None:
    # An operator does not retype the command byte for byte. `bun run`, the
    # absolute bun path, and `--flag=value` are the same invocation, and
    # refusing them would refuse the escape hatch on a technicality.
    paths = gate_paths(tmp_path)
    run_gate(paths, "session-start", {"source": "compact"})
    command = _recovery_command(run_gate(paths, "user-prompt-submit").stdout)

    respelled = command.replace(" | bun ", "\n| /opt/homebrew/bin/bun run ").replace(
        "--runtime claude --event session-start",
        "--event='session-start' --runtime=\"claude\"",
    )

    assert run_gate(paths, "pre-tool-use", _bash(respelled)).stdout == ""


@pytest.mark.parametrize(
    "mutate",
    [
        pytest.param(
            lambda command: (
                f"bun {shell_quote(SIBLING_PROVIDER)} "
                "--runtime claude --event session-start"
            ),
            id="no-payload",
        ),
        pytest.param(
            lambda command: command.replace(
                "--event session-start", "--event capture"
            ),
            id="wrong-event",
        ),
        pytest.param(
            lambda command: re.sub(
                r'"correlation_id":"[0-9a-f-]{36}"',
                '"correlation_id":"00000000-0000-4000-8000-000000000000"',
                command,
            ),
            id="wrong-cycle",
        ),
        pytest.param(
            lambda command: command.replace(
                f'"session_id":"{SESSION}"', '"session_id":"someone-else"'
            ),
            id="wrong-session",
        ),
        pytest.param(lambda command: f"{command} && git push", id="chained"),
    ],
)
def test_a_near_miss_recovery_command_is_refused(
    tmp_path: Path, mutate: object
) -> None:
    # Each of these is one edit away from the real command. A payload-free call
    # recalls nothing correlated; the wrong event, cycle, or session proves
    # somebody else's work; and a chained `&& git push` smuggles a mutation in
    # behind a command the gate approves of.
    paths = gate_paths(tmp_path)
    run_gate(paths, "session-start", {"source": "compact"})
    command = _recovery_command(run_gate(paths, "user-prompt-submit").stdout)

    assert callable(mutate)
    blocked = run_gate(paths, "pre-tool-use", _bash(mutate(command)))

    assert blocked.blocked
    assert read_session_state(paths)["readbackRequired"] is True


def test_the_currently_activated_provider_is_accepted_and_an_impostor_is_not(
    tmp_path: Path,
) -> None:
    # A deployed adapter generation lives at a `sha256-<hash>` path, and that is
    # the provider actually wired into settings. It is accepted BECAUSE settings
    # names it -- not because it sits in an adapters directory, which is what
    # the impostor case proves.
    paths = gate_paths(tmp_path)
    provider, settings = _activated_adapter(tmp_path)
    paths = GatePaths(
        root=paths.root,
        state=paths.state,
        receipts=paths.receipts,
        settings=settings,
        policy_state=paths.policy_state,
        spool=paths.spool,
    )
    correlation = start_compact_cycle(paths.receipts)
    run_gate(paths, "post-compact")

    allowed = run_gate(
        paths, "pre-tool-use", _bash(_recall_command(provider, correlation))
    )
    assert allowed.code == 0
    assert allowed.stdout == ""

    impostor_dir = tmp_path / "adapters" / "versions" / "evil"
    impostor_dir.mkdir(parents=True, exist_ok=True)
    impostor = impostor_dir / "ob-memory-provider.ts"
    impostor.write_text("// test provider stub\n", encoding="utf8")

    blocked = run_gate(
        paths, "pre-tool-use", _bash(_recall_command(str(impostor), correlation))
    )
    assert blocked.blocked


def test_the_hint_names_the_activated_provider_when_the_sibling_is_not_wired(
    tmp_path: Path,
) -> None:
    # The printed command has to name the provider that is actually installed,
    # or the operator runs a path that is not on the hook chain.
    paths = gate_paths(tmp_path)
    provider, settings = _activated_adapter(tmp_path)
    paths = GatePaths(
        root=paths.root,
        state=paths.state,
        receipts=paths.receipts,
        settings=settings,
        policy_state=paths.policy_state,
        spool=paths.spool,
    )
    run_gate(paths, "post-compact")

    blocked = run_gate(
        paths,
        "pre-tool-use",
        {"tool_name": "Write", "tool_input": {"file_path": str(tmp_path / "b.ts")}},
    )
    command = _recovery_command(blocked.stdout)

    assert shell_quote(provider) in command
    assert shell_quote(SIBLING_PROVIDER) not in command


@pytest.mark.parametrize(
    ("name", "malformed", "create_provider"),
    [("invalid-json", True, True), ("missing-generation", False, False)],
)
def test_unreadable_settings_fail_closed(
    tmp_path: Path, name: str, malformed: bool, create_provider: bool
) -> None:
    # Settings that cannot be read, or that name a generation which is not
    # installed, must NARROW the allowance rather than widen it. Falling back to
    # "allow any adapter path" on a parse error would make a corrupt file the
    # way in.
    root = tmp_path / name
    root.mkdir(parents=True, exist_ok=True)
    paths = gate_paths(root)
    provider, settings = _activated_adapter(root, create_provider)
    if malformed:
        settings.write_text("{not-json", encoding="utf8")
    paths = GatePaths(
        root=paths.root,
        state=paths.state,
        receipts=paths.receipts,
        settings=settings,
        policy_state=paths.policy_state,
        spool=paths.spool,
    )
    correlation = start_compact_cycle(paths.receipts)
    run_gate(paths, "post-compact")

    activated = run_gate(
        paths, "pre-tool-use", _bash(_recall_command(provider, correlation))
    )
    assert activated.blocked

    # The sibling path is still accepted: it is this gate's own configured
    # provider, so it does not depend on settings being readable at all.
    sibling = run_gate(
        paths, "pre-tool-use", _bash(_recall_command(SIBLING_PROVIDER, correlation))
    )
    assert sibling.stdout == ""


def test_a_realistic_quoted_checkpoint_payload_passes_the_capture_gate(
    tmp_path: Path,
) -> None:
    # A real distilled payload contains quotes, pipes, and a literal
    # `printf '%s' … | bun` example. The parser must handle the operator's own
    # content without either refusing it or being fooled by the pipe inside it.
    paths = gate_paths(tmp_path)
    transcript = tmp_path / "work.jsonl"
    transcript.write_text(
        "\n".join(
            [
                json.dumps({"type": "user", "message": {"content": "implement"}}),
                json.dumps(
                    {
                        "type": "assistant",
                        "message": {"content": [{"type": "tool_use", "name": "Write"}]},
                    }
                ),
            ]
        ),
        encoding="utf8",
    )
    stopped = run_gate(paths, "stop", {"transcript_path": str(transcript)})
    assert "OB Capture Gate" in stopped.stdout

    payload = json.dumps(
        {
            "cwd": DEVELOPMENT_CWD,
            "session_id": SESSION,
            "distilled": {
                "summary": (
                    "Preserve the user's literal printf '%s' payload | bun "
                    "recovery example."
                ),
                "key_decisions": ["Automatic compaction owns rollover"],
                "next_steps": [],
                "receipt_refs": [],
            },
        },
        separators=(",", ":"),
    )
    command = (
        f"printf '%s' {shell_quote(payload)} | bun {shell_quote(SIBLING_PROVIDER)} "
        "--runtime claude --event checkpoint"
    )

    assert run_gate(paths, "pre-tool-use", _bash(command)).stdout == ""
    assert run_gate(paths, "pre-tool-use", _bash(f"{command} && git push")).blocked


@pytest.mark.parametrize(
    "case",
    [
        {"session_id": SESSION, "project": PROJECT, "age_minutes": 3},
        {"session_id": "other-session", "project": PROJECT, "age_minutes": 0},
        {"session_id": SESSION, "project": "other-project", "age_minutes": 0},
    ],
    ids=["stale", "cross-session", "cross-project"],
)
def test_recall_evidence_outside_this_compaction_never_clears_it(
    tmp_path: Path, case: dict[str, object]
) -> None:
    paths = gate_paths(tmp_path)
    record_receipt(
        paths.receipts,
        "recall",
        "direct",
        False,
        "compact",
        iso(datetime.now(UTC) - timedelta(minutes=float(str(case["age_minutes"])))),
        project=str(case["project"]),
        session_id=str(case["session_id"]),
    )

    started = run_gate(paths, "session-start", {"source": "compact"})

    assert started.stdout == ""
    assert read_session_state(paths)["readbackRequired"] is True


@pytest.mark.parametrize(
    "command",
    [
        "env git push",
        "env rm blocked.ts",
        "git config user.name changed",
        "git remote add unsafe example.invalid/repo.git",
        "git branch unsafe-new-branch",
        "git -C /some/worktree push",
        "git -C /some/worktree commit -m x",
        "git --no-pager -C /some/worktree branch unsafe-new-branch",
        "git -C --force status",
    ],
)
def test_the_read_only_allowance_does_not_admit_a_mutation(
    tmp_path: Path, command: str
) -> None:
    # `env` prefixes a mutation with a read-only-looking word; `git config`,
    # `git remote add`, and `git branch <name>` all mutate under a subcommand
    # whose read-only spelling IS allowed. `git -C --force status` is the parser
    # test: `-C` taking a flag as its argument must not shift the subcommand.
    paths = gate_paths(tmp_path)
    run_gate(paths, "session-start", {"source": "compact"})

    assert run_gate(paths, "pre-tool-use", _bash(command)).blocked


@pytest.mark.parametrize(
    "command",
    [
        "git status --short",
        "git branch",
        "git branch --show-current",
        "printenv HOME",
        "git -C /some/worktree status",
        "git -C /some/worktree log --oneline -3",
        "git --no-pager -C /some/worktree diff",
        "git -C /some/worktree branch --show-current",
    ],
)
def test_the_read_only_allowance_admits_reading(tmp_path: Path, command: str) -> None:
    # A blocked session must still be able to LOOK at things. Refusing these
    # would make the block a total stop, and the operator could not even
    # diagnose what the gate is waiting for.
    paths = gate_paths(tmp_path)
    run_gate(paths, "session-start", {"source": "compact"})

    assert run_gate(paths, "pre-tool-use", _bash(command)).stdout == ""


@pytest.mark.parametrize(
    "command",
    [
        "mcp2cli qmd search --params '{}'",
        "mcp2cli open-brain session_load --params '{\"project\":\"Development\"}'",
    ],
)
def test_another_tools_memory_command_is_not_this_gates_evidence(
    tmp_path: Path, command: str
) -> None:
    # These commands may well read Open Brain. They do not produce the receipt
    # this gate reconciles against, so accepting them would clear a block on the
    # strength of a side effect nobody verified.
    paths = gate_paths(tmp_path)
    run_gate(paths, "session-start", {"source": "compact"})

    assert run_gate(paths, "pre-tool-use", _bash(command)).blocked
    assert read_session_state(paths)["readbackRequired"] is True
