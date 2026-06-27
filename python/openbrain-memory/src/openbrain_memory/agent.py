from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol, cast

from .client import JSON
from .policy import (
    SECRET_PATTERNS,
    SENSITIVE_KEY_RE,
    RetryPolicy,
    idempotency_key,
    with_retry,
)

EVENT_TYPES = {
    "fact",
    "decision",
    "blocker",
    "action",
    "artifact",
    "receipt",
    "question",
    "correction",
    "handoff",
}
IMPORTANCE_LEVELS = {"hot", "warm", "cold"}
PROTECTED_KEYS = {
    "agent",
    "authorization",
    "project",
    "session_key",
    "namespace",
    "role",
    "source",
    "event_type",
    "content",
    "kind",
    "title",
    "rationale",
    "summary",
    "token",
    "x-namespace",
    "x_namespace",
}
NESTED_AUTHORITY_KEYS = {
    "authorization",
    "headers",
    "namespace",
    "role",
    "token",
    "x-namespace",
}
_MAX_METADATA_KEYS = 50
_MAX_METADATA_KEY_LENGTH = 100
_MAX_METADATA_JSON_BYTES = 100_000
_MAX_METADATA_DEPTH = 16
SESSION_START_KEYS = {"channel_id", "thread_id", "topic"}
SESSION_WRAP_KEYS = {"key_decisions", "next_steps", "receipt_refs"}
DECISION_KEYS = {"alternatives", "tags", "context"}
THOUGHT_KEYS = {"tags"}
LANE_STATUSES = {"active", "wrapped", "archived"}
SEARCH_MODES = {"hybrid", "vector", "keyword"}
REPO_FACT_TYPES = {
    "api_contract",
    "dependency",
    "gotcha",
    "migration",
    "ownership",
    "source_pointer",
    "validation",
    "workflow",
}


class MemoryClient(Protocol):
    def session_start(self, **arguments: Any) -> JSON: ...

    def session_context(self, **arguments: Any) -> JSON: ...

    def append_session_event(self, **arguments: Any) -> JSON: ...

    def search_all(self, **arguments: Any) -> JSON: ...

    def brain_answer(self, **arguments: Any) -> JSON: ...

    def lane_load(self, **arguments: Any) -> JSON: ...

    def lane_upsert(self, **arguments: Any) -> JSON: ...

    def list_repo_facts(self, **arguments: Any) -> JSON: ...

    def log_thought(self, **arguments: Any) -> JSON: ...

    def log_decision(self, **arguments: Any) -> JSON: ...

    def session_wrap(self, **arguments: Any) -> JSON: ...

    def upsert_repo_fact(self, **arguments: Any) -> JSON: ...


class MemorySpool(Protocol):
    def append(
        self,
        operation: str,
        payload: Mapping[str, Any],
        *,
        key: str | None = None,
    ) -> str: ...


@dataclass(frozen=True)
class MemoryPolicy:
    max_items: int = 8
    max_chars: int = 4000
    max_item_chars: int = 800

    def __post_init__(self) -> None:
        if self.max_items < 1:
            raise ValueError("MemoryPolicy.max_items must be >= 1")
        if self.max_chars < 1:
            raise ValueError("MemoryPolicy.max_chars must be >= 1")
        if self.max_item_chars < 1:
            raise ValueError("MemoryPolicy.max_item_chars must be >= 1")


@dataclass(frozen=True)
class MemoryItem:
    text: str
    source: str | None = None
    kind: str | None = None
    score: float | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class MemoryContext:
    query: str
    items: tuple[MemoryItem, ...]
    text: str
    raw: Mapping[str, Any]
    session: JSON | None = None
    answer: JSON | None = None

    def as_prompt_text(self) -> str:
        return self.text


