"""Stage a giant file, then yield each turn to the raw lane -- loudly.

THE BULK SPINE. Composition only: the format adapter parses each line, the
staging store rejiggers the whole file into ordered ``RawTurn`` rows, and the
sibling package (``openbrain_memory``) writes. This module owns the operator
loop the live adapter deliberately does not have -- resume, retry, quarantine --
and it owns it LOUDLY, because a person runs it and can act on what it reports.

Non-goals: this module does not parse a line's shape (that is ``formats``), does
not own the staging SQL (that is ``staging``), and does not construct the client
(that is ``run``). Writes go ONLY through :class:`BulkLane`, a TYPE of the
existing ``AgentMemory.ingest_raw_turns`` write path, never a second
implementation of it (`_plans/python-port-sequence.md` §THE WRITE PATH ALREADY
EXISTS). It never touches the live adapter's watermark or hook path.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping, Sequence
from pathlib import Path
from typing import Any, Protocol

from pydantic import BaseModel, ConfigDict

from openbrain.apps.bulk.formats import (
    InputFormat,
    LineAdapter,
    MalformedCodexRecordError,
    adapter_for,
)
from openbrain.apps.bulk.staging import StagingStore
from openbrain.models.turn import RawTurn


class BulkLane(Protocol):
    """The single call the bulk spine needs from ``openbrain_memory.AgentMemory``.

    A Protocol rather than the class itself, so tests hand in a fake client and
    ``run`` hands in the real one, with mypy holding both to the same shape. This
    is a TYPE of the existing raw-lane write path, identical to
    ``deliver.RawLane`` -- not a second write implementation.
    """

    def ingest_raw_turns(self, turns: Sequence[Mapping[str, Any]]) -> object:
        """Full-send a batch of raw turns; the server owns every judgment."""
        ...


class StageResult(BaseModel):
    """What staging a file produced.

    Attributes:
        staged: Turns this call added to the staging store.
        input_format: The format the file was parsed under.
    """

    model_config = ConfigDict(frozen=True)

    staged: int
    input_format: InputFormat


class IngestResult(BaseModel):
    """What one ingest run delivered.

    Attributes:
        sent: Turns delivered to the raw lane and marked sent this run.
        quarantined: Turns the server rejected and this run set aside.
    """

    model_config = ConfigDict(frozen=True)

    sent: int
    quarantined: int


def stage_file(
    path: Path, input_format: InputFormat, store: StagingStore
) -> StageResult:
    """Read a whole session file and rejigger every turn into the staging store.

    Args:
        path: The giant session file. Read WHOLE -- the bulk signature, and the
            reason staging exists (holding a 27 MB parse in memory peaked at
            +90 MB RSS).
        input_format: Which format adapter to key on. An unbuilt format's adapter
            raises :class:`~openbrain.apps.bulk.formats.FormatNotImplementedError`
            on the first line, so selection is loud.
        store: Where the parsed turns are staged, in file order.

    Returns:
        A :class:`StageResult`.

    Every line is passed to the format adapter; a line that is not a turn is
    declined (``None``) exactly as the live path declines it, and never dropped
    for its size. Content is carried whole into the store.
    """
    adapter = adapter_for(input_format)
    staged = store.stage(_parsed_turns(path, adapter))
    return StageResult(staged=staged, input_format=input_format)


def ingest(store: StagingStore, lane: BulkLane) -> IngestResult:
    """Yield each staged, unsent turn to the raw lane; resume, and quarantine.

    Args:
        store: The staging store holding the rejiggered file. Only turns not
            already marked sent are attempted, so a re-run RESUMES rather than
            re-sends -- the operator's interrupted-run recovery.
        lane: The raw-lane write path (the real ``AgentMemory`` in production, a
            fake in tests).

    Returns:
        An :class:`IngestResult` counting what this run delivered and set aside.

    A turn the lane REJECTS is quarantined with its error class -- not dropped,
    not retried forever -- and the run continues to the next turn. That is the
    operator contract: loud, resumable, and nothing lost. A turn that IS sent is
    marked, so the same turn is never delivered twice across runs (and the
    server's ``UNIQUE(namespace, turn_uuid)`` dedupe is the second line of that
    defence, not the first).
    """
    return _drive(store, lane)


def _drive(store: StagingStore, lane: BulkLane) -> IngestResult:
    """Send every pending turn one at a time, marking or quarantining each.

    One turn per send, not a batch, because the operator failure mode is
    per-turn: a single rejected turn is quarantined and the rest still land,
    where a batched send would fail the whole remainder on one bad row.
    """
    sent = 0
    quarantined = 0
    for turn in store.pending():
        outcome = _send_one(store, lane, turn)
        sent += outcome
        quarantined += 1 - outcome
    return IngestResult(sent=sent, quarantined=quarantined)


def _send_one(store: StagingStore, lane: BulkLane, turn: RawTurn) -> int:
    """Deliver one turn; mark it sent, or quarantine it and carry on.

    Returns:
        ``1`` when the turn reached the lane, ``0`` when it was quarantined --
        so the caller sums outcomes without a second branch.

    The turn is sent WHOLE: ``model_dump`` with ``exclude_none`` produces the
    same payload the live spine sends, plus the per-invocation ``turn_index`` the
    server treats as a counter and recomputes real order from ``occurred_at``
    (`src/tools/ingest-raw-turn.ts`). Nothing here shortens it.
    """
    payload = [{**turn.model_dump(exclude_none=True), "turn_index": 0}]
    try:
        lane.ingest_raw_turns(payload)
    except Exception as error:  # noqa: BLE001 -- quarantine any lane rejection, loudly
        # Content-free BY CONSTRUCTION: only the error CLASS name is recorded,
        # never the exception object, so no turn text or token reaches the
        # quarantine store -- the same discipline the live swallow keeps.
        store.quarantine(turn, type(error).__name__)
        return 0
    store.mark_sent(turn.turn_uuid)
    return 1


def _parsed_turns(path: Path, adapter: LineAdapter) -> Iterator[RawTurn]:
    """Yield each ``RawTurn`` a format adapter finds in a file, in file order.

    The file is read line by line so the WHOLE file is walked without loading it
    as one string; each line goes to the adapter, and a line that is not a turn
    is declined. This is the generator ``stage_file`` streams into the store, so
    the parse is never fully resident as Python objects.
    """
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line_number, line in enumerate(handle, start=1):
            try:
                turn = adapter(line)
            except MalformedCodexRecordError as error:
                location = f"{path}:{line_number}"
                raise MalformedCodexRecordError(
                    error.record, error.fields, location
                ) from error
            if turn is not None:
                yield turn
