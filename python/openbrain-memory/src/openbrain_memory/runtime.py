"""First-class local runtime facade for Open Brain memory lifecycle calls."""

from __future__ import annotations

import logging
import os
import threading
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Any, cast
from urllib.parse import urlparse

from . import _runtime_validation
from ._runtime_router import (
    DirectClient,
    FallbackRunner,
    Mcp2CliFallback,
    RuntimeCallError,
    RuntimeClientRouter,
    run_subprocess,
    safe_error,
    safe_text,
)
from ._runtime_spool import PARKED_NAMESPACE_KEY, TrackingSpool
from ._runtime_validation import (
    bounded_int as _bounded_int,
)
from ._runtime_validation import (
    distilled_content as _validate_distilled_content,
)
from ._runtime_validation import (
    mapping_optional_text as _mapping_optional_text,
)
from ._runtime_validation import (
    mapping_text as _mapping_text,
)
from ._runtime_validation import (
    optional_text as _optional_text,
)
from ._runtime_validation import (
    persisted_text as _validate_persisted_text,
)
from ._runtime_validation import (
    project_reflex_result as _project_reflex_result,
)
from ._runtime_validation import (
    reflex_query as _reflex_query,
)
from ._runtime_validation import (
    reject_unknown_keys as _reject_unknown_keys,
)
from ._runtime_validation import (
    require_text as _require_text,
)
from ._runtime_validation import (
    sanitize_prior_context as _sanitize_prior_context,
)
from ._runtime_validation import (
    source_bool as _source_bool,
)
from ._runtime_validation import (
    source_float as _source_float,
)
from ._runtime_validation import (
    validate_context_pack_scope as _validate_context_pack_scope,
)
from ._runtime_validation import (
    validate_started_lane as _validate_started_lane,
)
from ._runtime_validation import (
    wrap_metadata as _validate_wrap_metadata,
)
from .agent import (
    EVENT_TYPES,
    AgentMemory,
    MemoryClient,
    MemorySpool,
    _reject_secret_payload,
)
from .client import JSON, OpenBrainClient, Transport
from .policy import redact_value
from .spool import (
    JsonlSpool,
    SpoolRecord,
    SpoolReplayReport,
    SpoolUnitOutcome,
    SpoolUnitRetained,
)

logger = logging.getLogger(__name__)

MAX_DISTILLED_CONTENT_BYTES = _runtime_validation.MAX_DISTILLED_CONTENT_BYTES
_CONFIG_KEYS = {
    "allow_insecure_http",
    "base_url",
    "fallback_enabled",
    "namespace",
    "project",
    "role",
    "spool_path",
    "timeout",
    "token",
}
_SCOPE_KEYS = {
    "agent",
    "channel_id",
    "platform",
    "server_id",
    "session_key",
    "thread_id",
}
_CONTEXT_PACK_SECTIONS = {
    "candidate_memory",
    "durable_lane_context",
    "durable_memory",
    "pointers",
    "process_guidance",
    "profile_guidance",
    "recovery",
    "repo_facts",
    "working_set",
}
_REPLAYABLE_SPOOL_OPERATIONS = frozenset(
    {
        "session_start",
        "lane_upsert",
        "upsert_repo_fact",
        "append_session_event",
        "log_thought",
        "log_decision",
        "session_wrap",
    }
)


def _spooled_start_scope(payload: Mapping[str, Any]) -> RuntimeScope:
    """Rebuild the exact scope a spooled session_start unit was parked under."""
    try:
        return RuntimeScope(
            agent=payload["agent"],
            platform=payload["platform"],
            server_id=payload["server_id"],
            channel_id=payload["channel_id"],
            session_key=payload["session_key"],
            thread_id=payload.get("thread_id"),
        )
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError(
            "spooled session_start record does not carry a complete exact scope"
        ) from error


class ReceiptStatus(StrEnum):
    """Observable outcome of one runtime lifecycle operation.

    ``REPLAYED`` and ``QUARANTINED`` are additive drain-receipt statuses
    (#296) within the pinned ``openbrain.runtime_receipt.v1`` schema.
    """

    DIRECT = "direct"
    SAVED = "saved"
    SPOOLED = "spooled"
    FALLBACK = "fallback"
    FAILED = "failed"
    LOST = "lost"
    REPLAYED = "replayed"
    QUARANTINED = "quarantined"


