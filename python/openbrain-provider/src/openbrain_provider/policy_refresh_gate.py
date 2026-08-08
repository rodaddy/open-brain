"""The policy-refresh gate entrypoint: keep the router in front of risky work.

Purpose:
    A session's policy goes stale at a compaction, because the summary keeps
    what it keeps. This gate marks that, injects the router text, and refuses
    RISKY tool calls until an explicit refresh — while allowing everything
    harmless and, critically, allowing the refresh command itself.

Architecture:
    A dispatch shell over one handler per event. Safety refusals live in
    ``policy_safety``, injected prose in ``policy_context``, the wire protocol in
    ``hook_io``. Nothing here decides what a command means or what the text says.

Pattern/Convention:
    THE UNBLOCK MUST BE REACHABLE. A stale session may always run the exact
    refresh command, checked by ``_is_policy_refresh_tool``. A gate whose escape
    is itself gated is the deadlock class issue #419 names, arriving through
    this gate instead of the budget one.

    SAFETY FIRST, STALENESS SECOND. Safety refusals are unconditional and are
    evaluated before staleness, so a `git reset --hard` is refused whether or
    not policy is fresh.

Example:
    >>> import io
    >>> main(["--event", "user-prompt-submit", "--session-id", "s1",
    ...       "--state-path", "/dev/null"],
    ...      stdin=io.StringIO("{}"), stdout=io.StringIO())
    0

See Also:
    - ``_ob/scripts/policy-refresh-gate.ts`` — the TypeScript this replaces
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, Final

from .hook_io import HookEvent, emit, emit_json, read_hook_event
from .policy_context import (
    post_compact_requirements,
    refresh_context,
    stale_context,
    startup_context,
)
from .policy_safety import (
    SHELL_TOOLS,
    is_risky_tool,
    pre_tool_advisory,
    pre_tool_safety_block_reason,
)

if TYPE_CHECKING:
    from typing import TextIO

__all__ = ["main"]

#: Every event this gate answers.
_EVENTS: Final[tuple[str, ...]] = (
    "session-start",
    "user-prompt-submit",
    "pre-tool-use",
    "pre-compact",
    "post-compact",
    "refresh",
)

#: policy-refresh-gate.ts:496-499 — the shape a refresh command must have to be
#: allowed through a stale block. Deliberately strict: no chaining, no
#: substitution, no redirect, because "a command that CONTAINS the refresh call"
#: is not the same thing as "the refresh call".
_REFRESH_SHELL_UNSAFE: Final[re.Pattern[str]] = re.compile(r"[;&|`$<>]")
_REFRESH_BUN: Final[re.Pattern[str]] = re.compile(r"(?:^|\s)(?:timeout \d+\s+)?bun\s+")
_REFRESH_EVENT: Final[re.Pattern[str]] = re.compile(
    r"(?:^|\s)--event\s+refresh(?:\s|$)"
)

#: policy-refresh-gate.ts:221-222 — a state file whose block came from a retired
#: turn/tool threshold resumes clean, because that mechanism no longer exists and
#: the stored reason would otherwise block forever with no way to satisfy it.
_LEGACY_THRESHOLD_REASON: Final[re.Pattern[str]] = re.compile(
    r"^(?:turn|tool) threshold reached:"
)


def _iso_now() -> str:
    """Return the current instant, ISO-8601 with a Z suffix."""
    utc = datetime.now(UTC)
    return f"{utc.strftime('%Y-%m-%dT%H:%M:%S')}.{utc.microsecond // 1000:03d}Z"


@dataclass
class PolicySessionState:
    """One session's policy-refresh state.

    Attributes:
        sessionId: The session id.
        agent: Which agent the state belongs to.
        cwd: The session's working directory.
        turnCount: Turns since the last refresh.
        toolCount: Tool calls since the last refresh.
        refreshRequired: Whether risky work is currently blocked.
        reason: Why, when it is.
        updatedAt: When this entry last changed.
        totalTurnCount: Turns across the whole session.
        lastRefreshAt: When policy was last refreshed.
        lastRefreshEvent: What refreshed it.
        lastPromptAt: When the last prompt arrived.

    Field names are the on-disk camelCase ones. The file is shared with the
    running TypeScript gate during the changeover, and the context-budget gate
    reads ``refreshRequired`` out of it by that exact name
    (``context-budget-gate.ts:373``), so renaming them here would silently make
    the status line report unknown forever.
    """

    sessionId: str  # noqa: N815 -- on-disk key, shared with the TypeScript gate
    agent: str
    cwd: str
    turnCount: int = 0  # noqa: N815
    toolCount: int = 0  # noqa: N815
    refreshRequired: bool = False  # noqa: N815
    reason: str = ""
    updatedAt: str = ""  # noqa: N815
    totalTurnCount: int | None = None  # noqa: N815
    lastRefreshAt: str | None = None  # noqa: N815
    lastRefreshEvent: str | None = None  # noqa: N815
    lastPromptAt: str | None = None  # noqa: N815

    def to_json(self) -> dict[str, Any]:
        """Return the on-disk representation, omitting unset optionals."""
        return {key: value for key, value in asdict(self).items() if value is not None}


@dataclass
class PolicyStateFile:
    """The whole policy state file.

    Attributes:
        sessions: ``<agent>:<session>`` to state.
    """

    sessions: dict[str, dict[str, Any]] = field(default_factory=dict)


def _load_state(state_path: Path) -> PolicyStateFile:
    """Read the policy state file, or an empty one.

    Args:
        state_path: The gate's state file.

    Returns:
        The parsed file. A corrupt file resets rather than raising: this gate
        runs on every tool call, and an exception here would break every one.
    """
    try:
        raw = json.loads(state_path.read_text(encoding="utf8"))
    except (OSError, json.JSONDecodeError):
        return PolicyStateFile()
    if not isinstance(raw, dict):
        return PolicyStateFile()
    sessions = raw.get("sessions")
    if not isinstance(sessions, dict):
        return PolicyStateFile()
    return PolicyStateFile(sessions=sessions)


def _write_state(state_path: Path, state_file: PolicyStateFile) -> None:
    """Write the policy state file.

    Args:
        state_path: The gate's state file.
        state_file: The state to write.
    """
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(
        json.dumps({"sessions": state_file.sessions}, indent=2, ensure_ascii=False),
        encoding="utf8",
    )


def _hydrate(
    stored: dict[str, Any] | None, session_id: str, agent: str, cwd: str, now: str
) -> PolicySessionState:
    """Build a session state from whatever the file held.

    Args:
        stored: Raw stored entry, or None.
        session_id: The session id.
        agent: The agent key.
        cwd: The session's working directory.
        now: Current instant.

    Returns:
        A usable state, with counters coerced to integers and a legacy
        threshold block cleared.
    """
    source = stored if isinstance(stored, dict) else {}

    def integer(key: str) -> int:
        value = source.get(key)
        if isinstance(value, bool) or not isinstance(value, int):
            return 0
        return value

    def text(key: str) -> str | None:
        value = source.get(key)
        return value if isinstance(value, str) else None

    state = PolicySessionState(
        sessionId=session_id,
        agent=agent,
        cwd=cwd,
        turnCount=integer("turnCount"),
        toolCount=integer("toolCount"),
        refreshRequired=bool(source.get("refreshRequired")),
        reason=text("reason") or "",
        updatedAt=now,
        totalTurnCount=integer("totalTurnCount"),
        lastRefreshAt=text("lastRefreshAt"),
        lastRefreshEvent=text("lastRefreshEvent"),
        lastPromptAt=text("lastPromptAt"),
    )
    if state.refreshRequired and _LEGACY_THRESHOLD_REASON.match(state.reason):
        state.refreshRequired = False
        state.reason = ""
    return state


def _is_policy_refresh_tool(name: str, tool_input: dict[str, Any]) -> bool:
    """Report whether a call is the exact refresh command, and nothing more.

    Args:
        name: Tool name in any casing.
        tool_input: The tool's arguments.

    Returns:
        True only for a single, unchained `bun … policy-refresh-gate.ts …
        --event refresh` invocation. This allowance is the ONLY way out of a
        stale block, so it is checked strictly: a chained or substituted command
        that merely contains the refresh call is not the refresh call.
    """
    if name.lower() not in SHELL_TOOLS:
        return False
    for key in ("command", "cmd", "cmdline"):
        value = tool_input.get(key)
        if value:
            command = str(value)
            break
    else:
        return False
    normalized = re.sub(r"\s+", " ", command.strip())
    if not normalized or "\n" in normalized:
        return False
    if _REFRESH_SHELL_UNSAFE.search(normalized):
        return False
    return bool(
        _REFRESH_BUN.search(normalized)
        and "policy-refresh-gate.ts" in normalized
        and _REFRESH_EVENT.search(normalized)
    )


@dataclass
class _Gate:
    """One invocation's resolved inputs and state."""

    args: argparse.Namespace
    event: HookEvent
    stdout: TextIO | None
    now: str
    cwd: str
    session_id: str
    state_key: str
    state_file: PolicyStateFile
    state: PolicySessionState

    def save(self) -> None:
        """Persist this session's entry."""
        self.state_file.sessions[self.state_key] = self.state.to_json()
        _write_state(self.args.state_path, self.state_file)

    def emit(self, text: str) -> None:
        """Write plain text to the return channel."""
        emit(text, self.stdout)

    def emit_json(self, payload: dict[str, Any]) -> None:
        """Write a JSON verdict to the return channel."""
        emit_json(payload, self.stdout)

    def save_and_output(self, content: str, *, inject: bool) -> None:
        """Persist, then emit content in the shape this runtime expects.

        Args:
            content: The text to inject.
            inject: Whether this content is an injection rather than a notice.

        Codex takes injected content as a `hookSpecificOutput` envelope; every
        other runtime takes plain text.
        """
        self.save()
        if not content:
            return
        if self.args.runtime == "codex" and inject:
            self.emit_json(
                {
                    "hookSpecificOutput": {
                        "hookEventName": "SessionStart",
                        "additionalContext": content,
                    }
                }
            )
            return
        self.emit(content)


