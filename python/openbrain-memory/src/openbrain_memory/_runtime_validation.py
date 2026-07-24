"""Private validation helpers for persisted runtime content and scope data."""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime
from typing import Any, Protocol
from uuid import UUID

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
            f"agent_reflex_pointers result is not the {REFLEX_ENVELOPE_SCHEMA} envelope"
        )
    candidate = result.get("scope")
    if not isinstance(candidate, Mapping):
        raise ValueError("agent_reflex_pointers result missing scope")
    validate_exact_fields(
        candidate,
        exact_scope_fields(namespace, scope),
        "agent_reflex_pointers result",
    )


REFLEX_STATUSES = {"ok", "degraded", "error"}
REFLEX_POINTERS_LABEL = "pointers"
REFLEX_CITATION_KIND = "pointer"
REFLEX_NAMESPACE_SOURCE = "authorization"
REFLEX_EMPTY_REASONS = {"whole_pack_budget"}
REFLEX_TIERS = {"hot", "warm", "cold"}
REFLEX_SOURCE_TYPES = {"thought", "decision", "relationship", "project", "session"}
REFLEX_SOURCE_REF_SOURCE = "brain"
REFLEX_ALLOCATION_ORDER = (
    "working_set",
    "recovery",
    "durable_lane_context",
    "durable_memory",
    "profile_guidance",
    "process_guidance",
    "repo_facts",
    "pointers",
    "candidate_memory",
)
MAX_REFLEX_POINTER_ITEMS = 500
MAX_TIMESTAMP_CHARS = 100
MAX_STATUS_CHARS = 100
MAX_REFLEX_WARNING_ITEMS = 200
_ISO_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$")

_POINTER_ITEM_KEYS = {
    "id",
    "source_type",
    "namespace",
    "tier",
    "created_at",
    "updated_at",
    "citation_id",
    "source_ref",
}
_CITATION_KEYS = {"id", "kind", "source_ref"}
_WARNING_CHANNELS = ("scope_denials", "degraded_sources", "truncation")


def project_reflex_result(
    result: Any,
    namespace: str,
    scope: RuntimeScopeCoordinates,
    expected_query: str,
) -> dict[str, Any]:
    """Return a freshly built, body-free ``agent_reflex_pointers.v1`` envelope.

    The runtime must never hand an agent an arbitrary server payload. This
    validates and projects every top-level truth of the published reflex
    envelope and rebuilds a new mapping from scratch: it never mutates or returns
    the untrusted original, and it copies no nested value it has not explicitly
    allowlisted as content-free. Any missing invariant, broken pointer/citation
    bijection, raw body/display/private field, or unknown key raises
    ``ValueError`` so the reflex fails closed with a content-free receipt.
    """
    validate_reflex_scope(result, namespace, scope)
    assert isinstance(result, Mapping)  # validate_reflex_scope proved this

    status = _bounded_text(result.get("status"), "status", MAX_STATUS_CHARS)
    if status not in REFLEX_STATUSES:
        raise ValueError("agent_reflex_pointers status is not a published status")
    if result.get("placement") != "client_owned":
        raise ValueError("agent_reflex_pointers placement must be client_owned")
    if result.get("resolvable_reference_only") is not True:
        raise ValueError("agent_reflex_pointers resolvable_reference_only must be true")
    query = _bounded_text(result.get("query"), "query", MAX_REFLEX_QUERY_CHARS)
    if query != expected_query:
        raise ValueError("agent_reflex_pointers query does not match the request")

    pointers, emitted_references = _project_reflex_pointers(result.get("pointers"))
    citations = _project_reflex_citations(result.get("citations"), emitted_references)

    scope_candidate = result.get("scope")
    assert isinstance(scope_candidate, Mapping)  # proven by validate_reflex_scope

    return {
        "schema": REFLEX_ENVELOPE_SCHEMA,
        "status": status,
        "placement": "client_owned",
        "resolvable_reference_only": True,
        "scope": _project_reflex_scope(scope_candidate, namespace, scope),
        "pointers": pointers,
        "warnings": _project_reflex_warnings(result.get("warnings")),
        "budget": _project_reflex_budget(result.get("budget")),
        "citations": citations,
    }


