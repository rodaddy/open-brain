from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from itertools import count
from typing import Any, Protocol, cast
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .policy import redact_text

JSON = dict[str, Any]
MCP_PROTOCOL_VERSION = "2025-03-26"
DEFAULT_MAX_RESPONSE_BYTES = 1_000_000
CURRENT_CONTRACT_VERSION = "2026-06-19.memory-tools.v5"
REQUIRED_CONTRACT_TOOLS = (
    "append_session_event",
    "get_contract",
    "lane_load",
    "lane_upsert",
    "list_repo_facts",
    "log_thought",
    "search_all",
    "session_context",
    "session_start",
    "session_wrap",
    "upsert_repo_fact",
)
CURRENT_TOOL_HELP: Mapping[str, str] = {
    "append_session_event": "Append a durable event to a session lane journal.",
    "brain_answer": "Return cited answer bullets from readable Open Brain evidence.",
    "get_entity": "Fetch a graph entity by ID.",
    "get_contract": "Read the canonical Open Brain public contract manifest.",
    "hydrate_entities": "Refresh missing graph entity embeddings.",
    "lane_load": "Load durable session lanes by filters.",
    "lane_upsert": "Create or update durable session lane metadata.",
    "list_entities": "List graph entities by type, name, or namespace.",
    "list_repo_facts": "Read curated qmd-derived repository facts.",
    "log_thought": "Write a durable thought or observation to Open Brain.",
    "search_all": "Search Open Brain memory and optional qmd-backed code context.",
    "search_brain": "Search Open Brain memory entries.",
    "session_context": "Read durable session lane state and recent events.",
    "session_start": "Find or create a durable session lane and return recent events.",
    "session_wrap": "Checkpoint a session lane with a durable summary.",
    "upsert_repo_fact": "Upsert a curated qmd-derived repository fact.",
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
    ) -> None:
        self.status_code = status_code
        self.context = context
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

    def find_duplicates(self, **arguments: Any) -> JSON:
        return self.call_tool("find_duplicates", arguments)

    def find_person(self, **arguments: Any) -> JSON:
        return self.call_tool("find_person", arguments)

    def get_entry(self, **arguments: Any) -> JSON:
        return self.call_tool("get_entry", arguments)

    def get_entity(self, **arguments: Any) -> JSON:
        return self.call_tool("get_entity", arguments)

    def get_contract(self, **arguments: Any) -> JSON:
        return self.call_tool("get_contract", arguments)

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
        request_id = next(self._ids)
        payload: JSON = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "initialize",
            "params": {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "openbrain-memory", "version": "0.1.0"},
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
        raise OpenBrainHTTPError(
            "Open Brain HTTP error",
            status_code=response.status_code,
            context=context,
            body=response.text,
            token=self.token,
            session_id=self._session_id,
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
