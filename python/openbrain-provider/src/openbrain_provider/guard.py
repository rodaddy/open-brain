"""Decide whether a Bash payload invokes the blocked Open Brain CLI route.

Purpose:
    Claude reaches Open Brain through the direct ``openbrain-memory`` provider.
    The executable ``mcp2cli open-brain`` route is retired for Claude and this
    guard refuses it at ``PreToolUse``, while leaving ``qmd`` and every other
    ``mcp2cli`` service alone.

Architecture:
    A behaviour-identical port of
    ``_ob/scripts/ob-memory-provider/guard.ts`` (493 lines, 1 live
    registration on ``PreToolUse``/``Bash`` in both the Claude and Codex-sol
    profiles). Lexing lives in ``shell_lexer``; this module is policy only and
    performs no I/O. ``cli_guard`` is the entrypoint shell around it.

Pattern/Convention:
    LANGUAGE PORT ONLY -- no design change. Every verdict, including the ones
    that look like gaps, matches the TypeScript byte for byte, proven against
    fixtures recorded from the running script rather than re-derived from its
    source. Two known gaps are deliberately preserved: ``( cmd )`` and
    ``if ...; then cmd; fi`` are NOT blocked, because ``(`` and ``then`` lex
    as the executable token. Closing either would change live enforcement.

    Whether ``PreToolUse`` should observe or enforce is open-brain#451 and is
    HITL. This port answers nothing about it: it preserves today's behaviour
    exactly so the decision stays open and stays the operator's.

    The guard fails OPEN by design. Malformed input, an unreadable payload, or
    any unexpected shape returns an empty response rather than a block, because
    a guard scoped to one command must never take out unrelated tool use.

Example:
    >>> guard_claude_command(b'{"tool_name":"Read","tool_input":{}}')
    ''
    >>> guard_claude_command(b'not json at all')
    ''

See Also:
    - ``shell_lexer`` - the tokenizer this reasons over
    - ``cli_guard`` - the ``ob-guard`` console script
    - open-brain#451 - the OPEN observation-vs-enforcement decision
"""

from __future__ import annotations

import json
import re
from typing import Final

from openbrain_provider.shell_lexer import (
    Segment,
    Token,
    executable_substitutions,
    tokenize_shell_detailed,
)

#: Largest stdin payload the guard parses as JSON, in bytes.
#: ``guard.ts:8``: `const MAX_INPUT_BYTES = 64 * 1024`. Structural, and it is a
#: FAIL-CLOSED threshold rather than a content bound: nothing is shortened or
#: dropped. Above it the payload is not parsed, and a shell tool is blocked
#: rather than waved through, so an oversized body cannot be used to smuggle a
#: forbidden command past the guard. Reproduced exactly because raising or
#: lowering it changes which payloads block.
MAX_INPUT_BYTES: Final[int] = 64 * 1024

#: Interpreters whose ``-c`` argument is scanned as a nested command.
#: ``guard.ts:9``.
SHELLS: Final[frozenset[str]] = frozenset({"sh", "bash", "zsh", "dash", "ksh"})

#: Wrappers that pass through to the command that follows them.
#: ``guard.ts:10``.
PREFIXES: Final[frozenset[str]] = frozenset({"command", "exec", "nohup"})

#: ``sudo`` options that take a separate value argument. ``guard.ts:11-14``.
SUDO_OPTIONS_WITH_VALUES: Final[frozenset[str]] = frozenset(
    {
        "-C",
        "-D",
        "-g",
        "-h",
        "-p",
        "-R",
        "-T",
        "-u",
        "--chdir",
        "--close-from",
        "--group",
        "--host",
        "--other-user",
        "--prompt",
        "--role",
        "--type",
        "--user",
    }
)

#: The refusal text handed back to the agent. ``guard.ts:15-16``, verbatim --
#: the agent reads its replacement out of this string, so it is a contract, not
#: a message.
BLOCK_REASON: Final[str] = (
    "Claude uses the direct openbrain-memory adapter; executable mcp2cli "
    "open-brain commands are blocked. qmd and other mcp2cli services remain "
    "allowed."
)

#: Tool names whose payload carries a shell command. ``guard.ts:37``.
_SHELL_TOOL_NAMES: Final[frozenset[str]] = frozenset({"Bash", "Shell"})

