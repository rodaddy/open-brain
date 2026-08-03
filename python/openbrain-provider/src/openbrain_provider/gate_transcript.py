"""Read two facts out of a session transcript: token pressure, and did-work.

Both are read from the TAIL of the file. A transcript is append-only and can be
tens of megabytes; the gate runs on the agent's critical path, so it seeks to
the end rather than reading the whole file. The read sizes below are I/O sizes,
not bounds on content — nothing here shortens, stores, or rewrites a transcript.

What this module does NOT do: it does not capture, store, or forward anything
from the transcript. It returns a number and a boolean.
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Final

from .receipt_state import parse_iso

__all__ = ["read_context_tokens", "turn_did_work"]

#: How much of the tail to read when looking for the latest usage record.
#: context-budget-gate.ts:442.
_TOKEN_SCAN_BYTES: Final[int] = 2 * 1024 * 1024

#: How much of the tail to read when looking for work in the current turn.
#: context-budget-gate.ts:411.
_WORK_SCAN_BYTES: Final[int] = 512 * 1024

#: context-budget-gate.ts:422 — the timestamp field on a transcript record.
_TIMESTAMP_PATTERN: Final[re.Pattern[str]] = re.compile(r'"timestamp":"([^"]+)"')

#: context-budget-gate.ts:424-428. Mutating tool activity, and the git commands
#: that constitute work even though Bash itself is not a mutating tool.
_TOOL_EVENT_PATTERN: Final[re.Pattern[str]] = re.compile(r'"(tool_use|tool_result)"')
_MUTATING_TOOL_PATTERN: Final[re.Pattern[str]] = re.compile(
    r'"(Edit|Write|NotebookEdit|Task|Agent)"'
)
_ERROR_PATTERN: Final[re.Pattern[str]] = re.compile(r'"is_error":true')
_BASH_PATTERN: Final[re.Pattern[str]] = re.compile(r'"Bash"')
_GIT_WORK_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"(git commit|git push|gh pr create|gh pr merge)"
)


def _read_tail_lines(path: Path, scan_bytes: int) -> list[str]:
    """Read the last ``scan_bytes`` of a file and split it into lines.

    Args:
        path: Transcript file.
        scan_bytes: How many trailing bytes to read.

    Returns:
        The decoded lines. The first line may be a partial record, which every
        caller tolerates: a partial line simply fails to parse and is skipped.
    """
    with path.open("rb") as handle:
        size = handle.seek(0, 2)
        handle.seek(max(0, size - scan_bytes))
        payload = handle.read()
    return payload.decode("utf8", errors="replace").split("\n")


def _usage_tokens(line: str) -> int | None:
    """Return the total context tokens a transcript line reports, or None.

    Cache reads and cache creation are added to input tokens, because all three
    occupy the context window. Counting only `input_tokens` under-reports a
    cached session by the size of its cache, which is most of it.

    Args:
        line: One transcript line.

    Returns:
        The token total, or None when the line carries no usable usage record.
    """
    if '"usage"' not in line or '"isSidechain":true' in line:
        return None
    try:
        entry = json.loads(line)
    except json.JSONDecodeError:
        return None
    if not isinstance(entry, dict) or entry.get("isSidechain"):
        return None
    message = entry.get("message")
    if not isinstance(message, dict):
        return None
    usage = message.get("usage")
    if not isinstance(usage, dict):
        return None
    input_tokens = usage.get("input_tokens")
    if not isinstance(input_tokens, int) or isinstance(input_tokens, bool):
        return None
    total = input_tokens
    for key in ("cache_read_input_tokens", "cache_creation_input_tokens"):
        value = usage.get(key)
        if isinstance(value, int) and not isinstance(value, bool):
            total += value
    return total


def read_context_tokens(transcript_path: str) -> int:
    """Return the newest reported context-token total, or 0.

    Args:
        transcript_path: The hook's reported transcript path.

    Returns:
        The most recent usage total, or 0 when the file is absent, unreadable,
        or carries no usage record in the scanned tail. Zero is "unknown", and
        the caller treats it as such by not overwriting a known value with it.
    """
    if not transcript_path:
        return 0
    path = Path(transcript_path)
    try:
        if not path.is_file():
            return 0
        lines = _read_tail_lines(path, _TOKEN_SCAN_BYTES)
    except OSError:
        return 0
    for line in reversed(lines):
        tokens = _usage_tokens(line)
        if tokens is not None:
            return tokens
    return 0


def _latest_user_boundary(lines: list[str]) -> int:
    """Return the index of the most recent real operator turn.

    Sidechain records are subagent traffic, not the operator, so they do not
    open a turn.

    Args:
        lines: Transcript lines.

    Returns:
        The index, or 0 when no boundary is found in the scanned tail.
    """
    for index in range(len(lines) - 1, -1, -1):
        line = lines[index]
        if '"type":"user"' in line and '"isSidechain":true' not in line:
            return index
    return 0


def _is_work_line(line: str, last_write: datetime | None) -> bool:
    """Report whether one line records work worth capturing.

    Args:
        line: One transcript line.
        last_write: When this session last wrote durably, or None.

    Returns:
        True for a successful mutating tool call, or a git/gh command that lands
        work. A record at or before ``last_write`` is not new work — it was
        already captured.
    """
    if not line:
        return False
    match = _TIMESTAMP_PATTERN.search(line)
    if match and last_write is not None:
        recorded = parse_iso(match.group(1))
        if recorded is not None and recorded <= last_write:
            return False
    tool_work = (
        _TOOL_EVENT_PATTERN.search(line) is not None
        and _MUTATING_TOOL_PATTERN.search(line) is not None
        and _ERROR_PATTERN.search(line) is None
    )
    git_work = (
        _BASH_PATTERN.search(line) is not None
        and _GIT_WORK_PATTERN.search(line) is not None
    )
    return tool_work or git_work


def turn_did_work(transcript_path: str, last_write_at: str) -> bool:
    """Report whether the current turn landed uncaptured work.

    Args:
        transcript_path: The hook's reported transcript path.
        last_write_at: When this session last wrote durably, ISO-8601 or empty.

    Returns:
        True when work happened since the last operator boundary and since the
        last durable write. False on any read failure — an unreadable transcript
        must not arm a block the operator cannot clear.
    """
    if not transcript_path:
        return False
    path = Path(transcript_path)
    try:
        if not path.is_file():
            return False
        lines = _read_tail_lines(path, _WORK_SCAN_BYTES)
    except OSError:
        return False
    boundary = _latest_user_boundary(lines)
    last_write = parse_iso(last_write_at) if last_write_at else None
    return any(_is_work_line(line, last_write) for line in lines[boundary:])
