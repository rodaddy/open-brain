"""Bounded JSON adapter for the first-class Open Brain runtime facade."""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Mapping, Sequence
from typing import Any, cast

from .agent import EVENT_TYPES, MemorySpool
from .client import OpenBrainClient, Transport
from .policy import redact_text
from .runtime import (
    FirstClassMemoryRuntime,
    ReceiptStatus,
    RuntimeConfig,
    RuntimeOutput,
    RuntimeReceipt,
    RuntimeScope,
)

_LOGGER = logging.getLogger(__name__)

# One admission size for EVERY operation.
#
# Until 2026-07-30 the distilled verbs -- capture, checkpoint, wrap -- were held
# to 64 KB while only `ingest` was allowed more. The reasoning for exempting
# ingest was already written here: 64 KB "would silently refuse a long assistant
# turn, which is the exact failure full-send exists to remove." That is equally
# true of a long decision or a long checkpoint, and the refusal was total -- a
# ValueError loses the whole write, not the excess.
#
# This is a stdin READ SIZE, not a rule about what may be remembered. It has to
# be finite because __main__ reads a fixed number of bytes from a pipe, and it
# is set far above anything measured: the largest turn in the live clone is
# 51,283 characters, roughly 1,300x smaller.
MAX_INGEST_JSON_INPUT_BYTES = 64 * 1024 * 1024
MAX_JSON_INPUT_BYTES = MAX_INGEST_JSON_INPUT_BYTES
MAX_JSON_OUTPUT_BYTES = 1_000_000
MAX_IGNORED_OPTIONAL_KEY_COUNT = 65_535
IGNORED_OPTIONAL_REQUEST_KEYS_NOTE = "ignored_optional_request_keys"
_COMMON_KEYS = {"config", "operation", "scope"}
_OPERATION_SPECS = {
    "help": ("List provider operations and an example request.", set()),
    "recall": (
        "Load context for a query.",
        {
            "include_unreviewed_recovery",
            "max_latency_ms",
            "max_tokens",
            "query",
            "requested_sections",
        },
    ),
    "reflex": (
        "Load body-free reflex pointers for a query.",
        {"max_latency_ms", "max_tokens", "prior_context", "query"},
    ),
    # The three lifecycle keys are the #445 promotion vocabulary. They were
    # absent here until 2026-08-03, which meant a scripted promotion through
    # this lane returned status:saved and wrote a row with none of the
    # metadata that makes it promotable -- a false receipt (#464).
    "capture": (
        "Persist one distilled memory event.",
        {
            "candidate_scope",
            "candidate_type",
            "content",
            "distilled",
            "event_type",
            "memory_lifecycle_action",
        },
    ),
    # The raw lane carries no "distilled" key by design: it is the one verb
    # that ships the transcript rather than a summary of it.
    "ingest": ("Persist raw conversation turns.", {"namespace", "turns"}),
    "checkpoint": (
        "Persist distilled session progress.",
        {
            "distilled",
            "key_decisions",
            "next_steps",
            "receipt_refs",
            "summary",
        },
    ),
    "wrap": (
        "Persist a distilled session wrap.",
        {
            "distilled",
            "key_decisions",
            "next_steps",
            "receipt_refs",
            "summary",
        },
    ),
}
_OPERATION_KEYS = {name: keys for name, (_, keys) in _OPERATION_SPECS.items()}
_OPERATION_NAMES = tuple(_OPERATION_SPECS)
_OPERATION_VOCABULARY = ", ".join(_OPERATION_NAMES)
_HELP_EXAMPLE = {
    "operation": "recall",
    "query": "current task",
    "scope": {
        "agent": "agent-name",
        "channel_id": "channel-id",
        "platform": "runtime-name",
        "server_id": "server-id",
        "session_key": "session-key",
    },
}

