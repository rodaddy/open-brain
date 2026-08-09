"""The format factory: turn one input line into a ``RawTurn``, by input type.

Purpose:
    A giant session file arrives in one of several shapes. Claude transcripts,
    Codex rollout JSONL, and JSON lines exported from Hermes's SQLite ``messages``
    table are built. This module is the factory keyed on input type, and it lives
    HERE by ruling: *"The factory keyed on input type belongs THERE"* -- in the
    bulk app, never on the live adapter's deadline-critical hook path
    (`_plans/python-port-sequence.md` §TWO APPLICATIONS).

Architecture:
    A format adapter is a PURE function ``(str) -> RawTurn | None`` over one line
    of the input, exactly the shape ``records.raw_turn_from_line`` already has.
    The Claude adapter IS ``records.raw_turn_from_line``, imported -- not copied.
    The Codex adapter validates the observed rollout envelope and dispatches known
    ``event_msg`` payloads through a table. The Hermes adapter validates one row
    exported from the observed SQLite schema. Adding a format is adding one
    function to :data:`_ADAPTERS`, not editing a chain of ``if`` branches.

Pattern/Convention:
    A malformed built-format line fails LOUD, never silent. Valid records that are
    not conversational turns return ``None``. Nothing here shortens or samples
    content: an adapter either yields a whole ``RawTurn`` or declines a valid
    non-turn record.

Example:
    >>> line = (
    ...     '{"type":"user","uuid":"u1","promptSource":"typed",'
    ...     '"message":{"content":"hello"}}'
    ... )
    >>> adapter = adapter_for(InputFormat.CLAUDE)
    >>> adapter(line).content
    'hello'
    >>> adapter('{"type":"assistant"}') is None
    True

See Also:
    - `openbrain.apps.capture.records.raw_turn_from_line` - reused Claude adapter
    - `_plans/python-port-sequence.md` §TWO APPLICATIONS - why the factory is here
"""

from __future__ import annotations

from collections.abc import Callable
from enum import StrEnum
from typing import Any, Literal
from uuid import NAMESPACE_URL, uuid5

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from openbrain.apps.capture.records import raw_turn_from_line
from openbrain.models.turn import RawTurn, TurnRole

#: A format adapter: one input line in, one whole ``RawTurn`` or ``None`` out.
LineAdapter = Callable[[str], RawTurn | None]

CODEX_EVENT_RECORD = "event_msg"
HERMES_BLANK_LINE_FIELD = "line (blank)"


class InputFormat(StrEnum):
    """The input shapes the bulk ingester knows how to key on."""

    CLAUDE = "claude"
    CODEX = "codex"
    HERMES = "hermes"


class MalformedCodexRecordError(ValueError):
    """A Codex rollout line violates the observed JSONL structure."""

    def __init__(
        self, record: str, fields: str, location: str = "the supplied line"
    ) -> None:
        """Report the record family and invalid fields without message content."""
        self.record = record
        self.fields = fields
        super().__init__(
            f"malformed Codex rollout record {record!r} at {location}; observed "
            f"shape failed at {fields}. No message content is included in this "
            "error. ACTION REQUIRED: inspect or sanitize that JSONL line and "
            "update the adapter only from an observed Codex format change."
        )


class MalformedHermesRecordError(ValueError):
    """A Hermes message row violates the observed SQLite export structure."""

    def __init__(self, fields: str, location: str = "the supplied line") -> None:
        """Report invalid fields without copying corpus content into the error."""
        self.fields = fields
        super().__init__(
            f"malformed Hermes messages row at {location}; observed shape failed "
            f"at {fields}. No message content is included in this error. "
            "ACTION REQUIRED: inspect or sanitize that exported SQLite row and "
            "update the adapter only from an observed Hermes schema change."
        )


class HermesMessageRole(StrEnum):
    """Roles observed in Hermes's SQLite ``messages`` table."""

    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"
    SYSTEM = "system"


class HermesMessageRecord(BaseModel):
    """One JSON-serialized row exported from Hermes's ``messages`` table."""

    model_config = ConfigDict(extra="ignore")

    id: str | int
    session_id: str
    role: HermesMessageRole
    content: str | None
    timestamp: str | int | None = None
    active: int | None = None
    compacted: int | None = None


class CodexEnvelope(BaseModel):
    """The top-level shape observed on every Codex rollout JSONL record."""

    model_config = ConfigDict(extra="ignore")

    timestamp: str
    record_type: str = Field(alias="type")
    payload: dict[str, Any]