def _project_reflex_scope(
    candidate: Mapping[str, Any],
    namespace: str,
    scope: RuntimeScopeCoordinates,
) -> dict[str, Any]:
    if candidate.get("namespace_source") != REFLEX_NAMESPACE_SOURCE:
        raise ValueError("agent_reflex_pointers namespace_source must be authorization")
    return {
        **exact_scope_fields(namespace, scope),
        "namespace_source": REFLEX_NAMESPACE_SOURCE,
    }


def _project_reflex_pointers(
    value: Any,
) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    if not isinstance(value, Mapping):
        raise ValueError("agent_reflex_pointers pointers section must be an object")
    if value.get("label") != REFLEX_POINTERS_LABEL:
        raise ValueError("pointers section label must be 'pointers'")
    if value.get("namespace_scoped") is not True:
        raise ValueError("pointers section must be namespace_scoped")
    if value.get("resolvable_reference_only") is not True:
        raise ValueError("pointers section resolvable_reference_only must be true")
    if not isinstance(value.get("truncated"), bool):
        raise ValueError("pointers section truncated must be a boolean")

    raw_items = value.get("items")
    if not isinstance(raw_items, Sequence) or isinstance(raw_items, (str, bytes)):
        raise ValueError("pointers section items must be an array")
    if len(raw_items) > MAX_REFLEX_POINTER_ITEMS:
        raise ValueError(f"pointers section exceeds {MAX_REFLEX_POINTER_ITEMS} items")

    items: list[dict[str, Any]] = []
    references: dict[str, dict[str, Any]] = {}
    for raw in raw_items:
        item, citation_id, source_ref = _project_pointer_item(raw)
        if citation_id in references:
            raise ValueError("pointers section emitted duplicate citation ids")
        items.append(item)
        references[citation_id] = source_ref

    item_count = value.get("item_count")
    if isinstance(item_count, bool) or not isinstance(item_count, int):
        raise ValueError("pointers section item_count must be an integer")
    if item_count != len(items):
        raise ValueError("pointers section item_count does not match emitted items")

    projected: dict[str, Any] = {
        "label": REFLEX_POINTERS_LABEL,
        "namespace_scoped": True,
        "resolvable_reference_only": True,
        "items": items,
        "item_count": len(items),
        "truncated": bool(value.get("truncated")),
    }
    if "empty_reason" in value:
        if items:
            raise ValueError("pointers section empty_reason set with emitted items")
        empty_reason = value.get("empty_reason")
        if empty_reason not in REFLEX_EMPTY_REASONS:
            raise ValueError("pointers section empty_reason is not published")
        projected["empty_reason"] = empty_reason
    return projected, references


def _project_pointer_item(
    value: Any,
) -> tuple[dict[str, Any], str, dict[str, Any]]:
    if not isinstance(value, Mapping):
        raise ValueError("pointer item must be an object")
    unknown = {str(key) for key in value if key not in _POINTER_ITEM_KEYS}
    if unknown:
        raise ValueError(
            "pointer item carries unsupported field(s): " + ", ".join(sorted(unknown))
        )
    record_id = _uuid_text(value.get("id"), "pointer.id")
    source_type = value.get("source_type")
    if source_type not in REFLEX_SOURCE_TYPES:
        raise ValueError("pointer.source_type is not a published brain source type")
    pointer_namespace = _bounded_text(
        value.get("namespace"),
        "pointer.namespace",
        MAX_SOURCE_REF_NAMESPACE_CHARS,
    )
    tier = value.get("tier")
    if tier is not None and tier not in REFLEX_TIERS:
        raise ValueError("pointer.tier is not a published tier")
    citation_id = _bounded_text(
        value.get("citation_id"), "pointer.citation_id", MAX_CITATION_ID_CHARS
    )
    expected_citation_id = f"brain_record:{source_type}:{record_id}"
    if citation_id != expected_citation_id:
        raise ValueError("pointer.citation_id does not match pointer identity")
    source_ref = _project_structural_source_ref(
        value.get("source_ref"), "pointer.source_ref", pointer_namespace
    )
    if (
        source_ref["source"] != REFLEX_SOURCE_REF_SOURCE
        or source_ref["type"] != source_type
        or source_ref["id"] != record_id
    ):
        raise ValueError("pointer.source_ref does not match pointer identity")
    item: dict[str, Any] = {
        "id": record_id,
        "source_type": source_type,
        "namespace": pointer_namespace,
        "tier": tier,
        "created_at": _iso_timestamp(value.get("created_at"), "pointer.created_at"),
        "updated_at": _nullable_iso_timestamp(
            value.get("updated_at"), "pointer.updated_at"
        ),
        "citation_id": citation_id,
        "source_ref": source_ref,
    }
    return item, citation_id, source_ref