@dataclass(frozen=True)
class RuntimeScope:
    """Exact runtime identity used for context-pack recall and lane writes."""

    agent: str
    platform: str
    server_id: str
    channel_id: str
    session_key: str
    thread_id: str | None = None

    def __post_init__(self) -> None:
        for name in ("agent", "platform", "server_id", "channel_id", "session_key"):
            object.__setattr__(
                self,
                name,
                _persisted_text(getattr(self, name), name),
            )
        if self.thread_id is not None:
            object.__setattr__(
                self,
                "thread_id",
                _persisted_text(self.thread_id, "thread_id"),
            )

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> RuntimeScope:
        """Build a validated scope from untrusted JSON-like input."""
        _reject_unknown_keys(value, _SCOPE_KEYS, "scope")
        return cls(
            agent=_mapping_text(value, "agent"),
            platform=_mapping_text(value, "platform"),
            server_id=_mapping_text(value, "server_id"),
            channel_id=_mapping_text(value, "channel_id"),
            session_key=_mapping_text(value, "session_key"),
            thread_id=_mapping_optional_text(value, "thread_id"),
        )

    def context_pack_arguments(self, query: str) -> dict[str, Any]:
        """Return the server contract's exact-scope context-pack fields."""
        arguments: dict[str, Any] = {
            "agent": self.agent,
            "platform": self.platform,
            "server_id": self.server_id,
            "channel_id": self.channel_id,
            "session_key": self.session_key,
            "query": _require_text(query, "query"),
        }
        if self.thread_id is not None:
            arguments["thread_id"] = self.thread_id
        return arguments

    def reflex_arguments(
        self,
        query: str,
        prior_context: Sequence[Mapping[str, Any]] | None,
    ) -> dict[str, Any]:
        """Return the reflex tool's exact-scope, body-free request fields.

        Reuses the exact-scope coordinates ``agent_context_pack`` requires and
        adds only the required ``query`` and an optional body-free
        ``prior_context``; the reflex has no ``namespace`` argument because the
        server derives it from the bound token.
        """
        arguments: dict[str, Any] = {
            "agent": self.agent,
            "platform": self.platform,
            "server_id": self.server_id,
            "channel_id": self.channel_id,
            "session_key": self.session_key,
            "query": _reflex_query(query),
        }
        if self.thread_id is not None:
            arguments["thread_id"] = self.thread_id
        if prior_context is not None:
            arguments["prior_context"] = _sanitize_prior_context(prior_context)
        return arguments

    def start_metadata(self) -> dict[str, str]:
        """Return scope-owned lane coordinates supported by ``session_start``."""
        metadata = {
            "platform": self.platform,
            "server_id": self.server_id,
            "channel_id": self.channel_id,
        }
        if self.thread_id is not None:
            metadata["thread_id"] = self.thread_id
        return metadata

    def wrap_metadata(self) -> dict[str, str]:
        """Return exact scope coordinates supported by ``session_wrap``."""
        return self.start_metadata()


@dataclass(frozen=True)
class RuntimeConfig:
    """Direct-client and fallback configuration loaded from args and environment."""

    base_url: str
    token: str = field(repr=False)
    namespace: str
    project: str | None = None
    role: str | None = None
    allow_insecure_http: bool = False
    timeout: float = 30.0
    fallback_enabled: bool = False
    spool_path: Path | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "base_url", _require_text(self.base_url, "base_url"))
        object.__setattr__(self, "token", _require_text(self.token, "token"))
        object.__setattr__(
            self,
            "namespace",
            _require_text(self.namespace, "namespace"),
        )
        if self.project is not None:
            object.__setattr__(
                self,
                "project",
                _persisted_text(self.project, "project"),
            )
        if self.role is not None:
            object.__setattr__(self, "role", _require_text(self.role, "role"))
        parsed = urlparse(self.base_url)
        if parsed.hostname in {"127.0.0.1", "localhost"} and parsed.port == 8317:
            raise ValueError("127.0.0.1:8317 is not an Open Brain endpoint")
        if self.timeout <= 0:
            raise ValueError("timeout must be > 0")

    @classmethod
    def from_sources(
        cls,
        explicit: Mapping[str, Any] | None = None,
        *,
        environ: Mapping[str, str] | None = None,
    ) -> RuntimeConfig:
        """Load config with explicit values taking precedence over environment."""
        values = dict(explicit or {})
        _reject_unknown_keys(values, _CONFIG_KEYS, "config")
        env = os.environ if environ is None else environ

        def source(name: str, env_name: str) -> Any:
            value = values.get(name)
            return value if value is not None else env.get(env_name)

        spool_value = source("spool_path", "OPENBRAIN_SPOOL_PATH")
        timeout_value = source("timeout", "OPENBRAIN_TIMEOUT")
        token_value = values.get("token")
        if token_value is None:
            token_value = env.get("OPENBRAIN_TOKEN") or env.get("OPEN_BRAIN_TOKEN")
        return cls(
            base_url=_require_text(
                source("base_url", "OPENBRAIN_BASE_URL"), "base_url"
            ),
            token=_require_text(token_value, "token"),
            namespace=_require_text(
                source("namespace", "OPENBRAIN_NAMESPACE"),
                "namespace",
            ),
            project=_optional_text(source("project", "OPENBRAIN_PROJECT"), "project"),
            role=_optional_text(source("role", "OPENBRAIN_ROLE"), "role"),
            allow_insecure_http=_source_bool(
                values,
                "allow_insecure_http",
                env,
                "OPENBRAIN_ALLOW_INSECURE_HTTP",
            ),
            timeout=_source_float(timeout_value, "timeout", default=30.0),
            fallback_enabled=_source_bool(
                values,
                "fallback_enabled",
                env,
                "OPENBRAIN_MCP2CLI_FALLBACK",
            ),
            spool_path=Path(str(spool_value)) if spool_value is not None else None,
        )

    @classmethod
    def from_env(
        cls,
        *,
        environ: Mapping[str, str] | None = None,
        **explicit: Any,
    ) -> RuntimeConfig:
        """Load canonical environment names with optional explicit overrides."""
        return cls.from_sources(explicit, environ=environ)