def _handle_session_start(gate: _Gate) -> int:
    """Reset the session's counters and inject the startup policy block."""
    state = gate.state
    state.turnCount = 0
    state.totalTurnCount = 0
    state.toolCount = 0
    state.refreshRequired = False
    state.reason = ""
    state.lastRefreshAt = gate.now
    state.lastRefreshEvent = "session-start"
    gate.save_and_output(startup_context(gate.cwd, gate.args.runtime), inject=True)
    return 0


def _handle_user_prompt_submit(gate: _Gate) -> int:
    """Count the turn. Emit nothing: a prompt is not a risky action."""
    state = gate.state
    state.turnCount += 1
    state.totalTurnCount = (state.totalTurnCount or 0) + 1
    state.lastPromptAt = gate.now
    gate.save()
    return 0


def _handle_pre_tool_use(gate: _Gate) -> int:
    """Refuse unsafe calls, refuse risky ones while stale, allow the rest."""
    gate.state.toolCount += 1
    gate.save()

    tool_name = gate.event.tool_name
    tool_input = gate.event.tool_input

    safety = pre_tool_safety_block_reason(tool_name, tool_input, gate.cwd)
    if safety is not None:
        gate.emit_json({"decision": "block", "reason": safety})
        return 0

    # Advisory only, and deliberately NOT an early exit in the blocking sense: a
    # native Agent call is allowed, but it must still pass the staleness check
    # below when policy IS stale.
    advisory = pre_tool_advisory(tool_name, gate.args.runtime)
    if advisory is not None and not gate.state.refreshRequired:
        gate.emit_json(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "additionalContext": advisory,
                }
            }
        )
        return 0

    if gate.state.refreshRequired and _is_policy_refresh_tool(tool_name, tool_input):
        return 0
    if gate.state.refreshRequired and is_risky_tool(tool_name, tool_input):
        gate.emit_json({"decision": "block", "reason": _stale_block_reason(gate)})
    return 0


