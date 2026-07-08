from __future__ import annotations

import json
import re
import tomllib
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from importlib.metadata import PackageNotFoundError, version
from itertools import count
from pathlib import Path
from typing import Any, Protocol, cast
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .nats_wire import (
    build_context_pack_subject,
    build_request_envelope,
)
from .policy import RetryPolicy, redact_text, with_retry

JSON = dict[str, Any]
MCP_PROTOCOL_VERSION = "2025-03-26"
DEFAULT_MAX_RESPONSE_BYTES = 1_000_000
# Default fleet environment prefix for the context-pack subject
# ({env}.ob.memory.context_pack). Local/trusted bus defaults to "dev".
DEFAULT_NATS_ENV = "dev"
DEFAULT_NATS_CONTEXT_PACK_SUBJECT = build_context_pack_subject(DEFAULT_NATS_ENV)
DEFAULT_NATS_MAX_REQUEST_BYTES = 64 * 1024


def _resolve_package_version(pyproject: Path | None = None) -> str:
    try:
        return version("openbrain-memory")
    except PackageNotFoundError:
        source_pyproject = (
            pyproject or Path(__file__).resolve().parents[2] / "pyproject.toml"
        )
        try:
            parsed = tomllib.loads(source_pyproject.read_text(encoding="utf-8"))
        except (OSError, tomllib.TOMLDecodeError):
            return "0.0.0+unknown"
        project = parsed.get("project")
        if not isinstance(project, dict):
            return "0.0.0+unknown"
        source_version = project.get("version")
        if not isinstance(source_version, str) or not source_version:
            return "0.0.0+unknown"
        return source_version


PACKAGE_VERSION = _resolve_package_version()
CURRENT_CONTRACT_VERSION = "2026-07-08.memory-tools.v20"
COMPATIBLE_CONTRACT_VERSIONS = (CURRENT_CONTRACT_VERSION,)
REQUIRED_CONTRACT_TOOLS = (
    "append_session_event",
    "agent_context_pack",
    "decompose_entry",
    "get_contract",
    "get_entry",
    "resolve_entry",
    "lane_load",
    "lane_upsert",
    "list_repo_facts",
    "log_thought",
    "operator_doctor",
    "recovery_wal_append",
    "recovery_wal_mark",
    "search_all",
    "session_context",
    "session_start",
    "session_wrap",
    "upsert_repo_fact",
    "working_set_append",
)
CURRENT_TOOL_HELP: Mapping[str, str] = {
    "append_session_event": "Append a durable event to a session lane journal.",
    "agent_context_pack": (
        "Build a scoped context pack with working context and explicit "
        "quarantined recovery."
    ),
    "brain_answer": "Return cited answer bullets from readable Open Brain evidence.",
    "decompose_entry": (
        "Plan dry-run-first oversized-entry decomposition; explicit apply can "
        "write linked replacement thoughts."
    ),
    "get_entity": "Fetch a graph entity by ID.",
    "get_contract": "Read the canonical Open Brain public contract manifest.",
    "get_entry": (
        "Fetch one readable memory row by table and UUID; render=compact "
        "returns a bounded preview."
    ),
    "resolve_entry": "Resolve a UUID to its readable source type and fetch path.",
    "hydrate_entities": "Refresh missing graph entity embeddings.",
    "lane_load": "Load durable session lanes by filters.",
    "lane_upsert": "Create or update durable session lane metadata.",
    "list_entities": "List graph entities by type, name, or namespace.",
    "list_repo_facts": "Read curated qmd-derived repository facts.",
    "log_thought": "Write a durable thought or observation to Open Brain.",
    "operator_doctor": "Read privileged Open Brain operator doctor/status JSON.",
    "recovery_wal_append": (
        "Append exact-scope quarantined recovery evidence, not durable memory."
    ),
    "recovery_wal_mark": (
        "Review, mark, or purge exact-scope quarantined recovery evidence."
    ),
    "search_all": "Search Open Brain memory and optional qmd-backed code context.",
    "search_brain": "Search Open Brain memory entries.",
    "session_context": "Read durable session lane state and recent events.",
    "session_start": "Find or create a durable session lane and return recent events.",
    "session_wrap": "Checkpoint a session lane with a durable summary.",
    "upsert_repo_fact": "Upsert a curated qmd-derived repository fact.",
    "working_set_append": "Append RAM-only working context for one exact active scope.",
}


@dataclass(frozen=True)
class TransportResponse:
    status_code: int
    headers: Mapping[str, str]
    text: str

    def json(self) -> Any:
        if not self.text:
            return None
        return json.loads(self.text)


class Transport(Protocol):
    def get(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        timeout: float,
    ) -> TransportResponse: ...

    def delete(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        timeout: float,
    ) -> TransportResponse: ...

    def post(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        json_body: JSON,
        timeout: float,
    ) -> TransportResponse: ...


class UrllibTransport:
    def __init__(self, *, max_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES) -> None:
        if max_response_bytes < 1:
            raise ValueError("max_response_bytes must be >= 1")
        self._opener = build_opener(_NoRedirectHandler)
        self.max_response_bytes = max_response_bytes

    def get(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        timeout: float,
    ) -> TransportResponse:
        request = Request(url, headers=dict(headers), method="GET")
        return self._send(request, timeout, expected_response_id=None)

    def delete(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        timeout: float,
    ) -> TransportResponse:
        request = Request(url, headers=dict(headers), method="DELETE")
        return self._send(request, timeout, expected_response_id=None)

    def post(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        json_body: JSON,
        timeout: float,
    ) -> TransportResponse:
        data = json.dumps(json_body).encode("utf-8")
        request = Request(url, data=data, headers=dict(headers), method="POST")
        expected_response_id = json_body.get("id")
        return self._send(
            request,
            timeout,
            expected_response_id=(
                expected_response_id if isinstance(expected_response_id, int) else None
            ),
        )

    def _send(
        self,
        request: Request,
        timeout: float,
        *,
        expected_response_id: int | None,
    ) -> TransportResponse:
        try:
            with self._opener.open(request, timeout=timeout) as response:
                headers = {k.lower(): v for k, v in response.headers.items()}
                body = self._read_response(
                    response,
                    headers=headers,
                    expected_response_id=expected_response_id,
                ).decode("utf-8")
                return TransportResponse(
                    status_code=response.status,
                    headers=headers,
                    text=body,
                )
        except HTTPError as exc:
            error_headers: dict[str, str] = {}
            try:
                error_headers = {k.lower(): v for k, v in exc.headers.items()}
                body = self._read_response(
                    exc,
                    headers=error_headers,
                    expected_response_id=expected_response_id,
                ).decode("utf-8", errors="replace")
            except OSError:
                body = ""
            return TransportResponse(
                status_code=exc.code,
                headers=error_headers,
                text=body,
            )
        except URLError as exc:
            raise OpenBrainHTTPError(
                f"Open Brain request failed: {exc.reason}",
                context="transport",
            ) from exc

    def _read_response(
        self,
        response: Any,
        *,
        headers: Mapping[str, str],
        expected_response_id: int | None,
    ) -> bytes:
        content_type = _header(headers, "content-type") or ""
        if "text/event-stream" in content_type:
            return self._read_first_sse_event(
                response,
                expected_response_id=expected_response_id,
            )
        body = cast(bytes, response.read(self.max_response_bytes + 1))
        if len(body) > self.max_response_bytes:
            raise OpenBrainHTTPError(
                "Open Brain response exceeded max_response_bytes",
                context="transport",
            )
        return body

    def _read_first_sse_event(
        self,
        response: Any,
        *,
        expected_response_id: int | None,
    ) -> bytes:
        total = 0
        event_lines: list[bytes] = []
        while True:
            line = response.readline(self.max_response_bytes + 1)
            if line == b"":
                break
            total += len(line)
            if total > self.max_response_bytes:
                raise OpenBrainHTTPError(
                    "Open Brain SSE response exceeded max_response_bytes",
                    context="transport",
                )
            event_lines.append(line)
            if line in {b"\n", b"\r\n"} and any(
                item.startswith(b"data:") for item in event_lines
            ):
                event = b"".join(event_lines)
                if _sse_event_has_response_id(event, expected_id=expected_response_id):
                    return event
                event_lines = []
        return b"".join(event_lines)


