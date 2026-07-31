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
    """Build one assistant transcript line -- not an operator turn."""
    return json.dumps({"type": "assistant", "uuid": uuid, "message": {"content": []}})


def write_lines(path: Path, lines: list[str]) -> None:
    """Write transcript lines, each newline-terminated, replacing the file."""
    path.write_text("".join(f"{line}\n" for line in lines), encoding="utf-8")


def append_lines(path: Path, lines: list[str]) -> None:
    """Append newline-terminated transcript lines to an existing file."""
    with path.open("a", encoding="utf-8") as handle:
        handle.write("".join(f"{line}\n" for line in lines))
