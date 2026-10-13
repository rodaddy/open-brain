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
from functools import partial
from pathlib import Path
from typing import Any, Protocol

from pydantic import BaseModel, ConfigDict

from openbrain.apps.bulk.formats import (
    InputFormat,
    LineAdapter,
    MalformedCodexRecordError,
    MalformedHermesRecordError,
    adapter_for,
    codex_raw_turn_from_line,
    codex_session_ref_if_present,
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

    def ingest_raw_turns(self, turns: Sequence[Mapping[str, Any]]) -> Mapping[str, Any]:
        """Full-send a batch of raw turns; the server owns every judgment."""
        ...


class RawIngestReceiptError(ValueError):
    """The server result cannot prove one durable raw-turn outcome."""

    _MESSAGES = {
        "counts": "raw ingest receipt is missing integer result counts",
        "accounting": "raw ingest receipt does not account for one turn",
        "namespace": "raw ingest receipt namespace mismatch",
        "filtered": "raw ingest receipt filtered the eligible turn",
    }

    def __init__(self, reason: str) -> None:
        """Build a fixed content-free diagnostic for one validation branch."""
        super().__init__(self._MESSAGES[reason])


class ServerFilteredTurnError(RawIngestReceiptError):
    """The server deliberately filtered an otherwise eligible parsed turn."""

    def __init__(self) -> None:
        """Build the fixed content-free filtered receipt diagnostic."""
        super().__init__("filtered")


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
    duplicates: int = 0
    filtered: int = 0
    quarantined: int
    namespace: str | None = None


def stage_file(
    path: Path, input_format: InputFormat, store: StagingStore
) -> StageResult:
    """Read a whole session file and rejigger every turn into the staging store.

    Args:
        path: The giant session file. Read WHOLE -- the bulk signature, and the
            reason staging exists (holding a 27 MB parse in memory peaked at
            +90 MB RSS).
        input_format: Which observed format adapter to key on. A malformed source
            row raises a content-free format error naming its file and line.
        store: Where the parsed turns are staged, in file order.

    Returns:
        A :class:`StageResult`.

    Every line is passed to the format adapter; a line that is not a turn is
    declined (``None``) exactly as the live path declines it, and never dropped
    for its size. Content is carried whole into the store.
    """
    staged = store.stage(parse_file(path, input_format))
    return StageResult(staged=staged, input_format=input_format)


def parse_file(path: Path, input_format: InputFormat) -> Iterator[RawTurn]:
    """Parse one physical source through the canonical format adapter.

    This is the side-effect-free half of :func:`stage_file`. Batch discovery and
    dry-run use it so they share the exact parser without opening SQLite or a
    client.
    """
    return _parsed_turns(path, _adapter_for_file(path, input_format))


def _adapter_for_file(path: Path, input_format: InputFormat) -> LineAdapter:
    """Bind source-level context when the accepted format carries it."""
    adapter = adapter_for(input_format)
    if input_format is not InputFormat.CODEX:
        return adapter

    with path.open("r", encoding="utf-8", errors="replace") as handle:
        first_line = handle.readline()
    if not first_line:
        return adapter
    try:
        session_ref = codex_session_ref_if_present(first_line)
    except MalformedCodexRecordError as error:
        raise MalformedCodexRecordError(
            error.record, error.fields, f"{path}:1"
        ) from error
    if session_ref is None:
        return adapter
    return partial(codex_raw_turn_from_line, session_ref=session_ref)


def ingest(
    store: StagingStore, lane: BulkLane, *, expected_namespace: str | None = None
) -> IngestResult:
    """Yield each staged, unsent turn to the raw lane; resume, and quarantine.

    Args:
        store: The staging store holding the rejiggered file. Only turns not
            already marked sent are attempted, so a re-run RESUMES rather than
            re-sends -- the operator's interrupted-run recovery.
        lane: The raw-lane write path (the real ``AgentMemory`` in production, a
            fake in tests).
        expected_namespace: Namespace the server receipt must confirm. ``None``
            preserves legacy callers that do not bind an expected namespace.

    Returns:
        An :class:`IngestResult` counting what this run delivered and set aside.

    A turn the lane REJECTS is quarantined with its error class -- not dropped,
    not retried forever -- and the run continues to the next turn. That is the
    operator contract: loud, resumable, and nothing lost. A turn that IS sent is
    marked, so the same turn is never delivered twice across runs (and the
    server's ``UNIQUE(namespace, turn_uuid)`` dedupe is the second line of that
    defence, not the first).
    """
    return _drive(store, lane, expected_namespace)


def _drive(
    store: StagingStore, lane: BulkLane, expected_namespace: str | None
) -> IngestResult:
    """Send every pending turn one at a time, marking or quarantining each.

    One turn per send, not a batch, because the operator failure mode is
    per-turn: a single rejected turn is quarantined and the rest still land,
    where a batched send would fail the whole remainder on one bad row.
    """
    sent = 0
    duplicates = 0
    filtered = 0
    quarantined = 0
    receipt_namespace = expected_namespace
    for turn in store.pending():
        delivered, duplicate, server_filtered, failed, namespace = _send_one(
            store, lane, turn, receipt_namespace
        )
        receipt_namespace = namespace or receipt_namespace
        sent += delivered
        duplicates += duplicate
        filtered += server_filtered
        quarantined += failed
    return IngestResult(
        sent=sent,
        duplicates=duplicates,
        filtered=filtered,
        quarantined=quarantined,
        namespace=receipt_namespace,
    )


def _send_one(
    store: StagingStore,
    lane: BulkLane,
    turn: RawTurn,
    expected_namespace: str | None,
) -> tuple[int, int, int, int, str | None]:
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
        receipt = lane.ingest_raw_turns(payload)
        delivered, duplicate, namespace = _validated_receipt(
            receipt, expected_namespace
        )
    except Exception as error:  # noqa: BLE001 -- quarantine any lane rejection, loudly
        # Content-free BY CONSTRUCTION: only the error CLASS name is recorded,
        # never the exception object, so no turn text or token reaches the
        # quarantine store -- the same discipline the live swallow keeps.
        store.quarantine(turn, type(error).__name__)
        if isinstance(error, ServerFilteredTurnError):
            return 0, 0, 1, 0, None
        return 0, 0, 0, 1, None
    store.mark_sent(turn.turn_uuid)
    return delivered, duplicate, 0, 0, namespace


def _validated_receipt(
    receipt: Mapping[str, Any], expected_namespace: str | None
) -> tuple[int, int, str]:
    """Validate the server's durable one-turn result before marking it sent."""
    ingested = receipt.get("ingested")
    duplicates = receipt.get("duplicates")
    filtered = receipt.get("filtered")
    values = (ingested, duplicates, filtered)
    if not all(
        isinstance(value, int) and not isinstance(value, bool) for value in values
    ):
        raise RawIngestReceiptError("counts")
    assert isinstance(ingested, int)
    assert isinstance(duplicates, int)
    assert isinstance(filtered, int)
    if min(ingested, duplicates, filtered) < 0:
        raise RawIngestReceiptError("counts")
    if ingested + duplicates + filtered != 1:
        raise RawIngestReceiptError("accounting")
    namespace = receipt.get("namespace")
    if not isinstance(namespace, str) or (
        expected_namespace is not None and namespace != expected_namespace
    ):
        raise RawIngestReceiptError("namespace")
    if filtered:
        raise ServerFilteredTurnError
    return ingested, duplicates, namespace


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
            except MalformedHermesRecordError as error:
                location = f"{path}:{line_number}"
                raise MalformedHermesRecordError(error.fields, location) from error
            if turn is not None:
                yield turn
