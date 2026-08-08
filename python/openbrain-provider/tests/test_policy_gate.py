"""The policy-refresh gate: what goes stale, what that blocks, and what clears it.

Ported from `policy-refresh-gate.test.ts`, with three assertions deliberately
NOT transcribed. That file is red today against its own source (verified
2026-08-02: 6 pass, 3 fail): it still expects `OB ✓ gate passed` and a
`source_validator:` line the gate no longer emits -- both moved into the
source-owned `AGENTS.md` -- and it expects an UNCONDITIONAL Agent/Task block
that the gate deliberately made conditional on `ANTHROPIC_BASE_URL`.

Those three are stale expectations, not gate defects. Copying them across would
import a false red. The tests below assert what the SOURCE does, and the Agent
rule is tested on BOTH branches so the conditionality is pinned rather than
assumed.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from gate_harness import SESSION, run_policy_gate

from openbrain_provider.development_scope import development_root

# Derived, not a literal: a second hardcoded copy of the root disagrees with
# the one the gate resolved against on any machine but Rico's Mac.
DEVELOPMENT_CWD = str(development_root())


def _state(state_path: Path, agent: str = "claude") -> dict[str, object]:
    """Read one session's stored policy state."""
    stored = json.loads(state_path.read_text(encoding="utf8"))
    return dict(stored["sessions"][f"{agent}:{SESSION}"])


def test_claude_startup_points_at_the_direct_adapter_not_the_retired_cli(
    tmp_path: Path,
) -> None:
    # The `mcp2cli open-brain` path is retired and hook-blocked for Claude. A
    # startup block still naming it would send every session to a command that
    # is refused before it runs.
    started = run_policy_gate(tmp_path / "state.json", "session-start")

    assert started.code == 0
    assert "package-owned direct Open Brain SessionStart adapter" in started.stdout
    assert "mcp2cli open-brain get_entity" not in started.stdout


def test_claudex_startup_uses_the_same_direct_hydration(tmp_path: Path) -> None:
    started = run_policy_gate(
        tmp_path / "state.json", "session-start", agent="claudex", runtime="claudex"
    )

    assert started.code == 0
    assert "package-owned direct Open Brain SessionStart adapter" in started.stdout
    assert "mcp2cli open-brain get_entity" not in started.stdout


def test_codex_startup_quotes_the_source_owned_fast_path(tmp_path: Path) -> None:
    # Codex keeps the UUID recipe, and the gate READS it out of AGENTS.md rather
    # than restating it -- a second copy would be stale the first time the real
    # one changed. The envelope is Codex's `hookSpecificOutput` shape.
    #
    # The AGENTS.md is written HERE rather than relying on the real one: reading
    # Rico's file made this pass on his Mac and fail on CI, and it also meant the
    # assertions were checking his file's contents instead of the extraction this
    # test is actually about. The fixture is minimal and deliberately unlike the
    # real file, so a pass means the markers were honoured.
    agents = tmp_path / "AGENTS.md"
    agents.write_text(
        "\n".join(
            [
                "# Fixture router",
                "Text before the block is not extracted.",
                "<!-- runtime-fast-path:start -->",
                "```yaml",
                "repo_fact_uuid: 0c0a4e94-84bc-424f-b396-bf7d0ad62083",
                "```",
                "<!-- runtime-fast-path:end -->",
                "Text after the block is not extracted either.",
            ]
        ),
        encoding="utf8",
    )

    started = run_policy_gate(
        tmp_path / "state.json",
        "session-start",
        {"cwd": str(tmp_path)},
        agent="codex",
        runtime="codex",
    )

    assert started.code == 0
    payload = started.json
    context = payload["hookSpecificOutput"]["additionalContext"]
    assert "runtime-fast-path:start" in context
    assert "repo_fact_uuid" in context
    assert "loaded from the source-owned AGENTS.md" in context
    # Only the marked span, not the whole file.
    assert "Text before the block" not in context
    assert "Text after the block" not in context


def test_startup_names_the_current_model_routing(tmp_path: Path) -> None:
    started = run_policy_gate(tmp_path / "state.json", "session-start")

    assert started.code == 0
    assert "Claude Opus 5" in started.stdout
    assert "Workflow `agent()` node" in started.stdout
    assert "codex:codex-rescue" in started.stdout
    assert "Sonnet max medium" in started.stdout
    assert "explicit non-default" in started.stdout