def _shell_quote(value: str) -> str:
    """Return a single-quoted shell word."""
    escaped = value.replace("'", "'\\''")
    return f"'{escaped}'"


def _stale_block_reason(gate: _Gate) -> str:
    """Render the refusal text, including the exact command that clears it."""
    reason = gate.state.reason or "refresh marked stale"
    # This is the command an operator PASTES to clear the block, so a path that
    # exists nowhere leaves the gate permanently unclearable (#636). Deployment
    # -specific, hence the override; the fallback stays a real location rather
    # than a neutral placeholder for that reason.
    gate_script = os.environ.get("OPENBRAIN_POLICY_REFRESH_GATE", "").strip() or (
        "/Volumes/ThunderBolt/Development/_ob/scripts/policy-refresh-gate.ts"
    )
    command = (
        f"bun {gate_script} "
        f"--event refresh --agent {gate.args.agent} "
        f"--session-id {_shell_quote(gate.session_id)}"
    )
    return "\n".join(
        [
            "Policy refresh is required before risky task action.",
            f"Reason: {reason}.",
            "",
            "Before continuing, reread the active router and triggered SOPs, then run:",
            command,
            "",
            "Refresh must restate Pony style, critical mode, source-of-truth "
            "order, and the next concrete action.",
        ]
    )


def _handle_compact(gate: _Gate) -> int:
    """Mark policy stale, and say what survives the compaction."""
    gate.state.refreshRequired = True
    gate.state.reason = f"{gate.args.event} marked context as stale"
    if gate.args.event == "post-compact":
        content = "\n".join(
            [stale_context(gate.state.reason), post_compact_requirements()]
        )
    else:
        content = stale_context(gate.state.reason)
    gate.save_and_output(content, inject=gate.args.event == "post-compact")
    return 0