#: How deep nested-command scanning recurses. ``guard.ts:44``: `depth > 3`.
#: Structural: it terminates the recursion that ``$(...)``, ``eval``, and
#: ``sh -c`` would otherwise make unbounded.
_MAX_NESTING_DEPTH: Final[int] = 3

#: ``find`` primaries that run a command. ``guard.ts:125``.
_FIND_EXEC_PRIMARIES: Final[frozenset[str]] = frozenset(
    {"-exec", "-execdir", "-ok", "-okdir"}
)

#: ``env`` options taking a separate value. ``guard.ts:79``.
_ENV_OPTIONS_WITH_VALUES: Final[frozenset[str]] = frozenset(
    {"-u", "--unset", "-C", "--chdir"}
)

#: ``env`` options whose value is a whole nested command. ``guard.ts:83``.
_ENV_SPLIT_STRING_OPTIONS: Final[frozenset[str]] = frozenset({"-S", "--split-string"})

#: The retired CLI binary. ``guard.ts:447``.
_BLOCKED_EXECUTABLE: Final[str] = "mcp2cli"

#: The retired service argument. ``guard.ts:449``.
_BLOCKED_SERVICE: Final[str] = "open-brain"

_ASSIGNMENT: Final[re.Pattern[str]] = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*=")
_ASSIGNMENT_PARTS: Final[re.Pattern[str]] = re.compile(
    r"^([a-zA-Z_][a-zA-Z0-9_]*)=(.*)$", re.DOTALL
)
_BARE_VARIABLE: Final[re.Pattern[str]] = re.compile(r"^\$([a-zA-Z_][a-zA-Z0-9_]*)$")
_BRACED_VARIABLE: Final[re.Pattern[str]] = re.compile(
    r"^\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}$"
)
_VARIABLE_MENTION: Final[re.Pattern[str]] = re.compile(r"\$\{?[a-zA-Z_]")
_SHELL_COMMAND_FLAG: Final[re.Pattern[str]] = re.compile(r"^-[a-zA-Z]*c[a-zA-Z]*$")
_QUOTE_OR_EXPANSION: Final[re.Pattern[str]] = re.compile(r"[$`]")