# The example above is a REQUEST BODY, and a request body carries no identity.
# base_url, token, and namespace come from the environment (or an explicit
# `config` object), so the example alone does not run on a clean shell -- it
# fails with "namespace must be a non-empty string" and says nothing about
# where namespace was supposed to come from. The first client install
# (2026-08-04) burned four round trips on exactly that. Name the requirement in
# the help output itself, next to the example it qualifies.
#
# The variable names are VALUES in a list rather than keys of an object on
# purpose. As `{"OPENBRAIN_TOKEN": "bearer token"}` the redactor matched the
# key -- its rule is `"token": "..."` -- and replaced the DESCRIPTION with
# [REDACTED], so the help hid its own explanation. The rule is right (a live
# token in that shape must never print); the help just has to stop looking like
# a credential it is not.
_HELP_ENVIRONMENT = {
    "required": [
        "OPENBRAIN_BASE_URL -- bare scheme://host:port, no path",
        "OPENBRAIN_NAMESPACE -- namespace for every request; NOT a request key",
        "OPENBRAIN_TOKEN -- the bearer value sent as the Authorization header",
    ],
    "note": (
        "The example is a request body and carries no identity. base_url, "
        "token, and namespace are read from these variables, or from an "
        "explicit top-level \"config\" object. Putting \"namespace\" at the top "
        "level of the request does nothing."
    ),
}

# Keys that are NOT request fields but that callers reach for anyway, mapped to
# the sentence that says where each one actually lives. Silently folding these
# into `ignored_optional_request_keys` produced a self-contradicting receipt:
# `namespace` listed as ignored AND `namespace must be a non-empty string` as
# the error, in the same JSON object. Ignoring a key is right when the key is
# merely unrecognised; it is wrong when the key names a real setting the caller
# is trying to set, because the request then fails for the exact thing the
# receipt says was optional.
#
# Rejecting rather than aliasing is deliberate. `docs/memory-contract.md` and
# `_CONFIG_KEYS` in runtime.py already give `config.namespace` as the explicit
# override; accepting a second top-level spelling would add an undocumented
# field with the same meaning. The error names the environment variable and the
# config path instead.
_MISPLACED_CONFIG_KEYS = {
    "namespace": (
        "namespace comes from OPENBRAIN_NAMESPACE in the environment, not the "
        "request body; to override it in-request use "
        '{"config": {"namespace": "..."}}'
    ),
    "base_url": (
        "base_url comes from OPENBRAIN_BASE_URL in the environment, not the "
        "request body; to override it in-request use "
        '{"config": {"base_url": "..."}}'
    ),
    "token": (
        "token comes from OPENBRAIN_TOKEN in the environment, not the request "
        'body; to override it in-request use {"config": {"token": "..."}}'
    ),
}


def _reject_misplaced_config_keys(
    payload: Mapping[str, Any],
    allowed: set[str],
) -> None:
    """Fail a request that puts a config setting at the top level.

    Only for keys this operation does not itself define -- `ingest` owns a real
    top-level ``namespace``, so it keeps it.
    """
    for key in sorted(_MISPLACED_CONFIG_KEYS):
        if key in payload and key not in allowed:
            raise ValueError(_MISPLACED_CONFIG_KEYS[key])


# Wrong spellings of a request field this lane DOES have, mapped to the field
# they were reaching for. Distinct from `_MISPLACED_CONFIG_KEYS`: those name a
# real setting that lives somewhere else, these name a real field under a name
# the contract never had.
#
# `kind` is the measured case (#598). It landed in
# `ignored_optional_request_keys`, so a capture that meant `event_type:
# "decision"` was accepted, stored as the default type, and exited 0 -- the
# caller's classification silently lost with a success receipt on top of it.
# Naming a dropped key (#464) is the right answer for a key that means nothing;
# it is the wrong answer for a key that means something the caller expected to
# take effect.
#
# Rejecting rather than aliasing is the operator ruling of 2026-08-07: the
# request is reworded to fit the vocabulary, the vocabulary is not widened to
# absorb the request. Honoring `kind` would mint a second undocumented spelling
# of `event_type` and defer the vocabulary question (#403) behind an alias
# nobody could later remove.
_MISSPELLED_REQUEST_KEYS = {"kind": "event_type"}