class _NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


class OpenBrainError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        context: str | None = None,
        body: str | None = None,
        token: str | None = None,
        session_id: str | None = None,
        retry_after_seconds: float | None = None,
    ) -> None:
        self.status_code = status_code
        self.context = context
        self.retry_after_seconds = retry_after_seconds
        self.body = _redact(body or "", token=token, session_id=session_id)
        parts = [message]
        if status_code is not None:
            parts.append(f"status={status_code}")
        if context:
            parts.append(f"context={context}")
        if self.body:
            parts.append(f"body={self.body}")
        super().__init__(" ".join(parts))


class OpenBrainHTTPError(OpenBrainError):
    pass


class OpenBrainProtocolError(OpenBrainError):
    pass


class OpenBrainToolError(OpenBrainError):
    pass


class RealtimeTransportAvailability(StrEnum):
    NOT_RUNTIME_AVAILABLE = "not_runtime_available"
    AVAILABLE = "available"


class OpenBrainTransportUnavailableError(OpenBrainError):
    def __init__(
        self,
        message: str,
        *,
        transport: str,
        availability: RealtimeTransportAvailability,
        fallback_transport: str | None = None,
    ) -> None:
        self.transport = transport
        self.availability = availability
        self.fallback_transport = fallback_transport
        body = json.dumps(
            {
                "transport": transport,
                "availability": availability.value,
                "fallback_transport": fallback_transport,
            },
            sort_keys=True,
        )
        super().__init__(
            message,
            context=f"transport:{transport}",
            body=body,
        )


class NatsRequestReplyDriver(Protocol):
    def request(
        self,
        subject: str,
        payload: JSON,
        *,
        headers: Mapping[str, str],
        timeout: float,
    ) -> JSON: ...