def test_startup_does_not_declare_critical_mode_active(tmp_path: Path) -> None:
    # Critical mode is INVOKED, not defaulted. A mode that is always on stops
    # being a mode, so injecting it every session would quietly override the
    # design that made it a command.
    started = run_policy_gate(tmp_path / "state.json", "session-start")

    assert "critical mode is active" not in started.stdout.lower()
    assert "Say what you mean" in started.stdout


def test_ordinary_turns_and_many_harmless_tools_never_go_stale(
    tmp_path: Path,
) -> None:
    # The retired turn/tool thresholds are why this test exists: volume alone is
    # not staleness, and a gate that blocked on a counter interrupted long
    # sessions that had done nothing wrong.
    state_path = tmp_path / "state.json"
    started = run_policy_gate(state_path, "session-start")
    assert started.code == 0
    assert "Development Policy Refresh" in started.stdout

    for _ in range(30):
        prompt = run_policy_gate(state_path, "user-prompt-submit")
        assert prompt.code == 0
        assert prompt.stdout == ""

    for _ in range(81):
        harmless = run_policy_gate(
            state_path,
            "pre-tool-use",
            {"tool_name": "Read", "tool_input": {"file_path": str(tmp_path / "a.txt")}},
        )
        assert harmless.code == 0
        assert harmless.stdout == ""

    state = _state(state_path)
    assert state["turnCount"] == 30
    assert state["totalTurnCount"] == 30
    assert state["toolCount"] == 81
    assert state["refreshRequired"] is False
    assert state["reason"] == ""

    risky = run_policy_gate(
        state_path,
        "pre-tool-use",
        {"tool_name": "Write", "tool_input": {"file_path": str(tmp_path / "b.ts")}},
    )
    assert risky.code == 0
    assert risky.stdout == ""


def test_post_compact_stays_stale_until_an_explicit_refresh(tmp_path: Path) -> None:
    state_path = tmp_path / "state.json"
    assert run_policy_gate(state_path, "session-start").code == 0

    compacted = run_policy_gate(state_path, "post-compact")
    assert compacted.code == 0
    assert "post-compact marked context as stale" in compacted.stdout
    state = _state(state_path)
    assert state["refreshRequired"] is True
    assert state["reason"] == "post-compact marked context as stale"

    blocked = run_policy_gate(
        state_path,
        "pre-tool-use",
        {"tool_name": "Write", "tool_input": {"file_path": str(tmp_path / "b.ts")}},
    )
    assert blocked.blocked
    assert "post-compact marked context as stale" in blocked.stdout

    refreshed = run_policy_gate(state_path, "refresh")
    assert refreshed.code == 0
    assert "Policy refresh marked complete" in refreshed.stdout
    cleared = _state(state_path)
    assert cleared["refreshRequired"] is False
    assert cleared["reason"] == ""

    allowed = run_policy_gate(
        state_path,
        "pre-tool-use",
        {"tool_name": "Write", "tool_input": {"file_path": str(tmp_path / "a.ts")}},
    )
    assert allowed.code == 0
    assert allowed.stdout == ""


def test_post_compact_restates_what_survives_the_compaction(tmp_path: Path) -> None:
    # A compaction summary keeps what it keeps. "The summary probably mentioned
    # the review gauntlet" is not a control, so the requirement is restated
    # every time rather than trusted to survive.
    compacted = run_policy_gate(tmp_path / "state.json", "post-compact")

    assert "Post-Compact Standing Requirements" in compacted.stdout
    assert "pre-merge review gauntlet is MANDATORY" in compacted.stdout


def test_a_stale_session_can_always_run_the_refresh_command(tmp_path: Path) -> None:
    # THE escape. A gate whose unblock is itself gated is a deadlock, and the
    # refusal text prints this exact command -- so it must be accepted.
    state_path = tmp_path / "state.json"
    run_policy_gate(state_path, "post-compact")

    command = (
        "bun /path/to/open-brain/Development/_ob/scripts/policy-refresh-gate.ts "
        "--event refresh --agent claude"
    )
    allowed = run_policy_gate(
        state_path,
        "pre-tool-use",
        {"tool_name": "Bash", "tool_input": {"command": command}},
    )
    assert allowed.stdout == ""