def _reject_misspelled_request_keys(
    payload: Mapping[str, Any],
    allowed: set[str],
) -> None:
    """Fail a request naming a real field by a name the contract does not have.

    The legal values come from `EVENT_TYPES` in `agent.py`, the one definition
    of the vocabulary (#412), because two hand-maintained copies of one list is
    exactly the drift #409 found. A rejection that named the key without the
    accepted set would leave the caller no way to be right, which is the
    correction already applied to `unsupported_event_type`.
    """
    for key in sorted(_MISSPELLED_REQUEST_KEYS):
        if key not in payload or key in allowed:
            continue
        target = _MISSPELLED_REQUEST_KEYS[key]
        if target not in allowed:
            continue
        raise ValueError(
            f"{key} is not a request key; this lane spells it {target}; "
            f"accepted {target} values: {', '.join(sorted(EVENT_TYPES))}"
        )


def execute_json(
    payload: Mapping[str, Any],
    *,
    environ: Mapping[str, str] | None = None,
    transport: Transport | None = None,
    client: Any | None = None,
    client_factory: Callable[..., Any] = OpenBrainClient,
    fallback_runner: Callable[..., Any] | None = None,
    spool: MemorySpool | None = None,
) -> dict[str, Any]:
    """Execute one bounded JSON lifecycle request and return JSON-ready output."""
    runtime: FirstClassMemoryRuntime | None = None
    ignored_optional_keys: list[str] = []
    try:
        operation = _operation_text(payload)
        projected, ignored_optional_keys = _project_request(payload, operation)
        if operation == "help":
            output = usage_output()
        else:
            scope_value = projected.get("scope")
            config_value = projected.get("config", {})
            if not isinstance(scope_value, Mapping):
                raise ValueError("scope must be a JSON object")
            if not isinstance(config_value, Mapping):
                raise ValueError("config must be a JSON object")
            runtime = FirstClassMemoryRuntime(
                RuntimeConfig.from_sources(config_value, environ=environ),
                RuntimeScope.from_mapping(scope_value),
                transport=transport,
                client=client,
                client_factory=client_factory,
                fallback_runner=fallback_runner,
                spool=spool,
            )
            output = _dispatch(runtime, operation, projected).as_dict()
    except Exception as error:
        output = failure_output(_safe_operation(payload.get("operation")), error)
    _attach_compatibility_receipt(output, ignored_optional_keys)
    if runtime is not None:
        try:
            runtime.close()
        except Exception as error:
            output = failure_output("close", error)
            _attach_compatibility_receipt(output, ignored_optional_keys)
            return output
    return output


def failure_output(operation: str, error: BaseException | str) -> dict[str, Any]:
    """Build one redacted structured failure for CLI boundaries."""
    error_text = (
        _safe_error(error) if isinstance(error, BaseException) else _safe_text(error)
    )
    return RuntimeOutput(
        receipt=RuntimeReceipt(
            operation=_safe_operation(operation),
            status=ReceiptStatus.FAILED,
            durable=False,
            direct_attempted=False,
            fallback_attempted=False,
            error=error_text,
        )
    ).as_dict()


def usage_output() -> dict[str, Any]:
    """Build the structured provider operation reference."""
    return RuntimeOutput(
        receipt=RuntimeReceipt(
            operation="help",
            status=ReceiptStatus.DIRECT,
            durable=False,
            direct_attempted=False,
            fallback_attempted=False,
        ),
        result={
            "operations": [
                {"name": name, "description": description}
                for name, (description, _) in _OPERATION_SPECS.items()
            ],
            "example": _HELP_EXAMPLE,
            "environment": _HELP_ENVIRONMENT,
        },
    ).as_dict()


def operation_names() -> tuple[str, ...]:
    """Return every operation accepted by the JSON router."""
    return _OPERATION_NAMES


def parse_json_input(data: bytes) -> Mapping[str, Any]:
    """Parse one UTF-8 JSON envelope.

    EVERY OPERATION IS ADMITTED AT THE SAME SIZE. The distilled verbs used to
    be held to 64 KB while ``ingest`` was not, so a long decision or checkpoint
    was refused outright -- losing the whole write rather than any excess --
    while the identical text went through as a raw turn.
    """
    if len(data) > MAX_INGEST_JSON_INPUT_BYTES:
        raise ValueError(f"JSON input exceeds {MAX_INGEST_JSON_INPUT_BYTES} bytes")
    try:
        decoded = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("input must be one UTF-8 JSON object") from error
    if not isinstance(decoded, dict):
        raise ValueError("input must be a JSON object")
    _LOGGER.debug(
        "cli_input_parsed",
        extra={
            "operation": decoded.get("operation"),
            "input_bytes": len(data),
        },
    )
    return cast(Mapping[str, Any], decoded)