class CodexUserMessagePayload(BaseModel):
    """Observed ``event_msg/user_message`` payload."""

    model_config = ConfigDict(extra="ignore")

    event_type: Literal["user_message"] = Field(alias="type")
    message: str
    images: list[Any]
    local_images: list[Any]
    audio: list[Any]
    local_audio: list[Any]
    text_elements: list[Any]


class CodexTokenCountInfo(BaseModel):
    """Observed metadata nested under ``event_msg/token_count``."""

    model_config = ConfigDict(extra="ignore")

    total_token_usage: dict[str, Any]
    last_token_usage: dict[str, Any]
    model_context_window: int


class CodexTokenCountPayload(BaseModel):
    """Observed ``event_msg/token_count`` payload; metadata, never a turn."""

    model_config = ConfigDict(extra="ignore")

    event_type: Literal["token_count"] = Field(alias="type")
    info: CodexTokenCountInfo
    rate_limits: dict[str, Any]


class CodexTaskStartedPayload(BaseModel):
    """Observed ``event_msg/task_started`` payload; lifecycle, never a turn."""

    model_config = ConfigDict(extra="ignore")

    event_type: Literal["task_started"] = Field(alias="type")
    turn_id: str
    started_at: int
    model_context_window: int
    collaboration_mode_kind: str


class CodexTaskCompletePayload(BaseModel):
    """Observed ``event_msg/task_complete`` payload carrying the final answer."""

    model_config = ConfigDict(extra="ignore")

    event_type: Literal["task_complete"] = Field(alias="type")
    turn_id: str
    last_agent_message: str | None
    started_at: int
    completed_at: int
    duration_ms: int
    # OPTIONAL BECAUSE CODEX OMITS IT, and it is telemetry either way.
    #
    # Measured 2026-08-09 against Codex CLI 0.147.0 (#512): a turn that produced
    # no tokens writes `task_complete` with NO `time_to_first_token_ms` at all.
    # Across every rollout written that day, 144 records carried the field and 1
    # did not -- and the one that did not came from `codex exec`, which is
    # exactly the non-interactive path automation and Workflow lanes use.
    #
    # Required, this cost the WHOLE file: `codex_raw_turn_from_line` raised
    # MalformedCodexRecordError, and `ingest.py` re-raises with a file:line
    # rather than skipping, so a single tokenless turn aborted the entire
    # ingest. Rare input, total failure.
    #
    # Optional is the minimal correct change, not a loosening: no turn content
    # depends on this field. `turn_id`, `last_agent_message`, and the timestamps
    # stay REQUIRED, because turn identity and the assistant's actual words do
    # depend on them -- a record missing those is still quarantined loudly, and
    # `scripts/done-means/512-codex-adapter.sh` clause (c) holds that line.
    time_to_first_token_ms: int | None = None


CodexEventAdapter = Callable[[CodexEnvelope, str], RawTurn | None]


def codex_raw_turn_from_line(line: str) -> RawTurn | None:
    """Build a normalized turn from one observed Codex rollout JSONL line.

    Args:
        line: One complete JSONL record.

    Returns:
        A user turn for ``event_msg/user_message``, an assistant turn for
        ``event_msg/task_complete``, or ``None`` for a valid non-turn record.

    Raises:
        MalformedCodexRecordError: When JSON or a known observed shape is invalid.
    """
    if not line.strip():
        raise MalformedCodexRecordError("envelope", "line (blank)")

    try:
        envelope = CodexEnvelope.model_validate_json(line)
    except ValidationError as error:
        raise _malformed("envelope", error) from error

    if envelope.record_type != CODEX_EVENT_RECORD:
        return None

    event_type = envelope.payload.get("type")
    if not isinstance(event_type, str):
        raise MalformedCodexRecordError("event_msg", "payload.type")

    adapter = _CODEX_EVENT_ADAPTERS.get(event_type)
    return None if adapter is None else adapter(envelope, line)


