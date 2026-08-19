"""Classify a tool call as checkpoint activity, repair-capable, or neither.

This is the module that decides what a BLOCKED session may still do. Two
separate allowances live here and must not be confused:

* **Checkpoint activity** — what is permitted while the gate is blocking,
  because it is either read-only or it is the exact command that clears the
  block. This is the escape hatch: a gate that blocks the repair of the
  subsystem it gates on is the defect issue #419 names.
* **Repair-capable** — the broader set (bash, write, edit) that an explicitly
  opened, expiring repair window admits.

The shell parser is deliberately strict and fails closed. It parses a simple
pipeline of quoted words and REFUSES on any character that could redirect,
substitute, or chain (``;``, ``&``, ``>``, `` ` ``, ``$``). A command it cannot
prove safe is not allowed. That is the correct direction for an allowance: a
parser that guessed would turn "read-only" into an arbitrary-execution hole.

What this module does NOT do: it holds no state and reads no receipts. It
answers questions about a command string and a session's current requirements.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

from .development_scope import resolve_development_scope
from .gate_state import SessionState

__all__ = [
    "READONLY_BASH",
    "WRAPPER_CONSOLE_EVENTS",
    "ShellGateContext",
    "activated_provider_script_paths",
    "is_checkpoint_activity",
    "is_repair_capable_tool",
    "shell_quote",
    "unrecognised_hook_invocation_diagnostic",
    "wrapper_console_invocations",
]

#: context-budget-gate-shell.ts:5-11, byte-identical. Commands that read and do
#: not write. `sed` and `find` are here but are re-checked below for their
#: mutating flags, because the binary alone does not settle it.
READONLY_BASH: Final[frozenset[str]] = frozenset(
    {
        "ls",
        "cat",
        "head",
        "tail",
        "grep",
        "rg",
        "egrep",
        "fgrep",
        "find",
        "fd",
        "wc",
        "stat",
        "file",
        "du",
        "df",
        "tree",
        "realpath",
        "dirname",
        "basename",
        "echo",
        "printf",
        "pwd",
        "whoami",
        "id",
        "date",
        "hostname",
        "uname",
        "which",
        "type",
        "printenv",
        "sort",
        "uniq",
        "cut",
        "tr",
        "column",
        "jq",
        "diff",
        "sed",
        "awk",
        "test",
        "sw_vers",
        "uuidgen",
    }
)

#: context-budget-gate-shell.ts:29 — tools that cannot mutate anything, so they
#: are permitted regardless of gate state.
_ALWAYS_ALLOWED_TOOLS: Final[frozenset[str]] = frozenset(
    {
        "read",
        "grep",
        "glob",
        "tasklist",
        "taskget",
        "askuserquestion",
        "skill",
        "toolsearch",
    }
)

#: context-budget-gate-shell.ts:21 — what an open repair window admits.
_REPAIR_CAPABLE_TOOLS: Final[frozenset[str]] = frozenset(
    {"bash", "shell", "write", "edit"}
)

_SHELL_TOOLS: Final[frozenset[str]] = frozenset({"bash", "shell"})
_FILE_TOOLS: Final[frozenset[str]] = frozenset({"write", "edit"})

#: The interpreters a maintenance command may be spelled with.
_BUN_BINARIES: Final[frozenset[str]] = frozenset({"bun", "/opt/homebrew/bin/bun"})

#: context-budget-gate-shell.ts:153 — the provider events a maintenance command
#: may name at all.
_PROVIDER_EVENTS: Final[frozenset[str]] = frozenset(
    {"session-start", "capture", "checkpoint", "wrap"}
)

#: context-budget-gate-shell.ts:193 — the activated-adapter path shape.
_ACTIVATED_PROVIDER_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"([^'\"\s]+/adapters/versions/sha256-[0-9a-f]{64})"
    r"/(?:context-budget-gate|ob-memory-provider)\.ts"
)

#: The packaged wrapper form settings.json actually uses (#81). Every hook now
#: reads `sh <…>/openbrain-hook-env openbrain-session-start`, and the console
#: script is a uv-installed Python entry point rather than a `bun` script. The
#: allowlist recognised only the older `bun <…>.ts` spelling, so a session could
#: be told to run one thing and refused for running it. The pattern captures the
#: wrapper path so the recovery command can be DERIVED from what is wired up
#: instead of written as a second literal that drifts.
_HOOK_WRAPPER_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"([^'\"\s]+/openbrain-hook-env)\s+(openbrain-[a-z0-9-]+)"
)

#: The console scripts the wrapper may run to satisfy a read-back or a capture.
#: Mapped to the provider event each one produces, because the allowance is per
#: event: a read-back block is cleared only by a recall, never by a capture.
WRAPPER_CONSOLE_EVENTS: Final[dict[str, str]] = {
    "openbrain-session-start": "session-start",
    "openbrain-capture-stop": "capture",
    "openbrain-post-compact": "session-start",
}

#: `sh` spellings the wrapper form may be invoked through.
_SHELL_BINARIES: Final[frozenset[str]] = frozenset(
    {"sh", "/bin/sh", "bash", "/opt/homebrew/bin/bash", "zsh", "/opt/homebrew/bin/zsh"}
)

#: Characters that make a command something other than a simple pipeline.
_UNSAFE_SHELL_CHARS: Final[frozenset[str]] = frozenset({";", "&", ">", "<", "`", "$"})


@dataclass(frozen=True)
class ShellGateContext:
    """Everything command classification needs besides the command itself.

    Attributes:
        state: The session's current requirements.
        gate_script_path: Path a `repair-enter`/`repair-exit` command must name.
        provider_script_path: Path a direct provider command must name.
        settings_path: Settings file scanned for activated adapter generations.
        project_root: Owning repo root whose handoff directory remains writable.
    """

    state: SessionState
    gate_script_path: str
    provider_script_path: str
    settings_path: Path
    project_root: Path


def shell_quote(value: str) -> str:
    """Return a single-quoted shell word.

    Args:
        value: Raw value.

    Returns:
        The value wrapped in single quotes with embedded quotes escaped the
        POSIX way, byte-identical to context-budget-gate-shell.ts:59-61 so the
        command the banner prints is the command the allowance accepts.
    """
    escaped = value.replace("'", "'\"'\"'")
    return f"'{escaped}'"


def is_repair_capable_tool(tool_name: str) -> bool:
    """Report whether an open repair window admits this tool.

    Args:
        tool_name: Lowercased tool name.

    Returns:
        True for bash, shell, write, and edit.
    """
    return tool_name in _REPAIR_CAPABLE_TOOLS


def _parse_shell_pipeline(command: str) -> list[list[str]] | None:
    """Parse a simple quoted pipeline into segments of words.

    Fails closed. Any construct beyond quoting, escaping, and a single ``|``
    returns None, and every caller treats None as "not allowed".

    Args:
        command: The raw command string.

    Returns:
        A list of pipeline segments, each a list of words, or None when the
        command is not a simple pipeline.
    """
    pipeline: list[list[str]] = [[]]
    word = ""
    started = False
    quote = ""
    index = 0
    length = len(command)

    while index < length:
        char = command[index]
        if quote:
            consumed = _consume_quoted(command, index, quote, word)
            if consumed is None:
                return None
            index, quote, word = consumed
            started = True
            index += 1
            continue
        if char.isspace():
            if started:
                pipeline[-1].append(word)
                word, started = "", False
            index += 1
            continue
        if char in ("'", '"'):
            quote, started = char, True
            index += 1
            continue
        if char == "|":
            if index + 1 < length and command[index + 1] == "|":
                return None
            if started:
                pipeline[-1].append(word)
                word, started = "", False
            if not pipeline[-1]:
                return None
            pipeline.append([])
            index += 1
            continue
        if char in _UNSAFE_SHELL_CHARS:
            return None
        if char == "\\":
            if index + 1 >= length:
                return None
            escaped = command[index + 1]
            word += "" if escaped == "\n" else escaped
            started = True
            index += 2
            continue
        word += char
        started = True
        index += 1

    if quote:
        return None
    if started:
        pipeline[-1].append(word)
    return pipeline if all(segment for segment in pipeline) else None


def _consume_quoted(
    command: str, index: int, quote: str, word: str
) -> tuple[int, str, str] | None:
    """Consume one character inside a quoted run.

    Args:
        command: The full command.
        index: Index of the character to consume.
        quote: The open quote character.
        word: The word built so far.

    Returns:
        ``(index, quote, word)`` after consuming, or None when the character is
        not permitted inside that quote. Inside double quotes ``$`` and
        `` ` `` are refused, because both still substitute there.
    """
    char = command[index]
    if char == quote:
        return index, "", word
    if quote == '"' and char in ("$", "`"):
        return None
    if quote != '"' or char != "\\":
        return index, quote, word + char
    if index + 1 >= len(command):
        return None
    escaped = command[index + 1]
    if escaped not in ('"', "\\"):
        return None
    return index + 1, quote, word + escaped