def encode_json_output(output: Mapping[str, Any]) -> bytes:
    """Encode bounded JSON output, replacing oversize data with a safe failure."""
    encoded = json.dumps(output, separators=(",", ":"), sort_keys=True).encode("utf-8")
    if len(encoded) <= MAX_JSON_OUTPUT_BYTES:
        return encoded + b"\n"
    fallback = failure_output(
        "output",
        f"JSON output exceeds {MAX_JSON_OUTPUT_BYTES} bytes",
    )
    return (
        json.dumps(fallback, separators=(",", ":"), sort_keys=True).encode("utf-8")
        + b"\n"
    )


def _dispatch(
    runtime: FirstClassMemoryRuntime,
    operation: str,
    payload: Mapping[str, Any],
) -> RuntimeOutput:
    if operation == "recall":
        return runtime.recall_context(
            _mapping_text(payload, "query"),
            max_tokens=_mapping_optional_int(payload, "max_tokens"),
            max_latency_ms=_mapping_optional_int(payload, "max_latency_ms"),
            requested_sections=_mapping_optional_str_list(
                payload,
                "requested_sections",
            ),
            include_unreviewed_recovery=_mapping_optional_bool(
                payload,
                "include_unreviewed_recovery",
            ),
        )
    if operation == "reflex":
        return runtime.reflex(
            _mapping_text(payload, "query"),
            max_tokens=_mapping_optional_int(payload, "max_tokens"),
            max_latency_ms=_mapping_optional_int(payload, "max_latency_ms"),
            prior_context=_mapping_optional_object_list(payload, "prior_context"),
        )
    if operation == "capture":
        _require_distilled(payload, operation)
        return runtime.capture_distilled(
            _mapping_text(payload, "content"),
            event_type=_mapping_default_text(payload, "event_type", "fact"),
            candidate_type=_mapping_optional_text(payload, "candidate_type"),
            memory_lifecycle_action=_mapping_optional_text(
                payload,
                "memory_lifecycle_action",
            ),
            candidate_scope=_mapping_optional_object(payload, "candidate_scope"),
        )
    if operation == "ingest":
        # Deliberately NOT _require_distilled: this is the raw lane. Every
        # other write verb asserts distilled=true because it carries a
        # summarized statement; raw turns carry the transcript itself.
        turns = _mapping_optional_object_list(payload, "turns")
        if turns is None:
            raise ValueError("turns must be a JSON array")
        namespace = payload.get("namespace")
        return runtime.ingest_raw_turns(
            turns,
            namespace=(
                _mapping_text(payload, "namespace") if namespace is not None else None
            ),
        )
    if operation == "checkpoint":
        _require_distilled(payload, operation)
        return runtime.checkpoint(
            _mapping_text(payload, "summary"),
            key_decisions=_mapping_optional_str_list(payload, "key_decisions"),
            next_steps=_mapping_optional_str_list(payload, "next_steps"),
            receipt_refs=_mapping_optional_str_list(payload, "receipt_refs"),
        )
    if operation == "wrap":
        _require_distilled(payload, operation)
        return runtime.wrap(
            _mapping_text(payload, "summary"),
            key_decisions=_mapping_optional_str_list(payload, "key_decisions"),
            next_steps=_mapping_optional_str_list(payload, "next_steps"),
            receipt_refs=_mapping_optional_str_list(payload, "receipt_refs"),
        )
    raise ValueError(
        f"unsupported operation: {_safe_text(operation)}; "
        f"valid operations: {_OPERATION_VOCABULARY}"
    )


def _project_request(
    payload: Mapping[str, Any],
    operation: str,
) -> tuple[dict[str, Any], list[str]]:
    allowed = _OPERATION_KEYS.get(operation)
    if allowed is None:
        raise ValueError(
            f"unsupported operation: {_safe_text(operation)}; "
            f"valid operations: {_OPERATION_VOCABULARY}"
        )
    _reject_misplaced_config_keys(payload, allowed)
    _reject_misspelled_request_keys(payload, allowed)
    known_keys = _COMMON_KEYS | allowed
    projected = {key: value for key, value in payload.items() if key in known_keys}
    ignored_keys = sorted(
        _safe_text(str(key)) for key in payload if key not in known_keys
    )[:MAX_IGNORED_OPTIONAL_KEY_COUNT]
    return projected, ignored_keys