class NatsTransport:
    def __init__(
        self,
        url: str,
        *,
        env: str = DEFAULT_NATS_ENV,
        context_pack_subject: str | None = None,
        identity: str = "openbrain-memory",
        fallback_transport: Transport | None = None,
        request_reply_driver: NatsRequestReplyDriver | None = None,
        fallback_on_nats_error: bool = True,
        require_message_auth: bool = False,
        clock: Callable[[], str] | None = None,
        availability: RealtimeTransportAvailability | str = (
            RealtimeTransportAvailability.NOT_RUNTIME_AVAILABLE
        ),
    ) -> None:
        try:
            normalized_availability = RealtimeTransportAvailability(availability)
        except ValueError as exc:
            raise ValueError("NatsTransport is not runtime available yet") from exc
        if (
            normalized_availability is RealtimeTransportAvailability.AVAILABLE
        ):
            raise ValueError("NatsTransport availability is derived from get_contract")
        if not identity:
            raise ValueError("NatsTransport identity must be non-empty")
        self.url = url
        self.env = env
        # Subject is env-prefixed ({env}.ob.memory.context_pack) built through
        # the fleet-nats convention. An explicit override is honoured verbatim
        # (e.g. a caller that already resolved the full subject).
        self.context_pack_subject = (
            context_pack_subject
            if context_pack_subject is not None
            else build_context_pack_subject(env)
        )
        # Fleet Envelope `from`/sender for outbound requests: the DECLARED
        # identity of this client. Lane/namespace binding uses this declared
        # identity by default; an explicit per-request namespace overrides it.
        self.identity = identity
        self.fallback_transport = fallback_transport
        self.availability: RealtimeTransportAvailability = normalized_availability
        self.request_reply_driver = request_reply_driver
        self.fallback_on_nats_error = fallback_on_nats_error
        # v1 trusted local bus: NO message-auth gate. The config exists so a
        # hardened deployment can flip it on, but it defaults OFF locally. When
        # ON, an outbound request without an Authorization header is refused
        # before it reaches the bus.
        self.require_message_auth = require_message_auth
        # Clock for the fleet Envelope ``ts``. Caller-injectable for
        # determinism; the default reads UTC now at CALL time (never import).
        self.clock = clock if clock is not None else _default_iso_clock

    def get(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        timeout: float,
    ) -> TransportResponse:
        return self._delegate_or_raise(
            "GET",
            url,
            headers=headers,
            timeout=timeout,
        )

    def delete(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        timeout: float,
    ) -> TransportResponse:
        return self._delegate_or_raise(
            "DELETE",
            url,
            headers=headers,
            timeout=timeout,
        )

    def post(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        json_body: JSON,
        timeout: float,
    ) -> TransportResponse:
        if self._should_use_nats_context_pack(json_body):
            try:
                return self._post_context_pack_over_nats(
                    headers=headers,
                    json_body=json_body,
                    timeout=timeout,
                )
            except OpenBrainTransportUnavailableError:
                if self.fallback_transport is not None and self.fallback_on_nats_error:
                    return self.fallback_transport.post(
                        url,
                        headers=headers,
                        json_body=json_body,
                        timeout=timeout,
                    )
                raise

        if self._is_get_contract_call(json_body):
            response = self._delegate_or_raise(
                "POST",
                url,
                headers=headers,
                timeout=timeout,
                json_body=json_body,
            )
            self._sync_availability_from_contract_response(response)
            return response

        return self._delegate_or_raise(
            "POST",
            url,
            headers=headers,
            timeout=timeout,
            json_body=json_body,
        )

    def _delegate_or_raise(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str],
        timeout: float,
        json_body: JSON | None = None,
    ) -> TransportResponse:
        if self.fallback_transport is not None:
            if method == "GET":
                return self.fallback_transport.get(
                    url,
                    headers=headers,
                    timeout=timeout,
                )
            if method == "DELETE":
                return self.fallback_transport.delete(
                    url,
                    headers=headers,
                    timeout=timeout,
                )
            if json_body is None:
                raise ValueError("json_body is required for POST")
            return self.fallback_transport.post(
                url,
                headers=headers,
                json_body=json_body,
                timeout=timeout,
            )
        raise OpenBrainTransportUnavailableError(
            "Open Brain realtime transport is not runtime available",
            transport="nats_jetstream",
            availability=self.availability,
            fallback_transport=None,
        )

    def _should_use_nats_context_pack(self, json_body: JSON) -> bool:
        if self.availability is not RealtimeTransportAvailability.AVAILABLE:
            return False
        if self.request_reply_driver is None:
            return False
        return _tool_call_name(json_body) == "agent_context_pack"

    def _is_get_contract_call(self, json_body: JSON) -> bool:
        return _tool_call_name(json_body) == "get_contract"

    def _post_context_pack_over_nats(
        self,
        *,
        headers: Mapping[str, str],
        json_body: JSON,
        timeout: float,
    ) -> TransportResponse:
        if self.request_reply_driver is None:
            raise OpenBrainTransportUnavailableError(
                "Open Brain realtime transport is not runtime available",
                transport="nats_jetstream",
                availability=self.availability,
                fallback_transport=(
                    "http_mcp" if self.fallback_transport is not None else None
                ),
            )
        if _header(headers, "x-namespace"):
            raise OpenBrainTransportUnavailableError(
                "Open Brain realtime transport does not support delegated namespace",
                transport="nats_jetstream",
                availability=self.availability,
                fallback_transport=(
                    "http_mcp" if self.fallback_transport is not None else None
                ),
            )
        # Auth-gate (v1: OFF by default on the trusted local bus). When enabled,
        # refuse to publish a request that carries no Authorization header
        # rather than emit an unauthenticated message onto a hardened bus.
        if self.require_message_auth and not _header(headers, "authorization"):
            raise OpenBrainTransportUnavailableError(
                "Open Brain realtime transport requires message auth",
                transport="nats_jetstream",
                availability=self.availability,
                fallback_transport=(
                    "http_mcp" if self.fallback_transport is not None else None
                ),
            )
        unsupported_arguments = _unsupported_nats_context_pack_arguments(json_body)
        if unsupported_arguments:
            raise OpenBrainTransportUnavailableError(
                "Open Brain realtime transport does not support all "
                "agent_context_pack arguments",
                transport="nats_jetstream",
                availability=self.availability,
                fallback_transport=(
                    "http_mcp" if self.fallback_transport is not None else None
                ),
            )
        envelope = _nats_context_pack_envelope(
            json_body,
            sender=self.identity,
            ts=self.clock(),
        )
        correlation_id = _envelope_correlation_id(envelope)
        if _nats_envelope_size_bytes(envelope) > DEFAULT_NATS_MAX_REQUEST_BYTES:
            raise OpenBrainTransportUnavailableError(
                "Open Brain realtime transport request exceeded max_request_bytes",
                transport="nats_jetstream",
                availability=self.availability,
                fallback_transport=(
                    "http_mcp" if self.fallback_transport is not None else None
                ),
            )
        try:
            response = self.request_reply_driver.request(
                self.context_pack_subject,
                envelope,
                headers=_nats_headers(headers),
                timeout=timeout,
            )
        except Exception:
            raise OpenBrainTransportUnavailableError(
                "Open Brain realtime transport request failed",
                transport="nats_jetstream",
                availability=self.availability,
                fallback_transport=(
                    "http_mcp" if self.fallback_transport is not None else None
                ),
            ) from None
        if (
            _nats_response_status(response) == "error"
            and self.fallback_transport is not None
            and self.fallback_on_nats_error
        ):
            _validate_nats_context_pack_response_envelope(
                response,
                expected_correlation_id=correlation_id,
            )
            raise OpenBrainTransportUnavailableError(
                "Open Brain realtime transport returned an error",
                transport="nats_jetstream",
                availability=self.availability,
                fallback_transport="http_mcp",
            )
        return _nats_context_pack_response_to_transport_response(
            response,
            expected_correlation_id=correlation_id,
            json_rpc_id=json_body.get("id"),
        )

    def _sync_availability_from_contract_response(
        self,
        response: TransportResponse,
    ) -> None:
        availability = _nats_availability_from_contract_response(response)
        if availability is None:
            self.availability = RealtimeTransportAvailability.NOT_RUNTIME_AVAILABLE
            return
        if (
            availability is RealtimeTransportAvailability.AVAILABLE
            and self.request_reply_driver is None
        ):
            self.availability = RealtimeTransportAvailability.NOT_RUNTIME_AVAILABLE
            return
        self.availability = availability