class AgentMemory:
    def __init__(
        self,
        client: MemoryClient,
        agent: str,
        project: str | None = None,
        policy: MemoryPolicy | Mapping[str, Any] | None = None,
        spool: MemorySpool | None = None,
        retry_policy: RetryPolicy | Mapping[str, Any] | None = None,
    ) -> None:
        self.client: MemoryClient = client
        self.agent = agent
        self.project = project
        self.policy = _coerce_policy(policy)
        self.spool = spool
        self.retry_policy = _coerce_retry_policy(retry_policy)
        self.conversation_key: str | None = None

    def start_session(self, conversation_key: str, **metadata: Any) -> JSON:
        self._reject_reserved_metadata(metadata)
        self._reject_unknown_metadata(metadata, SESSION_START_KEYS)
        payload = dict(metadata)
        payload["session_key"] = conversation_key
        payload["agent"] = self.agent
        if self.project is not None:
            payload["project"] = self.project
        result = self._call_write("session_start", payload, self.client.session_start)
        self.conversation_key = conversation_key
        return result

    def recall(
        self,
        query: str,
        *,
        limit: int | None = None,
        include_decisions: bool = True,
        include_facts: bool = True,
        include_raw: bool = False,
        include_session: bool = False,
        include_answer: bool = False,
    ) -> MemoryContext:
        effective_limit = self._effective_limit(limit)
        sources = _sources(include_decisions, include_facts)
        payload = {
            "query": query,
            "limit": effective_limit,
        }
        if sources:
            payload["sources"] = sources

        session = (
            self.client.session_context(
                session_key=self.conversation_key,
                include_events=True,
                event_limit=effective_limit,
            )
            if include_session and self.conversation_key
            else None
        )
        raw = self.client.search_all(**payload)
        answer = (
            self.client.brain_answer(query=query, limit=effective_limit)
            if include_answer
            else None
        )
        raw_mapping = raw if isinstance(raw, Mapping) else {}
        items = _bounded_items(raw_mapping, self.policy, effective_limit)
        return MemoryContext(
            query=query,
            items=items,
            text=_prompt_text(items, self.policy),
            raw=raw_mapping if include_raw else {},
            session=cast(JSON | None, session),
            answer=cast(JSON | None, answer),
        )

    def load_session_context(
        self,
        session_key: str | None = None,
        *,
        channel_id: str | None = None,
        thread_id: str | None = None,
        include_events: bool | None = None,
        event_limit: int | None = None,
        event_types: list[str] | None = None,
        importance: str | None = None,
    ) -> JSON:
        if not session_key and not channel_id:
            raise ValueError("load_session_context requires session_key or channel_id")
        payload: dict[str, Any] = {}
        _set_optional_str(payload, "session_key", session_key)
        _set_optional_str(payload, "channel_id", channel_id)
        _set_optional_str(payload, "thread_id", thread_id)
        if include_events is not None:
            payload["include_events"] = include_events
        if event_limit is not None:
            payload["event_limit"] = _bounded_int(
                event_limit,
                "event_limit",
                minimum=1,
                maximum=200,
            )
        if event_types is not None:
            payload["event_types"] = _str_list(event_types, "event_types")
        if importance is not None:
            payload["importance"] = _enum_value(
                importance,
                "importance",
                IMPORTANCE_LEVELS,
            )
        return self.client.session_context(**payload)

    def load_lane(
        self,
        session_key: str | None = None,
        *,
        project: str | None = None,
        agent: str | None = None,
        channel_id: str | None = None,
        status: str | None = None,
        limit: int | None = None,
    ) -> JSON:
        payload: dict[str, Any] = {}
        _set_optional_str(payload, "session_key", session_key)
        _set_optional_str(
            payload,
            "project",
            project if project is not None else self.project,
        )
        _set_optional_str(payload, "agent", agent)
        _set_optional_str(payload, "channel_id", channel_id)
        if status is not None:
            payload["status"] = _enum_value(status, "status", LANE_STATUSES)
        if limit is not None:
            payload["limit"] = _bounded_int(limit, "limit", minimum=1, maximum=50)
        return self.client.lane_load(**payload)

    def update_lane(
        self,
        session_key: str,
        *,
        status: str | None = None,
        agent: str | None = None,
        source: str | None = None,
        channel_id: str | None = None,
        thread_id: str | None = None,
        project: str | None = None,
        topic: str | None = None,
        current_context_md: str | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> JSON:
        payload: dict[str, Any] = {
            "session_key": _required_str(session_key, "session_key")
        }
        if status is not None:
            payload["status"] = _enum_value(status, "status", LANE_STATUSES)
        _set_optional_str(payload, "agent", agent if agent is not None else self.agent)
        _set_optional_str(payload, "source", source)
        _set_optional_str(payload, "channel_id", channel_id)
        _set_optional_str(payload, "thread_id", thread_id)
        _set_optional_str(
            payload,
            "project",
            project if project is not None else self.project,
        )
        _set_optional_str(payload, "topic", topic)
        _set_optional_str(payload, "current_context_md", current_context_md)
        if metadata is not None:
            self._reject_reserved_metadata(metadata)
            payload["metadata"] = dict(metadata)
        return self._call_write("lane_upsert", payload, self.client.lane_upsert)

    def answer(
        self,
        query: str,
        *,
        limit: int | None = None,
        search_mode: str | None = None,
        tier: str | None = None,
        max_age_days: int | None = None,
        include_raw: bool | None = None,
    ) -> JSON:
        payload: dict[str, Any] = {"query": _required_str(query, "query")}
        if limit is not None:
            payload["limit"] = _bounded_int(limit, "limit", minimum=1, maximum=25)
        if search_mode is not None:
            payload["search_mode"] = _enum_value(
                search_mode,
                "search_mode",
                SEARCH_MODES,
            )
        if tier is not None:
            payload["tier"] = _enum_value(tier, "tier", IMPORTANCE_LEVELS)
        if max_age_days is not None:
            payload["max_age_days"] = _bounded_int(
                max_age_days,
                "max_age_days",
                minimum=1,
                maximum=3650,
            )
        if include_raw is not None:
            payload["include_raw"] = include_raw
        return self.client.brain_answer(**payload)

    def repo_facts(
        self,
        *,
        repo: str | None = None,
        collection: str | None = None,
        path: str | None = None,
        fact_type: str | None = None,
        subject: str | None = None,
        limit: int | None = None,
        offset: int | None = None,
    ) -> JSON:
        payload: dict[str, Any] = {}
        _set_optional_str(payload, "repo", repo)
        _set_optional_str(payload, "collection", collection)
        _set_optional_str(payload, "path", path)
        if fact_type is not None:
            payload["fact_type"] = _enum_value(
                fact_type,
                "fact_type",
                REPO_FACT_TYPES,
            )
        _set_optional_str(payload, "subject", subject)
        if limit is not None:
            payload["limit"] = _bounded_int(limit, "limit", minimum=1, maximum=250)
        if offset is not None:
            payload["offset"] = _bounded_int(offset, "offset", minimum=0)
        return self.client.list_repo_facts(**payload)

    def upsert_repo_fact(
        self,
        metadata: Mapping[str, Any],
        *,
        validation: Mapping[str, Any] | None = None,
    ) -> JSON:
        self._reject_reserved_metadata(metadata)
        payload: dict[str, Any] = {"metadata": dict(metadata)}
        if validation is not None:
            self._reject_reserved_metadata(validation)
            payload["validation"] = dict(validation)
        return self._call_write(
            "upsert_repo_fact",
            payload,
            self.client.upsert_repo_fact,
        )

    def record_receipt(
        self,
        action: str,
        *,
        sources: list[Mapping[str, Any]],
        outputs: list[Mapping[str, Any]],
        validations: list[Mapping[str, Any]],
        timestamp: str | None = None,
        residual_risk: str | None = None,
        **metadata: Any,
    ) -> JSON:
        self._require_session("record_receipt")
        self._reject_reserved_metadata(metadata)
        if "receipt" in metadata:
            raise ValueError("metadata contains reserved keys: receipt")

        receipt: dict[str, Any] = {
            "schema": "openbrain.receipt.v1",
            "action": _required_str(action, "action"),
            "agent": self.agent,
            "session_key": self.conversation_key,
            "timestamp": timestamp if timestamp is not None else _utc_now(),
            "sources": _mapping_list(sources, "sources"),
            "outputs": _mapping_list(outputs, "outputs"),
            "validations": _validation_list(validations),
        }
        if self.project is not None:
            receipt["project"] = self.project
        if residual_risk is not None:
            receipt["residual_risk"] = _required_str(
                residual_risk,
                "residual_risk",
            )
        _reject_receipt_secrets(
            {
                "sources": receipt["sources"],
                "outputs": receipt["outputs"],
                "validations": receipt["validations"],
                "residual_risk": receipt.get("residual_risk"),
                "metadata": metadata,
            }
        )

        return self.append_event(
            self.agent,
            f"Receipt: {action}",
            event_type="receipt",
            receipt=receipt,
            **metadata,
        )

    def append_event(self, role: str, content: str, **metadata: Any) -> JSON:
        self._require_session("append_event")
        event_type = str(metadata.pop("event_type", "fact"))
        if event_type not in EVENT_TYPES:
            raise ValueError(f"Unsupported event_type: {event_type}")
        artifact_path = metadata.pop("artifact_path", None)
        importance = metadata.pop("importance", None)
        self._reject_reserved_metadata(metadata)
        key = idempotency_key()
        payload = {
            "event_type": event_type,
            "content": content,
            "source": role,
            "metadata": {**dict(metadata), "idempotency_key": key},
            "session_key": self.conversation_key,
        }
        if artifact_path is not None:
            payload["artifact_path"] = _required_str(artifact_path, "artifact_path")
        if importance is not None:
            payload["importance"] = _enum_value(
                importance,
                "importance",
                IMPORTANCE_LEVELS,
            )
        return self._call_write(
            "append_session_event",
            payload,
            self.client.append_session_event,
            key=key,
        )

    def remember_fact(self, text: str, **metadata: Any) -> JSON:
        self._reject_reserved_metadata(metadata)
        self._reject_unknown_metadata(metadata, THOUGHT_KEYS)
        key = idempotency_key()
        tags = _tags("fact", metadata.pop("tags", None))
        tags.append(f"idempotency:{key}")
        payload: dict[str, Any] = {"content": text, "tags": tags}
        return self._call_write(
            "log_thought",
            payload,
            self.client.log_thought,
            key=key,
        )

    def remember_decision(self, text: str, **metadata: Any) -> JSON:
        self._reject_reserved_metadata(metadata)
        self._reject_unknown_metadata(metadata, DECISION_KEYS)
        idem = idempotency_key()
        payload: dict[str, Any] = {
            "title": _title_from_text(text),
            "rationale": text,
            "tags": [f"idempotency:{idem}"],
        }
        if "alternatives" in metadata:
            payload["alternatives"] = _str_list(
                metadata["alternatives"],
                "alternatives",
            )
        if "context" in metadata:
            payload["context"] = _required_str(metadata["context"], "context")
        if "tags" in metadata:
            payload["tags"] = _tags(f"idempotency:{idem}", metadata["tags"])
        return self._call_write(
            "log_decision",
            payload,
            self.client.log_decision,
            key=idem,
        )

    def checkpoint(self, summary: str, **metadata: Any) -> JSON:
        self._require_session("checkpoint")
        if not summary:
            raise ValueError("checkpoint summary must not be empty")
        self._reject_reserved_metadata(metadata)
        self._reject_unknown_metadata(metadata, SESSION_WRAP_KEYS)
        key = idempotency_key()
        payload = self._session_payload(
            _session_wrap_metadata({"summary": summary, **metadata})
        )
        return self._call_write(
            "session_wrap",
            payload,
            self.client.session_wrap,
            key=key,
        )

    def compact(
        self,
        summary: str,
        *,
        key_decisions: list[str] | None = None,
        next_steps: list[str] | None = None,
        receipt_refs: list[str] | None = None,
        context_to_summary: Callable[[JSON], str] | None = None,
    ) -> JSON:
        self._require_session("compact")
        context = self.client.session_context(
            session_key=self.conversation_key,
            include_events=True,
            event_limit=self.policy.max_items,
        )
        distilled_summary = (
            context_to_summary(context)
            if context_to_summary is not None
            else _required_str(summary, "summary")
        )
        return self.wrap_session(
            distilled_summary,
            key_decisions=key_decisions,
            next_steps=next_steps,
            receipt_refs=receipt_refs,
        )

    def wrap_session(self, summary: str | None = None, **metadata: Any) -> JSON:
        self._require_session("wrap_session")
        if not summary:
            raise ValueError("wrap_session summary must not be empty")
        self._reject_reserved_metadata(metadata)
        self._reject_unknown_metadata(metadata, SESSION_WRAP_KEYS)
        payload = _session_wrap_metadata({"summary": summary, **metadata})
        key = idempotency_key()
        return self._call_write(
            "session_wrap",
            self._session_payload(payload),
            self.client.session_wrap,
            key=key,
        )

    def export_disclosure_bundle(
        self,
        *,
        events: list[Mapping[str, Any]] | None = None,
        repo_facts: list[Mapping[str, Any]] | None = None,
        receipts: list[Mapping[str, Any]] | None = None,
        lane: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        self._require_session("export_disclosure_bundle")
        lane_payload: dict[str, Any] = dict(lane or {})
        lane_payload["sessionKey"] = self.conversation_key
        lane_payload["agent"] = self.agent
        if self.project is not None:
            lane_payload["project"] = self.project
        event_payloads = [dict(item) for item in events or []]
        fact_payloads = [dict(item) for item in repo_facts or []]
        receipt_payloads = [dict(item) for item in receipts or []]
        return _export_disclosure_bundle(
            lane=lane_payload,
            events=event_payloads,
            repo_facts=fact_payloads,
            receipts=receipt_payloads,
        )

    def _session_payload(self, metadata: Mapping[str, Any]) -> dict[str, Any]:
        payload = dict(metadata)
        if self.project is not None:
            payload["project"] = self.project
        if self.conversation_key is not None:
            payload["session_key"] = self.conversation_key
        return payload

    def _require_session(self, method_name: str) -> None:
        if not self.conversation_key:
            raise RuntimeError(f"{method_name} requires start_session() first")

    def _reject_reserved_metadata(self, metadata: Mapping[str, Any]) -> None:
        if len(metadata) > _MAX_METADATA_KEYS:
            raise ValueError(f"metadata must have at most {_MAX_METADATA_KEYS} keys")
        long_keys = [
            str(key)
            for key in metadata
            if len(str(key)) > _MAX_METADATA_KEY_LENGTH
        ]
        if long_keys:
            names = ", ".join(sorted(long_keys))
            raise ValueError(
                "metadata keys must be at most "
                f"{_MAX_METADATA_KEY_LENGTH} characters: {names}"
            )
        try:
            encoded = json.dumps(metadata, separators=(",", ":")).encode("utf-8")
        except (TypeError, ValueError) as error:
            raise ValueError("metadata must be JSON serializable") from error
        if len(encoded) > _MAX_METADATA_JSON_BYTES:
            raise ValueError(
                f"metadata JSON must be at most {_MAX_METADATA_JSON_BYTES} bytes"
            )
        collisions = PROTECTED_KEYS.intersection(metadata)
        if collisions:
            names = ", ".join(sorted(collisions))
            raise ValueError(f"metadata contains reserved keys: {names}")
        self._reject_reserved_nested_metadata(metadata, "metadata", depth=0)

    def _reject_reserved_nested_metadata(
        self,
        value: Any,
        path: str,
        *,
        depth: int,
    ) -> None:
        if depth > _MAX_METADATA_DEPTH:
            raise ValueError(
                f"{path} exceeds maximum nesting depth ({_MAX_METADATA_DEPTH})"
            )
        if isinstance(value, Mapping):
            collisions = {
                str(key)
                for key in value
                if _authority_key(str(key)) in NESTED_AUTHORITY_KEYS
            }
            if collisions:
                names = ", ".join(sorted(collisions))
                raise ValueError(f"{path} contains reserved authority keys: {names}")
            for key, item in value.items():
                self._reject_reserved_nested_metadata(
                    item,
                    f"{path}.{key}",
                    depth=depth + 1,
                )
        elif isinstance(value, list | tuple):
            for index, item in enumerate(value):
                self._reject_reserved_nested_metadata(
                    item,
                    f"{path}[{index}]",
                    depth=depth + 1,
                )

    def _reject_unknown_metadata(
        self,
        metadata: Mapping[str, Any],
        allowed_keys: set[str],
    ) -> None:
        unknown = set(metadata).difference(allowed_keys)
        if unknown:
            names = ", ".join(sorted(unknown))
            raise ValueError(f"metadata contains unsupported keys: {names}")

    def _effective_limit(self, limit: int | None) -> int:
        if limit is None:
            return self.policy.max_items
        if limit < 1:
            raise ValueError("recall limit must be >= 1")
        return min(limit, self.policy.max_items)

    def _call_write(
        self,
        operation: str,
        payload: Mapping[str, Any],
        call: Any,
        *,
        key: str | None = None,
    ) -> JSON:
        write_payload = dict(payload)
        try:
            if operation == "session_start":
                return with_retry(
                    lambda: cast(JSON, call(**write_payload)),
                    retry_policy=self.retry_policy,
                )
            return cast(JSON, call(**write_payload))
        except Exception as error:
            if self.spool is not None:
                try:
                    self.spool.append(operation, write_payload, key=key)
                except Exception as spool_error:
                    error.add_note(f"Failed to spool {operation}: {spool_error}")
            raise


def _coerce_policy(policy: MemoryPolicy | Mapping[str, Any] | None) -> MemoryPolicy:
    if policy is None:
        return MemoryPolicy()
    if isinstance(policy, MemoryPolicy):
        return policy
    return MemoryPolicy(**dict(policy))


def _coerce_retry_policy(policy: RetryPolicy | Mapping[str, Any] | None) -> RetryPolicy:
    if policy is None:
        return RetryPolicy()
    if isinstance(policy, RetryPolicy):
        return policy
    return RetryPolicy(**dict(policy))


def _bounded_items(
    raw: Mapping[str, Any],
    policy: MemoryPolicy,
    limit: int,
) -> tuple[MemoryItem, ...]:
    results = raw.get("results", [])
    if not isinstance(results, list):
        return ()

    items: list[MemoryItem] = []
    used_chars = 0
    for result in results:
        if not isinstance(result, Mapping):
            continue
        text = _result_text(result)
        if not text:
            continue
        text = _trim(text, policy.max_item_chars)
        if used_chars + len(text) > policy.max_chars and items:
            break
        items.append(
            MemoryItem(
                text=text,
                source=_optional_str(result.get("source")),
                kind=_optional_str(result.get("kind") or result.get("type")),
                score=_optional_float(result.get("score")),
                metadata=_bounded_metadata(result),
            )
        )
        used_chars += len(text)
        if len(items) >= limit:
            break
    return tuple(items)


def _prompt_text(items: tuple[MemoryItem, ...], policy: MemoryPolicy) -> str:
    lines = []
    used_chars = 0
    for item in items:
        prefix_parts = [part for part in (item.kind, item.source) if part]
        prefix = f"[{'/'.join(prefix_parts)}] " if prefix_parts else ""
        prefix = f"- {prefix}"
        remaining = policy.max_chars - used_chars - len(prefix)
        if remaining <= 0:
            break
        line = prefix + _trim(item.text, remaining)
        lines.append(line)
        used_chars += len(line)
    return "\n".join(lines)


def _result_text(result: Mapping[str, Any]) -> str:
    for key in ("text", "content", "summary", "memory"):
        value = result.get(key)
        if isinstance(value, str):
            return value.strip()
    return ""


def _trim(text: str, max_chars: int) -> str:
    if max_chars < 1:
        return ""
    if len(text) <= max_chars:
        return text
    if max_chars <= 3:
        return "." * max_chars
    return text[: max_chars - 3].rstrip() + "..."


def _title_from_text(text: str) -> str:
    title = text.strip().splitlines()[0] if text.strip() else "Decision"
    return _trim(title, 120)


def _optional_str(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _optional_float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value)
    return None


def _sources(include_decisions: bool, include_facts: bool) -> str | None:
    if include_decisions or include_facts:
        return "brain"
    return "qmd"


def _tags(required: str, value: Any) -> list[str]:
    tags = [required]
    if isinstance(value, list):
        tags.extend(str(item) for item in value if item != required)
    return tags


def _required_str(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{name} must be a non-empty string")
    return value


def _str_list(value: Any, name: str) -> list[str]:
    if not isinstance(value, list) or not all(
        isinstance(item, str) and item for item in value
    ):
        raise ValueError(f"{name} must be a list of non-empty strings")
    return value


def _mapping_list(value: Any, name: str) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not all(
        isinstance(item, Mapping) for item in value
    ):
        raise ValueError(f"{name} must be a list of mappings")
    result: list[dict[str, Any]] = []
    for index, item in enumerate(value):
        copied = dict(item)
        _reject_nested_authority_keys(copied, f"{name}[{index}]", 0)
        try:
            encoded = json.dumps(copied, separators=(",", ":")).encode("utf-8")
        except (TypeError, ValueError) as error:
            raise ValueError(f"{name}[{index}] must be JSON serializable") from error
        if len(encoded) > _MAX_METADATA_JSON_BYTES:
            raise ValueError(
                f"{name}[{index}] JSON must be at most {_MAX_METADATA_JSON_BYTES} bytes"
            )
        result.append(copied)
    return result


def _reject_nested_authority_keys(value: Any, path: str, depth: int) -> None:
    if depth > _MAX_METADATA_DEPTH:
        raise ValueError(
            f"{path} exceeds maximum nesting depth ({_MAX_METADATA_DEPTH})"
        )
    if isinstance(value, Mapping):
        collisions = {
            str(key)
            for key in value
            if _authority_key(str(key)) in NESTED_AUTHORITY_KEYS
        }
        if collisions:
            names = ", ".join(sorted(collisions))
            raise ValueError(f"{path} contains reserved authority keys: {names}")
        for key, item in value.items():
            _reject_nested_authority_keys(item, f"{path}.{key}", depth + 1)
    elif isinstance(value, list | tuple):
        for index, item in enumerate(value):
            _reject_nested_authority_keys(item, f"{path}[{index}]", depth + 1)


def _validation_list(value: Any) -> list[dict[str, Any]]:
    validations = _mapping_list(value, "validations")
    for index, validation in enumerate(validations):
        _required_str(validation.get("kind"), f"validations[{index}].kind")
        _required_str(validation.get("status"), f"validations[{index}].status")
    return validations


def _session_wrap_metadata(metadata: Mapping[str, Any]) -> dict[str, Any]:
    payload = dict(metadata)
    if "key_decisions" in payload:
        payload["key_decisions"] = _str_list(
            payload["key_decisions"],
            "key_decisions",
        )
        if len(payload["key_decisions"]) > 20:
            raise ValueError("key_decisions must contain at most 20 items")
    if payload.get("next_steps") is None:
        payload.pop("next_steps", None)
    elif "next_steps" in payload:
        payload["next_steps"] = _str_list(payload["next_steps"], "next_steps")
        if len(payload["next_steps"]) > 20:
            raise ValueError("next_steps must contain at most 20 items")
    receipt_refs = payload.pop("receipt_refs", None)
    if receipt_refs is not None:
        next_steps = payload.get("next_steps", [])
        if next_steps is None:
            next_steps = []
        next_steps = _str_list(next_steps, "next_steps")
        receipt_next_steps = [
            f"Receipt ref: {item}" for item in _str_list(receipt_refs, "receipt_refs")
        ]
        next_steps = [*next_steps, *receipt_next_steps]
        if len(next_steps) > 20:
            raise ValueError(
                "next_steps plus receipt_refs must contain at most 20 items"
            )
        payload["next_steps"] = next_steps
    return payload


def _reject_receipt_secrets(value: Mapping[str, Any]) -> None:
    _reject_secret_payload(value, "receipt")


def _reject_secret_payload(value: Any, path: str) -> None:
    if isinstance(value, str):
        if any(pattern.search(value) for pattern in SECRET_PATTERNS):
            raise ValueError(f"{path} contains secret-like material")
        return
    if isinstance(value, Mapping):
        for key, item in value.items():
            key_text = str(key)
            if SENSITIVE_KEY_RE.search(key_text):
                raise ValueError(f"{path}.{key_text} contains secret-like material")
            _reject_secret_payload(item, f"{path}.{key_text}")
    elif isinstance(value, list | tuple):
        for index, item in enumerate(value):
            _reject_secret_payload(item, f"{path}[{index}]")


def _enum_value(value: Any, name: str, allowed: set[str]) -> str:
    text = _required_str(value, name)
    if text not in allowed:
        choices = ", ".join(sorted(allowed))
        raise ValueError(f"{name} must be one of: {choices}")
    return text


def _set_optional_str(payload: dict[str, Any], key: str, value: str | None) -> None:
    if value is not None:
        payload[key] = _required_str(value, key)


def _bounded_int(
    value: Any,
    name: str,
    *,
    minimum: int,
    maximum: int | None = None,
) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} must be an integer")
    if value < minimum:
        raise ValueError(f"{name} must be >= {minimum}")
    if maximum is not None and value > maximum:
        raise ValueError(f"{name} must be <= {maximum}")
    return value


def _bounded_metadata(result: Mapping[str, Any]) -> dict[str, Any]:
    allowed = ("id", "path", "collection", "tags", "tier")
    return {key: result[key] for key in allowed if key in result}


def _authority_key(key: str) -> str:
    return key.lower().replace("_", "-")


def _export_disclosure_bundle(
    *,
    lane: Mapping[str, Any],
    events: list[dict[str, Any]],
    repo_facts: list[dict[str, Any]],
    receipts: list[dict[str, Any]],
) -> dict[str, Any]:
    sorted_events = sorted(events, key=lambda item: (item["timestamp"], item["id"]))
    sorted_facts = sorted(repo_facts, key=lambda item: item["id"])
    sorted_receipts = sorted(
        receipts,
        key=lambda item: (item["timestamp"], item["id"]),
    )
    citations = _collect_disclosure_citations(
        sorted_events,
        sorted_facts,
        sorted_receipts,
    )
    fact_paths = _concept_paths(sorted_facts)
    files = [
        {
            "path": "index.md",
            "content": _render_disclosure_index(
                lane,
                sorted_events,
                sorted_facts,
                sorted_receipts,
                citations,
                fact_paths,
            ),
        },
        {"path": "log.md", "content": _render_disclosure_log(sorted_events)},
    ]
    files.extend(
        {
            "path": fact_paths[index],
            "content": _render_disclosure_concept(fact),
        }
        for index, fact in enumerate(sorted_facts)
    )
    files.extend(
        [
            {
                "path": "citations.md",
                "content": _render_disclosure_citations(citations),
            },
            {
                "path": "receipts.md",
                "content": _render_disclosure_receipts(sorted_receipts),
            },
        ]
    )
    return {"profile": "okf-like", "files": files}


def _render_disclosure_index(
    lane: Mapping[str, Any],
    events: list[dict[str, Any]],
    facts: list[dict[str, Any]],
    receipts: list[dict[str, Any]],
    citations: list[dict[str, Any]],
    fact_paths: list[str],
) -> str:
    title = lane.get("topic") or lane["sessionKey"]
    lines = [
        _frontmatter(
            {
                "profile": "okf-like",
                "type": "index",
                "session_key": lane["sessionKey"],
                "agent": lane.get("agent"),
                "project": lane.get("project"),
                "okf": _okf_metadata(lane.get("metadata")),
            }
        ),
        f"# {title}",
        "",
        f"- Session: {lane['sessionKey']}",
    ]
    if lane.get("agent"):
        lines.append(f"- Agent: {lane['agent']}")
    if lane.get("project"):
        lines.append(f"- Project: {lane['project']}")
    lines.extend(
        [
            f"- Events: {len(events)}",
            f"- Concepts: {len(facts)}",
            f"- Receipts: {len(receipts)}",
            f"- Citations: {len(citations)}",
            "",
            "## Files",
            "",
            "- [log.md](log.md)",
            "- [citations.md](citations.md)",
            "- [receipts.md](receipts.md)",
        ]
    )
    lines.extend(
        f"- [{fact['subject']}]({fact_paths[index]})"
        for index, fact in enumerate(facts)
    )
    lines.append("")
    return "\n".join(lines)


def _render_disclosure_log(events: list[dict[str, Any]]) -> str:
    lines = [_frontmatter({"profile": "okf-like", "type": "log"}), "# Log", ""]
    for event in events:
        lines.extend(
            [
                f"## {event['timestamp']} {event['type']}",
                "",
                event["content"],
                "",
            ]
        )
        lines.extend(_event_citation_lines(event))
    return "\n".join(lines)


def _render_disclosure_concept(fact: Mapping[str, Any]) -> str:
    return "\n".join(
        [
            _frontmatter(
                {
                    "profile": "okf-like",
                    "type": "concept",
                    "id": fact["id"],
                    "okf": _okf_metadata(fact.get("metadata")),
                }
            ),
            f"# {fact['subject']}",
            "",
            fact["fact"],
            "",
            "## Citations",
            "",
            *_fact_citation_lines(fact),
            "",
        ]
    )


def _render_disclosure_citations(citations: list[dict[str, Any]]) -> str:
    return "\n".join(
        [
            _frontmatter({"profile": "okf-like", "type": "citations"}),
            "# Citations",
            "",
            *[
                f"- {citation['id']}: {_citation_label(citation)}"
                for citation in citations
            ],
            "",
        ]
    )


def _render_disclosure_receipts(receipts: list[dict[str, Any]]) -> str:
    lines = [
        _frontmatter({"profile": "okf-like", "type": "receipts"}),
        "# Receipts",
        "",
    ]
    for receipt in receipts:
        lines.extend(
            [
                f"## {receipt['action']}",
                "",
                f"- ID: {receipt['id']}",
                f"- Timestamp: {receipt['timestamp']}",
                f"- Sources: {_stable_json(receipt.get('sources', []))}",
                f"- Outputs: {_stable_json(receipt.get('outputs', []))}",
                f"- Validations: {_stable_json(receipt.get('validations', []))}",
                "",
            ]
        )
    return "\n".join(lines)


def _collect_disclosure_citations(
    events: list[dict[str, Any]],
    facts: list[dict[str, Any]],
    receipts: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    citations: dict[str, dict[str, Any]] = {}
    for event in events:
        source_ref = _event_source_ref(event)
        artifact_path = _event_artifact_path(event)
        if source_ref:
            citations[f"event:{event['id']}:source"] = {
                "id": f"event:{event['id']}:source",
                "label": "source_ref",
                "sourceRef": source_ref,
            }
        if artifact_path:
            citations[f"event:{event['id']}:artifact"] = {
                "id": f"event:{event['id']}:artifact",
                "label": "artifact_path",
                "path": artifact_path,
            }
        for citation in event.get("citations", []):
            citations[citation["id"]] = dict(citation)
    for fact in facts:
        source_url = _fact_source_url(fact)
        if source_url:
            citations[f"fact:{fact['id']}:source_url"] = {
                "id": f"fact:{fact['id']}:source_url",
                "label": fact["subject"],
                "url": source_url,
            }
        if fact.get("path"):
            citations[f"fact:{fact['id']}:path"] = {
                "id": f"fact:{fact['id']}:path",
                "label": fact["subject"],
                "path": fact["path"],
            }
        for citation in fact.get("citations", []):
            citations[citation["id"]] = dict(citation)
    for receipt in receipts:
        citations[f"receipt:{receipt['id']}"] = {
            "id": f"receipt:{receipt['id']}",
            "label": receipt["action"],
            "sourceRef": receipt["id"],
        }
    return [citations[key] for key in sorted(citations)]


def _concept_paths(facts: list[dict[str, Any]]) -> list[str]:
    paths: list[str] = []
    seen: set[str] = set()
    for index, fact in enumerate(facts):
        path = _concept_path(fact)
        if path in seen:
            subject_slug = _slug(fact.get("subject") or "concept")
            id_slug = _slug(fact.get("id") or "fact")
            path = f"concepts/{subject_slug}-{id_slug}.md"
        while path in seen:
            path = (
                f"concepts/{_slug(fact.get('subject') or 'concept')}-"
                f"{_slug(fact.get('id') or 'fact')}-{index}.md"
            )
        seen.add(path)
        paths.append(path)
    return paths


def _concept_path(fact: Mapping[str, Any]) -> str:
    return f"concepts/{_slug(str(fact.get('subject') or fact['id']))}.md"


def _event_citation_lines(event: Mapping[str, Any]) -> list[str]:
    lines: list[str] = []
    source_ref = _event_source_ref(event)
    artifact_path = _event_artifact_path(event)
    if source_ref:
        lines.append(f"- Source ref: {source_ref}")
    if artifact_path:
        lines.append(f"- Artifact: {artifact_path}")
    lines.extend(
        f"- Citation: {_citation_label(citation)}"
        for citation in event.get("citations", [])
    )
    return ["### Citations", "", *lines, ""] if lines else []


def _fact_citation_lines(fact: Mapping[str, Any]) -> list[str]:
    lines: list[str] = []
    source_url = _fact_source_url(fact)
    if source_url:
        lines.append(f"- Source URL: {source_url}")
    if fact.get("path"):
        lines.append(f"- Path: {fact['path']}")
    lines.extend(
        f"- {_citation_label(citation)}" for citation in fact.get("citations", [])
    )
    return lines or ["- None"]


def _event_source_ref(event: Mapping[str, Any]) -> str | None:
    value = event.get("sourceRef", event.get("source_ref"))
    return value if isinstance(value, str) else None


def _event_artifact_path(event: Mapping[str, Any]) -> str | None:
    value = event.get("artifactPath", event.get("artifact_path"))
    return value if isinstance(value, str) else None


def _fact_source_url(fact: Mapping[str, Any]) -> str | None:
    value = fact.get("sourceUrl", fact.get("source_url"))
    return value if isinstance(value, str) else None


def _citation_label(citation: Mapping[str, Any]) -> str:
    return " ".join(
        str(value)
        for value in (
            citation.get("label"),
            citation.get("url"),
            citation.get("path"),
            citation.get("sourceRef"),
        )
        if value
    )


def _frontmatter(values: Mapping[str, Any]) -> str:
    lines = ["---"]
    for key, value in values.items():
        if value is None:
            continue
        lines.append(f"{key}: {_stable_json(value)}")
    lines.extend(["---", ""])
    return "\n".join(lines)


def _okf_metadata(metadata: Any) -> Any | None:
    if isinstance(metadata, Mapping):
        okf = metadata.get("okf")
        if isinstance(okf, Mapping):
            return dict(okf)
    return None


def _stable_json(value: Any) -> str:
    return json.dumps(_sort_json(value), separators=(",", ":"))


def _sort_json(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {key: _sort_json(value[key]) for key in sorted(value)}
    if isinstance(value, list):
        return [_sort_json(item) for item in value]
    return value


def _slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug[:80] or "concept"


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")