def hermes_raw_turn_from_line(line: str) -> RawTurn | None:
    """Build a normalized turn from one Hermes SQLite ``messages`` row.

    The SQLite source is exported as one JSON object per line before it enters the
    existing bulk spine. The adapter consumes only the charted message columns;
    richer columns such as tool calls and reasoning remain present in the export
    but cannot be represented by ``RawTurn`` and are ignored by validation.

    Args:
        line: One complete JSON object produced from a ``messages`` row.

    Returns:
        A user, assistant, or tool turn when the row carries live conversational
        content, or ``None`` for inactive, compacted, system, and content-free rows.

    Raises:
        MalformedHermesRecordError: When JSON or the observed row shape is invalid.
    """
    if not line.strip():
        raise MalformedHermesRecordError(HERMES_BLANK_LINE_FIELD)

    try:
        message = HermesMessageRecord.model_validate_json(line)
    except ValidationError as error:
        raise _malformed_hermes(error) from error

    if message.active == 0 or message.compacted == 1:
        return None

    turn_role = _HERMES_TURN_ROLES.get(message.role)
    if turn_role is None or message.content is None or not message.content.strip():
        return None

    occurred_at = str(message.timestamp) if message.timestamp is not None else None
    return RawTurn(
        turn_uuid=f"hermes:{message.session_id}:{message.id}",
        content=message.content,
        role=turn_role,
        is_human_prompt=turn_role is TurnRole.USER,
        occurred_at=occurred_at,
        session_ref=message.session_id,
    )


def _codex_user_turn(envelope: CodexEnvelope, line: str) -> RawTurn:
    """Normalize the human event with a deterministic whole-record identity."""
    payload = _payload(CodexUserMessagePayload, envelope)
    return RawTurn(
        turn_uuid=f"codex-user:{uuid5(NAMESPACE_URL, line.strip())}",
        content=payload.message,
        role=TurnRole.USER,
        is_human_prompt=True,
        occurred_at=envelope.timestamp,
    )


def _codex_task_complete_turn(
    envelope: CodexEnvelope, _line: str
) -> RawTurn | None:
    """Normalize a completed task when its observed final message is present."""
    payload = _payload(CodexTaskCompletePayload, envelope)
    if payload.last_agent_message is None:
        return None
    return RawTurn(
        turn_uuid=payload.turn_id,
        content=payload.last_agent_message,
        role=TurnRole.ASSISTANT,
        is_human_prompt=False,
        occurred_at=envelope.timestamp,
    )


def _codex_token_count(envelope: CodexEnvelope, _line: str) -> None:
    """Validate observed token metadata, then decline it as not a turn."""
    _payload(CodexTokenCountPayload, envelope)


def _codex_task_started(envelope: CodexEnvelope, _line: str) -> None:
    """Validate observed task lifecycle metadata, then decline it."""
    _payload(CodexTaskStartedPayload, envelope)


def _payload[PayloadModel: BaseModel](
    model: type[PayloadModel], envelope: CodexEnvelope
) -> PayloadModel:
    """Validate a known event payload without exposing its values on failure."""
    try:
        return model.model_validate(envelope.payload)
    except ValidationError as error:
        event_type = envelope.payload.get("type", "event_msg")
        raise _malformed(f"event_msg/{event_type}", error) from error


def _malformed(record: str, error: ValidationError) -> MalformedCodexRecordError:
    """Convert pydantic errors into content-free field locations."""
    locations = (
        ", ".join(".".join(str(part) for part in item["loc"]) for item in error.errors())
        or "unknown field"
    )
    return MalformedCodexRecordError(record, locations)


def _malformed_hermes(error: ValidationError) -> MalformedHermesRecordError:
    """Convert pydantic errors into content-free field locations."""
    locations = (
        ", ".join(
            ".".join(str(part) for part in item["loc"]) for item in error.errors()
        )
        or "unknown field"
    )
    return MalformedHermesRecordError(locations)


#: Hermes system rows are context metadata, not participant or tool turns.
_HERMES_TURN_ROLES: dict[HermesMessageRole, TurnRole] = {
    HermesMessageRole.USER: TurnRole.USER,
    HermesMessageRole.ASSISTANT: TurnRole.ASSISTANT,
    HermesMessageRole.TOOL: TurnRole.TOOL,
}


#: Known Codex events use table dispatch; unknown valid events are non-turns.
_CODEX_EVENT_ADAPTERS: dict[str, CodexEventAdapter] = {
    "user_message": _codex_user_turn,
    "token_count": _codex_token_count,
    "task_started": _codex_task_started,
    "task_complete": _codex_task_complete_turn,
}

#: The one place an input format maps to its pure line adapter.
_ADAPTERS: dict[InputFormat, LineAdapter] = {
    InputFormat.CLAUDE: raw_turn_from_line,
    InputFormat.CODEX: codex_raw_turn_from_line,
    InputFormat.HERMES: hermes_raw_turn_from_line,
}


def adapter_for(input_format: InputFormat) -> LineAdapter:
    """Return the pure line adapter for one input format."""
    return _ADAPTERS[input_format]