class FleetNatsDriver:
    """Concrete :class:`NatsRequestReplyDriver` backed by fleet-nats.

    A thin adapter: it takes the already-built fleet Envelope wire dict from
    :class:`NatsTransport`, publishes it over ``fleet_nats.FleetBus`` as a NATS
    core request, and returns the reply Envelope's wire dict. The transport owns
    the OB wire contract (subject, envelope shape, validation, redaction); this
    driver owns only the NATS I/O.

    Both ``nats-py`` and ``fleet-nats`` are OPTIONAL imports (see
    ``pyproject.toml`` extra ``nats`` and ``nats_wire`` for the fleet-nats
    situation). Construction raises a clear error if either is missing rather
    than failing deep inside a request.

    The :class:`NatsRequestReplyDriver` protocol is synchronous; fleet-nats is
    async. Each request runs on a short-lived event loop via ``asyncio.run`` —
    correct and simple for v1 request/reply. A persistent-connection driver can
    replace this later without changing the transport.
    """

    def __init__(
        self,
        *,
        agent_id: str = "openbrain-memory",
        url: str | None = None,
        env: str = DEFAULT_NATS_ENV,
    ) -> None:
        try:
            import fleet_nats  # type: ignore[import-not-found] # noqa: F401
        except Exception as exc:  # pragma: no cover - optional dep
            raise OpenBrainTransportUnavailableError(
                "fleet-nats is not installed; NATS transport requires the "
                "'nats' extra and the fleet-nats library",
                transport="nats_jetstream",
                availability=RealtimeTransportAvailability.NOT_RUNTIME_AVAILABLE,
            ) from exc
        self.agent_id = agent_id
        self.url = url
        self.env = env

    def request(
        self,
        subject: str,
        payload: JSON,
        *,
        headers: Mapping[str, str],
        timeout: float,
    ) -> JSON:  # pragma: no cover - requires a live broker
        import asyncio

        from fleet_nats import (  # type: ignore[import-not-found]
            BusConfig,
            Envelope,
            FleetBus,
        )

        async def _run() -> JSON:
            config_kwargs: dict[str, Any] = {"agent_id": self.agent_id, "env": self.env}
            if self.url is not None:
                config_kwargs["url"] = self.url
            bus = FleetBus(BusConfig(**config_kwargs))
            await bus.connect()
            try:
                envelope = Envelope.from_bytes(
                    json.dumps(payload).encode("utf-8"),
                )
                reply = await bus.request(subject, envelope, timeout_s=timeout)
            finally:
                await bus.close()
            if reply is None:
                raise OpenBrainTransportUnavailableError(
                    "NATS request received no reply",
                    transport="nats_jetstream",
                    availability=RealtimeTransportAvailability.AVAILABLE,
                )
            wire = json.loads(reply.to_bytes())
            if not isinstance(wire, dict):
                raise OpenBrainProtocolError(
                    "NATS reply envelope was not a JSON object",
                    context="transport:nats_jetstream",
                )
            return wire

        return asyncio.run(_run())


def _tool_call_name(json_body: Mapping[str, Any]) -> str | None:
    params = json_body.get("params")
    if not isinstance(params, Mapping):
        return None
    name = params.get("name")
    return name if isinstance(name, str) else None


def _tool_call_arguments(json_body: Mapping[str, Any]) -> Mapping[str, Any]:
    params = json_body.get("params")
    if not isinstance(params, Mapping):
        return {}
    arguments = params.get("arguments")
    return arguments if isinstance(arguments, Mapping) else {}


_NATS_CONTEXT_PACK_IDENTITY_ARGUMENTS = frozenset(
    {
        "agent",
        "platform",
        "server_id",
        "channel_id",
        "thread_id",
        "session_key",
        # Optional explicit namespace override for lane/namespace binding. When
        # absent, the declared identity binds the namespace.
        "namespace",
    },
)
_NATS_CONTEXT_PACK_BODY_ARGUMENTS = frozenset(
    {
        "query",
        "requested_sections",
        "include_unreviewed_recovery",
        "budget",
    },
)
_NATS_CONTEXT_PACK_SUPPORTED_ARGUMENTS = (
    _NATS_CONTEXT_PACK_IDENTITY_ARGUMENTS | _NATS_CONTEXT_PACK_BODY_ARGUMENTS
)


def _unsupported_nats_context_pack_arguments(
    json_body: Mapping[str, Any],
) -> tuple[str, ...]:
    arguments = _tool_call_arguments(json_body)
    return tuple(
        sorted(
            str(key)
            for key in arguments
            if key not in _NATS_CONTEXT_PACK_SUPPORTED_ARGUMENTS
        ),
    )


def _required_context_pack_string(
    arguments: Mapping[str, Any],
    name: str,
) -> str:
    value = arguments.get(name)
    if not isinstance(value, str) or not value:
        raise ValueError(f"agent_context_pack.{name} is required for NATS transport")
    return value


def _nats_context_pack_envelope(
    json_body: Mapping[str, Any],
    *,
    sender: str = "openbrain-memory",
    ts: str | None = None,
) -> JSON:
    """Build the fleet ``Envelope`` wire dict for an agent_context_pack request.

    The wire request is a fleet-nats :class:`Envelope`:
    ``kind="context_pack_request"``, a caller-supplied ``id``/``ts``, a
    ``correlation_id`` for reply linkage, ``from`` = this client's declared
    identity, and OB's identity + request body carried in ``payload``.

    The ``id`` is the jsonrpc request id; the ``ts`` is supplied by the caller
    (the transport's clock) — never generated in this module — so the module
    stays import-side-effect-free and deterministic under test. When ``ts`` is
    omitted it falls back to the request id (still no clock call here).

    Namespace/lane binding: DECLARED identity by default. The declared lane is
    derived server-side from the envelope ``from``/``identity.agent`` +
    ``session_key`` the caller passed. An explicit ``namespace`` argument is
    emitted as a TOP-LEVEL ``payload.namespace`` hint (matching the canonical
    cross-language wire the TS side conforms to; TS reads ``payload.namespace``,
    NOT ``identity.namespace``).

    Server-authority contract: ``payload.namespace`` is ADVISORY. The server is
    authoritative and re-derives/re-authorizes the namespace from the request's
    auth. On the auth-off local bus this is a trusted-bus convenience; it grants
    NO cross-namespace access the server would not already grant. ``namespace_source``
    is a RESPONSE-ONLY field and is intentionally NOT stamped on the request wire.
    """
    arguments = _tool_call_arguments(json_body)
    body: JSON = {}
    for key in (
        "query",
        "requested_sections",
        "include_unreviewed_recovery",
        "budget",
    ):
        if key in arguments:
            body[key] = arguments[key]

    thread_id = arguments.get("thread_id")
    identity: JSON = {
        "agent": _required_context_pack_string(arguments, "agent"),
        "platform": _required_context_pack_string(arguments, "platform"),
        "server_id": _required_context_pack_string(arguments, "server_id"),
        "channel_id": _required_context_pack_string(arguments, "channel_id"),
        "session_key": _required_context_pack_string(arguments, "session_key"),
    }
    if thread_id is not None:
        if not isinstance(thread_id, str):
            raise ValueError(
                "agent_context_pack.thread_id must be a string for NATS transport",
            )
        identity["thread_id"] = thread_id

    # Lane/namespace binding: declared-by-default, explicit-override. The
    # override rides TOP-LEVEL payload.namespace (canonical wire; TS reads it
    # there). namespace_source is response-only and is NOT stamped on the
    # request. There is intentionally NO client-side namespace allowlist here:
    # the server is the authority and re-authorizes the requested namespace
    # against the request's auth; a client-asserted value is only a wire hint.
    namespace_override = arguments.get("namespace")
    if namespace_override is not None and (
        not isinstance(namespace_override, str) or not namespace_override
    ):
        raise ValueError(
            "agent_context_pack.namespace must be a non-empty string "
            "for NATS transport",
        )

    request_id = str(json_body.get("id"))
    ts_str = ts if ts else request_id
    payload: JSON = {
        "operation": "agent_context_pack",
        "identity": identity,
        "body": body,
        "metadata": {
            "client": "openbrain-memory",
            "client_version": PACKAGE_VERSION,
            "transport": "nats",
        },
    }
    if namespace_override is not None:
        payload["namespace"] = namespace_override
    return build_request_envelope(
        msg_id=request_id,
        ts=ts_str,
        sender=sender,
        correlation_id=request_id,
        payload=payload,
    )