def guard_claude_command(raw_input: bytes) -> str:
    """Decide the guard's stdout for one ``PreToolUse`` payload.

    Args:
        raw_input: The raw stdin bytes of the hook event.

    Returns:
        The JSON block response with a trailing newline when the payload
        invokes the blocked route, or an empty string to allow it.
    """
    if len(raw_input) > MAX_INPUT_BYTES:
        return _oversized_response(raw_input)
    try:
        parsed = json.loads(raw_input.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return ""
    if not _is_record(parsed):
        return ""
    if parsed.get("tool_name") not in _SHELL_TOOL_NAMES:
        return ""
    tool_input = parsed.get("tool_input")
    if not _is_record(tool_input):
        return ""
    command = tool_input.get("command")
    if not isinstance(command, str):
        return ""
    if not contains_forbidden_open_brain_command(command):
        return ""
    return _block_response()


def _oversized_response(raw_input: bytes) -> str:
    """Answer a payload too large to parse, without parsing it.

    The prefix is scanned for a top-level ``tool_name`` only. A payload that
    names a non-shell tool is allowed; anything else -- including one whose
    ``tool_name`` sits past the prefix -- is blocked, because the command
    cannot be inspected and waving it through would make oversizing the way
    around the guard. ``guard.ts:22-28``.

    Args:
        raw_input: The raw stdin bytes.

    Returns:
        An empty string to allow, or the block response.
    """
    prefix = raw_input[:MAX_INPUT_BYTES].decode("utf-8", errors="replace")
    tool_name = _top_level_string_property(prefix, "tool_name")
    if tool_name and tool_name not in _SHELL_TOOL_NAMES:
        return ""
    return _block_response()


def contains_forbidden_open_brain_command(command: str, depth: int = 0) -> bool:
    """Report whether ``command`` would execute the blocked route.

    Scans command substitutions first, then every segment, resolving simple
    variable assignments that a previous segment made in the same shell.

    Args:
        command: The shell command text.
        depth: Current nesting depth; recursion stops past
            ``_MAX_NESTING_DEPTH``.

    Returns:
        True when some part of the command invokes the blocked route.
    """
    if not command or len(command) > MAX_INPUT_BYTES or depth > _MAX_NESTING_DEPTH:
        return False
    for nested in executable_substitutions(command):
        if contains_forbidden_open_brain_command(nested, depth + 1):
            return True
    assignments: dict[str, str] = {}
    segment_is_in_pipeline = False
    for segment in tokenize_shell_detailed(command):
        if _segment_is_forbidden(segment, assignments, depth):
            return True
        if not segment_is_in_pipeline and segment.terminator not in ("|", "&"):
            _record_persistent_assignments(segment.tokens, assignments)
        segment_is_in_pipeline = segment.terminator == "|"
    return False


def _segment_is_forbidden(
    segment: Segment, assignments: dict[str, str], depth: int
) -> bool:
    """Check one segment both with and without assignment resolution.

    The unresolved pass matters: a variable the guard could not resolve still
    counts as dynamic, so ``$tool $service`` blocks even when nothing recorded
    a value for either. ``guard.ts:52-55``.

    Args:
        segment: The segment to inspect.
        assignments: Variable values recorded by earlier segments.
        depth: Current nesting depth.

    Returns:
        True when either reading of the segment invokes the blocked route.
    """
    values = [token.value for token in segment.tokens]
    resolved = [_resolve_assigned_token(token, assignments) for token in segment.tokens]
    assignments_resolved = resolved != values
    if _segment_invokes_open_brain(resolved, depth):
        return True
    return not assignments_resolved and _segment_invokes_open_brain(values, depth)


def _segment_invokes_open_brain(tokens: list[str], depth: int) -> bool:
    """Report whether a token list invokes the blocked route.

    Walks past leading assignments, ``env``, pass-through prefixes, and
    ``sudo`` to find the executable token, then checks it and the wrappers
    that carry a command in an argument. ``guard.ts:64-137``.

    Args:
        tokens: The segment's token values.
        depth: Current nesting depth.

    Returns:
        True when the segment invokes the blocked route.
    """
    index = 0
    while index < len(tokens) and _is_assignment(_at(tokens, index)):
        index += 1
    if _at(tokens, index) == "env":
        env_result = _skip_env_options(tokens, index + 1, depth)
        if isinstance(env_result, bool):
            return env_result
        index = env_result
    while _at(tokens, index) in PREFIXES:
        index += 1
        if _at(tokens, index) == "--":
            index += 1
    if _at(tokens, index) == "sudo":
        index = _skip_sudo_options(tokens, index + 1)
    executable_token = _at(tokens, index)
    executable = _basename(executable_token)
    if tokens_invoke_open_brain(executable_token, _at(tokens, index + 1)):
        return True
    return _wrapper_invokes_open_brain(executable, tokens, index, depth)


def _wrapper_invokes_open_brain(
    executable: str, tokens: list[str], index: int, depth: int
) -> bool:
    """Check the wrappers that carry a command in an argument.

    ``eval``, ``xargs``, ``find -exec``, and ``sh -c`` each run something the
    executable token alone does not reveal. ``guard.ts:115-135``.

    Args:
        executable: Basename of the executable token.
        tokens: The segment's token values.
        index: Index of the executable token.
        depth: Current nesting depth.

    Returns:
        True when the wrapped command invokes the blocked route.
    """
    if executable == "eval":
        nested = " ".join(tokens[index + 1 :])
        return bool(nested) and contains_forbidden_open_brain_command(nested, depth + 1)
    if executable == "xargs":
        for candidate in range(index + 1, len(tokens) - 1):
            if tokens_invoke_open_brain(tokens[candidate], tokens[candidate + 1]):
                return True
    if executable == "find":
        exec_index = next(
            (
                i
                for i, token in enumerate(tokens)
                if i > index and token in _FIND_EXEC_PRIMARIES
            ),
            -1,
        )
        if exec_index >= 0 and tokens_invoke_open_brain(
            _at(tokens, exec_index + 1), _at(tokens, exec_index + 2)
        ):
            return True
    if executable in SHELLS:
        command_flag = next(
            (
                i
                for i, token in enumerate(tokens)
                if i > index
                and (_SHELL_COMMAND_FLAG.match(token) or token == "--command")
            ),
            -1,
        )
        nested = tokens[command_flag + 1] if 0 <= command_flag < len(tokens) - 1 else ""
        if nested and contains_forbidden_open_brain_command(nested, depth + 1):
            return True
    return False


def _skip_env_options(tokens: list[str], index: int, depth: int) -> int | bool:
    """Advance past ``env`` options to the command it runs.

    Args:
        tokens: The segment's token values.
        index: Index just after the ``env`` token.
        depth: Current nesting depth.

    Returns:
        The index of the command token, or a bool verdict when ``env -S``
        supplied the whole command as one argument.
    """
    while index < len(tokens):
        token = _at(tokens, index)
        if _is_assignment(token):
            index += 1
            continue
        if token == "--":
            return index + 1
        if token in _ENV_OPTIONS_WITH_VALUES:
            index += 2
            continue
        if token in _ENV_SPLIT_STRING_OPTIONS:
            nested = tokens[index + 1] if index + 1 < len(tokens) else ""
            return bool(nested) and contains_forbidden_open_brain_command(
                nested, depth + 1
            )
        if token.startswith("-"):
            index += 1
            continue
        break
    return index


def _skip_sudo_options(tokens: list[str], index: int) -> int:
    """Advance past ``sudo`` options to the command it runs.

    Args:
        tokens: The segment's token values.
        index: Index just after the ``sudo`` token.

    Returns:
        The index of the command token.
    """
    while index < len(tokens):
        token = _at(tokens, index)
        if token == "--":
            return index + 1
        if not token.startswith("-"):
            break
        index += 2 if token in SUDO_OPTIONS_WITH_VALUES else 1
    return index


def tokens_invoke_open_brain(executable_token: str, first_argument: str) -> bool:
    """Report whether an executable/argument pair reaches the blocked route.

    A token that could expand at runtime counts as possibly matching, so
    ``$tool $service`` blocks even though neither word is literal. That is
    what makes the guard resistant to trivially indirecting around it.
    ``guard.ts:445-456``.

    Args:
        executable_token: The token in command position, path included.
        first_argument: The token directly after it.

    Returns:
        True when the pair invokes, or may invoke, the blocked route.
    """
    executable = _basename(executable_token)
    executable_is_cli = executable == _BLOCKED_EXECUTABLE
    executable_may_be_cli = executable_is_cli or _dynamic_token_mentions(
        executable_token, _BLOCKED_EXECUTABLE
    )
    argument_is_service = first_argument == _BLOCKED_SERVICE
    argument_may_be_service = (
        argument_is_service
        or _dynamic_token_mentions(first_argument, _BLOCKED_SERVICE)
        or (executable_may_be_cli and _is_dynamic_shell_token(first_argument))
    )
    return (
        (executable_may_be_cli and argument_may_be_service)
        or (_is_dynamic_shell_token(executable_token) and argument_is_service)
        or (
            _is_dynamic_shell_token(executable_token)
            and _is_dynamic_shell_token(first_argument)
        )
    )


def _resolve_assigned_token(token: Token, assignments: dict[str, str]) -> str:
    """Substitute a recorded value for a bare ``$name`` token.

    A token with any single-quoted part cannot expand, so its ``$`` and
    backtick characters are stripped instead -- that is what stops
    ``'$tool' '$service'`` from being read as an invocation.
    ``guard.ts:271-276``.

    Args:
        token: The token to resolve.
        assignments: Variable values recorded by earlier segments.

    Returns:
        The resolved token value.
    """
    if token.has_single_quoted_part:
        return _QUOTE_OR_EXPANSION.sub("", token.value)
    match = _BARE_VARIABLE.match(token.value) or _BRACED_VARIABLE.match(token.value)
    name = match.group(1) if match else None
    if name and name in assignments:
        return assignments[name]
    return token.value


def _record_persistent_assignments(
    tokens: tuple[Token, ...], assignments: dict[str, str]
) -> None:
    """Record assignments from a segment that is nothing but assignments.

    A segment that also runs a command sets those variables only for that
    command, so it is skipped. An empty or dynamic value forgets the variable
    rather than recording something the guard cannot reason about.
    ``guard.ts:278-288``.

    Args:
        tokens: The segment's tokens.
        assignments: The map to update in place.
    """
    if not tokens or not all(_is_assignment(token.value) for token in tokens):
        return
    for token in tokens:
        match = _ASSIGNMENT_PARTS.match(token.value)
        if not match:
            continue
        name, value = match.group(1), match.group(2)
        if not name:
            continue
        if not value or _is_dynamic_shell_token(value):
            assignments.pop(name, None)
        else:
            assignments[name] = value


def _dynamic_token_mentions(token: str, marker: str) -> bool:
    """Report whether a runtime-expanding token names ``marker``."""
    return _is_dynamic_shell_token(token) and marker in token


def _is_dynamic_shell_token(token: str) -> bool:
    """Report whether a token could expand to something else at runtime."""
    return "$(" in token or "`" in token or bool(_VARIABLE_MENTION.search(token))


def _is_assignment(token: str) -> bool:
    """Report whether a token is a ``NAME=value`` assignment."""
    return bool(_ASSIGNMENT.match(token))


def _basename(path: str) -> str:
    """Return the last ``/``-separated component of a token.

    ``os.path.basename`` is deliberately not used: it returns ``""`` for a
    trailing slash where ``guard.ts:462-465`` returns the empty final
    component, and the guard's verdicts are pinned to the latter.
    """
    return path.split("/")[-1]


def _at(tokens: list[str], index: int) -> str:
    """Return ``tokens[index]``, or ``""`` when the index is out of range.

    Mirrors the ``tokens[index] ?? ""`` idiom the TypeScript relies on; a
    Python ``IndexError`` there would change a verdict into a crash.
    """
    return tokens[index] if 0 <= index < len(tokens) else ""


def _block_response() -> str:
    """Build the refusal payload, byte-identical to ``guard.ts:290-292``."""
    payload = json.dumps(
        {"decision": "block", "reason": BLOCK_REASON}, separators=(",", ":")
    )
    return f"{payload}\n"


def _top_level_string_property(text: str, prop: str) -> str | None:
    """Find a top-level string property in possibly-invalid JSON text.

    Scans rather than parses, because the text is a prefix of an oversized
    payload and will not parse. ``guard.ts:294-322``.

    Args:
        text: The JSON prefix to scan.
        prop: The property name to find.

    Returns:
        The property's string value, or None when it is absent, nested, or
        not a string.
    """
    depth = 0
    index = 0
    while index < len(text):
        char = text[index]
        if char == "{":
            depth += 1
            index += 1
            continue
        if char == "}":
            depth -= 1
            index += 1
            continue
        if char != '"':
            index += 1
            continue
        token = _read_json_string(text, index)
        if token is None:
            return None
        if depth == 1:
            matched, value = _value_after_key(text, token, prop)
            if matched:
                return value
        index = token[1] + 1
    return None


def _value_after_key(
    text: str, token: tuple[str, int], prop: str
) -> tuple[bool, str | None]:
    """Read the value following a key token when the key matches ``prop``.

    The match flag is separate from the value because "this key was not the
    one" and "the key matched but its value is not a string" are different
    answers, and the second one stops the scan. ``guard.ts:309-317`` expresses
    the same split with an early ``return null``.

    Args:
        text: The JSON prefix being scanned.
        token: The ``(value, end_index)`` pair of the key just read.
        prop: The property name being sought.

    Returns:
        ``(False, None)`` when this key is not the one, otherwise ``(True,
        value)`` where value is the string or None when it is not a string.
    """
    value, end = token
    cursor = end + 1
    while cursor < len(text) and _is_json_space(text[cursor]):
        cursor += 1
    if cursor >= len(text) or text[cursor] != ":" or value != prop:
        return (False, None)
    cursor += 1
    while cursor < len(text) and _is_json_space(text[cursor]):
        cursor += 1
    if cursor >= len(text) or text[cursor] != '"':
        return (True, None)
    found = _read_json_string(text, cursor)
    return (True, found[0] if found else None)


def _read_json_string(text: str, start: int) -> tuple[str, int] | None:
    """Read one JSON string literal beginning at ``start``.

    Args:
        text: The JSON prefix being scanned.
        start: Index of the opening quote.

    Returns:
        The decoded value and the index of the closing quote, or None when the
        literal never closes or does not decode.
    """
    escaped = False
    for index in range(start + 1, len(text)):
        char = text[index]
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if char != '"':
            continue
        try:
            decoded = json.loads(text[start : index + 1])
        except ValueError:
            return None
        return (decoded, index) if isinstance(decoded, str) else None
    return None


def _is_json_space(char: str) -> bool:
    r"""Report whether a character is whitespace by JavaScript's ``\s``."""
    return bool(re.match(r"\s", char))


def _is_record(value: object) -> bool:
    """Report whether a decoded JSON value is a non-array object."""
    return isinstance(value, dict)