@dataclass(frozen=True)
class RuntimeReceipt:
    """Truthful, JSON-ready evidence for a lifecycle operation."""

    operation: str
    status: ReceiptStatus
    durable: bool
    direct_attempted: bool
    fallback_attempted: bool
    spool_key: str | None = None
    error: str | None = None

    def as_dict(self) -> dict[str, Any]:
        """Return a safe JSON representation."""
        value: dict[str, Any] = {
            "schema": "openbrain.runtime_receipt.v1",
            "operation": self.operation,
            "status": self.status.value,
            "durable": self.durable,
            "direct_attempted": self.direct_attempted,
            "fallback_attempted": self.fallback_attempted,
        }
        if self.spool_key is not None:
            value["spool_key"] = self.spool_key
        if self.error is not None:
            value["error"] = self.error
        return value


@dataclass(frozen=True)
class DrainReport:
    """Content-free outcome of one automatic spool drain (#296).

    Carries counts and linked receipts only: spool keys, operations,
    statuses, and error categories — never payload content and never error
    message bodies. ``REPLAYED`` receipts are per successfully replayed
    record. ``QUARANTINED`` receipts are per quarantined unit and use the
    unit's first record key as ``spool_key``; they report ``durable=True``
    because the unit's redacted lines still exist on disk in the quarantine
    sidecar — the write was not delivered, but it was not lost, and an
    operator can restore-and-replay it.

    ``retained_units`` counts units left parked in the spool without any
    dispatch or failure accounting, for either reason: foreign-namespace
    provenance (#314) or a parked scope the record cannot prove.
    """

    attempted_units: int
    replayed_units: int
    replayed_records: int
    failed_units: int
    quarantined_units: int
    retained_units: int
    receipts: tuple[RuntimeReceipt, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        """Return a safe JSON representation."""
        return {
            "attempted_units": self.attempted_units,
            "replayed_units": self.replayed_units,
            "replayed_records": self.replayed_records,
            "failed_units": self.failed_units,
            "quarantined_units": self.quarantined_units,
            "retained_units": self.retained_units,
            "receipts": [receipt.as_dict() for receipt in self.receipts],
        }


@dataclass(frozen=True)
class RuntimeOutput:
    """One context or write result with its receipt."""

    receipt: RuntimeReceipt
    context: Mapping[str, Any] | None = None
    result: Mapping[str, Any] | None = None
    # Present only when this operation triggered an automatic spool drain;
    # kept outside RuntimeReceipt because that shape is contract-pinned.
    drain: DrainReport | None = None

    def as_dict(self) -> dict[str, Any]:
        """Return redacted JSON output for visible runtime adapters."""
        output: dict[str, Any] = {"receipt": self.receipt.as_dict()}
        if self.context is not None:
            output["context"] = dict(self.context)
        if self.result is not None:
            output["result"] = redact_value(dict(self.result))
        if self.drain is not None:
            output["drain"] = self.drain.as_dict()
        return output


class FirstClassMemoryRuntime:
    """Primary local memory path for thin runtime adapters."""

    def __init__(
        self,
        config: RuntimeConfig,
        scope: RuntimeScope,
        *,
        transport: Transport | None = None,
        client: DirectClient | None = None,
        client_factory: Callable[..., DirectClient] = OpenBrainClient,
        fallback_runner: FallbackRunner | None = None,
        spool: MemorySpool | None = None,
    ) -> None:
        self.config = config
        self.scope = scope
        self._owns_client = client is None
        self._operation_lock = threading.RLock()
        # Content-free report from the most recent automatic spool drain;
        # None until a drain has run in this runtime.
        self.last_drain_report: DrainReport | None = None
        # Set only while draining a spooled unit parked under another scope;
        # session_start replay results validate against this instead of scope.
        self._replay_scope: RuntimeScope | None = None
        direct = client
        setup_error: BaseException | None = None
        if direct is None:
            try:
                direct = client_factory(
                    config.base_url,
                    token=config.token,
                    namespace=config.namespace,
                    agent_id=scope.agent,
                    role=config.role,
                    timeout=config.timeout,
                    transport=transport,
                    allow_insecure_http=config.allow_insecure_http,
                    delegate_namespace=False,
                )
            except Exception as error:
                setup_error = error
        fallback = None
        if config.fallback_enabled:
            fallback = Mcp2CliFallback(
                fallback_runner or run_subprocess,
                namespace=config.namespace,
                scope=scope,
                timeout=config.timeout,
            )
        self._router = RuntimeClientRouter(
            direct,
            fallback,
            setup_error=setup_error,
            direct_result_validator=self._validate_direct_result,
        )
        configured_spool = spool
        if configured_spool is None and config.spool_path is not None:
            configured_spool = JsonlSpool(config.spool_path)
        self._spool = (
            TrackingSpool(configured_spool, namespace=config.namespace)
            if configured_spool
            else None
        )
        self._memory = AgentMemory(
            cast(MemoryClient, self._router),
            agent=scope.agent,
            project=config.project,
            source=scope.agent,
            spool=cast(MemorySpool | None, self._spool),
        )

    def close(self) -> None:
        """Close only a direct MCP client constructed by this runtime."""
        if not self._owns_client:
            return
        with self._operation_lock:
            self._router.close()

    def drain_spool_now(self) -> DrainReport | None:
        """Replay pending durable records on demand, outside a write/recall.

        Scheduled or queued maintenance uses this to run the *same* spool
        drain the write and recall paths trigger automatically after a
        successful direct call: it reuses ``_drain_spool`` unchanged, so the
        exact-scope replay, foreign-namespace/unprovable-scope retention,
        ``REPLAYED``/``QUARANTINED`` semantics, full-record namespace
        provenance, drain receipts, and content-free observability are
        identical to the standalone path.

        Idempotent by construction: a replayed unit is removed from the spool
        in the same pass, so a re-run only drains what is still pending and a
        fully-drained spool returns a zero-count report. Returns ``None`` when
        there was nothing to drain or the drain machinery itself failed, and
        the same content-free ``DrainReport`` otherwise (also stored on
        ``last_drain_report``). The operation lock and per-operation state
        reset mirror the write path so a concurrent write and a scheduled
        drain never share a partial spool snapshot or stale router evidence.
        """
        with self._operation_lock:
            self._router.reset()
            if self._spool is not None:
                self._spool.reset()
            return self._drain_spool()

    def recall_context(
        self,
        query: str,
        *,
        max_tokens: int | None = None,
        max_latency_ms: int | None = None,
        requested_sections: Sequence[str] | None = None,
        include_unreviewed_recovery: bool | None = None,
    ) -> RuntimeOutput:
        """Fail open while recalling the exact-scope server context pack."""
        with self._operation_lock:
            return self._recall_context(
                query,
                max_tokens=max_tokens,
                max_latency_ms=max_latency_ms,
                requested_sections=requested_sections,
                include_unreviewed_recovery=include_unreviewed_recovery,
            )

    def _recall_context(
        self,
        query: str,
        *,
        max_tokens: int | None,
        max_latency_ms: int | None,
        requested_sections: Sequence[str] | None,
        include_unreviewed_recovery: bool | None = None,
    ) -> RuntimeOutput:
        self._router.reset()
        try:
            arguments = self.scope.context_pack_arguments(query)
            budget: dict[str, int] = {}
            if max_tokens is not None:
                budget["max_tokens"] = _bounded_int(
                    max_tokens,
                    "max_tokens",
                    minimum=100,
                    maximum=20_000,
                )
            if max_latency_ms is not None:
                budget["max_latency_ms"] = _bounded_int(
                    max_latency_ms,
                    "max_latency_ms",
                    minimum=1,
                    maximum=10_000,
                )
            if budget:
                arguments["budget"] = budget
            if requested_sections is not None:
                sections = [
                    _require_text(section, "requested_sections")
                    for section in requested_sections
                ]
                unsupported = set(sections).difference(_CONTEXT_PACK_SECTIONS)
                if unsupported:
                    raise ValueError(
                        "requested_sections contains unsupported values: "
                        f"{', '.join(sorted(unsupported))}"
                    )
                arguments["requested_sections"] = sections
            # Runtime-specific projection of an already server-supported
            # agent_context_pack argument (#371): forward it only when the
            # caller explicitly opted in, so an omitted flag preserves the
            # prior request shape exactly. Revalidate boolean-ness here as well
            # because programmatic callers can bypass the CLI type boundary.
            if include_unreviewed_recovery is not None:
                arguments["include_unreviewed_recovery"] = _require_bool(
                    include_unreviewed_recovery,
                    "include_unreviewed_recovery",
                )
            local_timeout = (
                max_latency_ms / 1000 if max_latency_ms is not None else None
            )
            result = self._router.agent_context_pack(
                timeout=local_timeout,
                **arguments,
            )
            status = (
                ReceiptStatus(self._router.state.path)
                if self._router.state.path is not None
                else ReceiptStatus.FAILED
            )
            receipt = self._receipt("recall", status, durable=False)
            drain = self._drain_spool() if status is ReceiptStatus.DIRECT else None
            return RuntimeOutput(receipt=receipt, context=result, drain=drain)
        except Exception as error:
            return RuntimeOutput(
                receipt=self._receipt(
                    "recall",
                    ReceiptStatus.FAILED,
                    durable=False,
                    error=error,
                ),
                context={},
            )

    def reflex(
        self,
        query: str,
        *,
        max_tokens: int | None = None,
        max_latency_ms: int | None = None,
        prior_context: Sequence[Mapping[str, Any]] | None = None,
    ) -> RuntimeOutput:
        """Return exact-scope body-free reflex pointers for the current query.

        A pure read: it routes direct-only (never spool, never mcp2cli
        fallback), enforces the exact returned scope and the ordinary
        ``openbrain.agent_reflex_pointers.v1`` envelope, and returns that
        validated envelope through ``result`` with a content-free receipt.
        """
        with self._operation_lock:
            return self._reflex(
                query,
                max_tokens=max_tokens,
                max_latency_ms=max_latency_ms,
                prior_context=prior_context,
            )

    def _reflex(
        self,
        query: str,
        *,
        max_tokens: int | None,
        max_latency_ms: int | None,
        prior_context: Sequence[Mapping[str, Any]] | None,
    ) -> RuntimeOutput:
        self._router.reset()
        try:
            arguments = self.scope.reflex_arguments(query, prior_context)
            budget: dict[str, int] = {}
            if max_tokens is not None:
                budget["max_tokens"] = _bounded_int(
                    max_tokens,
                    "max_tokens",
                    minimum=100,
                    maximum=20_000,
                )
            if max_latency_ms is not None:
                budget["max_latency_ms"] = _bounded_int(
                    max_latency_ms,
                    "max_latency_ms",
                    minimum=1,
                    maximum=10_000,
                )
            if budget:
                arguments["budget"] = budget
            local_timeout = (
                max_latency_ms / 1000 if max_latency_ms is not None else None
            )
            result = self._router.agent_reflex_pointers(
                timeout=local_timeout,
                **arguments,
            )
            # Never surface the raw server payload: project the complete
            # openbrain.agent_reflex_pointers.v1 envelope into a freshly built,
            # body-free mapping. Any invariant break, raw body/display field, or
            # broken citation bijection raises here and fails the read closed.
            try:
                projected = _project_reflex_result(
                    result,
                    self.config.namespace,
                    self.scope,
                    str(arguments["query"]),
                )
            except ValueError as error:
                raise _ReflexResultError from error
            status = (
                ReceiptStatus(self._router.state.path)
                if self._router.state.path is not None
                else ReceiptStatus.FAILED
            )
            receipt = self._receipt("reflex", status, durable=False)
            return RuntimeOutput(receipt=receipt, result=projected)
        except Exception as error:
            # A reflex failure receipt carries a stable content-free category, not
            # redacted exception text: even a redacted message could echo a
            # private, non-secret-shaped sentinel from a hostile server body. The
            # category is derived from the failure kind alone.
            return RuntimeOutput(
                receipt=self._receipt(
                    "reflex",
                    ReceiptStatus.FAILED,
                    durable=False,
                    error=_reflex_error_category(error),
                ),
                result={},
            )

    def capture_distilled(
        self,
        content: str,
        *,
        event_type: str = "fact",
    ) -> RuntimeOutput:
        """Capture one already-distilled event; raw transcript APIs are absent."""
        try:
            safe_content = _distilled_content(content, "content")
            safe_event_type = _require_text(event_type, "event_type")
            if safe_event_type not in EVENT_TYPES:
                raise ValueError(f"Unsupported event_type: {safe_event_type}")
        except ValueError as error:
            return _failed_write("capture", error)
        return self._write(
            "capture",
            lambda: self._memory.append_scoped_event(
                self.scope.agent,
                safe_content,
                platform=self.scope.platform,
                server_id=self.scope.server_id,
                channel_id=self.scope.channel_id,
                thread_id=self.scope.thread_id,
                event_type=safe_event_type,
            ),
        )

    def checkpoint(
        self,
        summary: str,
        *,
        key_decisions: Sequence[str] | None = None,
        next_steps: Sequence[str] | None = None,
        receipt_refs: Sequence[str] | None = None,
    ) -> RuntimeOutput:
        """Persist a distilled checkpoint through ``AgentMemory.checkpoint``."""
        try:
            safe_summary = _distilled_content(summary, "summary")
            metadata = _wrap_metadata(key_decisions, next_steps, receipt_refs)
        except ValueError as error:
            return _failed_write("checkpoint", error)
        return self._write(
            "checkpoint",
            lambda: self._memory.checkpoint(
                safe_summary,
                **self.scope.wrap_metadata(),
                **metadata,
            ),
        )

    def wrap(
        self,
        summary: str,
        *,
        key_decisions: Sequence[str] | None = None,
        next_steps: Sequence[str] | None = None,
        receipt_refs: Sequence[str] | None = None,
    ) -> RuntimeOutput:
        """Persist a distilled session wrap through ``AgentMemory.wrap_session``."""
        try:
            safe_summary = _distilled_content(summary, "summary")
            metadata = _wrap_metadata(key_decisions, next_steps, receipt_refs)
        except ValueError as error:
            return _failed_write("wrap", error)
        return self._write(
            "wrap",
            lambda: self._memory.wrap_session(
                safe_summary,
                **self.scope.wrap_metadata(),
                **metadata,
            ),
        )

    def _write(self, operation: str, call: Callable[[], JSON]) -> RuntimeOutput:
        with self._operation_lock:
            return self._write_locked(operation, call)

    def _write_locked(
        self,
        operation: str,
        call: Callable[[], JSON],
    ) -> RuntimeOutput:
        self._router.reset()
        if self._spool is not None:
            self._spool.reset()
        try:
            self._ensure_lane()
            result = call()
            receipt_status = (
                ReceiptStatus.FALLBACK
                if self._router.state.path == ReceiptStatus.FALLBACK.value
                else ReceiptStatus.SAVED
            )
            receipt = self._receipt(operation, receipt_status, durable=True)
            drain = (
                self._drain_spool() if receipt_status is ReceiptStatus.SAVED else None
            )
            return RuntimeOutput(receipt=receipt, result=result, drain=drain)
        except ValueError as error:
            return RuntimeOutput(
                receipt=self._receipt(
                    operation,
                    ReceiptStatus.FAILED,
                    durable=False,
                    error=error,
                )
            )
        except Exception as error:
            queue_error: BaseException | None = None
            if self._spool is not None and self._spool.pending_start is not None:
                queue_error = self._queue_requested_write(call)
            if (
                self._spool is not None
                and self._spool.last_key is not None
                and self._spool.last_operation != "session_start"
            ):
                return RuntimeOutput(
                    receipt=self._receipt(
                        operation,
                        ReceiptStatus.SPOOLED,
                        durable=True,
                        spool_key=self._spool.last_key,
                        error=error,
                    )
                )
            lost_error = safe_error(error)
            if self._spool is not None and self._spool.last_error is not None:
                lost_error = safe_text(
                    f"{lost_error}; spool failed: {self._spool.last_error}"
                )
            elif queue_error is not None:
                lost_error = safe_text(
                    f"{lost_error}; requested write was not queued: "
                    f"{safe_error(queue_error)}"
                )
            return RuntimeOutput(
                receipt=self._receipt(
                    operation,
                    ReceiptStatus.LOST,
                    durable=False,
                    error=lost_error,
                )
            )

    def _drain_spool(self) -> DrainReport | None:
        """Replay pending durable records after direct connectivity recovers.

        Returns a content-free ``DrainReport`` (also stored on
        ``last_drain_report``) when a drain ran, or ``None`` when there was
        nothing to drain or the drain machinery itself failed.
        """
        try:
            if self._spool is None:
                return None
            spool = self._spool.spool
            if not isinstance(spool, JsonlSpool):
                return None
            if spool.status().pending_count <= 0:
                return None

            def dispatch(record: SpoolRecord) -> JSON:
                # Reset per record so no later record or unit can inherit a
                # stale scope if scope-validated replay operations are added.
                self._replay_scope = None
                if record.operation not in _REPLAYABLE_SPOOL_OPERATIONS:
                    raise ValueError(
                        f"Unsupported spooled operation: {record.operation}"
                    )
                payload = dict(record.payload)
                # A record parked by a runtime configured for another
                # namespace must stay parked: draining it here would
                # silently transplant its content into this runtime's
                # namespace. Provenance is stamped on EVERY spooled record
                # (session_start since #314, all replayable operations since
                # PR #317), so lone non-start units are covered too. Raised
                # as SpoolUnitRetained so retention never counts toward
                # quarantine. Honest legacy carve-out (mirrors
                # docs/memory-contract.md): records already on disk without
                # the marker — spooled before the stamping landed, or by a
                # namespace-less runtime config — carry no provenance and
                # drain under the replaying runtime's namespace.
                parked_namespace = payload.pop(PARKED_NAMESPACE_KEY, None)
                if (
                    parked_namespace is not None
                    and parked_namespace != self.config.namespace
                ):
                    raise SpoolUnitRetained(
                        "spooled unit parked under a different namespace"
                    )
                if record.operation == "session_start":
                    # Validate the replayed lane against the scope the unit was
                    # parked under, not the runtime's current scope, so units
                    # from another project drain instead of re-failing forever
                    # (#310). The namespace stays bound to this runtime's auth
                    # config; only the lane coordinates come from the record.
                    # A record that cannot prove its parked scope is retained
                    # without dispatch or failure accounting, as before #296.
                    try:
                        self._replay_scope = _spooled_start_scope(payload)
                    except ValueError as error:
                        raise SpoolUnitRetained(str(error)) from error
                method = getattr(self._router, record.operation)
                return cast(JSON, method(**payload))

            try:
                with self._router.direct_only():
                    report = spool.replay_with_report(dispatch)
            finally:
                self._replay_scope = None
            drain = self._build_drain_report(report)
            self.last_drain_report = drain
            return drain
        except Exception:
            # Content-free background observability (#296): the raised error may
            # be an OpenBrainError whose message/body carries redacted-but-
            # private content, and a traceback exposes it. Log a stable status
            # token only — no exception object/traceback, message, spool path,
            # idempotency key, namespace, payload, or provider/server body.
            logger.warning(
                "Spool auto-drain failed",
                extra={"spool_drain_status": "error"},
            )
            return None

    def _build_drain_report(self, report: SpoolReplayReport) -> DrainReport:
        counts = {"replayed": 0, "failed": 0, "quarantined": 0, "retained": 0}
        replayed_records = 0
        receipts: list[RuntimeReceipt] = []
        for outcome in report.outcomes:
            counts[outcome.status] = counts.get(outcome.status, 0) + 1
            if outcome.status == "replayed":
                replayed_records += len(outcome.record_keys)
                receipts.extend(self._replayed_receipts(outcome))
            elif outcome.status == "quarantined":
                receipts.append(self._quarantined_receipt(outcome))
        return DrainReport(
            attempted_units=len(report.outcomes),
            replayed_units=counts["replayed"],
            replayed_records=replayed_records,
            failed_units=counts["failed"],
            quarantined_units=counts["quarantined"],
            retained_units=counts["retained"],
            receipts=tuple(receipts),
        )

    @staticmethod
    def _replayed_receipts(outcome: SpoolUnitOutcome) -> list[RuntimeReceipt]:
        return [
            RuntimeReceipt(
                operation=operation,
                status=ReceiptStatus.REPLAYED,
                durable=True,
                direct_attempted=True,
                fallback_attempted=False,
                spool_key=record_key,
            )
            for operation, record_key in zip(
                outcome.operations, outcome.record_keys, strict=True
            )
        ]

    @staticmethod
    def _quarantined_receipt(outcome: SpoolUnitOutcome) -> RuntimeReceipt:
        return RuntimeReceipt(
            operation=outcome.operations[0],
            status=ReceiptStatus.QUARANTINED,
            durable=True,
            direct_attempted=True,
            fallback_attempted=False,
            spool_key=outcome.record_keys[0],
            error=outcome.error_category,
        )

    def _queue_requested_write(self, call: Callable[[], JSON]) -> BaseException:
        previous_key = self._memory.conversation_key
        self._memory.conversation_key = self.scope.session_key
        try:
            with self._router.queue_only():
                call()
        except Exception as error:
            return error
        finally:
            self._memory.conversation_key = previous_key
        return RuntimeError("requested write did not enter the ordered spool")

    def _validate_direct_result(self, tool: str, result: Any) -> None:
        try:
            if tool == "session_start":
                scope = (
                    self._replay_scope if self._replay_scope is not None else self.scope
                )
                _validate_started_lane(result, self.config.namespace, scope)
            elif tool == "agent_context_pack":
                _validate_context_pack_scope(result, self.config.namespace, self.scope)
        except ValueError as error:
            raise RuntimeCallError(str(error)) from error

    def _ensure_lane(self) -> None:
        if self._memory.conversation_key is not None:
            return
        self._memory.start_session(
            self.scope.session_key,
            **self.scope.start_metadata(),
        )

    def _receipt(
        self,
        operation: str,
        status: ReceiptStatus,
        *,
        durable: bool,
        spool_key: str | None = None,
        error: BaseException | str | None = None,
    ) -> RuntimeReceipt:
        error_text = None
        if error is not None:
            error_text = (
                safe_error(error)
                if isinstance(error, BaseException)
                else safe_text(error)
            )
        return RuntimeReceipt(
            operation=operation,
            status=status,
            durable=durable,
            direct_attempted=self._router.state.direct_attempted,
            fallback_attempted=self._router.state.fallback_attempted,
            spool_key=spool_key,
            error=error_text,
        )


class _ReflexResultError(Exception):
    """A projected reflex envelope failed a body-free invariant.

    Carries no message so a hostile server envelope can never smuggle text into
    the content-free failure receipt; the stable category is derived from the
    exception type alone.
    """


# Stable, content-free reflex failure categories. The failure receipt never
# echoes exception text — a redacted message could still surface a private,
# non-secret-shaped sentinel from a hostile server body — so the category is
# derived from the failure kind only.
_REFLEX_ERROR_REQUEST_INVALID = "reflex_request_invalid"
_REFLEX_ERROR_RESULT_INVALID = "reflex_result_invalid"
_REFLEX_ERROR_DISPATCH_FAILED = "reflex_dispatch_failed"


def _reflex_error_category(error: BaseException) -> str:
    """Map a reflex failure to a stable content-free category label."""
    if isinstance(error, _ReflexResultError):
        return _REFLEX_ERROR_RESULT_INVALID
    if isinstance(error, ValueError):
        return _REFLEX_ERROR_REQUEST_INVALID
    return _REFLEX_ERROR_DISPATCH_FAILED


def _failed_write(operation: str, error: BaseException) -> RuntimeOutput:
    return RuntimeOutput(
        receipt=RuntimeReceipt(
            operation=operation,
            status=ReceiptStatus.FAILED,
            durable=False,
            direct_attempted=False,
            fallback_attempted=False,
            error=safe_error(error),
        )
    )


def _distilled_content(value: str, name: str) -> str:
    return _validate_distilled_content(value, name, _reject_secret_payload)


def _persisted_text(value: Any, name: str) -> str:
    return _validate_persisted_text(value, name, _reject_secret_payload)


def _require_bool(value: Any, name: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{name} must be a boolean")
    return value


def _wrap_metadata(
    key_decisions: Sequence[str] | None,
    next_steps: Sequence[str] | None,
    receipt_refs: Sequence[str] | None,
) -> dict[str, Any]:
    return _validate_wrap_metadata(
        key_decisions,
        next_steps,
        receipt_refs,
        _reject_secret_payload,
    )