def _default_iso_clock() -> str:
    """Return the current UTC time as an ISO-8601 string.

    Called only at request time (never at import), so the module has no
    import-side clock read and stays deterministic under an injected clock.
    """
    return datetime.now(UTC).isoformat()


def _envelope_correlation_id(envelope: Mapping[str, Any]) -> str:
    correlation_id = envelope.get("correlation_id")
    if not isinstance(correlation_id, str) or not correlation_id:
        raise OpenBrainProtocolError(
            "NATS request envelope missing correlation_id",
            context="transport:nats_jetstream",
        )
    return correlation_id


def _nats_headers(headers: Mapping[str, str]) -> dict[str, str]:
    authorization = _header(headers, "authorization")
    return {"Authorization": authorization} if authorization else {}


def _nats_envelope_size_bytes(envelope: Mapping[str, Any]) -> int:
    return len(json.dumps(envelope, sort_keys=True).encode("utf-8"))


# Fleet Envelope kind for the context-pack reply. The reply mirrors the request
# as a fleet Envelope; OB's status/body/error live in the Envelope payload.
# Canonical cross-language wire kind — the TS side emits exactly this.
CONTEXT_PACK_REPLY_KIND = "context_pack_response"


def _nats_reply_payload(response: object) -> Mapping[str, Any] | None:
    if not isinstance(response, Mapping):
        return None
    payload = response.get("payload")
    return payload if isinstance(payload, Mapping) else None


def _nats_response_status(response: object) -> str | None:
    payload = _nats_reply_payload(response)
    if payload is None:
        return None
    status = payload.get("status")
    return status if isinstance(status, str) else None


def _nats_context_pack_response_to_transport_response(
    response: Mapping[str, Any],
    *,
    expected_correlation_id: str,
    json_rpc_id: Any,
) -> TransportResponse:
    if not isinstance(response, Mapping):
        raise OpenBrainProtocolError(
            "NATS context pack response was not a JSON object",
            context="transport:nats_jetstream",
        )
    _validate_nats_context_pack_response_envelope(
        response,
        expected_correlation_id=expected_correlation_id,
    )
    reply_payload = _nats_reply_payload(response) or {}
    status = reply_payload.get("status")
    if status == "ok":
        result = {
            "content": [
                {
                    "type": "text",
                    "text": json.dumps(reply_payload.get("body"), sort_keys=True),
                }
            ]
        }
        payload = {"jsonrpc": "2.0", "id": json_rpc_id, "result": result}
        return TransportResponse(
            status_code=200,
            headers={"content-type": "application/json"},
            text=json.dumps(payload, sort_keys=True),
        )

    if status == "error":
        error = reply_payload.get("error")
        payload = {
            "error": error
            if isinstance(error, Mapping)
            else {"message": "NATS context pack request failed"},
        }
        return TransportResponse(
            status_code=503,
            headers={"content-type": "application/json"},
            text=json.dumps(payload, sort_keys=True),
        )

    raise OpenBrainProtocolError(
        "NATS context pack response had an unexpected status",
        context="transport:nats_jetstream",
    )


def _validate_nats_context_pack_response_envelope(
    response: Mapping[str, Any],
    *,
    expected_correlation_id: str,
) -> None:
    if response.get("kind") != CONTEXT_PACK_REPLY_KIND:
        raise OpenBrainProtocolError(
            "NATS context pack response had an unexpected kind",
            context="transport:nats_jetstream",
        )
    if response.get("correlation_id") != expected_correlation_id:
        raise OpenBrainProtocolError(
            "NATS context pack response id did not match request",
            context="transport:nats_jetstream",
        )
    payload = _nats_reply_payload(response)
    if payload is None or payload.get("operation") != "agent_context_pack":
        raise OpenBrainProtocolError(
            "NATS context pack response had an unexpected operation",
            context="transport:nats_jetstream",
        )


def _nats_availability_from_contract_response(
    response: TransportResponse,
) -> RealtimeTransportAvailability | None:
    if response.status_code < 200 or response.status_code >= 300:
        return None
    try:
        message = json.loads(response.text)
    except json.JSONDecodeError:
        return None
    if not isinstance(message, Mapping):
        return None
    result = message.get("result")
    if not isinstance(result, Mapping):
        return None
    manifest = _decode_tool_payload(result)
    realtime_transport = manifest.get("realtime_transport")
    if not isinstance(realtime_transport, Mapping):
        return None
    nats = realtime_transport.get("nats_jetstream")
    if not isinstance(nats, Mapping):
        return None
    availability = nats.get("availability")
    if availability == RealtimeTransportAvailability.AVAILABLE.value:
        return RealtimeTransportAvailability.AVAILABLE
    if availability == RealtimeTransportAvailability.NOT_RUNTIME_AVAILABLE.value:
        return RealtimeTransportAvailability.NOT_RUNTIME_AVAILABLE
    return None


