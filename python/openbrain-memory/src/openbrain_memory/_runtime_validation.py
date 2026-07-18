"""Private validation helpers for persisted runtime content and scope data."""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Protocol

MAX_DISTILLED_CONTENT_BYTES = 16 * 1024


class RuntimeScopeCoordinates(Protocol):
    """Scope fields required to validate a started persistence lane."""

    @property
    def agent(self) -> str: ...

    @property
    def platform(self) -> str: ...

    @property
    def server_id(self) -> str: ...

    @property
    def channel_id(self) -> str: ...

    @property
    def session_key(self) -> str: ...

    @property
    def thread_id(self) -> str | None: ...


def distilled_content(
    value: str,
    name: str,
    reject_secret_payload: Callable[[Any, str], None],
) -> str:
    """Validate content that will be persisted as distilled memory."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a non-empty string")
    if len(value.encode("utf-8")) > MAX_DISTILLED_CONTENT_BYTES:
        raise ValueError(f"{name} exceeds {MAX_DISTILLED_CONTENT_BYTES} UTF-8 bytes")
    reject_secret_payload(value, name)
    return value


def validate_started_lane(
    result: Any,
    namespace: str,
    scope: RuntimeScopeCoordinates,
) -> None:
    """Require a session-start result to prove the requested exact scope."""
    if not isinstance(result, Mapping):
        raise ValueError("session_start result missing lane object")
    lane = result.get("lane")
    if not isinstance(lane, Mapping):
        raise ValueError("session_start result missing lane object")
    metadata = lane.get("metadata")
    candidate = {
        name: lane[name]
        for name in (
            "namespace",
            "session_key",
            "agent",
            "source",
            "channel_id",
            "thread_id",
        )
        if name in lane
    }
    if isinstance(metadata, Mapping) and "server_id" in metadata:
        candidate["server_id"] = metadata["server_id"]
    expected = exact_scope_fields(namespace, scope)
    expected["source"] = expected.pop("platform")
    validate_exact_fields(candidate, expected, "session_start result")


def validate_context_pack_scope(
    result: Any,
    namespace: str,
    scope: RuntimeScopeCoordinates,
) -> None:
    """Require a context-pack result to prove the requested exact scope."""
    if not isinstance(result, Mapping):
        raise ValueError("agent_context_pack result missing scope")
    candidate = result.get("scope")
    if not isinstance(candidate, Mapping):
        payload = result.get("payload")
        candidate = payload.get("scope") if isinstance(payload, Mapping) else None
    if not isinstance(candidate, Mapping):
        raise ValueError("agent_context_pack result missing scope")
    validate_exact_fields(
        candidate,
        exact_scope_fields(namespace, scope),
        "agent_context_pack result",
    )


def exact_scope_fields(
    namespace: str,
    scope: RuntimeScopeCoordinates,
) -> dict[str, Any]:
    """Return the exact scope fields a server response must prove."""
    return {
        "namespace": namespace,
        "session_key": scope.session_key,
        "agent": scope.agent,
        "platform": scope.platform,
        "server_id": scope.server_id,
        "channel_id": scope.channel_id,
        "thread_id": scope.thread_id,
    }


def validate_exact_fields(
    candidate: Mapping[str, Any],
    expected: Mapping[str, Any],
    label: str,
) -> None:
    """Require every expected field to be present with its exact value."""
    mismatches = sorted(
        name
        for name, value in expected.items()
        if name not in candidate or candidate[name] != value
    )
    if mismatches:
        raise ValueError(
            f"{label} did not prove exact Open Brain scope: {', '.join(mismatches)}"
        )


def persisted_text(
    value: Any,
    name: str,
    reject_secret_payload: Callable[[Any, str], None],
) -> str:
    """Validate text that will be persisted as scope or project metadata."""
    text = require_text(value, name)
    if len(text.encode("utf-8")) > MAX_DISTILLED_CONTENT_BYTES:
        raise ValueError(f"{name} exceeds {MAX_DISTILLED_CONTENT_BYTES} UTF-8 bytes")
    reject_secret_payload(text, name)
    return text


def wrap_metadata(
    key_decisions: Sequence[str] | None,
    next_steps: Sequence[str] | None,
    receipt_refs: Sequence[str] | None,
    reject_secret_payload: Callable[[Any, str], None],
) -> dict[str, Any]:
    """Validate optional persisted metadata for checkpoint and wrap calls."""
    metadata: dict[str, Any] = {}
    for name, values in (
        ("key_decisions", key_decisions),
        ("next_steps", next_steps),
        ("receipt_refs", receipt_refs),
    ):
        if values is None:
            continue
        if isinstance(values, str):
            raise ValueError(f"{name} must be a sequence of strings")
        distilled = [
            distilled_content(value, name, reject_secret_payload) for value in values
        ]
        if len(distilled) > 20:
            raise ValueError(f"{name} must contain at most 20 items")
        encoded = json.dumps(distilled, separators=(",", ":")).encode("utf-8")
        if len(encoded) > MAX_DISTILLED_CONTENT_BYTES:
            raise ValueError(
                f"{name} exceeds {MAX_DISTILLED_CONTENT_BYTES} UTF-8 bytes"
            )
        metadata[name] = distilled
    return metadata


def source_bool(
    explicit: Mapping[str, Any],
    name: str,
    environ: Mapping[str, str],
    env_name: str,
) -> bool:
    """Parse a boolean from explicit configuration or an environment mapping."""
    value = explicit.get(name)
    if value is None:
        value = environ.get(env_name)
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off", ""}:
        return False
    raise ValueError(f"{name} must be a boolean")


def source_float(value: Any, name: str, *, default: float) -> float:
    """Parse a positive float from configuration input."""
    if value is None:
        return default
    if isinstance(value, bool):
        raise ValueError(f"{name} must be a number")
    try:
        result = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{name} must be a number") from error
    if result <= 0:
        raise ValueError(f"{name} must be > 0")
    return result


def mapping_text(value: Mapping[str, Any], name: str) -> str:
    """Read a required text field from a mapping."""
    return require_text(value.get(name), name)


def mapping_optional_text(value: Mapping[str, Any], name: str) -> str | None:
    """Read an optional text field from a mapping."""
    return optional_text(value.get(name), name)


def optional_text(value: Any, name: str) -> str | None:
    """Validate optional text input."""
    if value is None:
        return None
    return require_text(value, name)


def require_text(value: Any, name: str) -> str:
    """Validate and normalize required text input."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be a non-empty string")
    return value.strip()


def bounded_int(value: int, name: str, *, minimum: int, maximum: int) -> int:
    """Validate an integer within inclusive bounds."""
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} must be an integer")
    if value < minimum or value > maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def reject_unknown_keys(
    value: Mapping[str, Any],
    allowed: set[str],
    name: str,
) -> None:
    """Reject mapping keys outside an explicit allowlist."""
    unknown = {str(key) for key in value if key not in allowed}
    if unknown:
        raise ValueError(
            f"{name} contains unsupported keys: {', '.join(sorted(unknown))}"
        )