def _project_reflex_citations(
    value: Any,
    emitted_references: Mapping[str, Mapping[str, Any]],
) -> list[dict[str, Any]]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise ValueError("agent_reflex_pointers citations must be an array")
    citations: list[dict[str, Any]] = []
    citation_ids: list[str] = []
    for raw in value:
        if not isinstance(raw, Mapping):
            raise ValueError("citation must be an object")
        unknown = {str(key) for key in raw if key not in _CITATION_KEYS}
        if unknown:
            raise ValueError(
                "citation carries unsupported field(s): " + ", ".join(sorted(unknown))
            )
        if raw.get("kind") != REFLEX_CITATION_KIND:
            raise ValueError("citation kind must be 'pointer'")
        citation_id = _bounded_text(raw.get("id"), "citation.id", MAX_CITATION_ID_CHARS)
        if citation_id in citation_ids:
            raise ValueError("citations contain a duplicate pointer id")
        expected_source_ref = emitted_references.get(citation_id)
        if expected_source_ref is None:
            raise ValueError("citation does not identify an emitted pointer")
        source_ref = _project_structural_source_ref(
            raw.get("source_ref"),
            "citation.source_ref",
            str(expected_source_ref["namespace"]),
        )
        if expected_source_ref != source_ref:
            raise ValueError("citation source_ref does not match its emitted pointer")
        citations.append(
            {
                "id": citation_id,
                "kind": REFLEX_CITATION_KIND,
                "source_ref": source_ref,
            }
        )
        citation_ids.append(citation_id)
    if set(citation_ids) != set(emitted_references):
        raise ValueError("citations are not a bijection with the emitted pointer items")
    return citations


def _project_structural_source_ref(
    value: Any,
    name: str,
    namespace: str,
) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{name} must be a structural object")
    unknown = {str(key) for key in value if key not in _SOURCE_REF_OBJECT_KEYS}
    if unknown:
        raise ValueError(
            f"{name} carries unsupported field(s): " + ", ".join(sorted(unknown))
        )
    source = value.get("source")
    if source != REFLEX_SOURCE_REF_SOURCE:
        raise ValueError(f"{name}.source must be brain")
    source_type = value.get("type")
    if source_type not in REFLEX_SOURCE_TYPES:
        raise ValueError(f"{name}.type is not a published brain source type")
    source_namespace = value.get("namespace")
    if source_namespace != namespace:
        raise ValueError(f"{name}.namespace does not match pointer identity")
    return {
        "source": REFLEX_SOURCE_REF_SOURCE,
        "type": source_type,
        "id": _uuid_text(value.get("id"), f"{name}.id"),
        "namespace": namespace,
    }


def _project_reflex_warnings(value: Any) -> dict[str, list[dict[str, Any]]]:
    warnings: dict[str, list[dict[str, Any]]] = {
        channel: [] for channel in _WARNING_CHANNELS
    }
    if value is None:
        return warnings
    if not isinstance(value, Mapping):
        raise ValueError("agent_reflex_pointers warnings must be an object")
    for channel in _WARNING_CHANNELS:
        entries = value.get(channel)
        if entries is None:
            continue
        if not isinstance(entries, Sequence) or isinstance(entries, (str, bytes)):
            raise ValueError(f"warnings.{channel} must be an array")
        if len(entries) > MAX_REFLEX_WARNING_ITEMS:
            raise ValueError(f"warnings.{channel} exceeds the bounded item count")
        warnings[channel] = [
            _project_warning_entry(channel, entry) for entry in entries
        ]
    return warnings