def _attach_compatibility_receipt(
    output: dict[str, Any],
    ignored_optional_keys: Sequence[str],
) -> None:
    """Record WHICH request keys were dropped, not just how many.

    A bare count told a caller that something was ignored without saying what,
    so a promotion whose lifecycle keys were dropped read as a successful write
    with an unexplained note attached (#464). The names make the same receipt
    diagnosable at the point of the write.
    """
    if not ignored_optional_keys:
        return
    receipt = output.get("receipt")
    if not isinstance(receipt, dict):
        return
    receipt["compatibility_note"] = IGNORED_OPTIONAL_REQUEST_KEYS_NOTE
    receipt["ignored_optional_key_count"] = len(ignored_optional_keys)
    receipt["ignored_optional_request_keys"] = list(ignored_optional_keys)


def _require_distilled(payload: Mapping[str, Any], operation: str) -> None:
    if payload.get("distilled") is not True:
        raise ValueError(f"{operation} requires distilled=true")


def _operation_text(value: Mapping[str, Any]) -> str:
    item = value.get("operation")
    if not isinstance(item, str) or not item.strip():
        raise ValueError(
            "operation must be a non-empty string; "
            f"valid operations: {_OPERATION_VOCABULARY}"
        )
    return item.strip()


def _mapping_text(value: Mapping[str, Any], name: str) -> str:
    item = value.get(name)
    if not isinstance(item, str) or not item.strip():
        raise ValueError(f"{name} must be a non-empty string")
    return item.strip()


def _mapping_default_text(
    value: Mapping[str, Any],
    name: str,
    default: str,
) -> str:
    if name not in value:
        return default
    return _mapping_text(value, name)


def _mapping_optional_text(value: Mapping[str, Any], name: str) -> str | None:
    if value.get(name) is None:
        return None
    return _mapping_text(value, name)


def _mapping_optional_object(
    value: Mapping[str, Any],
    name: str,
) -> Mapping[str, Any] | None:
    item = value.get(name)
    if item is None:
        return None
    if not isinstance(item, Mapping):
        raise ValueError(f"{name} must be a JSON object")
    return item


def _mapping_optional_int(value: Mapping[str, Any], name: str) -> int | None:
    item = value.get(name)
    if item is None:
        return None
    if isinstance(item, bool) or not isinstance(item, int):
        raise ValueError(f"{name} must be an integer")
    return item


def _mapping_optional_bool(value: Mapping[str, Any], name: str) -> bool | None:
    item = value.get(name)
    if item is None:
        return None
    if not isinstance(item, bool):
        raise ValueError(f"{name} must be a boolean")
    return item


def _mapping_optional_str_list(
    value: Mapping[str, Any],
    name: str,
) -> list[str] | None:
    item = value.get(name)
    if item is None:
        return None
    if not isinstance(item, list):
        raise ValueError(f"{name} must be a JSON array")
    result: list[str] = []
    for entry in item:
        if not isinstance(entry, str) or not entry.strip():
            raise ValueError(f"{name} must contain non-empty strings")
        result.append(entry.strip())
    return result


def _mapping_optional_object_list(
    value: Mapping[str, Any],
    name: str,
) -> list[Mapping[str, Any]] | None:
    item = value.get(name)
    if item is None:
        return None
    if not isinstance(item, list):
        raise ValueError(f"{name} must be a JSON array")
    result: list[Mapping[str, Any]] = []
    for entry in item:
        if not isinstance(entry, Mapping):
            raise ValueError(f"{name} must contain JSON objects")
        result.append(entry)
    return result


def _safe_operation(value: Any) -> str:
    if not isinstance(value, str):
        return "unknown"
    return _safe_text(value) or "unknown"


def _safe_error(error: BaseException) -> str:
    return _safe_text(str(error) or error.__class__.__name__)


def _safe_text(value: str) -> str:
    return redact_text(value)[:500]
