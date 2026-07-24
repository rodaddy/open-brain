"""Private validation helpers for persisted runtime content and scope data."""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Protocol

MAX_DISTILLED_CONTENT_BYTES = 16 * 1024
MAX_REFLEX_QUERY_CHARS = 4_000
MAX_CITATION_ID_CHARS = 500
MAX_SOURCE_REF_CHARS = 1_000
MAX_SOURCE_REF_SOURCE_CHARS = 200
MAX_SOURCE_REF_TYPE_CHARS = 200
MAX_SOURCE_REF_ID_CHARS = 500
MAX_SOURCE_REF_NAMESPACE_CHARS = 200


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


REFLEX_ENVELOPE_SCHEMA = "openbrain.agent_reflex_pointers.v1"
_PRIOR_CONTEXT_REFERENCE_KEYS = {"citation_id", "source_ref"}
_SOURCE_REF_OBJECT_KEYS = {"source", "type", "id", "namespace"}
MAX_PRIOR_CONTEXT_ITEMS = 200


def validate_reflex_scope(
    result: Any,
    namespace: str,
    scope: RuntimeScopeCoordinates,
) -> None:
    """Require a reflex-pointer result to be the exact-scope v1 envelope.

    The runtime must never surface a reflex payload that fails to prove the
    ordinary ``openbrain.agent_reflex_pointers.v1`` schema tag or the requested
    exact scope, so a server that returned another tool's shape, or scope for a
    different lane, is rejected instead of leaking foreign pointers.
    """
    if not isinstance(result, Mapping):
        raise ValueError("agent_reflex_pointers result missing scope")
    if result.get("schema") != REFLEX_ENVELOPE_SCHEMA:
        raise ValueError(
            "agent_reflex_pointers result is not the "
            f"{REFLEX_ENVELOPE_SCHEMA} envelope"
        )
    candidate = result.get("scope")
    if not isinstance(candidate, Mapping):
        raise ValueError("agent_reflex_pointers result missing scope")
    validate_exact_fields(
        candidate,
        exact_scope_fields(namespace, scope),
        "agent_reflex_pointers result",
    )


def reflex_query(value: Any) -> str:
    """Validate the reflex query against the server's exact 4,000-char bound."""
    return _bounded_text(value, "query", MAX_REFLEX_QUERY_CHARS)


def sanitize_prior_context(value: Any) -> list[dict[str, Any]]:
    """Return body-free prior-context references or raise on anything else.

    Only ``citation_id`` and ``source_ref`` identities are accepted, mirroring
    the server ``prior_context`` contract: at least one identity per reference,
    ``source_ref`` in its string form or the structural ``{source,type,id}``
    object, and NO arbitrary bodies or extra secret-like fields. Raw
    prior-context text or any unknown key is rejected before it can reach the
    transport.
    """
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise ValueError("prior_context must be an array of references")
    references = list(value)
    if len(references) > MAX_PRIOR_CONTEXT_ITEMS:
        raise ValueError(
            f"prior_context must contain at most {MAX_PRIOR_CONTEXT_ITEMS} references"
        )
    return [_sanitize_prior_context_reference(item) for item in references]


def _sanitize_prior_context_reference(item: Any) -> dict[str, Any]:
    if not isinstance(item, Mapping):
        raise ValueError("prior_context reference must be an object")
    unknown = {str(key) for key in item if key not in _PRIOR_CONTEXT_REFERENCE_KEYS}
    if unknown:
        raise ValueError(
            "prior_context reference contains unsupported keys: "
            + ", ".join(sorted(unknown))
        )
    reference: dict[str, Any] = {}
    if "citation_id" in item:
        reference["citation_id"] = _bounded_text(
            item["citation_id"], "citation_id", MAX_CITATION_ID_CHARS
        )
    if "source_ref" in item:
        reference["source_ref"] = _sanitize_source_ref(item["source_ref"])
    if not reference:
        raise ValueError(
            "prior_context reference requires citation_id or source_ref"
        )
    return reference


def _sanitize_source_ref(value: Any) -> Any:
    if isinstance(value, str):
        return _bounded_text(value, "source_ref", MAX_SOURCE_REF_CHARS)
    if isinstance(value, Mapping):
        unknown = {str(key) for key in value if key not in _SOURCE_REF_OBJECT_KEYS}
        if unknown:
            raise ValueError(
                "source_ref object contains unsupported keys: "
                + ", ".join(sorted(unknown))
            )
        structural: dict[str, Any] = {
            "source": _bounded_text(
                value.get("source"),
                "source_ref.source",
                MAX_SOURCE_REF_SOURCE_CHARS,
            ),
            "type": _bounded_text(
                value.get("type"), "source_ref.type", MAX_SOURCE_REF_TYPE_CHARS
            ),
            "id": _bounded_text(
                value.get("id"), "source_ref.id", MAX_SOURCE_REF_ID_CHARS
            ),
        }
        if "namespace" in value:
            structural["namespace"] = _bounded_text(
                value.get("namespace"),
                "source_ref.namespace",
                MAX_SOURCE_REF_NAMESPACE_CHARS,
            )
        return structural
    raise ValueError("source_ref must be a string or a structural object")


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


def _bounded_text(value: Any, name: str, maximum: int) -> str:
    text = require_text(value, name)
    if len(text) > maximum:
        raise ValueError(f"{name} must contain at most {maximum} characters")
    return text


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