class OpenBrainClient:
    def __init__(
        self,
        base_url: str,
        token: str,
        namespace: str,
        agent_id: str | None = None,
        role: str | None = None,
        timeout: float = 30.0,
        transport: Transport | None = None,
        allow_insecure_http: bool = False,
        delegate_namespace: bool = False,
        retry_policy: RetryPolicy | Mapping[str, Any] | None = None,
    ) -> None:
        _validate_base_url(base_url, allow_insecure_http=allow_insecure_http)
        self.base_url = base_url.rstrip("/") + "/"
        self.token = token
        self.namespace = namespace
        self.agent_id = agent_id
        self.role = role
        self.timeout = timeout
        self.transport = transport or UrllibTransport()
        self.delegate_namespace = delegate_namespace
        self.retry_policy = _coerce_retry_policy(retry_policy)
        self._session_id: str | None = None
        self._protocol_version = MCP_PROTOCOL_VERSION
        self._ids = count(1)

    @property
    def session_id(self) -> str | None:
        return self._session_id

    def health(self) -> JSON:
        response = self.transport.get(
            self._url("health"),
            headers={"Accept": "application/json"},
            timeout=self.timeout,
        )
        if response.status_code == 503:
            payload = self._decode_json_response(response, context="health")
            if isinstance(payload, dict) and payload.get("status") == "degraded":
                return payload
        self._raise_for_status(response, context="health")
        payload = self._decode_json_response(response, context="health")
        if not isinstance(payload, dict):
            raise OpenBrainProtocolError(
                "Health response was not a JSON object",
                context="health",
            )
        return payload

    def close(self) -> None:
        session_id = self._session_id
        if not session_id:
            return
        try:
            response = self.transport.delete(
                self._url("mcp"),
                headers=self._mcp_headers(include_session=True, session_id=session_id),
                timeout=self.timeout,
            )
            if response.status_code < 200 or response.status_code >= 300:
                return
        except Exception:
            return
        finally:
            self._session_id = None

    def __enter__(self) -> OpenBrainClient:
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        self.close()

    def call_tool(self, name: str, arguments: Mapping[str, Any] | None = None) -> JSON:
        self._ensure_session()
        request_id = next(self._ids)
        payload: JSON = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "tools/call",
            "params": {"name": name, "arguments": dict(arguments or {})},
        }
        response = self._post_tool_call(payload)
        if self._is_expired_session_response(response):
            self._session_id = None
            self._ensure_session()
            response = self._post_tool_call(payload)
        self._raise_for_status(response, context=f"call_tool:{name}")
        message = self._decode_jsonrpc_response(
            response,
            expected_id=request_id,
            context=f"call_tool:{name}",
        )
        result = message.get("result")
        if not isinstance(result, dict):
            raise OpenBrainProtocolError(
                "MCP tool result was not a JSON object",
                context=f"call_tool:{name}",
            )
        if result.get("isError"):
            raise OpenBrainToolError(
                "Open Brain tool returned an error",
                context=f"call_tool:{name}",
                body=_tool_text(result),
                token=self.token,
                session_id=self._session_id,
            )
        return _decode_tool_payload(result)

    def known_tools(self) -> tuple[str, ...]:
        return tuple(CURRENT_TOOL_HELP)

    def tool_help(self, name: str | None = None) -> Mapping[str, str] | str:
        if name is None:
            return dict(CURRENT_TOOL_HELP)
        try:
            return CURRENT_TOOL_HELP[name]
        except KeyError as exc:
            raise KeyError(f"Unknown Open Brain tool: {name}") from exc

    def access_report(self, **arguments: Any) -> JSON:
        return self.call_tool("access_report", arguments)

    def adjacent_context(self, **arguments: Any) -> JSON:
        return self.call_tool("adjacent_context", arguments)

    def brain_answer(self, **arguments: Any) -> JSON:
        return self.call_tool("brain_answer", arguments)

    def session_start(self, **arguments: Any) -> JSON:
        return self.call_tool("session_start", arguments)

    def session_context(self, **arguments: Any) -> JSON:
        return self.call_tool("session_context", arguments)

    def agent_context_pack(self, **arguments: Any) -> JSON:
        return self.call_tool("agent_context_pack", arguments)

    def working_set_append(self, **arguments: Any) -> JSON:
        return self.call_tool("working_set_append", arguments)

    def recovery_wal_append(self, **arguments: Any) -> JSON:
        return self.call_tool("recovery_wal_append", arguments)

    def recovery_wal_mark(self, **arguments: Any) -> JSON:
        return self.call_tool("recovery_wal_mark", arguments)

    def append_session_event(self, **arguments: Any) -> JSON:
        return self.call_tool("append_session_event", arguments)

    def archive_entry(self, **arguments: Any) -> JSON:
        return self.call_tool("archive_entry", arguments)

    def archive_entity(self, **arguments: Any) -> JSON:
        return self.call_tool("archive_entity", arguments)

    def bulk_archive(self, **arguments: Any) -> JSON:
        return self.call_tool("bulk_archive", arguments)

    def bulk_set_tier(self, **arguments: Any) -> JSON:
        return self.call_tool("bulk_set_tier", arguments)

    def curate_entries(self, **arguments: Any) -> JSON:
        return self.call_tool("curate_entries", arguments)

    def demote_entry(self, **arguments: Any) -> JSON:
        return self.call_tool("demote_entry", arguments)

    def decompose_entry(self, **arguments: Any) -> JSON:
        return self.call_tool("decompose_entry", arguments)

    def find_duplicates(self, **arguments: Any) -> JSON:
        return self.call_tool("find_duplicates", arguments)

    def find_person(self, **arguments: Any) -> JSON:
        return self.call_tool("find_person", arguments)

    def get_entry(self, **arguments: Any) -> JSON:
        return self.call_tool("get_entry", arguments)

    def resolve_entry(self, **arguments: Any) -> JSON:
        return self.call_tool("resolve_entry", arguments)

    def get_entity(self, **arguments: Any) -> JSON:
        return self.call_tool("get_entity", arguments)

    def get_contract(self, **arguments: Any) -> JSON:
        return self.call_tool("get_contract", arguments)

    def operator_doctor(self, **arguments: Any) -> JSON:
        return self.call_tool("operator_doctor", arguments)

    def get_stats(self, **arguments: Any) -> JSON:
        return self.call_tool("get_stats", arguments)

    def lane_load(self, **arguments: Any) -> JSON:
        return self.call_tool("lane_load", arguments)

    def lane_upsert(self, **arguments: Any) -> JSON:
        return self.call_tool("lane_upsert", arguments)

    def link_entities(self, **arguments: Any) -> JSON:
        return self.call_tool("link_entities", arguments)

    def hydrate_entities(self, **arguments: Any) -> JSON:
        return self.call_tool("hydrate_entities", arguments)

    def list_namespaces(self, **arguments: Any) -> JSON:
        return self.call_tool("list_namespaces", arguments)

    def list_repo_facts(self, **arguments: Any) -> JSON:
        return self.call_tool("list_repo_facts", arguments)

    def list_entities(self, **arguments: Any) -> JSON:
        return self.call_tool("list_entities", arguments)

    def list_recent(self, **arguments: Any) -> JSON:
        return self.call_tool("list_recent", arguments)

    def list_stale(self, **arguments: Any) -> JSON:
        return self.call_tool("list_stale", arguments)

    def session_wrap(self, **arguments: Any) -> JSON:
        return self.call_tool("session_wrap", arguments)

    def log_thought(self, **arguments: Any) -> JSON:
        return self.call_tool("log_thought", arguments)

    def log_decision(self, **arguments: Any) -> JSON:
        return self.call_tool("log_decision", arguments)

    def promote_entry(self, **arguments: Any) -> JSON:
        return self.call_tool("promote_entry", arguments)

    def rate_entry(self, **arguments: Any) -> JSON:
        return self.call_tool("rate_entry", arguments)

    def scan_namespace(self, **arguments: Any) -> JSON:
        return self.call_tool("scan_namespace", arguments)

    def search_all(self, **arguments: Any) -> JSON:
        return self.call_tool("search_all", arguments)

    def search_brain(self, **arguments: Any) -> JSON:
        return self.call_tool("search_brain", arguments)

    def session_load(self, **arguments: Any) -> JSON:
        return self.call_tool("session_load", arguments)

    def session_save(self, **arguments: Any) -> JSON:
        return self.call_tool("session_save", arguments)

    def set_tier(self, **arguments: Any) -> JSON:
        return self.call_tool("set_tier", arguments)

    def tier_recommendations(self, **arguments: Any) -> JSON:
        return self.call_tool("tier_recommendations", arguments)

    def update_entry(self, **arguments: Any) -> JSON:
        return self.call_tool("update_entry", arguments)

    def unlink_entities(self, **arguments: Any) -> JSON:
        return self.call_tool("unlink_entities", arguments)

    def upsert_entity(self, **arguments: Any) -> JSON:
        return self.call_tool("upsert_entity", arguments)

    def upsert_repo_fact(self, **arguments: Any) -> JSON:
        return self.call_tool("upsert_repo_fact", arguments)

    def upsert_person(self, **arguments: Any) -> JSON:
        return self.call_tool("upsert_person", arguments)

    def _ensure_session(self) -> None:
        if self._session_id:
            return
        with_retry(
            self._initialize_session,
            retry_policy=self.retry_policy,
            retryable=_is_rate_limit_error,
        )

    def _initialize_session(self) -> None:
        request_id = next(self._ids)
        payload: JSON = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "initialize",
            "params": {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "openbrain-memory", "version": PACKAGE_VERSION},
            },
        }
        response = self.transport.post(
            self._url("mcp"),
            headers=self._mcp_headers(include_session=False),
            json_body=payload,
            timeout=self.timeout,
        )
        self._raise_for_status(response, context="initialize")
        pending_session_id = _header(response.headers, "mcp-session-id")
        if not pending_session_id:
            raise OpenBrainProtocolError(
                "Initialize response missing mcp-session-id",
                context="initialize",
            )
        message = self._decode_jsonrpc_response(
            response,
            expected_id=request_id,
            context="initialize",
        )
        result = message.get("result")
        if not isinstance(result, dict):
            raise OpenBrainProtocolError(
                "Initialize response missing result object",
                context="initialize",
                body=json.dumps(message, sort_keys=True),
                token=self.token,
            )
        protocol_version = result.get("protocolVersion")
        if not isinstance(protocol_version, str):
            raise OpenBrainProtocolError(
                "Initialize response missing protocolVersion",
                context="initialize",
                body=json.dumps(result, sort_keys=True),
                token=self.token,
            )
        self._protocol_version = protocol_version
        self._send_initialized_notification(pending_session_id)
        self._session_id = pending_session_id

    def _send_initialized_notification(self, session_id: str) -> None:
        payload: JSON = {"jsonrpc": "2.0", "method": "notifications/initialized"}
        response = self.transport.post(
            self._url("mcp"),
            headers=self._mcp_headers(include_session=True, session_id=session_id),
            json_body=payload,
            timeout=self.timeout,
        )
        self._raise_for_status(response, context="initialized")

    def _post_tool_call(self, payload: JSON) -> TransportResponse:
        return self.transport.post(
            self._url("mcp"),
            headers=self._mcp_headers(include_session=True),
            json_body=payload,
            timeout=self.timeout,
        )

    def _is_expired_session_response(self, response: TransportResponse) -> bool:
        if response.status_code == 404:
            return True
        if response.status_code != 400:
            return False
        messages = {
            "bad request: missing session or not an initialize request",
            "invalid or missing session",
        }
        try:
            body = response.json()
        except json.JSONDecodeError:
            return response.text.strip().lower() in messages
        if not isinstance(body, dict):
            return False
        error = body.get("error")
        if isinstance(error, str):
            return error.strip().lower() in messages
        if isinstance(error, dict):
            message = error.get("message")
            return isinstance(message, str) and message.strip().lower() in messages
        return False

    def _url(self, path: str) -> str:
        return urljoin(self.base_url, path)

    def _mcp_headers(
        self,
        *,
        include_session: bool,
        session_id: str | None = None,
    ) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
        }
        if self.delegate_namespace:
            headers["X-Namespace"] = self.namespace
        if self.agent_id:
            headers["X-Agent-Id"] = self.agent_id
        if self.role:
            headers["X-Role"] = self.role
        if include_session:
            active_session_id = session_id or self._session_id
            if not active_session_id:
                raise OpenBrainProtocolError(
                    "MCP session has not been initialized",
                    context="headers",
                )
            headers["Mcp-Session-Id"] = active_session_id
            headers["MCP-Protocol-Version"] = self._protocol_version
        return headers

    def _raise_for_status(self, response: TransportResponse, *, context: str) -> None:
        if 200 <= response.status_code < 300:
            return
        retry_after = _retry_after_seconds(response)
        raise OpenBrainHTTPError(
            "Open Brain HTTP error",
            status_code=response.status_code,
            context=context,
            body=response.text,
            token=self.token,
            session_id=self._session_id,
            retry_after_seconds=retry_after,
        )

    def _decode_json_response(
        self,
        response: TransportResponse,
        *,
        context: str,
    ) -> Any:
        try:
            return response.json()
        except json.JSONDecodeError as exc:
            raise OpenBrainProtocolError(
                "Open Brain response was not valid JSON",
                status_code=response.status_code,
                context=context,
                body=response.text,
                token=self.token,
                session_id=self._session_id,
            ) from exc

    def _decode_mcp_response(
        self,
        response: TransportResponse,
        *,
        context: str,
        expected_id: int | None = None,
    ) -> Any:
        text = response.text.strip()
        if not text:
            return None
        content_type = _header(response.headers, "content-type") or ""
        if (
            "text/event-stream" in content_type
            or text.startswith("event:")
            or text.startswith("data:")
        ):
            text = _last_sse_data(text, expected_id=expected_id)
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise OpenBrainProtocolError(
                "MCP response was not valid JSON",
                status_code=response.status_code,
                context=context,
                body=text,
                token=self.token,
                session_id=self._session_id,
            ) from exc

    def _decode_jsonrpc_response(
        self,
        response: TransportResponse,
        *,
        expected_id: int,
        context: str,
    ) -> JSON:
        message = self._decode_mcp_response(
            response,
            context=context,
            expected_id=expected_id,
        )
        if not isinstance(message, dict):
            raise OpenBrainProtocolError(
                "MCP response was not a JSON object",
                context=context,
            )
        if message.get("jsonrpc") != "2.0":
            raise OpenBrainProtocolError(
                "MCP response missing jsonrpc=2.0",
                context=context,
                body=json.dumps(message, sort_keys=True),
                token=self.token,
                session_id=self._session_id,
            )
        if message.get("id") != expected_id:
            raise OpenBrainProtocolError(
                "MCP response id did not match request",
                context=context,
                body=json.dumps(message, sort_keys=True),
                token=self.token,
                session_id=self._session_id,
            )
        if "error" in message:
            raise OpenBrainProtocolError(
                "MCP JSON-RPC error",
                context=context,
                body=json.dumps(message["error"], sort_keys=True),
                token=self.token,
                session_id=self._session_id,
            )
        return message


