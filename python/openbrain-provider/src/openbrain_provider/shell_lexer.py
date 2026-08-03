"""Shell lexing primitives the guard reasons over.

Purpose:
    Break a shell command string into segments of tokens, and find the
    command substitutions inside it, closely enough that a guard can tell
    which token is the executable being invoked.

Architecture:
    Pure functions over a string. No I/O, no state, no knowledge of what is
    being guarded -- ``guard.py`` owns every policy decision and this module
    owns none. Ported byte-for-byte in behaviour from
    ``_ob/scripts/ob-memory-provider/guard.ts`` lines 139-269 and 346-435.

Pattern/Convention:
    This is deliberately NOT a shell parser and must not become one. It is a
    scanner sized for one question -- "which word is the command?" -- and its
    known gaps are part of the contract the TypeScript established: ``(`` and
    ``then`` are ordinary token characters, so ``( cmd )`` lexes with ``(``
    glued to ``cmd``. Recorded parity fixtures pin those gaps; closing one
    would change live enforcement behaviour, which is open-brain#451's
    decision to make and not this module's.

    ``shlex`` is the obvious library answer and was rejected on measurement,
    not on taste: ``shlex.split`` discards the segment terminators (``;``,
    ``|``, ``&``) the guard needs to scope variable assignments, drops the
    single-quoted-part provenance that decides whether ``$tool`` may expand,
    and raises on unbalanced quotes where the guard must fail open. Matching
    the recorded fixtures through it would mean re-deriving all three on top.

Example:
    >>> [s.terminator for s in tokenize_shell_detailed("a; b | c")]
    [';', '|', None]
    >>> [t.value for t in tokenize_shell_detailed("echo 'a b'")[0].tokens]
    ['echo', 'a b']

See Also:
    - ``guard.py`` - the policy that consumes these tokens
    - ``_ob/scripts/ob-memory-provider/guard.ts`` - the source of truth ported
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Final

#: Escapes ``$'...'`` (ANSI-C quoting) understands as a single character.
#: Mirrors the map at ``guard.ts:357-361``.
_ANSI_C_SIMPLE_ESCAPES: Final[dict[str, str]] = {
    "a": "\x07",
    "b": "\b",
    "e": "\x1b",
    "f": "\f",
    "n": "\n",
    "r": "\r",
    "t": "\t",
    "v": "\v",
    "\\": "\\",
    "'": "'",
    '"': '"',
}

#: Digit width per numeric ``$'...'`` escape prefix. ``guard.ts:367``.
_ANSI_C_HEX_WIDTHS: Final[dict[str, int]] = {"x": 2, "u": 4, "U": 8}

#: Highest code point ``String.fromCodePoint`` accepts. ``guard.ts:372``.
#: A Unicode fact, not a policy choice: this is the end of the code space.
_MAX_CODE_POINT: Final[int] = 0x10FFFF

_HEX_DIGITS: Final[re.Pattern[str]] = re.compile(r"^[a-fA-F0-9]+$")
_OCTAL_RUN: Final[re.Pattern[str]] = re.compile(r"^[0-7]{1,3}")
_WHITESPACE: Final[re.Pattern[str]] = re.compile(r"\s")

#: Characters that end a segment. ``guard.ts:259``.
_SEGMENT_TERMINATORS: Final[frozenset[str]] = frozenset({";", "|", "&"})


@dataclass(frozen=True)
class Token:
    """One shell word, with whether any part of it was single-quoted.

    Attributes:
        value: The word with quoting removed.
        has_single_quoted_part: True when any character came from inside
            ``'...'`` or ``$'...'``. The guard uses this to decide that a
            ``$name`` inside the word could not have expanded.
    """

    value: str
    has_single_quoted_part: bool


@dataclass(frozen=True)
class Segment:
    r"""One run of tokens up to a separator.

    Attributes:
        tokens: The words in this segment, in order.
        terminator: The separator that ended it (``;``, ``|``, ``||``, ``&``,
            ``&&``, ``\n``), or None at end of input.
    """

    tokens: tuple[Token, ...]
    terminator: str | None


@dataclass(frozen=True)
class _Span:
    """A parsed sub-string and the index of its final character."""

    value: str
    end: int


def read_ansi_c_string(command: str, start: int) -> _Span | None:
    """Read a ``$'...'`` ANSI-C quoted string starting at ``start``.

    Args:
        command: The full command text.
        start: Index of the ``$``.

    Returns:
        The decoded value and the index of the closing quote, or None when
        the string is never closed.
    """
    value = ""
    index = start + 2
    while index < len(command):
        char = command[index]
        if char == "'":
            return _Span(value, index)
        if char != "\\":
            value += char
            index += 1
            continue
        if index + 1 >= len(command):
            return None
        escaped = command[index + 1]
        simple = _ANSI_C_SIMPLE_ESCAPES.get(escaped)
        if simple is not None:
            value += simple
            index += 2
            continue
        decoded = _read_numeric_escape(command, index, escaped)
        if decoded is not None:
            value += decoded.value
            index = decoded.end
            continue
        value += escaped
        index += 2
    return None


def _read_numeric_escape(command: str, index: int, escaped: str) -> _Span | None:
    r"""Decode a ``\xNN``/``\uNNNN``/``\UNNNNNNNN``/``\NNN`` escape.

    Args:
        command: The full command text.
        index: Index of the backslash.
        escaped: The character directly after the backslash.

    Returns:
        The decoded text and the next index to scan, or None when this is not
        a numeric escape.
    """
    width = _ANSI_C_HEX_WIDTHS.get(escaped, 0)
    if width:
        digits = command[index + 2 : index + 2 + width]
        if len(digits) == width and _HEX_DIGITS.match(digits):
            code_point = int(digits, 16)
            # `String.fromCodePoint` throws above this and guard.ts lets the
            # throw escape into its outer catch; the value is simply dropped.
            text = chr(code_point) if code_point <= _MAX_CODE_POINT else ""
            return _Span(text, index + width + 2)
        return None
    if escaped in "01234567":
        match = _OCTAL_RUN.match(command[index + 1 :])
        digits = match.group(0) if match else escaped
        return _Span(chr(int(digits, 8)), index + 1 + len(digits))
    return None


def read_command_substitution(command: str, start: int) -> _Span | None:
    """Read a ``$(...)`` substitution starting at ``start``.

    Args:
        command: The full command text.
        start: Index of the ``$``.

    Returns:
        The whole ``$(...)`` text and the index of its closing paren, or None
        when it is never closed.
    """
    depth = 1
    quote: str | None = None
    escaped = False
    for index in range(start + 2, len(command)):
        char = command[index]
        if escaped:
            escaped = False
            continue
        if char == "\\" and quote != "'":
            escaped = True
            continue
        if quote:
            if char == quote:
                quote = None
            continue
        if char in ("'", '"'):
            quote = char
            continue
        if char == "(":
            depth += 1
        if char == ")":
            depth -= 1
            if depth == 0:
                return _Span(command[start : index + 1], index)
    return None


def read_backtick_substitution(command: str, start: int) -> _Span | None:
    """Read a `` `...` `` substitution starting at ``start``.

    Args:
        command: The full command text.
        start: Index of the opening backtick.

    Returns:
        The whole backtick text and the index of the closing backtick, or None
        when it is never closed.
    """
    escaped = False
    for index in range(start + 1, len(command)):
        char = command[index]
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if char == "`":
            return _Span(command[start : index + 1], index)
    return None


def executable_substitutions(command: str) -> list[str]:
    """Collect the bodies of substitutions that would actually execute.

    A substitution inside single quotes is literal text and is skipped, which
    is what keeps ``echo '$(...)'`` from being treated as an invocation.

    Args:
        command: The full command text.

    Returns:
        The inner text of each executing ``$(...)`` and `` `...` ``, in order.
    """
    nested: list[str] = []
    quote: str | None = None
    escaped = False
    index = 0
    while index < len(command):
        char = command[index]
        if escaped:
            escaped = False
            index += 1
            continue
        if char == "\\" and quote != "'":
            escaped = True
            index += 1
            continue
        if quote == "'":
            if char == "'":
                quote = None
            index += 1
            continue
        if char == "'":
            quote = "'"
            index += 1
            continue
        if char == '"':
            quote = None if quote == '"' else '"'
            index += 1
            continue
        if char == "$" and command[index + 1 : index + 2] == "(":
            parsed = read_command_substitution(command, index)
            if parsed:
                nested.append(command[index + 2 : parsed.end])
                index = parsed.end
            index += 1
            continue
        if char == "`":
            parsed = read_backtick_substitution(command, index)
            if parsed:
                nested.append(command[index + 1 : parsed.end])
                index = parsed.end
        index += 1
    return nested


class _SegmentAccumulator:
    """Builds tokens and segments as the scanner walks the command.

    Split out because the scanner loop would otherwise carry five mutable
    locals through every branch, which is how a token gets flushed on one path
    and forgotten on another.
    """

    def __init__(self) -> None:
        """Start with no tokens and no completed segments."""
        self.segments: list[Segment] = []
        self._tokens: list[Token] = []
        self._token = ""
        self._token_has_single_quoted_part = False

    def add(self, text: str, *, single_quoted: bool = False) -> None:
        """Append text to the token under construction."""
        self._token += text
        if single_quoted:
            self._token_has_single_quoted_part = True

    def mark_single_quoted(self) -> None:
        """Record that this token touched a single-quoted region."""
        self._token_has_single_quoted_part = True

    @property
    def token_is_empty(self) -> bool:
        """True when no characters have been added to the current token."""
        return not self._token

    def finish_token(self) -> None:
        """Close the current token, discarding it when it is empty."""
        if self._token:
            self._tokens.append(Token(self._token, self._token_has_single_quoted_part))
        self._token = ""
        self._token_has_single_quoted_part = False

    def finish_segment(self, terminator: str | None) -> None:
        """Close the current token and segment, discarding an empty segment."""
        self.finish_token()
        if self._tokens:
            self.segments.append(Segment(tuple(self._tokens), terminator))
        self._tokens = []


def tokenize_shell_detailed(command: str) -> list[Segment]:
    """Split a command into segments of tokens.

    Quotes are removed, ``$'...'``/``$(...)``/`` `...` `` are folded into the
    surrounding token, comments run to end of line, and ``;``/``|``/``&`` (and
    their doubled forms) end a segment.

    Args:
        command: The full command text.

    Returns:
        The segments in order. Empty segments are dropped.
    """
    state = _SegmentAccumulator()
    quote: str | None = None
    escaped = False
    index = 0
    while index < len(command):
        char = command[index]
        if escaped:
            state.add(char)
            escaped = False
            index += 1
            continue
        if char == "\\" and quote != "'":
            escaped = True
            index += 1
            continue
        if quote:
            if char == quote:
                quote = None
            else:
                state.add(char, single_quoted=quote == "'")
            index += 1
            continue
        consumed = _consume_expansion(command, index, state)
        if consumed is not None:
            index = consumed
            continue
        if char in ("'", '"'):
            quote = char
            if char == "'":
                state.mark_single_quoted()
            index += 1
            continue
        if char == "#" and state.token_is_empty:
            while index < len(command) and command[index] != "\n":
                index += 1
            state.finish_segment("\n")
            index += 1
            continue
        if _WHITESPACE.match(char):
            if char == "\n":
                state.finish_segment("\n")
            else:
                state.finish_token()
            index += 1
            continue
        if char in _SEGMENT_TERMINATORS:
            doubled = command[index + 1 : index + 2] == char and char != ";"
            state.finish_segment(f"{char}{char}" if doubled else char)
            index += 2 if doubled else 1
            continue
        state.add(char)
        index += 1
    state.finish_segment(None)
    return state.segments


def _consume_expansion(
    command: str, index: int, state: _SegmentAccumulator
) -> int | None:
    """Fold a ``$'...'``, ``$(...)``, or `` `...` `` span into the token.

    Args:
        command: The full command text.
        index: Index of the character starting the span.
        state: The accumulator to append the span's text to.

    Returns:
        The next index to scan, or None when nothing was consumed.
    """
    char = command[index]
    following = command[index + 1 : index + 2]
    if char == "$" and following == "'":
        parsed = read_ansi_c_string(command, index)
        if parsed:
            state.add(parsed.value)
            return parsed.end + 1
    if char == "$" and following == "(":
        parsed = read_command_substitution(command, index)
        if parsed:
            state.add(parsed.value)
            return parsed.end + 1
    if char == "`":
        parsed = read_backtick_substitution(command, index)
        if parsed:
            state.add(parsed.value)
            return parsed.end + 1
    return None
