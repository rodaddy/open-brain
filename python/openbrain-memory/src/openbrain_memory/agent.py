from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Protocol

from .client import JSON


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
PROTECTED_KEYS = {
    "agent",
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
}
SESSION_START_KEYS = {"channel_id", "thread_id", "topic"}
SESSION_WRAP_KEYS = {"key_decisions", "next_steps"}
DECISION_KEYS = {"alternatives", "tags", "context", "namespace"}
THOUGHT_KEYS = {"tags", "namespace"}


class MemoryClient(Protocol):
    def session_start(self, **arguments: Any) -> JSON:
        ...

    def append_session_event(self, **arguments: Any) -> JSON:
        ...

    def search_all(self, **arguments: Any) -> JSON:
        ...

    def log_thought(self, **arguments: Any) -> JSON:
        ...

    def log_decision(self, **arguments: Any) -> JSON:
        ...

    def session_wrap(self, **arguments: Any) -> JSON:
        ...


class MemorySpool(Protocol):
    def append(self, operation: str, payload: Mapping[str, Any]) -> None:
        ...


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
    ) -> None:
        self.client: MemoryClient = client
        self.agent = agent
        self.project = project
        self.policy = _coerce_policy(policy)
        self.spool = spool
        self.conversation_key: str | None = None

    def start_session(self, conversation_key: str, **metadata: Any) -> JSON:
        self._reject_reserved_metadata(metadata)
        self._reject_unknown_metadata(metadata, SESSION_START_KEYS)
        payload = dict(metadata)
        payload["session_key"] = conversation_key
        payload["agent"] = self.agent
        if self.project is not None:
            payload["project"] = self.project
        result = self.client.session_start(**payload)
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
    ) -> MemoryContext:
        effective_limit = self._effective_limit(limit)
        sources = _sources(include_decisions, include_facts)
        payload = {
            "query": query,
            "limit": effective_limit,
        }
        if sources:
            payload["sources"] = sources

        raw = self.client.search_all(**payload)
        raw_mapping = raw if isinstance(raw, Mapping) else {}
        items = _bounded_items(raw_mapping, self.policy, effective_limit)
        return MemoryContext(
            query=query,
            items=items,
            text=_prompt_text(items, self.policy),
            raw=raw_mapping if include_raw else {},
        )

    def append_event(self, role: str, content: str, **metadata: Any) -> JSON:
        self._require_session("append_event")
        event_type = str(metadata.pop("event_type", "fact"))
        if event_type not in EVENT_TYPES:
            raise ValueError(f"Unsupported event_type: {event_type}")
        self._reject_reserved_metadata(metadata)
        return self.client.append_session_event(
            **self._session_payload(
                {
                    "event_type": event_type,
                    "content": content,
                    "source": role,
                    "metadata": dict(metadata),
                }
            )
        )

    def remember_fact(self, text: str, **metadata: Any) -> JSON:
        self._reject_reserved_metadata(metadata)
        self._reject_unknown_metadata(metadata, THOUGHT_KEYS)
        tags = _tags("fact", metadata.pop("tags", None))
        payload: dict[str, Any] = {"content": text, "tags": tags}
        if "namespace" in metadata:
            payload["namespace"] = metadata["namespace"]
        return self.client.log_thought(**payload)

    def remember_decision(self, text: str, **metadata: Any) -> JSON:
        self._reject_reserved_metadata(metadata)
        self._reject_unknown_metadata(metadata, DECISION_KEYS)
        payload: dict[str, Any] = {
            "title": _title_from_text(text),
            "rationale": text,
        }
        for key in DECISION_KEYS:
            if key in metadata:
                payload[key] = metadata[key]
        return self.client.log_decision(**payload)

    def checkpoint(self, summary: str, **metadata: Any) -> JSON:
        self._require_session("checkpoint")
        if not summary:
            raise ValueError("checkpoint summary must not be empty")
        self._reject_reserved_metadata(metadata)
        self._reject_unknown_metadata(metadata, SESSION_WRAP_KEYS)
        return self.client.session_wrap(
            **self._session_payload({"summary": summary, **metadata})
        )

    def wrap_session(self, summary: str | None = None, **metadata: Any) -> JSON:
        self._require_session("wrap_session")
        if not summary:
            raise ValueError("wrap_session summary must not be empty")
        self._reject_reserved_metadata(metadata)
        self._reject_unknown_metadata(metadata, SESSION_WRAP_KEYS)
        payload = dict(metadata)
        payload["summary"] = summary
        return self.client.session_wrap(**self._session_payload(payload))

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
        collisions = PROTECTED_KEYS.intersection(metadata)
        if collisions:
            names = ", ".join(sorted(collisions))
            raise ValueError(f"metadata contains reserved keys: {names}")

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


def _coerce_policy(policy: MemoryPolicy | Mapping[str, Any] | None) -> MemoryPolicy:
    if policy is None:
        return MemoryPolicy()
    if isinstance(policy, MemoryPolicy):
        return policy
    return MemoryPolicy(**dict(policy))


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


def _bounded_metadata(result: Mapping[str, Any]) -> dict[str, Any]:
    allowed = ("id", "path", "collection", "tags", "tier")
    return {key: result[key] for key in allowed if key in result}