@pytest.mark.parametrize(
    "command",
    [
        "bun .../policy-refresh-gate.ts --event refresh && git push",
        "echo x; bun .../policy-refresh-gate.ts --event refresh",
        "bun .../policy-refresh-gate.ts --event refresh > out.txt",
        "bun .../policy-refresh-gate.ts --event session-start",
    ],
)
def test_a_command_that_merely_contains_the_refresh_call_is_not_the_refresh_call(
    tmp_path: Path, command: str
) -> None:
    # The allowance is the way out of a block, so it is the thing worth
    # smuggling a mutation through. Chaining, redirecting, and naming a
    # different event are all refused.
    state_path = tmp_path / "state.json"
    run_policy_gate(state_path, "post-compact")

    result = run_policy_gate(
        state_path,
        "pre-tool-use",
        {"tool_name": "Bash", "tool_input": {"command": f"{command} && rm -rf x"}},
    )
    assert result.blocked


def test_a_direct_agent_call_is_blocked_under_a_proxied_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Under Claudex an unrouted Agent call silently collapses the worker to the
    # head model -- a Sol session reviewing its own work while the record says
    # Opus did. That is the failure the block exists for.
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://127.0.0.1:7180")
    state_path = tmp_path / "state.json"
    assert run_policy_gate(state_path, "session-start").code == 0

    for tool in ("Agent", "agent", "Task", "task"):
        result = run_policy_gate(
            state_path,
            "pre-tool-use",
            {"tool_name": tool, "tool_input": {"model": "claude-opus-5"}},
        )
        assert result.blocked, tool
        assert "Workflow `agent()` node" in result.stdout
        assert "MODEL_ROUTING.md" in result.stdout


def test_a_direct_agent_call_is_advised_not_blocked_on_a_native_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A native session talks to Anthropic directly and cannot reach that failure
    # mode, so blocking would refuse a safe operation to prevent an impossible
    # one -- and worse, a hook that BEHAVES like Claudex convinces a native
    # session it is under the Claudex contract.
    monkeypatch.delenv("ANTHROPIC_BASE_URL", raising=False)
    state_path = tmp_path / "state.json"
    assert run_policy_gate(state_path, "session-start").code == 0

    result = run_policy_gate(
        state_path, "pre-tool-use", {"tool_name": "Agent", "tool_input": {}}
    )

    assert not result.blocked
    context = result.json["hookSpecificOutput"]["additionalContext"]
    assert "direct Agent/Task is permitted" in context
    assert "MODEL_ROUTING.md" in context