def _header(headers: Mapping[str, str], name: str) -> str | None:
    wanted = name.lower()
    for key, value in headers.items():
        if key.lower() == wanted:
            return value
    return None


def _retry_after_seconds(response: TransportResponse) -> float | None:
    header = _header(response.headers, "retry-after")
    if header is not None:
        try:
            parsed = float(header)
            if parsed >= 0:
                return parsed
        except ValueError:
            pass
    try:
        body = response.json()
    except json.JSONDecodeError:
        return None
    if not isinstance(body, dict):
        return None
    value = body.get("retry_after_seconds")
    if isinstance(value, (int, float)) and value >= 0:
        return float(value)
    return None


def _coerce_retry_policy(
    policy: RetryPolicy | Mapping[str, Any] | None,
) -> RetryPolicy:
    if policy is None:
        return RetryPolicy()
    if isinstance(policy, RetryPolicy):
        return policy
    return RetryPolicy(**dict(policy))


def _is_rate_limit_error(exc: BaseException) -> bool:
    return getattr(exc, "status_code", None) == 429


def _last_sse_data(text: str, *, expected_id: int | None = None) -> str:
    data_blocks: list[str] = []
    current: list[str] = []
    for line in text.splitlines():
        if not line:
            if current:
                data_blocks.append("\n".join(current))
                current = []
            continue
        if line.startswith("data:"):
            current.append(line.removeprefix("data:").strip())
    if current:
        data_blocks.append("\n".join(current))
    if not data_blocks:
        raise OpenBrainProtocolError("MCP SSE response did not contain data")
    if expected_id is not None:
        for block in data_blocks:
            try:
                message = json.loads(block)
            except json.JSONDecodeError:
                continue
            if isinstance(message, dict) and message.get("id") == expected_id:
                return block
    return data_blocks[-1]