def _project_warning_entry(channel: str, value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError("warning entry must be an object")
    source = value.get("source")
    if channel == "scope_denials":
        reasons = value.get("reasons")
        if source != "durable_memory" or reasons != ["no_readable_tables"]:
            raise ValueError("scope denial is not a published reflex warning")
        return {"source": "durable_memory", "reasons": ["no_readable_tables"]}
    if channel == "degraded_sources":
        if source != "durable_memory" or value.get("reason") != "recall_failed":
            raise ValueError("degraded source is not a published reflex warning")
        return {"source": "durable_memory", "reason": "recall_failed"}
    if source == "pointers.items":
        max_items = _bounded_nonnegative_int(
            value.get("max_items"), "warning.max_items"
        )
        if max_items > MAX_REFLEX_POINTER_ITEMS:
            raise ValueError("warning.max_items exceeds the pointer item bound")
        return {"source": "pointers.items", "max_items": max_items}
    if source == "pointers" and value.get("reason") == "whole_pack_budget":
        projected: dict[str, Any] = {
            "source": "pointers",
            "reason": "whole_pack_budget",
            "max_chars": _bounded_nonnegative_int(
                value.get("max_chars"), "warning.max_chars"
            ),
        }
        if "starved" in value:
            if value.get("starved") is not True:
                raise ValueError("warning.starved must be true when present")
            projected["starved"] = True
        return projected
    raise ValueError("truncation entry is not a published reflex warning")


def _project_reflex_budget(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, Mapping):
        raise ValueError("agent_reflex_pointers budget must be an object")
    budget: dict[str, Any] = {}
    if "requested" in value:
        budget["requested"] = _project_requested_budget(value.get("requested"))
    if "whole_pack" in value:
        budget["whole_pack"] = _project_whole_pack_budget(value.get("whole_pack"))
    return budget


def _project_requested_budget(value: Any) -> dict[str, int] | None:
    if value is None:
        return None
    if not isinstance(value, Mapping):
        raise ValueError("budget.requested must be an object")
    requested: dict[str, int] = {}
    if "max_tokens" in value:
        max_tokens = _bounded_nonnegative_int(
            value.get("max_tokens"), "budget.requested.max_tokens"
        )
        if not 100 <= max_tokens <= 20_000:
            raise ValueError("budget.requested.max_tokens is out of range")
        requested["max_tokens"] = max_tokens
    if "max_latency_ms" in value:
        max_latency_ms = _bounded_nonnegative_int(
            value.get("max_latency_ms"), "budget.requested.max_latency_ms"
        )
        if not 1 <= max_latency_ms <= 10_000:
            raise ValueError("budget.requested.max_latency_ms is out of range")
        requested["max_latency_ms"] = max_latency_ms
    return requested


def _project_whole_pack_budget(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError("budget.whole_pack must be an object")
    content_char_limit = _bounded_nonnegative_int(
        value.get("content_char_limit"), "budget.whole_pack.content_char_limit"
    )
    content_chars_used = _bounded_nonnegative_int(
        value.get("content_chars_used"), "budget.whole_pack.content_chars_used"
    )
    if content_chars_used > content_char_limit:
        raise ValueError("budget.whole_pack usage exceeds its limit")
    order = value.get("allocation_order")
    if not isinstance(order, Sequence) or isinstance(order, (str, bytes)):
        raise ValueError("budget.whole_pack.allocation_order must be an array")
    allocation_order = list(order)
    if tuple(allocation_order) != REFLEX_ALLOCATION_ORDER:
        raise ValueError("budget allocation order does not match the published order")
    return {
        "content_char_limit": content_char_limit,
        "content_chars_used": content_chars_used,
        "allocation_order": allocation_order,
    }


def _bounded_nonnegative_int(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{name} must be a non-negative integer")
    return value


def _uuid_text(value: Any, name: str) -> str:
    text = _bounded_text(value, name, MAX_SOURCE_REF_ID_CHARS)
    try:
        canonical = str(UUID(text))
    except ValueError as error:
        raise ValueError(f"{name} must be a UUID") from error
    if text.lower() != canonical:
        raise ValueError(f"{name} must be a canonical UUID")
    return canonical


def _iso_timestamp(value: Any, name: str) -> str:
    text = _bounded_text(value, name, MAX_TIMESTAMP_CHARS)
    if not _ISO_TIMESTAMP.fullmatch(text):
        raise ValueError(f"{name} must be a canonical UTC timestamp")
    try:
        datetime.fromisoformat(text.removesuffix("Z") + "+00:00")
    except ValueError as error:
        raise ValueError(f"{name} must be a valid UTC timestamp") from error
    return text


def _nullable_iso_timestamp(value: Any, name: str) -> str | None:
    if value is None:
        return None
    return _iso_timestamp(value, name)


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
        raise ValueError("prior_context reference requires citation_id or source_ref")
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
