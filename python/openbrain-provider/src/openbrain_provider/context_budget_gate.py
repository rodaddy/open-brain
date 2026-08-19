"""The context-budget gate entrypoint: one event in, one verdict out.

Purpose:
    Automatic-compaction discipline. Token pressure is ADVISORY before a
    compaction. After one, task mutation waits for an exact-cycle direct recall
    receipt -- and that requirement self-releases after fifteen minutes, with an
    explicit expiring repair mode that admits Bash, Write, and Edit while the
    recall plumbing itself is being fixed.

Architecture:
    A dispatch shell. Argument parsing, state loading, and event routing live
    here; every decision lives in a module underneath -- ``gate_state`` for what
    is owed, ``gate_shell`` for what a blocked session may still run,
    ``gate_presentation`` for the text, ``gate_transcript`` for token pressure,
    ``receipt_state`` for the evidence. One handler per event, none of them
    sharing a branch with another.

Pattern/Convention:
    THE GATE MUST NOT DEADLOCK ON WHAT IT GATES. Issue #419 exists because the
    documented self-release did not fire, so the gate blocked Bash and Write
    until an Open Brain recall succeeded while the broken recall was the thing
    needing repair. Two mechanisms answer it, both tested: the timed
    self-release in ``gate_state._release_timed_out_readback``, and the bounded
    repair window entered with ``--event repair-enter``.

    EVERY BRANCH RECORDS A NAMED TRANSITION. Silence is a signal (#419
    acceptance): a state change nobody can grep for later is a state change
    nobody can debug.

Example:
    >>> import io
    >>> main(["--event", "status", "--session-id", "s1"],
    ...      stdin=io.StringIO("{}"), stdout=io.StringIO())
    0

See Also:
    - ``_plans/issues/419-prov-10-context-budget-gate-with-a-repair-mode-escape.md``
    - ``_ob/scripts/context-budget-gate.ts`` - the TypeScript this replaces
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any, Final

from .development_scope import (
    describe_development_root,
    development_root,
    development_root_missing,
    render_scope_diagnosis,
    resolve_development_scope,
)
from .gate_presentation import (
    PresentationContext,
    capture_banner,
    gate_status_line,
    handoff_banner,
    nag_banner,
    readback_banner,
    transition_message,
)
from .gate_shell import (
    ShellGateContext,
    is_checkpoint_activity,
    is_repair_capable_tool,
    unrecognised_hook_invocation_diagnostic,
)
from .gate_state import (
    CHECKPOINT_MAX_AGE_SECONDS,
    enter_repair_mode,
    exit_repair_mode,
    fresh_session_state,
    hydrate_session_state,
    load_state,
    reconcile_gate_state,
    record_transition,
    repair_mode_is_active,
    save_session_state,
    verified_checkpoint,
)
from .gate_transcript import (
    count_compact_boundaries,
    read_context_tokens,
    turn_did_work,
)
from .hook_io import HookEvent, emit, emit_json, read_hook_event
from .receipt_state import (
    current_compact_cycle,
    default_receipt_state_path,
    gate_compact_cycle,
)

if TYPE_CHECKING:
    from typing import TextIO

__all__ = ["main"]

#: Advisory notice thresholds. These are notice points, not blocks: crossing
#: them prints a line and nothing else (``nag_banner`` says so in its own text).
#:
#: THESE ARE THE LAST RESORT, NOT THE OPERATING VALUES. They apply only when the
#: compaction window cannot be resolved from settings at all (see
#: ``resolve_thresholds``). Read as absolute token counts they are meaningless;
#: they are the fractions below applied to a 200k window, which is the smallest
#: context any supported model ships with.
_FALLBACK_COMPACT_WINDOW: Final[int] = 200_000

#: Claude Code reserves output tokens before measuring the compaction trigger,
#: then fires at ``percent`` of what is left. Mirrors the live formula in
#: ``~/.claudex/doctor.ts`` (``computedCompactAt``: ``floor((window -
#: OUTPUT_RESERVE) * percent / 100)``) and its ``OUTPUT_RESERVE = 16_384``.
#: Verified against that source 2026-08-05 (issue #77).
_OUTPUT_RESERVE: Final[int] = 16_384
_DEFAULT_COMPACT_PCT: Final[int] = 92

#: Where the advisory sits relative to the REAL compaction point, not a fixed
#: token count. An advisory that fires with 40%+ of the window still free is
#: noise, and noise trains the reader to skip the channel -- so the nag opens at
#: 88% of the way to compaction (~35k of runway on a 450k window: enough to wrap
#: a thought, short enough to mean something) and the second tier at 96%
#: (~14k out, compaction is imminent).
_NAG_FRACTION_OF_COMPACT: Final[float] = 0.88
_ADVISORY_FRACTION_OF_COMPACT: Final[float] = 0.96

#: Rico's 2026-08-19 single-sprint rule: compact once, then hand off after
#: roughly 200k more tokens. This is intentionally separate from the first-sprint
#: advisory, whose live profile override is currently higher.
_DEFAULT_HANDOFF_TOKENS: Final[int] = 200_000

#: context-budget-gate.ts:75 -- how much the count must climb before the same
#: advisory is repeated, so one long session does not print it every turn.
_RENAG_STEP: Final[int] = 15_000

#: context-budget-gate.ts:77-78. A repair window is minutes, and the longest one
#: is the same fifteen minutes the read-back self-releases in -- an escape hatch
#: that outlived the requirement it escapes would just be the gate switched off.
_DEFAULT_REPAIR_MINUTES: Final[int] = 5
_LONGEST_REPAIR_MINUTES: Final[int] = 15

#: context-budget-gate.ts:79 -- the agent key the policy state file is scoped by.
_POLICY_STATE_AGENT: Final[str] = "claude"

#: context-budget-gate.ts:80 -- how much of an auxiliary state file to inspect
#: before answering "unknown" instead. An unbounded read of an arbitrary file on
#: the hook's critical path is the failure this avoids; the answer when it trips
#: is `None`, which the status line renders as unknown rather than as healthy.
_MAX_STATE_SCAN_BYTES: Final[int] = 8 * 1024 * 1024

#: Every event this gate answers.
_EVENTS: Final[tuple[str, ...]] = (
    "user-prompt-submit",
    "pre-tool-use",
    "pre-compact",
    "post-compact",
    "session-start",
    "checkpoint-done",
    "repair-enter",
    "repair-exit",
    "stop",
    "status",
)


def compaction_trigger(window: int, percent: int) -> int:
    """Return the token count at which automatic compaction actually fires.

    Mirrors ``computedCompactAt`` in ``~/.claudex/doctor.ts``: the output reserve
    comes off the window first, and the trigger is ``percent`` of the remainder.
    """
    return (window - _OUTPUT_RESERVE) * percent // 100


def _settings_env(settings_path: Path) -> dict[str, str]:
    """Return the ``env`` block of a Claude settings file, or ``{}``.

    Fail-open by contract: an unreadable, absent, or malformed settings file
    leaves the caller on its fallbacks rather than raising inside a hook.
    """
    try:
        if not settings_path.is_file():
            return {}
        if settings_path.stat().st_size > _MAX_STATE_SCAN_BYTES:
            return {}
        parsed = json.loads(settings_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(parsed, dict):
        return {}
    env = parsed.get("env")
    return {k: str(v) for k, v in env.items()} if isinstance(env, dict) else {}


def _positive_int(raw: str | None) -> int | None:
    """Parse a positive integer, or return ``None`` for anything else."""
    try:
        value = int(str(raw))
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def resolve_thresholds(env: dict[str, str], settings_path: Path) -> tuple[int, int]:
    """Return ``(nag, advisory)`` token counts for the ACTIVE profile.

    Resolution order, most authoritative first:

    1. ``CONTEXT_BUDGET_NAG`` / ``CONTEXT_BUDGET_HARD`` in the environment --
       an explicit operator override, honoured verbatim.
    2. The compaction window for the profile that is actually running, read out
       of the settings file, with the thresholds placed as fractions of the real
       trigger point.
    3. ``_FALLBACK_COMPACT_WINDOW``, when no window can be resolved at all.

    Why it reads the FILE and not just the environment (issue #77): the live
    hook wrapper ``openbrain-hook-env`` starts the gate with ``exec env -i`` and
    an explicit allowlist that carries no ``CONTEXT_BUDGET_*`` and no
    ``CLAUDE_CODE_AUTO_COMPACT_WINDOW``. Every one of those variables is
    stripped before the gate is reached, so a value set in ``settings.json`` had
    no effect and the gate silently ran on the old hardcoded 200k -- firing at
    roughly half the real compaction point, on every turn, until the reader
    learned to ignore it. Reading the same file the settings live in needs no
    passthrough and cannot be defeated by the wrapper.

    Profiles differ and must not be hardcoded: the global profile runs a 450000
    window and the Claudex native/Sol profiles run 397000, which is a ~49k
    difference in where compaction lands.
    """
    window = _positive_int(env.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW"))
    percent = _positive_int(env.get("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"))
    nag_override = _positive_int(env.get("CONTEXT_BUDGET_NAG"))
    advisory_override = _positive_int(env.get("CONTEXT_BUDGET_HARD"))

    if None in (window, percent, nag_override, advisory_override):
        settings_env = _settings_env(settings_path)
        window = window or _positive_int(
            settings_env.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW")
        )
        percent = percent or _positive_int(
            settings_env.get("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE")
        )
        nag_override = nag_override or _positive_int(
            settings_env.get("CONTEXT_BUDGET_NAG")
        )
        advisory_override = advisory_override or _positive_int(
            settings_env.get("CONTEXT_BUDGET_HARD")
        )

    trigger = compaction_trigger(
        window or _FALLBACK_COMPACT_WINDOW, percent or _DEFAULT_COMPACT_PCT
    )
    nag = nag_override or int(trigger * _NAG_FRACTION_OF_COMPACT)
    advisory = advisory_override or int(trigger * _ADVISORY_FRACTION_OF_COMPACT)
    return nag, advisory


def _iso_now() -> str:
    """Return the current instant the way the TypeScript writer spells it."""
    utc = datetime.now(UTC)
    return f"{utc.strftime('%Y-%m-%dT%H:%M:%S')}.{utc.microsecond // 1000:03d}Z"


def _state_home(env: dict[str, str]) -> Path:
    """Return ``$XDG_STATE_HOME`` or its documented default."""
    configured = env.get("XDG_STATE_HOME", "").strip()
    return Path(configured) if configured else Path.home() / ".local" / "state"


def _build_parser(env: dict[str, str]) -> argparse.ArgumentParser:
    """Build the argument parser with environment-aware defaults.

    Args:
        env: Environment mapping, so defaults are testable without exporting.

    Returns:
        The parser. Every path is overridable, which is what lets the parity
        tests run against scratch files instead of the operator's live state.
    """
    state_home = _state_home(env)
    parser = argparse.ArgumentParser(
        prog="openbrain-context-budget-gate", add_help=True
    )
    parser.add_argument("--event", default="status", choices=_EVENTS)
    parser.add_argument("--session-id", default="")
    parser.add_argument("--project", default="")
    # Defaulted to None and filled in by ``resolve_thresholds`` AFTER parsing:
    # resolution reads ``--settings-path``, which is parsed in this same pass, so
    # it cannot be computed while the parser is still being built.
    parser.add_argument("--nag-tokens", type=int, default=None)
    parser.add_argument("--hard-tokens", type=int, default=None)
    parser.add_argument("--handoff-tokens", type=int, default=_DEFAULT_HANDOFF_TOKENS)
    parser.add_argument(
        "--state-path",
        type=Path,
        default=state_home / "agent-runtime" / "context-budget" / "state.json",
    )
    parser.add_argument(
        "--receipt-state-path", type=Path, default=default_receipt_state_path(env)
    )
    parser.add_argument(
        "--settings-path",
        type=Path,
        default=Path.home() / ".claude" / "settings.json",
    )
    parser.add_argument(
        "--policy-state-path",
        type=Path,
        default=Path.home()
        / ".local"
        / "state"
        / "agent-policy-refresh"
        / "state.json",
    )
    parser.add_argument(
        "--spool-path",
        type=Path,
        default=Path(
            env.get("OPENBRAIN_SPOOL_PATH")
            or Path.home()
            / ".local"
            / "state"
            / "openbrain-memory"
            / "claude-spool.jsonl"
        ),
    )
    parser.add_argument("--repair-reason", default="")
    parser.add_argument("--repair-minutes", type=int, default=_DEFAULT_REPAIR_MINUTES)
    parser.add_argument(
        "--gate-script-path",
        default="",
        help="Path a repair-enter/repair-exit command must name to be allowed.",
    )
    parser.add_argument(
        "--provider-script-path",
        # Derived from the resolved root rather than written as an independent
        # literal: this path and the recovery command's cwd have to agree, and
        # two literals agree only by luck.
        default=str(development_root() / "_ob" / "scripts" / "ob-memory-provider.ts"),
        help="Path a direct provider command must name to be allowed.",
    )
    return parser


class _Gate:
    """One invocation's resolved inputs, state, and handlers.

    Grouped into an object because every handler needs the same six things and
    threading them through ten function signatures would be noise. The class
    holds no behaviour a function could not -- it is the invocation's scope.
    """

    def __init__(
        self,
        args: argparse.Namespace,
        event: HookEvent,
        stdout: TextIO | None,
    ) -> None:
        """Resolve state and context for one invocation.

        Args:
            args: Parsed arguments.
            event: The parsed hook stdin.
            stdout: Where the verdict goes.
        """
        self.args = args
        self.event = event
        self.stdout = stdout
        self.now = _iso_now()
        self.event_name: str = args.event
        self.session_id = args.session_id or event.session_id or "unknown-session"
        self.state_file, self.raw_sessions = load_state(args.state_path)
        self.state = hydrate_session_state(
            self.raw_sessions.get(self.session_id), self.session_id, self.now
        )
        self._set_project()
        if self.event_name != "pre-tool-use":
            observed_boundaries = count_compact_boundaries(event.transcript_path)
            self.state.compact_boundary_count = max(
                self.state.compact_boundary_count, observed_boundaries
            )
        tokens = read_context_tokens(event.transcript_path)
        if tokens > 0:
            self.state.context_tokens = tokens
        reconcile_gate_state(
            self.state, receipt_state_path=args.receipt_state_path, now=self.now
        )
        self._arm_handoff_if_due()
        self.presentation = PresentationContext(
            advisory_tokens=args.hard_tokens,
            provider_script_path=args.provider_script_path,
            settings_path=args.settings_path,
            cwd=str(self._project_root()),
        )
        self.shell = ShellGateContext(
            state=self.state,
            gate_script_path=args.gate_script_path or _default_gate_script_path(),
            provider_script_path=args.provider_script_path,
            settings_path=args.settings_path,
            project_root=self._project_root(),
        )
        self._policy_stale: bool | None | _Unset = _UNSET
        self._spool_pending: int | None | _Unset = _UNSET

    def _set_project(self) -> None:
        """Resolve the project this session is scoped to.

        An explicit ``--project`` wins; otherwise the cwd is resolved. A cwd
        outside Development leaves the project as it was, so a hook fired from
        elsewhere mid-session does not silently re-scope the state.
        """
        if self.args.project:
            self.state.project = self.args.project
            return
        if not self.event.cwd:
            return
        scope = resolve_development_scope(self.event.cwd)
        if scope is not None:
            self.state.project = scope.project

    def _project_root(self) -> Path:
        """Return the owning repo root for handoff output and recovery payloads."""
        if development_root_missing() and self.event.cwd:
            return Path(self.event.cwd)
        root = development_root()
        project = self.state.project or ""
        if not project or project == root.name:
            return root
        return root / project

    def _arm_handoff_if_due(self) -> None:
        """Arm handoff after compact one consumes its 200k post-compact budget."""
        state = self.state
        if state.handoff_required:
            return
        if state.compact_boundary_count < 1:
            return
        if state.context_tokens < self.args.handoff_tokens:
            return
        self.require_handoff(
            f"compact #1 plus {round(state.context_tokens / 1000)}k "
            f"post-compact tokens reached the "
            f"{round(self.args.handoff_tokens / 1000)}k handoff band"
        )

    def require_handoff(self, reason: str) -> None:
        """Permanently close this sprint and record why."""
        if self.state.handoff_required:
            return
        self.state.handoff_required = True
        self.state.handoff_required_at = self.now
        record_transition(self.state, "handoff-armed", self.now, reason)

    def save(self) -> None:
        """Persist this session's state."""
        save_session_state(self.args.state_path, self.raw_sessions, self.state)

    def consume_notices(self) -> list[str]:
        """Take the queued one-time notices and persist the empty queue.

        Persisting immediately is what makes a notice survive a still-blocked
        call: it is removed only once something has actually displayed it.

        Returns:
            The notices that were queued.
        """
        notices = list(self.state.pending_cleared_notices)
        self.state.pending_cleared_notices = []
        self.save()
        return notices

    def policy_stale(self) -> bool | None:
        """Report policy-refresh staleness for this session, or None.

        Returns:
            True/False from the policy gate's own state file, or None when that
            file is absent, oversized, or unreadable. None is rendered as
            unknown, never as healthy.
        """
        if not isinstance(self._policy_stale, _Unset):
            return self._policy_stale
        self._policy_stale = self._read_policy_state()
        return self._policy_stale

    def _read_policy_state(self) -> bool | None:
        """Read `refreshRequired` for this session from the policy state file."""
        path: Path = self.args.policy_state_path
        try:
            if not path.is_file() or path.stat().st_size > _MAX_STATE_SCAN_BYTES:
                return None
            parsed = json.loads(path.read_text(encoding="utf8"))
        except (OSError, json.JSONDecodeError):
            return None
        if not isinstance(parsed, dict):
            return None
        sessions = parsed.get("sessions")
        if not isinstance(sessions, dict):
            return None
        entry = sessions.get(f"{_POLICY_STATE_AGENT}:{self.session_id}")
        if not isinstance(entry, dict):
            return None
        return bool(entry.get("refreshRequired"))

    def spool_pending(self) -> int | None:
        """Report how many entries are waiting in the durability spool."""
        if not isinstance(self._spool_pending, _Unset):
            return self._spool_pending
        self._spool_pending = self._read_spool_pending()
        return self._spool_pending

    def _read_spool_pending(self) -> int | None:
        """Count JSON-object lines in the spool file."""
        path: Path = self.args.spool_path
        try:
            if not path.exists():
                return 0
            size = path.stat().st_size
            if size == 0:
                return 0
            if size > _MAX_STATE_SCAN_BYTES:
                return None
            text = path.read_text(encoding="utf8")
        except OSError:
            return None
        return sum(1 for line in text.split("\n") if _is_json_object_line(line))

    def status_line(self) -> str:
        """Render the per-turn status line."""
        return gate_status_line(self.state, self.policy_stale(), self.spool_pending())

    def emit(self, text: str) -> None:
        """Write plain text to the return channel."""
        emit(text, self.stdout)

    def emit_json(self, payload: dict[str, Any]) -> None:
        """Write a JSON verdict to the return channel."""
        emit_json(payload, self.stdout)


class _Unset:
    """Sentinel type distinguishing "not computed yet" from a computed None."""


_UNSET: Final[_Unset] = _Unset()


def _is_json_object_line(line: str) -> bool:
    """Report whether a line is a JSON object.

    Args:
        line: One spool line.

    Returns:
        True only for a parseable JSON object; blanks and fragments are not
        pending entries.
    """
    if not line.strip():
        return False
    try:
        parsed = json.loads(line)
    except json.JSONDecodeError:
        return False
    return isinstance(parsed, dict)


def _default_gate_script_path() -> str:
    """Return the TypeScript gate path a repair command may still name.

    During the changeover the operator's muscle memory and every banner still
    name the `.ts` entry, and refusing that spelling would block the repair
    command the gate itself printed.
    """
    return str(development_root() / "_ob" / "scripts" / "context-budget-gate.ts")


def _handle_user_prompt_submit(gate: _Gate) -> int:
    """Emit the per-turn status line, plus a banner when one is owed."""
    gate.save()
    banner = ""
    state = gate.state
    if state.handoff_required:
        banner = handoff_banner(state, gate.presentation)
    elif state.readback_required:
        banner = readback_banner(state, gate.presentation)
    elif (
        state.context_tokens >= gate.args.nag_tokens
        and state.context_tokens >= state.last_nag_at_tokens + _RENAG_STEP
    ):
        state.last_nag_at_tokens = state.context_tokens
        gate.save()
        banner = nag_banner(state, gate.presentation)

    if not state.project:
        # Outside Development the gate reports nothing at all; a banner would be
        # the only output, and this hook has no authority in another repo.
        if banner:
            gate.emit(banner)
        return 0

    notices = gate.consume_notices()
    lines = [f"OB ✓ {' · '.join(notices)}"] if notices else []
    lines.append(gate.status_line())
    payload: dict[str, Any] = {"systemMessage": "\n".join(lines)}
    if banner:
        payload["hookSpecificOutput"] = {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": banner,
        }
    gate.emit_json(payload)
    return 0


def _handle_pre_tool_use(gate: _Gate) -> int:
    """Allow, allow-under-repair, or block one tool call."""
    tool_name = gate.event.tool_name.lower()
    tool_input = gate.event.tool_input
    state = gate.state

    if state.handoff_required and not is_checkpoint_activity(
        tool_name, tool_input, gate.shell
    ):
        return _block(
            gate, "handoff-required", handoff_banner(state, gate.presentation)
        )

    if repair_mode_is_active(state, gate.now) and is_repair_capable_tool(tool_name):
        gate.save()
        gate.emit_json(
            {
                "systemMessage": transition_message(
                    "repair-active-tool-allowed",
                    f"{tool_name} permitted until {state.repair_mode_expires_at}",
                )
            }
        )
        return 0

    if state.capture_required and not is_checkpoint_activity(
        tool_name, tool_input, gate.shell
    ):
        return _block(
            gate, "capture-required", capture_banner(state, gate.presentation)
        )
    if state.readback_required and not is_checkpoint_activity(
        tool_name, tool_input, gate.shell
    ):
        return _block(
            gate, "readback-required", readback_banner(state, gate.presentation)
        )

    notices = gate.consume_notices()
    gate.save()
    if notices:
        gate.emit_json({"systemMessage": f"OB ✓ {' · '.join(notices)}"})
    return 0


def _block(gate: _Gate, reason: str, banner: str) -> int:
    """Emit a block verdict and record that it happened.

    Args:
        gate: The invocation.
        reason: Short machine-readable reason.
        banner: The operator-facing text carrying the command that clears it.

    Returns:
        ``0``. A BLOCK is carried in the verdict JSON, not in the exit code --
        a non-zero exit is a hook failure, which is a different thing entirely.
    """
    record_transition(gate.state, "still-blocking-with-reason", gate.now, reason)
    gate.save()
    # #81: if NO provider invocation form is recognised, the banner above is
    # printing a command this gate would refuse, and a bare "blocked" gives the
    # session nothing to act on. Say what was not recognised, in the block
    # itself -- a silently-empty allowance is what makes a deadlock inescapable.
    diagnostic = unrecognised_hook_invocation_diagnostic(gate.shell)
    message = transition_message("still-blocking-with-reason", reason)
    gate.emit_json(
        {
            "decision": "block",
            "reason": f"{banner}\n{diagnostic}" if diagnostic else banner,
            "systemMessage": f"{message}\n{diagnostic}" if diagnostic else message,
        }
    )
    return 0


def _handle_checkpoint_done(gate: _Gate) -> int:
    """Accept an operator's checkpoint claim only against a real receipt."""
    evidence = verified_checkpoint(
        gate.state, gate.args.receipt_state_path, CHECKPOINT_MAX_AGE_SECONDS
    )
    if evidence is None:
        gate.emit(
            "REFUSED: no fresh verified-remote provider checkpoint receipt exists "
            "for this session/project. Run the direct ob-memory-provider checkpoint "
            "command and retry; spooled, failed, and lost writes do not count."
        )
        return 1
    state = gate.state
    state.checkpoint_required = False
    state.checkpoint_required_at = ""
    state.checkpoint_at_tokens = state.context_tokens
    state.checkpoint_at = evidence.recorded_at
    state.last_nag_at_tokens = state.context_tokens
    gate.save()
    gate.emit(
        "\n".join(
            [
                f"Checkpoint verified remotely at "
                f"~{round(state.context_tokens / 1000)}k tokens.",
                (
                    "Handoff remains required; this session does not reopen. "
                    "Start a fresh session."
                    if state.handoff_required
                    else "Task tools remain available; automatic compaction "
                    "handles rollover."
                ),
            ]
        )
    )
    return 0


def _handle_repair_enter(gate: _Gate) -> int:
    """Open a bounded repair window, or refuse and say exactly why."""
    reason = gate.args.repair_reason
    minutes = gate.args.repair_minutes
    if not reason or minutes < 1 or minutes > _LONGEST_REPAIR_MINUTES:
        gate.emit(
            "REFUSED: repair-enter requires --repair-reason and --repair-minutes "
            f"between 1 and {_LONGEST_REPAIR_MINUTES}."
        )
        return 1
    enter_repair_mode(gate.state, gate.now, timedelta(minutes=minutes), reason)
    gate.save()
    gate.emit(
        transition_message(
            "repair-entered",
            f"expires at {gate.state.repair_mode_expires_at}; {reason}",
        )
    )
    return 0


def _handle_repair_exit(gate: _Gate) -> int:
    """Close the repair window explicitly."""
    exit_repair_mode(
        gate.state, gate.now, gate.args.repair_reason or "explicit repair exit"
    )
    gate.save()
    gate.emit(transition_message("repair-exited", "normal enforcement resumed"))
    return 0


def _handle_stop(gate: _Gate) -> int:
    """Arm the capture requirement when the turn landed uncaptured work."""
    if not turn_did_work(gate.event.transcript_path, gate.state.last_write_at):
        gate.save()
        return 0
    gate.state.capture_required = True
    gate.state.capture_required_at = gate.now
    record_transition(
        gate.state, "armed", gate.now, "capture required after uncaptured work"
    )
    gate.save()
    gate.emit(capture_banner(gate.state, gate.presentation))
    return 0


def _handle_pre_compact(gate: _Gate) -> int:
    """Allow compact one and refuse every later compaction."""
    state = gate.state
    if state.handoff_required or state.compact_boundary_count >= 1:
        gate.require_handoff(
            "second compaction refused; one compact boundary already exists"
        )
        gate.save()
        gate.emit_json(
            {
                "decision": "block",
                "reason": handoff_banner(state, gate.presentation),
                "systemMessage": transition_message(
                    "handoff-armed", "second compaction refused"
                ),
            }
        )
        return 0
    gate.save()
    return 0


def _handle_compact_lifecycle(gate: _Gate) -> int:
    """Arm the post-compact read-back, or reset for a genuinely new session."""
    state = gate.state
    if gate.event_name == "session-start" and gate.event.source:
        if gate.event.source != "compact":
            if state.repair_mode_active:
                record_transition(
                    state, "repair-exited", gate.now, "fresh session reset"
                )
            gate.state = fresh_session_state(state)
            gate.save()
            return 0

    state.checkpoint_required = False
    state.checkpoint_required_at = ""
    state.readback_required = True
    state.last_nag_at_tokens = 0
    state.context_tokens = 0
    cycle_id, started_at = _compact_cycle_for_event(gate)
    state.readback_required_at = started_at
    state.readback_correlation_id = cycle_id
    record_transition(
        state, "armed", gate.now, f"post-compact read-back cycle {cycle_id}"
    )
    if state.compact_boundary_count >= 2:
        gate.require_handoff(
            "second compact boundary observed; fail-safe handoff required"
        )
    if gate.event_name == "session-start":
        reconcile_gate_state(
            state, receipt_state_path=gate.args.receipt_state_path, now=gate.now
        )
    gate.save()
    return 0


def _compact_cycle_for_event(gate: _Gate) -> tuple[str, str]:
    """Return the compaction cycle this read-back is correlated to.

    ``post-compact`` always joins-or-opens: it IS the compaction, so if no cycle
    exists the gate opens one rather than arming with no correlation id. A
    ``session-start`` prefers an existing cycle and only opens one when there is
    none, because a session-start that follows a compaction should attach to the
    cycle that compaction already opened
    (``context-budget-gate.ts:280-286``).

    Args:
        gate: The invocation.

    Returns:
        ``(correlation_id, started_at)``. An empty id means the cycle could not
        be read or written; the read-back still arms and still blocks, and
        ``_recover_legacy_correlation`` adopts the real id as soon as one exists.
    """
    if gate.event_name != "post-compact":
        existing = current_compact_cycle(
            gate.args.receipt_state_path,
            session_id=gate.session_id,
            project=gate.state.project,
        )
        if existing is not None:
            return existing.id, existing.started_at
    cycle = gate_compact_cycle(
        gate.args.receipt_state_path,
        session_id=gate.session_id,
        project=gate.state.project,
    )
    if cycle is not None:
        return cycle.id, cycle.started_at
    return "", gate.now


def _handle_status(gate: _Gate) -> int:
    """Print the whole gate state as JSON, for a human or a test."""
    gate.save()
    state = gate.state
    payload = {
        "sessionId": gate.session_id,
        "project": state.project or None,
        "contextTokens": state.context_tokens,
        "compactBoundaryCount": state.compact_boundary_count,
        "handoffRequired": state.handoff_required,
        "handoffRequiredAt": state.handoff_required_at or None,
        "nagAt": gate.args.nag_tokens,
        "hardAt": gate.args.hard_tokens,
        "handoffAt": gate.args.handoff_tokens,
        "checkpointRequired": False,
        "preCompactTaskBlocking": state.handoff_required,
        "readbackRequired": state.readback_required,
        "captureRequired": state.capture_required,
        "repairModeActive": state.repair_mode_active,
        "repairModeEnteredAt": state.repair_mode_entered_at or None,
        "repairModeExpiresAt": state.repair_mode_expires_at or None,
        "lastWriteAt": state.last_write_at or None,
        "checkpointAt": state.checkpoint_at or None,
        "policyStale": gate.policy_stale(),
        "spoolPending": gate.spool_pending(),
        "statusLine": gate.status_line() if state.project else None,
        "pendingClearedNotices": state.pending_cleared_notices,
        "transitions": [entry.to_json() for entry in state.transition_log],
    }
    gate.emit(json.dumps(payload, indent=2, ensure_ascii=False))
    return 0


#: Event name to handler. A table rather than a branch chain: adding an event is
#: one row, and no handler can reach another's locals.
_HANDLERS: Final[dict[str, Any]] = {
    "user-prompt-submit": _handle_user_prompt_submit,
    "pre-tool-use": _handle_pre_tool_use,
    "checkpoint-done": _handle_checkpoint_done,
    "repair-enter": _handle_repair_enter,
    "repair-exit": _handle_repair_exit,
    "stop": _handle_stop,
    "pre-compact": _handle_pre_compact,
    "post-compact": _handle_compact_lifecycle,
    "session-start": _handle_compact_lifecycle,
    "status": _handle_status,
}


def _warn_missing_development_root(event: HookEvent, stderr: TextIO | None) -> None:
    """Say so on stderr when the configured Development root does not exist.

    Diagnostic only, and deliberately NOT a verdict. The gate's contract is that
    it must not deadlock on what it gates (#419), and the repair for an absent
    root is an environment variable the operator exports in a shell -- so a gate
    that blocked here would be gating its own escape. Loud, then out of the way.

    stderr rather than stdout for the same reason: stdout is the hook's verdict
    channel and a JSON reader is on the other end of it.

    Args:
        event: The hook event, read for its measured cwd.
        stderr: Where the diagnosis goes. Defaults to ``sys.stderr``.
    """
    if not development_root_missing():
        return
    diagnosis = describe_development_root(event.cwd or None)
    if diagnosis is None:
        return
    print(render_scope_diagnosis(diagnosis), file=stderr or sys.stderr)


def main(
    argv: list[str] | None = None,
    *,
    stdin: TextIO | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
    env: dict[str, str] | None = None,
) -> int:
    """Run one gate invocation.

    Args:
        argv: Command-line arguments. Defaults to ``sys.argv[1:]``.
        stdin: The hook's stdin. Defaults to ``sys.stdin``.
        stdout: The return channel. Defaults to ``sys.stdout``.
        stderr: The diagnostic channel. Defaults to ``sys.stderr``.
        env: Environment mapping for defaults. Defaults to ``os.environ``.

    Returns:
        The process exit code: ``0`` for every verdict including a block, and
        ``1`` only for a REFUSED operator command. A block is data on stdout;
        a non-zero exit means the hook itself failed. An absent Development root
        changes none of this -- it is reported on stderr and nothing else.
    """
    environment = dict(os.environ) if env is None else env
    args = _build_parser(environment).parse_args(sys.argv[1:] if argv is None else argv)
    # Resolved here, not in the parser: it depends on ``--settings-path``, which
    # the same parse produces. An explicit --nag-tokens/--hard-tokens still wins.
    resolved_nag, resolved_advisory = resolve_thresholds(
        environment, args.settings_path
    )
    if args.nag_tokens is None:
        args.nag_tokens = resolved_nag
    if args.hard_tokens is None:
        args.hard_tokens = resolved_advisory
    event = read_hook_event(stdin)
    _warn_missing_development_root(event, stderr)
    gate = _Gate(args, event, stdout)
    handler = _HANDLERS[gate.event_name]
    result = handler(gate)
    return int(result)


def _cli() -> int:
    """Console-script entrypoint.

    Returns:
        The exit code.
    """
    return main()


if __name__ == "__main__":
    raise SystemExit(_cli())