def _sse_event_has_response_id(event: bytes, *, expected_id: int | None = None) -> bool:
    text = event.decode("utf-8", errors="replace")
    for block in _sse_data_blocks(text):
        try:
            message = json.loads(block)
        except json.JSONDecodeError:
            continue
        if not isinstance(message, dict) or "id" not in message:
            continue
        if expected_id is None or message.get("id") == expected_id:
            return True
    return False


def _sse_data_blocks(text: str) -> list[str]:
    data_blocks: list[str] = []
    current: list[str] = []
    for line in text.splitlines():
        if not line:
            if current:
                data_blocks.append("\n".join(current))
                current = []
            continue
        if line.startswith("data:"):
            current.append(line.removeprefix("data:").strip())
    if current:
        data_blocks.append("\n".join(current))
    return data_blocks


def _tool_text(result: Mapping[str, Any]) -> str:
    content = result.get("content")
    if not isinstance(content, list):
        return json.dumps(result, sort_keys=True)
    parts = []
    for item in content:
        if isinstance(item, dict) and item.get("type") == "text":
            parts.append(str(item.get("text", "")))
    return "\n".join(parts)


def _decode_tool_payload(result: Mapping[str, Any]) -> JSON:
    content = result.get("content")
    if not isinstance(content, list) or len(content) != 1:
        return dict(result)
    item = content[0]
    if not isinstance(item, dict) or item.get("type") != "text":
        return dict(result)
    text = item.get("text")
    if not isinstance(text, str):
        return dict(result)
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return dict(result)
    return parsed if isinstance(parsed, dict) else dict(result)


def _validate_base_url(base_url: str, *, allow_insecure_http: bool) -> None:
    parsed = urlparse(base_url)
    if parsed.scheme == "https":
        return
    if parsed.scheme == "http":
        host = (parsed.hostname or "").lower()
        if allow_insecure_http or host in {"localhost", "127.0.0.1", "::1"}:
            return
    raise ValueError(
        "OpenBrainClient base_url must use https, localhost http, "
        "or allow_insecure_http=True"
    )


SENSITIVE_KEY_PATTERN = re.compile(
    r"(?i)(token|secret|password|api[_-]?key|credential|authorization|session[_-]?id)"
)
MAX_REDACT_JSON_DEPTH = 32


def _redact_json_value(value: Any, *, depth: int = 0) -> Any:
    if depth >= MAX_REDACT_JSON_DEPTH:
        return "[REDACTED:depth]"
    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        for key, item in value.items():
            if SENSITIVE_KEY_PATTERN.search(str(key)):
                redacted[str(key)] = "[REDACTED]"
            else:
                redacted[str(key)] = _redact_json_value(item, depth=depth + 1)
        return redacted
    if isinstance(value, list):
        return [_redact_json_value(item, depth=depth + 1) for item in value]
    return value


def _redact_json_text(text: str) -> str | None:
    try:
        parsed = json.loads(text)
    except RecursionError:
        return json.dumps("[REDACTED:depth]")
    except json.JSONDecodeError:
        return None
    return json.dumps(_redact_json_value(parsed), sort_keys=True)


def _redact(
    text: str,
    *,
    token: str | None = None,
    session_id: str | None = None,
    max_length: int = 1000,
) -> str:
    redacted = _redact_json_text(text) or text
    for secret in (token, session_id):
        if secret:
            redacted = redacted.replace(secret, "[REDACTED]")
    redacted = redact_text(redacted)
    if len(redacted) > max_length:
        redacted = redacted[:max_length] + "...[truncated]"
    return redacted
