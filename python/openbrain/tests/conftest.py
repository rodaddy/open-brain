"""Shared capture-test building blocks: recording lanes and transcript writers.

Two test files exercise the spine -- ``test_capture_deliver`` at the composition
boundary and ``test_capture_hooks`` at the entrypoint boundary -- and both need
a lane that records what it was handed, a lane that always fails, and helpers to
write transcript lines in the shape Claude Code actually writes.

They live HERE, in ``conftest.py``, rather than in one test file the other
imports: a test module importing another test module is the fork the plan names
(``_plans/python-port-sequence.md``, step 8). pytest makes conftest symbols
importable from every test package without that coupling.

The ``RawLane`` these satisfy is ``deliver.RawLane`` -- the one call the spine
needs from ``openbrain_memory.AgentMemory``. A recorder proves order and payload
shape; only the ``-m live`` tests prove a write survives Postgres.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from pathlib import Path

#: The timestamp every helper line carries. Real transcripts always set one, and
#: the server orders a session by it; a fixed value keeps assertions stable.
TIMESTAMP = "2026-07-31T06:00:00.000Z"


class LaneUnreachableError(RuntimeError):
    """The send failed outright -- server gone, spool broken."""


@dataclass
class RecordingLane:
    """A ``RawLane`` that remembers every batch it was handed."""

    batches: list[list[dict[str, Any]]] = field(default_factory=list)

    def ingest_raw_turns(self, turns: Any) -> object:
        self.batches.append([dict(turn) for turn in turns])
        return {"ingested": len(self.batches[-1])}

    @property
    def turns(self) -> list[dict[str, Any]]:
        return [turn for batch in self.batches for turn in batch]


@dataclass
class UnreachableLane:
    """A ``RawLane`` that raises :class:`LaneUnreachableError` on every send."""

    calls: int = 0

    def ingest_raw_turns(self, turns: Any) -> object:
        self.calls += 1
        raise LaneUnreachableError


class BatchTooLargeError(RuntimeError):
    """A send exceeded what the server's Zod validator accepts in one call.

    Stands in for the real ``ingest_raw_turn`` rejection: the request schema
    declares ``turns`` as an array the server refuses above ``MAX_BATCH`` (100,
    ``src/tools/ingest-raw-turn.ts``). A recorder that never crossed that bound
    was green against a fake the real server would have refused (gotcha #275),
    so this lane enforces the same bound the server does.
    """


@dataclass
class BoundedRecordingLane:
    """A ``RawLane`` that records batches but rejects one larger than the server.

    Attributes:
        accepts: The most turns one call may carry, matching the server's own
            ``MAX_BATCH``. A call over it raises :class:`BatchTooLargeError`
            before recording anything, exactly as the server rejects the whole
            batch before writing a row.
    """

    accepts: int = 100
    batches: list[list[dict[str, Any]]] = field(default_factory=list)

    def ingest_raw_turns(self, turns: Any) -> object:
        batch = [dict(turn) for turn in turns]
        if len(batch) > self.accepts:
            raise BatchTooLargeError
        self.batches.append(batch)
        return {"ingested": len(batch)}

    @property
    def turns(self) -> list[dict[str, Any]]:
        return [turn for batch in self.batches for turn in batch]


@dataclass
class FailAfterNBatchesLane:
    """A ``RawLane`` that takes the first ``fail_on`` batches, then raises.

    Proves a mid-delivery failure never advances the watermark past turns that
    did not land: the send is split into successive calls, and if a later call
    raises, the whole region must re-read next time.

    Attributes:
        fail_on: The 1-based call number that raises. Earlier calls record.
    """

    fail_on: int = 2
    batches: list[list[dict[str, Any]]] = field(default_factory=list)

    def ingest_raw_turns(self, turns: Any) -> object:
        self.batches.append([dict(turn) for turn in turns])
        if len(self.batches) >= self.fail_on:
            raise LaneUnreachableError
        return {"ingested": len(self.batches[-1])}


@dataclass
class ClosingRecorder:
    """A ``RawLane`` whose close is observable -- proves ``run_stop`` releases it.

    ``run_stop`` builds a :class:`~openbrain.apps.hooks.session.StartedLane` and
    frees its session slot in a ``finally``. A test recorder is content only; the
    slot it stands in for is a server resource, so it records that close was
    called on both the success and the failure path.
    """

    batches: list[list[dict[str, Any]]] = field(default_factory=list)
    closed: int = 0
    fail: bool = False

    def ingest_raw_turns(self, turns: Any) -> object:
        self.batches.append([dict(turn) for turn in turns])
        if self.fail:
            raise LaneUnreachableError
        return {"ingested": len(self.batches[-1])}

    def close(self) -> None:
        self.closed += 1


@dataclass
class CanonPackReader:
    """A canon factory stand-in: records the settings it was asked for, returns a pack.

    ``run_session_start`` takes a ``canon_factory`` that reads
    ``agent_context_pack`` and returns a
    :class:`~openbrain.apps.hooks.session.CanonContext`. This recorder captures
    the :class:`CanonSettings` handed to it -- so a test can assert exactly which
    sections and scope were requested -- and hands back a fixed pack plus an
    observable close, without building a client or reaching a server.

    Attributes:
        pack: The payload to return as the assembled canon.
        requested: Every settings object the factory was called with, in order.
        closed: How many times the returned slot closer was called.
        fail: When true, raise :class:`LaneUnreachableError` instead of returning
            -- the unreachable-brain path.
    """

    pack: Any = field(default_factory=lambda: {"sections": {}})
    requested: list[Any] = field(default_factory=list)
    closed: int = 0
    fail: bool = False

    def __call__(self, settings: Any) -> Any:
        from openbrain.apps.hooks.session import CanonContext

        self.requested.append(settings)
        if self.fail:
            raise LaneUnreachableError
        return CanonContext(pack=self.pack, close=self._close)

    def _close(self) -> None:
        self.closed += 1


def operator_line(
    uuid: str, content: str, *, session: str = "s1", timestamp: str = TIMESTAMP
) -> str:
    """Build one transcript line in the shape Claude Code actually writes."""
    return json.dumps(
        {
            "type": "user",
            "uuid": uuid,
            "promptSource": "typed",
            "sessionId": session,
            "cwd": "/repo",
            "parentUuid": None,
            "timestamp": timestamp,
            "message": {"role": "user", "content": content},
        }
    )


def assistant_line(uuid: str) -> str:
    """Build one assistant line that SAID NOTHING -- no text blocks at all.

    Still not a captured turn after #447 restored the agent side, and for a
    reason worth keeping distinct: it is declined for holding no spoken text,
    NOT for being the assistant. Use :func:`assistant_says` for a reply that
    actually speaks.
    """
    return json.dumps({"type": "assistant", "uuid": uuid, "message": {"content": []}})


def assistant_says(
    uuid: str,
    *blocks: dict[str, Any],
    session: str = "s1",
    timestamp: str = TIMESTAMP,
) -> str:
    """Build one assistant line carrying the given content blocks (#447).

    The assistant's half is ALWAYS the list shape -- measured 2026-08-03 across
    134 live assistant records, none of which used a bare string -- so blocks are
    passed through exactly as the transcript writes them and callers build the
    mix they mean to test (``text``, ``tool_use``, ``thinking``).
    """
    return json.dumps(
        {
            "type": "assistant",
            "uuid": uuid,
            "sessionId": session,
            "cwd": "/repo",
            "parentUuid": None,
            "timestamp": timestamp,
            "message": {"role": "assistant", "content": list(blocks)},
        }
    )


def text_block(text: str) -> dict[str, Any]:
    """An assistant ``text`` block -- words that appeared on screen."""
    return {"type": "text", "text": text}


def thinking_block(text: str) -> dict[str, Any]:
    """An assistant ``thinking`` block -- chain-of-thought, never stored."""
    return {"type": "thinking", "thinking": text}


#: A value placed inside a `tool_use` block's ARGUMENTS that must never persist.
#:
#: Distinct from the tool NAME and from the argument KEY, because those three can
#: leak independently. An earlier version of the leak assertions checked the name
#: and the key only, so a parser that persisted just the argument VALUE would
#: have passed -- the reviewer's finding, 2026-08-03. A unique sentinel makes the
#: value itself assertable.
TOOL_ARGUMENT_SENTINEL = "ToolArgumentValueMustNotPersist"


def tool_use_block(name: str) -> dict[str, Any]:
    """An assistant ``tool_use`` block -- machinery, left to the open question.

    Carries a NON-EMPTY argument holding :data:`TOOL_ARGUMENT_SENTINEL`, so a
    test can assert the absence of the name, the key, AND the value. An empty
    ``input`` would make the strongest of those three assertions unprovable.
    """
    return {
        "type": "tool_use",
        "name": name,
        "input": {"command": TOOL_ARGUMENT_SENTINEL},
    }


def write_lines(path: Path, lines: list[str]) -> None:
    """Write transcript lines, each newline-terminated, replacing the file."""
    path.write_text("".join(f"{line}\n" for line in lines), encoding="utf-8")


def append_lines(path: Path, lines: list[str]) -> None:
    """Append newline-terminated transcript lines to an existing file."""
    with path.open("a", encoding="utf-8") as handle:
        handle.write("".join(f"{line}\n" for line in lines))