def test_the_agent_advisory_is_suppressed_for_codex(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Codex PreToolUse honours only the FIRST verdict and reads plain stdout as
    # allow, so emitting an advisory there risks eating a real decision.
    monkeypatch.delenv("ANTHROPIC_BASE_URL", raising=False)
    state_path = tmp_path / "state.json"

    result = run_policy_gate(
        state_path,
        "pre-tool-use",
        {"tool_name": "Agent", "tool_input": {}},
        agent="codex",
        runtime="codex",
    )

    assert result.stdout == ""


def test_safety_blocks_fire_even_when_policy_is_fresh(tmp_path: Path) -> None:
    # Safety and staleness are different mechanisms. A `git reset --hard` is not
    # safer because the router was reread five seconds ago.
    state_path = tmp_path / "state.json"
    assert run_policy_gate(state_path, "session-start").code == 0

    blocked = run_policy_gate(
        state_path,
        "pre-tool-use",
        {"tool_name": "Bash", "tool_input": {"command": "git reset --hard"}},
    )

    assert blocked.blocked
    assert "git reset --hard" in blocked.stdout


@pytest.mark.parametrize(
    ("tool_name", "tool_input"),
    [
        ("Write", {"file_path": "/tmp/evil.txt"}),
        ("Edit", {"file_path": "/private/tmp/evil.txt"}),
        ("Bash", {"command": "echo hi > /tmp/x.txt"}),
        ("Bash", {"command": "cp a.txt /var/tmp/b.txt"}),
    ],
)
def test_a_write_into_system_temp_is_refused(
    tmp_path: Path, tool_name: str, tool_input: dict[str, str]
) -> None:
    # `/tmp` is sandbox-local, so an artifact written there is invisible to
    # runners and to the operator: "I saved it to /tmp" silently means gone.
    blocked = run_policy_gate(
        tmp_path / "state.json",
        "pre-tool-use",
        {"tool_name": tool_name, "tool_input": tool_input},
    )

    assert blocked.blocked
    assert "temp workspace" in blocked.stdout


@pytest.mark.parametrize(
    "command",
    ["cat /tmp/some.sock", "ls /tmp", "rg pattern /var/tmp/log.txt"],
)
def test_reading_from_system_temp_is_allowed(tmp_path: Path, command: str) -> None:
    # Only writes are refused. Plenty of legitimate work reads system-owned
    # paths there, and blocking those would teach agents to route around the
    # guard rather than obey it.
    result = run_policy_gate(
        tmp_path / "state.json",
        "pre-tool-use",
        {"tool_name": "Bash", "tool_input": {"command": command}},
    )

    assert not result.blocked


def test_a_commit_message_mentioning_main_is_not_a_push_to_main(
    tmp_path: Path,
) -> None:
    # The protected-ref test runs OUTSIDE quoted strings, so the English word
    # "main" in a message is not a refspec. Getting this wrong would refuse a
    # correct commit for its prose.
    result = run_policy_gate(
        tmp_path / "state.json",
        "pre-tool-use",
        {
            "tool_name": "Bash",
            "tool_input": {
                "command": 'git commit -m "align the main flow with the router"'
            },
        },
    )

    # It may still be refused for the branch check -- what must NOT happen is
    # the protected-REF refusal, which would be reading the message as a target.
    assert "do not commit or push directly to main/master" not in result.stdout


def test_an_unquoted_push_to_main_is_refused(tmp_path: Path) -> None:
    blocked = run_policy_gate(
        tmp_path / "state.json",
        "pre-tool-use",
        {"tool_name": "Bash", "tool_input": {"command": "git push origin main"}},
    )

    assert blocked.blocked
    assert "do not commit or push directly to main/master" in blocked.stdout


def test_a_legacy_threshold_block_resumes_without_a_refresh(tmp_path: Path) -> None:
    # The turn/tool threshold mechanism no longer exists, so a state file still
    # carrying its block would wait forever for a condition nothing can satisfy.
    state_path = tmp_path / "state.json"
    state_path.write_text(
        json.dumps(
            {
                "sessions": {
                    f"claude:{SESSION}": {
                        "sessionId": SESSION,
                        "agent": "claude",
                        "cwd": DEVELOPMENT_CWD,
                        "turnCount": 24,
                        "totalTurnCount": 24,
                        "toolCount": 81,
                        "refreshRequired": True,
                        "reason": "tool threshold reached: 81/80",
                        "updatedAt": "2026-07-19T00:00:00.000Z",
                    }
                }
            }
        ),
        encoding="utf8",
    )

    allowed = run_policy_gate(
        state_path,
        "pre-tool-use",
        {"tool_name": "Write", "tool_input": {"file_path": str(tmp_path / "a.ts")}},
    )

    assert allowed.code == 0
    assert allowed.stdout == ""
    state = _state(state_path)
    assert state["toolCount"] == 82
    assert state["refreshRequired"] is False
    assert state["reason"] == ""


def test_a_real_stale_block_is_not_cleared_by_the_legacy_migration(
    tmp_path: Path,
) -> None:
    # The migration must only drop the RETIRED reason. A post-compact block
    # carries a different reason and has to survive, or every stored block would
    # be cleared on read.
    state_path = tmp_path / "state.json"
    state_path.write_text(
        json.dumps(
            {
                "sessions": {
                    f"claude:{SESSION}": {
                        "sessionId": SESSION,
                        "agent": "claude",
                        "cwd": DEVELOPMENT_CWD,
                        "refreshRequired": True,
                        "reason": "post-compact marked context as stale",
                        "updatedAt": "2026-07-19T00:00:00.000Z",
                    }
                }
            }
        ),
        encoding="utf8",
    )

    blocked = run_policy_gate(
        state_path,
        "pre-tool-use",
        {"tool_name": "Write", "tool_input": {"file_path": str(tmp_path / "a.ts")}},
    )

    assert blocked.blocked