def _handle_refresh(gate: _Gate) -> int:
    """Mark policy refreshed and print what must be restated."""
    refreshed = _refresh_matching_states(gate)
    _write_state(gate.args.state_path, gate.state_file)
    gate.emit(refresh_context(refreshed))
    return 0


def _refresh_matching_states(gate: _Gate) -> int:
    """Refresh this session, or every session for this agent and cwd.

    Args:
        gate: The invocation.

    Returns:
        How many states were marked refreshed.

    A refresh naming a session refreshes only that one. A refresh with no
    session named refreshes every session for the same agent in the same
    directory, because the operator running it in a terminal cannot know which
    session id they are in.
    """
    explicit = bool(gate.args.session_id or gate.event.session_id)
    if explicit:
        keys = [gate.state_key]
    else:
        keys = [
            key
            for key, candidate in gate.state_file.sessions.items()
            if isinstance(candidate, dict)
            and candidate.get("agent") == gate.args.agent
            and candidate.get("cwd") == gate.cwd
        ] or [gate.state_key]

    for key in keys:
        stored = gate.state_file.sessions.get(key)
        target = (
            _hydrate(stored, gate.session_id, gate.args.agent, gate.cwd, gate.now)
            if isinstance(stored, dict)
            else gate.state
        )
        _mark_refreshed(target, gate.now)
        gate.state_file.sessions[key] = target.to_json()

    if gate.state_key not in keys:
        _mark_refreshed(gate.state, gate.now)
    return len(keys)


def _mark_refreshed(state: PolicySessionState, now: str) -> None:
    """Clear a session's staleness and reset its counters."""
    state.turnCount = 0
    state.toolCount = 0
    state.refreshRequired = False
    state.reason = ""
    state.lastRefreshAt = now
    state.lastRefreshEvent = "manual-refresh"
    state.updatedAt = now


#: Event name to handler. A table, not a branch chain.
_HANDLERS: Final[dict[str, Any]] = {
    "session-start": _handle_session_start,
    "user-prompt-submit": _handle_user_prompt_submit,
    "pre-tool-use": _handle_pre_tool_use,
    "pre-compact": _handle_compact,
    "post-compact": _handle_compact,
    "refresh": _handle_refresh,
}


def _build_parser() -> argparse.ArgumentParser:
    """Build the argument parser.

    Returns:
        The parser. ``--runtime`` defaults to ``--agent`` when unset, matching
        policy-refresh-gate.ts:47-48.
    """
    parser = argparse.ArgumentParser(prog="openbrain-policy-refresh-gate")
    parser.add_argument("--event", default="session-start", choices=_EVENTS)
    parser.add_argument("--agent", default="agent")
    parser.add_argument("--runtime", default="")
    parser.add_argument("--session-id", default="")
    parser.add_argument(
        "--state-path",
        type=Path,
        default=Path.home()
        / ".local"
        / "state"
        / "agent-policy-refresh"
        / "state.json",
    )
    return parser


def main(
    argv: list[str] | None = None,
    *,
    stdin: TextIO | None = None,
    stdout: TextIO | None = None,
) -> int:
    """Run one gate invocation.

    Args:
        argv: Command-line arguments. Defaults to ``sys.argv[1:]``.
        stdin: The hook's stdin. Defaults to ``sys.stdin``.
        stdout: The return channel. Defaults to ``sys.stdout``.

    Returns:
        ``0``. This gate never fails a hook: a block is data on stdout.
    """
    args = _build_parser().parse_args(sys.argv[1:] if argv is None else argv)
    if not args.runtime:
        args.runtime = args.agent
    event = read_hook_event(stdin)
    now = _iso_now()
    cwd = event.cwd or os.getcwd()
    session_id = args.session_id or event.session_id or f"{args.agent}:{cwd}"
    state_key = f"{args.agent}:{session_id}"
    state_file = _load_state(args.state_path)
    state = _hydrate(
        state_file.sessions.get(state_key), session_id, args.agent, cwd, now
    )
    gate = _Gate(
        args=args,
        event=event,
        stdout=stdout,
        now=now,
        cwd=cwd,
        session_id=session_id,
        state_key=state_key,
        state_file=state_file,
        state=state,
    )
    return int(_HANDLERS[args.event](gate))


def _cli() -> int:
    """Console-script entrypoint.

    Returns:
        The exit code.
    """
    return main()


if __name__ == "__main__":
    raise SystemExit(_cli())
