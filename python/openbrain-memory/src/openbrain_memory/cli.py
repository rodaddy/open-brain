"""Bounded JSON adapter for the first-class Open Brain runtime facade."""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping
from typing import Any, cast

from .agent import MemorySpool
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

MAX_JSON_INPUT_BYTES = 64 * 1024
MAX_JSON_OUTPUT_BYTES = 1_000_000
_COMMON_KEYS = {"config", "operation", "scope"}
_OPERATION_KEYS = {
    "recall": {"max_latency_ms", "max_tokens", "query", "requested_sections"},
    "capture": {"content", "distilled", "event_type"},
    "checkpoint": {
        "distilled",
        "key_decisions",
        "next_steps",
        "receipt_refs",
        "summary",
    },
    "wrap": {
        "distilled",
        "key_decisions",
        "next_steps",
        "receipt_refs",
        "summary",
    },
}


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
    try:
        operation = _mapping_text(payload, "operation")
        scope_value = payload.get("scope")
        config_value = payload.get("config", {})
        if not isinstance(scope_value, Mapping):
            raise ValueError("scope must be a JSON object")
        if not isinstance(config_value, Mapping):
            raise ValueError("config must be a JSON object")
        _validate_request_keys(payload, operation)
        runtime = FirstClassMemoryRuntime(
            RuntimeConfig.from_sources(config_value, environ=environ),
            RuntimeScope.from_mapping(scope_value),
            transport=transport,
            client=client,
            client_factory=client_factory,
            fallback_runner=fallback_runner,
            spool=spool,
        )
        output = _dispatch(runtime, operation, payload).as_dict()
    except Exception as error:
        output = failure_output(_safe_operation(payload.get("operation")), error)
    if runtime is not None:
        try:
            runtime.close()
        except Exception as error:
            return failure_output("close", error)
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


def parse_json_input(data: bytes) -> Mapping[str, Any]:
    """Parse one bounded UTF-8 JSON object."""
    if len(data) > MAX_JSON_INPUT_BYTES:
        raise ValueError(f"JSON input exceeds {MAX_JSON_INPUT_BYTES} bytes")
    try:
        decoded = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("input must be one UTF-8 JSON object") from error
    if not isinstance(decoded, dict):
        raise ValueError("input must be a JSON object")
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
        )
    if operation == "capture":
        _require_distilled(payload, operation)
        return runtime.capture_distilled(
            _mapping_text(payload, "content"),
            event_type=_mapping_default_text(payload, "event_type", "fact"),
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
    raise ValueError(f"unsupported operation: {_safe_text(operation)}")


def _validate_request_keys(payload: Mapping[str, Any], operation: str) -> None:
    allowed = _OPERATION_KEYS.get(operation)
    if allowed is None:
        raise ValueError(f"unsupported operation: {_safe_text(operation)}")
    unknown = {str(key) for key in payload if key not in _COMMON_KEYS | allowed}
    if unknown:
        raise ValueError(
            f"{operation} contains unsupported keys: {', '.join(sorted(unknown))}"
        )


def _require_distilled(payload: Mapping[str, Any], operation: str) -> None:
    if payload.get("distilled") is not True:
        raise ValueError(f"{operation} requires distilled=true")


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


def _mapping_optional_int(value: Mapping[str, Any], name: str) -> int | None:
    item = value.get(name)
    if item is None:
        return None
    if isinstance(item, bool) or not isinstance(item, int):
        raise ValueError(f"{name} must be an integer")
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


def _safe_operation(value: Any) -> str:
    if not isinstance(value, str):
        return "unknown"
    return _safe_text(value) or "unknown"


def _safe_error(error: BaseException) -> str:
    return _safe_text(str(error) or error.__class__.__name__)


def _safe_text(value: str) -> str:
    return redact_text(value)[:500]