def activated_provider_script_paths(settings_path: Path) -> list[str]:
    """Return provider paths from activated adapter generations in settings.

    Args:
        settings_path: A Claude settings file.

    Returns:
        Every existing `ob-memory-provider.ts` reachable from a `sha256-<hash>`
        adapter path named in a hook command. Empty on any read or parse
        failure — malformed settings fail closed, they do not widen the
        allowance.
    """
    try:
        parsed = json.loads(settings_path.read_text(encoding="utf8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(parsed, dict):
        return []
    hooks = parsed.get("hooks")
    if not isinstance(hooks, dict):
        return []

    candidates: list[str] = []
    for event_hooks in hooks.values():
        if not isinstance(event_hooks, list):
            continue
        for event_hook in event_hooks:
            if not isinstance(event_hook, dict):
                continue
            commands = event_hook.get("hooks")
            if not isinstance(commands, list):
                continue
            for hook in commands:
                _collect_provider_path(hook, candidates)
    return candidates


def wrapper_console_invocations(settings_path: Path) -> list[tuple[str, str]]:
    """Return `(wrapper_path, console_script)` pairs wired up in settings.

    This is the #81 half of provider discovery. `activated_provider_script_paths`
    answers "which `bun` adapter generation is installed"; this answers "which
    packaged console script is on the hook chain", which is the form every hook
    has used since the #420 cutover.

    Args:
        settings_path: A Claude settings file.

    Returns:
        Every `(wrapper, console script)` pair whose wrapper exists on disk and
        whose console script is one the gate knows how to credit. Empty on any
        read or parse failure, matching the fail-closed posture of its sibling —
        malformed settings never widen an allowance.
    """
    try:
        parsed = json.loads(settings_path.read_text(encoding="utf8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(parsed, dict):
        return []
    hooks = parsed.get("hooks")
    if not isinstance(hooks, dict):
        return []

    found: list[tuple[str, str]] = []
    for event_hooks in hooks.values():
        if not isinstance(event_hooks, list):
            continue
        for event_hook in event_hooks:
            if not isinstance(event_hook, dict):
                continue
            commands = event_hook.get("hooks")
            if not isinstance(commands, list):
                continue
            for hook in commands:
                _collect_wrapper_invocation(hook, found)
    return found


def _collect_wrapper_invocation(hook: object, found: list[tuple[str, str]]) -> None:
    """Append any wrapper/console-script pair named by one hook command."""
    if not isinstance(hook, dict):
        return
    command = hook.get("command")
    if not isinstance(command, str):
        return
    for match in _HOOK_WRAPPER_PATTERN.finditer(command):
        wrapper, console = match.group(1), match.group(2)
        if console not in WRAPPER_CONSOLE_EVENTS:
            continue
        pair = (wrapper, console)
        try:
            if Path(wrapper).is_file() and pair not in found:
                found.append(pair)
        except OSError:
            continue


def _collect_provider_path(hook: object, candidates: list[str]) -> None:
    """Append any existing provider path named by one hook command."""
    if not isinstance(hook, dict):
        return
    command = hook.get("command")
    if not isinstance(command, str):
        return
    for match in _ACTIVATED_PROVIDER_PATTERN.finditer(command):
        candidate = f"{match.group(1)}/ob-memory-provider.ts"
        try:
            if Path(candidate).is_file() and candidate not in candidates:
                candidates.append(candidate)
        except OSError:
            continue


def unrecognised_hook_invocation_diagnostic(
    context: ShellGateContext,
) -> str:
    """Return a diagnostic when NO provider invocation form is recognised.

    The #81 defect class: an allowlist that resolves to nothing looks exactly
    like an allowlist that is correctly empty, so the gate refuses its own
    recovery command and says only "blocked". An empty allowance and a
    deliberately-narrow one must not be indistinguishable — the same silent
    failure family as #98 (untested wrapper allowlist) and #99 (a test run that
    dies and exits 0).

    Args:
        context: The paths this gate would accept a recovery command at.

    Returns:
        A one-line operator-facing diagnostic naming what was not recognised and
        what to do, or ``""`` when at least one form IS recognised (the normal
        case, where staying quiet is correct).
    """
    if Path(context.provider_script_path).is_file():
        return ""
    if activated_provider_script_paths(context.settings_path):
        return ""
    if wrapper_console_invocations(context.settings_path):
        return ""
    return (
        "OB ✗ gate cannot recognise ANY provider invocation form — the recovery "
        f"command it prints will be refused. Checked: sibling script "
        f"{context.provider_script_path} (absent), and {context.settings_path} "
        "for a sha256 adapter generation or an openbrain-hook-env console "
        "script (neither found). Repair with --provider-script-path pointing at "
        "the installed provider, or run "
        "'openbrain-context-budget-gate --event repair-enter' to open a repair "
        "window."
    )


def is_checkpoint_activity(
    tool_name: str, tool_input: dict[str, Any], context: ShellGateContext
) -> bool:
    """Report whether a blocked session may still run this tool call.

    Args:
        tool_name: Lowercased tool name.
        tool_input: The tool's arguments.
        context: Session requirements and the paths a maintenance command may
            name.

    Returns:
        True when the call is read-only, is memory-file bookkeeping, or is one
        of the exact maintenance commands that clears or repairs the gate.
    """
    if tool_name in _ALWAYS_ALLOWED_TOOLS:
        return True
    if tool_name in _FILE_TOOLS:
        path = str(tool_input.get("file_path") or "")
        if context.state.handoff_required and _is_handoff_document(
            path, context.project_root
        ):
            return True
        return "/.claude/projects/" in path and "/memory/" in path
    if tool_name not in _SHELL_TOOLS:
        return False

    command = str(tool_input.get("command") or "").strip()
    maintenance = (
        _is_direct_provider_command(command, context)
        or _is_maintenance_command(command, "context-budget-gate.ts", "checkpoint-done")
        or _is_gate_repair_command(command, "repair-enter", context.gate_script_path)
        or _is_gate_repair_command(command, "repair-exit", context.gate_script_path)
        or _is_maintenance_command(command, "policy-refresh-gate.ts", "refresh")
    )
    return maintenance or _is_read_only_bash(command)


def _is_maintenance_command(
    command: str, script_name: str, required_event: str
) -> bool:
    """Report whether a command is `bun <…/script> … --event <required>`.

    Args:
        command: The raw command.
        script_name: Filename the command must name.
        required_event: The event it must request.

    Returns:
        True only for a single unchained invocation naming both.
    """
    if re.search(r"[>`;&|]|\$\(", command):
        return False
    escaped = re.escape(script_name)
    pattern = (
        r"^\s*(?:bun|/opt/homebrew/bin/bun)(?:\s+run)?\s+"
        rf"(?:'|\")?[^\s'\"]*/{escaped}(?:'|\")?\s+.*"
        rf"--event\s+{re.escape(required_event)}(?:\s|$).*$"
    )
    return re.match(pattern, command, re.DOTALL) is not None


def _is_gate_repair_command(
    command: str, required_event: str, gate_script_path: str
) -> bool:
    """Report whether a command is this exact gate's repair-enter/exit call.

    The gate script path must match exactly. A repair command naming some other
    gate script would open a window in a state file this process does not own.

    Args:
        command: The raw command.
        required_event: ``repair-enter`` or ``repair-exit``.
        gate_script_path: The path this process is running as.

    Returns:
        True only for a single-segment invocation naming both.
    """
    pipeline = _parse_shell_pipeline(command)
    if pipeline is None or len(pipeline) != 1:
        return False
    words = pipeline[0]
    index = 0
    if index >= len(words) or words[index] not in _BUN_BINARIES:
        return False
    index += 1
    if index < len(words) and words[index] == "run":
        index += 1
    if index >= len(words) or words[index] != gate_script_path:
        return False
    try:
        event_index = words.index("--event", index + 1)
    except ValueError:
        return False
    return event_index + 1 < len(words) and words[event_index + 1] == required_event


def _provider_events_allowed_by_state(state: SessionState) -> frozenset[str]:
    """Return the provider events permitted by the session's current block.

    A handoff admits only its final checkpoint. A read-back block is cleared
    only by a recall (`session-start`), and a capture block only by a durable
    write. Allowing a different event would admit mutation that cannot produce
    the evidence the block is waiting for.

    Args:
        state: Session state.

    Returns:
        The allowed provider event names.
    """
    if state.handoff_required:
        return frozenset({"checkpoint"})
    if state.readback_required:
        return frozenset({"session-start"})
    if state.capture_required:
        return frozenset({"capture", "checkpoint", "wrap"})
    return frozenset({"session-start", "capture", "checkpoint", "wrap"})


def _is_direct_provider_command(command: str, context: ShellGateContext) -> bool:
    """Report whether a command is the exact direct provider call this gate wants.

    Args:
        command: The raw command.
        context: Session requirements and provider paths.

    Returns:
        True for a one- or two-segment pipeline whose last segment is a valid
        provider invocation for an allowed event, and whose payload (when a
        payload is piped in) matches this session, project, and cycle.
    """
    allowed = _provider_events_allowed_by_state(context.state)
    pipeline = _parse_shell_pipeline(command)
    if pipeline is None or len(pipeline) > 2:
        return False
    event = _parse_provider_invocation(pipeline[-1], context)
    if event is None or event not in allowed:
        return False
    if len(pipeline) == 1:
        # A session-start recall must carry a correlated payload, so the bare
        # form cannot satisfy a read-back block.
        return event != "session-start"
    return _valid_provider_payload(pipeline[0], event, context.state)


def _valid_provider_payload(
    words: list[str], provider_event: str, state: SessionState
) -> bool:
    """Report whether the piped payload belongs to THIS session and cycle.

    Args:
        words: The producing segment's words, expected `printf %s <json>`.
        provider_event: The provider event the payload feeds.
        state: Session state the payload must match.

    Returns:
        True only when the JSON names this session, resolves to this project,
        and — for a recall — quotes the exact correlation id the gate is
        waiting on.
    """
    if len(words) != 3 or words[0] != "printf" or words[1] != "%s":
        return False
    try:
        payload = json.loads(words[2])
    except json.JSONDecodeError:
        return False
    if not isinstance(payload, dict):
        return False
    if payload.get("session_id") != state.session_id:
        return False
    cwd = payload.get("cwd")
    if not isinstance(cwd, str):
        return False
    scope = resolve_development_scope(cwd)
    if scope is None or scope.project != state.project:
        return False
    if provider_event != "session-start":
        distilled = payload.get("distilled")
        return isinstance(distilled, dict)
    return (
        payload.get("source") == "compact"
        and bool(state.readback_correlation_id)
        and payload.get("correlation_id") == state.readback_correlation_id
    )


def _parse_provider_invocation(
    words: list[str], context: ShellGateContext
) -> str | None:
    """Return the provider event a segment invokes, or None.

    Args:
        words: One pipeline segment's words.
        context: Provider paths this gate accepts.

    Returns:
        The event name, or None when the segment is not a provider invocation
        naming a path this gate recognises.
    """
    wrapper_event = _parse_wrapper_invocation(words, context)
    if wrapper_event is not None:
        return wrapper_event
    index = 0
    if index >= len(words) or words[index] not in _BUN_BINARIES:
        return None
    index += 1
    if index < len(words) and words[index] == "run":
        index += 1
    if index >= len(words):
        return None
    path = words[index]
    activated = activated_provider_script_paths(context.settings_path)
    if path != context.provider_script_path and path not in activated:
        return None
    return _parse_provider_flags(words, index + 1)


def _parse_wrapper_invocation(
    words: list[str], context: ShellGateContext
) -> str | None:
    """Return the provider event a packaged wrapper invocation produces.

    Recognises `sh <…>/openbrain-hook-env <console-script>`, the shape every
    hook in settings.json has used since the #420 cutover (#81). The pair must
    be one settings actually names, so an arbitrary script cannot be smuggled
    through by borrowing the wrapper's name.

    Args:
        words: One pipeline segment's words.
        context: Provider paths this gate accepts.

    Returns:
        The provider event, or None when the segment is not a recognised
        wrapper invocation.
    """
    index = 0
    if index < len(words) and words[index] in _SHELL_BINARIES:
        index += 1
    if index + 1 >= len(words):
        return None
    wrapper, console = words[index], words[index + 1]
    if (wrapper, console) not in wrapper_console_invocations(context.settings_path):
        return None
    # Trailing words are refused rather than ignored: the console scripts take
    # their input on stdin, so an extra argument means this is not the command
    # the gate would have printed, and an allowance must not guess.
    if len(words) > index + 2:
        return None
    return WRAPPER_CONSOLE_EVENTS.get(console)


def _parse_provider_flags(words: list[str], start: int) -> str | None:
    """Parse `--runtime`/`--event` flags, refusing anything else.

    A repeated flag is refused: two `--event` values make the effective event
    ambiguous, and ambiguity in an allowance is a hole.

    Args:
        words: The segment's words.
        start: Index of the first flag.

    Returns:
        The event, or None when the flags are unrecognised, duplicated, or the
        runtime is not `claude`.
    """
    index = start
    runtime = ""
    event = ""
    while index < len(words):
        parsed = _parse_flag(words, index)
        if parsed is None:
            return None
        name, value, index = parsed
        if name == "runtime":
            if runtime:
                return None
            runtime = value
        if name == "event":
            if event:
                return None
            event = value
    if runtime != "claude" or event not in _PROVIDER_EVENTS:
        return None
    return event


def _parse_flag(words: list[str], index: int) -> tuple[str, str, int] | None:
    """Parse one `--runtime`/`--event` flag in either spelling.

    Args:
        words: The segment's words.
        index: Index to parse at.

    Returns:
        ``(name, value, next_index)``, or None for any other word.
    """
    word = words[index]
    for name in ("runtime", "event"):
        flag = f"--{name}"
        if word == flag and index + 1 < len(words):
            return name, words[index + 1], index + 2
        if word.startswith(f"{flag}="):
            return name, word[len(flag) + 1 :], index + 1
    return None


def _is_handoff_document(path: str, project_root: Path) -> bool:
    """Report whether a file mutation stays inside the handoff directory.

    Args:
        path: Candidate file path.
        project_root: Owning repo root.

    Returns:
        True only for a Markdown file below `_DOCS/_handoff` with traversal
        resolved away before the comparison.
    """
    if not path:
        return False
    try:
        candidate = Path(path).resolve(strict=False)
        root = (project_root / "_DOCS" / "_handoff").resolve(strict=False)
    except OSError:
        return False
    return candidate.suffix == ".md" and root in candidate.parents


def _is_read_only_bash(command: str) -> bool:
    """Report whether every segment of a command is read-only.

    Args:
        command: The raw command.

    Returns:
        True only when the command has no redirect or substitution and every
        chained segment is a read-only binary or a read-only git subcommand.
    """
    if not command or re.search(r"[>`]|\$\(", command):
        return False
    segments = [
        segment.strip()
        for segment in re.split(r"\|\||&&|[;|&]", command)
        if segment.strip()
    ]
    if not segments:
        return False
    return all(_is_read_only_segment(segment) for segment in segments)


def _is_read_only_segment(segment: str) -> bool:
    """Report whether one chained segment is read-only.

    Args:
        segment: One segment of a chained command.

    Returns:
        True for a read-only binary used read-only. `sed -i` and `find -delete`
        are refused because the binary alone does not settle it.
    """
    parts = segment.split()
    if not parts:
        return False
    head, rest = parts[0], parts[1:]
    if head == "git":
        return _is_read_only_git(rest)
    if head not in READONLY_BASH:
        return False
    if head == "sed" and any(
        arg.startswith("-i") or arg.startswith("--in-place") for arg in rest
    ):
        return False
    if head == "find" and any(
        arg in ("-delete", "-exec", "-execdir", "-fprint") for arg in rest
    ):
        return False
    return True


def _is_read_only_git(args: list[str]) -> bool:
    """Report whether a git invocation only reads.

    Args:
        args: Arguments after `git`.

    Returns:
        True for the read-only subcommands, and for `git branch` only with
        listing flags — `git branch -D` deletes.
    """
    index = 0
    while index < len(args):
        arg = args[index]
        if arg == "--no-pager":
            index += 1
            continue
        following = args[index + 1] if index + 1 < len(args) else "-"
        if arg == "-C" and not following.startswith("-"):
            index += 2
            continue
        break
    subcommand = args[index] if index < len(args) else ""
    if subcommand != "branch":
        return subcommand in ("status", "log", "diff", "show", "rev-parse", "ls-files")
    flags = args[index + 1 :]
    listing = {"-a", "--all", "-r", "--remotes", "-v", "-vv", "--show-current"}
    return not flags or all(flag in listing for flag in flags)
