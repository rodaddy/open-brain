from __future__ import annotations

import json
import pathlib
import re
import threading
import time
import tomllib
from http.server import BaseHTTPRequestHandler, HTTPServer
from importlib.metadata import PackageNotFoundError, version

import pytest

from openbrain_memory import (
    CURRENT_CONTRACT_VERSION,
    CURRENT_TOOL_HELP,
    PACKAGE_VERSION,
    REQUIRED_CONTRACT_TOOLS,
    OpenBrainClient,
    OpenBrainHTTPError,
    OpenBrainProtocolError,
    OpenBrainToolError,
    RetryPolicy,
)
from openbrain_memory.client import (
    TransportResponse,
    UrllibTransport,
    _resolve_package_version,
)


class FakeTransport:
    def __init__(self) -> None:
        self.requests = []
        self.health_payload = {"status": "healthy", "database": {"connected": True}}
        self.tool_results = {}
        self.next_status = 200
        self.next_text = ""

    def get(self, url, *, headers, timeout):
        self.requests.append(
            {"method": "GET", "url": url, "headers": dict(headers), "timeout": timeout}
        )
        return TransportResponse(
            status_code=self.next_status,
            headers={"content-type": "application/json"},
            text=json.dumps(self.health_payload)
            if not self.next_text
            else self.next_text,
        )

    def delete(self, url, *, headers, timeout):
        self.requests.append(
            {
                "method": "DELETE",
                "url": url,
                "headers": dict(headers),
                "timeout": timeout,
            }
        )
        return TransportResponse(status_code=200, headers={}, text="")

    def post(self, url, *, headers, json_body, timeout):
        self.requests.append(
            {
                "method": "POST",
                "url": url,
                "headers": dict(headers),
                "json": json_body,
                "timeout": timeout,
            }
        )
        if self.next_status >= 400:
            return TransportResponse(
                status_code=self.next_status,
                headers={"content-type": "application/json"},
                text=self.next_text,
            )
        method = json_body.get("method")
        if method == "initialize":
            return TransportResponse(
                status_code=200,
                headers={
                    "content-type": "application/json",
                    "mcp-session-id": "session-123",
                },
                text=json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": json_body["id"],
                        "result": {"protocolVersion": "2025-03-26"},
                    }
                ),
            )
        if method == "notifications/initialized":
            return TransportResponse(status_code=202, headers={}, text="")
        if method == "tools/call":
            name = json_body["params"]["name"]
            result = self.tool_results.get(
                name,
                {
                    "content": [
                        {
                            "type": "text",
                            "text": json.dumps(
                                {
                                    "tool": name,
                                    "ok": True,
                                    "total": 0,
                                    "brain_hits": 0,
                                    "qmd_hits": 0,
                                    "results": [],
                                }
                            ),
                        }
                    ]
                },
            )
            return TransportResponse(
                status_code=200,
                headers={"content-type": "application/json"},
                text=json.dumps(
                    {"jsonrpc": "2.0", "id": json_body["id"], "result": result}
                ),
            )
        raise AssertionError(f"Unexpected JSON-RPC method: {method}")


def make_client(transport: FakeTransport) -> OpenBrainClient:
    return OpenBrainClient(
        "https://brain.example",
        "secret-token",
        "bilby",
        agent_id="bilby-agent",
        role="agent",
        timeout=12.5,
        transport=transport,
    )


def make_retrying_client(transport: FakeTransport) -> OpenBrainClient:
    return OpenBrainClient(
        "https://brain.example",
        "secret-token",
        "bilby",
        agent_id="bilby-agent",
        role="agent",
        timeout=12.5,
        transport=transport,
        retry_policy=RetryPolicy(
            attempts=3,
            backoff_seconds=0,
            max_backoff_seconds=0,
        ),
    )


def make_delegating_client(transport: FakeTransport) -> OpenBrainClient:
    return OpenBrainClient(
        "https://brain.example",
        "secret-token",
        "bilby",
        agent_id="bilby-agent",
        role="agent",
        timeout=12.5,
        transport=transport,
        delegate_namespace=True,
    )


def post_requests(transport: FakeTransport):
    return [request for request in transport.requests if request["method"] == "POST"]


def tool_requests(transport: FakeTransport):
    return [
        request
        for request in post_requests(transport)
        if request["json"].get("method") == "tools/call"
    ]


def header_value(headers: dict[str, str], name: str) -> str | None:
    wanted = name.lower()
    for key, value in headers.items():
        if key.lower() == wanted:
            return value
    return None


def test_health_check_uses_public_health_endpoint_without_credentials():
    transport = FakeTransport()
    client = make_client(transport)

    assert client.health()["status"] == "healthy"

    request = transport.requests[0]
    assert request["method"] == "GET"
    assert request["url"] == "https://brain.example/health"
    assert request["headers"] == {"Accept": "application/json"}


def test_health_returns_structured_degraded_body_for_503():
    transport = FakeTransport()
    transport.next_status = 503
    transport.health_payload = {
        "status": "degraded",
        "database": {"connected": False},
        "error": "database unavailable",
    }
    client = make_client(transport)

    assert client.health() == {
        "status": "degraded",
        "database": {"connected": False},
        "error": "database unavailable",
    }


def test_health_raises_for_unstructured_503_body():
    transport = FakeTransport()
    transport.next_status = 503
    transport.health_payload = {"error": "proxy unavailable"}
    client = make_client(transport)

    with pytest.raises(OpenBrainHTTPError, match="status=503"):
        client.health()


def test_http_error_redacts_deep_json_without_recursion_error():
    body = '{"safe":' * 1200 + '"secret-token"' + "}" * 1200

    error = OpenBrainHTTPError(
        "request failed",
        status_code=500,
        body=body,
        token="secret-token",
    )

    assert "RecursionError" not in str(error)
    assert "[REDACTED:depth]" in str(error)
    assert "secret-token" not in str(error)


def test_initialize_omits_namespace_delegation_by_default_and_stores_session_id():
    transport = FakeTransport()
    client = make_client(transport)

    client.call_tool("search_all", {"query": "namespace routing"})

    initialize = post_requests(transport)[0]
    headers = initialize["headers"]
    assert headers["Authorization"] == "Bearer secret-token"
    assert headers["Accept"] == "application/json, text/event-stream"
    assert headers["Content-Type"] == "application/json"
    assert "X-Namespace" not in headers
    assert headers["X-Agent-Id"] == "bilby-agent"
    assert headers["X-Role"] == "agent"
    assert "Mcp-Session-Id" not in headers
    assert initialize["json"]["method"] == "initialize"
    assert initialize["json"]["params"]["clientInfo"] == {
        "name": "openbrain-memory",
        "version": PACKAGE_VERSION,
    }
    assert client.session_id == "session-123"


def test_package_version_matches_installed_metadata():
    assert PACKAGE_VERSION == version("openbrain-memory")


def test_package_version_falls_back_to_source_pyproject(
    monkeypatch: pytest.MonkeyPatch,
):
    def missing_distribution(_: str) -> str:
        raise PackageNotFoundError("openbrain-memory")

    monkeypatch.setattr("openbrain_memory.client.version", missing_distribution)

    pyproject = pathlib.Path(__file__).resolve().parents[1] / "pyproject.toml"
    expected_version = tomllib.loads(pyproject.read_text(encoding="utf-8"))["project"][
        "version"
    ]
    assert _resolve_package_version() == expected_version


def test_package_version_fallback_returns_unknown_without_source_metadata(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: pathlib.Path,
):
    def missing_distribution(_: str) -> str:
        raise PackageNotFoundError("openbrain-memory")

    monkeypatch.setattr("openbrain_memory.client.version", missing_distribution)

    assert _resolve_package_version(tmp_path / "missing.toml") == "0.0.0+unknown"


def test_initialize_sends_namespace_only_when_delegation_is_enabled():
    transport = FakeTransport()
    client = make_delegating_client(transport)

    client.call_tool("search_all", {"query": "namespace routing"})

    initialize = post_requests(transport)[0]
    headers = initialize["headers"]
    assert headers["X-Namespace"] == "bilby"
    assert headers["X-Agent-Id"] == "bilby-agent"
    assert headers["X-Role"] == "agent"


def test_initialized_notification_and_tool_calls_reuse_session_header():
    transport = FakeTransport()
    client = make_client(transport)

    client.call_tool("search_all", {"query": "policy"})

    initialized = post_requests(transport)[1]
    call = post_requests(transport)[2]
    assert initialized["json"]["method"] == "notifications/initialized"
    assert initialized["headers"]["Mcp-Session-Id"] == "session-123"
    assert initialized["headers"]["MCP-Protocol-Version"] == "2025-03-26"
    assert call["headers"]["Mcp-Session-Id"] == "session-123"
    assert call["headers"]["MCP-Protocol-Version"] == "2025-03-26"


def test_close_sends_delete_once_and_context_manager_closes():
    transport = FakeTransport()
    client = make_client(transport)

    client.search_all(query="x")
    assert client.session_id == "session-123"

    client.close()
    assert client.session_id is None
    client.close()

    delete_requests = [
        request for request in transport.requests if request["method"] == "DELETE"
    ]
    assert len(delete_requests) == 1
    delete = delete_requests[0]
    assert delete["url"] == "https://brain.example/mcp"
    assert delete["headers"]["Authorization"] == "Bearer secret-token"
    assert "X-Namespace" not in delete["headers"]
    assert delete["headers"]["X-Agent-Id"] == "bilby-agent"
    assert delete["headers"]["X-Role"] == "agent"
    assert delete["headers"]["Mcp-Session-Id"] == "session-123"
    assert delete["headers"]["MCP-Protocol-Version"] == "2025-03-26"

    scoped_transport = FakeTransport()
    with make_client(scoped_transport) as scoped:
        scoped.search_all(query="x")
        assert scoped.session_id == "session-123"
    assert scoped.session_id is None
    assert [request["method"] for request in scoped_transport.requests].count(
        "DELETE"
    ) == 1


def test_close_is_best_effort_when_delete_fails():
    class FailingDeleteTransport(FakeTransport):
        def delete(self, url, *, headers, timeout):
            self.requests.append(
                {
                    "method": "DELETE",
                    "url": url,
                    "headers": dict(headers),
                    "timeout": timeout,
                }
            )
            raise ConnectionError("delete failed")

    transport = FailingDeleteTransport()
    client = make_client(transport)

    client.search_all(query="x")
    client.close()

    assert client.session_id is None


def test_generic_call_tool_emits_json_rpc_tools_call_shape():
    transport = FakeTransport()
    client = make_client(transport)

    result = client.call_tool("search_all", {"query": "policy", "limit": 3})

    call = tool_requests(transport)[0]
    assert call["json"]["jsonrpc"] == "2.0"
    assert call["json"]["method"] == "tools/call"
    assert call["json"]["params"] == {
        "name": "search_all",
        "arguments": {"query": "policy", "limit": 3},
    }
    assert result["tool"] == "search_all"
    assert result["results"] == []


def test_representative_wrappers_use_generic_call_tool_shape():
    transport = FakeTransport()
    client = make_client(transport)

    client.session_start(session_key="chan/thread", agent="bilby")
    client.append_session_event(
        session_key="chan/thread",
        event_type="fact",
        content="The client works.",
    )
    client.search_all(query="client works")

    calls = tool_requests(transport)
    assert [call["json"]["params"]["name"] for call in calls] == [
        "session_start",
        "append_session_event",
        "search_all",
    ]
    assert calls[0]["json"]["params"]["arguments"]["session_key"] == "chan/thread"
    assert calls[1]["json"]["params"]["arguments"]["event_type"] == "fact"
    assert calls[2]["json"]["params"]["arguments"]["query"] == "client works"


def test_thin_wrappers_cover_current_issue_scope():
    transport = FakeTransport()
    client = make_client(transport)

    client.session_context(session_key="s")
    client.working_set_append(
        agent="nagatha",
        platform="discord",
        server_id="guild",
        channel_id="chan",
        session_key="session",
        kind="current_intent",
        content="finish the local slice",
    )
    client.agent_context_pack(
        agent="nagatha",
        platform="discord",
        server_id="guild",
        channel_id="chan",
        session_key="session",
        requested_sections=["working_set"],
    )
    client.recovery_wal_append(
        agent="nagatha",
        platform="discord",
        server_id="guild",
        channel_id="chan",
        session_key="session",
        content="recover this trace",
    )
    client.recovery_wal_mark(
        agent="nagatha",
        platform="discord",
        server_id="guild",
        channel_id="chan",
        session_key="session",
        id="rw-1",
        action="review",
        status="reviewed",
    )
    client.session_wrap(session_key="s", summary="done")
    client.log_thought(content="fact")
    client.log_decision(title="decision", rationale="because")
    client.search_brain(query="decision")

    calls = tool_requests(transport)
    assert [call["json"]["params"]["name"] for call in calls] == [
        "session_context",
        "working_set_append",
        "agent_context_pack",
        "recovery_wal_append",
        "recovery_wal_mark",
        "session_wrap",
        "log_thought",
        "log_decision",
        "search_brain",
    ]
    assert calls[1]["json"]["params"]["arguments"] == {
        "agent": "nagatha",
        "platform": "discord",
        "server_id": "guild",
        "channel_id": "chan",
        "session_key": "session",
        "kind": "current_intent",
        "content": "finish the local slice",
    }
    assert calls[2]["json"]["params"]["arguments"] == {
        "agent": "nagatha",
        "platform": "discord",
        "server_id": "guild",
        "channel_id": "chan",
        "session_key": "session",
        "requested_sections": ["working_set"],
    }
    assert calls[3]["json"]["params"]["arguments"] == {
        "agent": "nagatha",
        "platform": "discord",
        "server_id": "guild",
        "channel_id": "chan",
        "session_key": "session",
        "content": "recover this trace",
    }
    assert calls[4]["json"]["params"]["arguments"] == {
        "agent": "nagatha",
        "platform": "discord",
        "server_id": "guild",
        "channel_id": "chan",
        "session_key": "session",
        "id": "rw-1",
        "action": "review",
        "status": "reviewed",
    }


def test_all_registered_tool_wrappers_call_matching_tool_names():
    transport = FakeTransport()
    client = make_client(transport)
    wrapper_names = [
        "access_report",
        "adjacent_context",
        "append_session_event",
        "agent_context_pack",
        "archive_entity",
        "archive_entry",
        "brain_answer",
        "bulk_archive",
        "bulk_set_tier",
        "curate_entries",
        "demote_entry",
        "decompose_entry",
        "find_duplicates",
        "find_person",
        "get_contract",
        "get_entry",
        "resolve_entry",
        "get_entity",
        "get_stats",
        "hydrate_entities",
        "lane_load",
        "lane_upsert",
        "link_entities",
        "list_entities",
        "list_namespaces",
        "list_repo_facts",
        "list_recent",
        "list_stale",
        "log_decision",
        "log_thought",
        "promote_entry",
        "rate_entry",
        "recovery_wal_append",
        "recovery_wal_mark",
        "scan_namespace",
        "search_all",
        "search_brain",
        "session_context",
        "working_set_append",
        "session_load",
        "session_save",
        "session_start",
        "session_wrap",
        "set_tier",
        "tier_recommendations",
        "unlink_entities",
        "update_entry",
        "upsert_entity",
        "upsert_repo_fact",
        "upsert_person",
    ]

    for name in wrapper_names:
        getattr(client, name)(probe=True)

    assert [
        call["json"]["params"]["name"] for call in tool_requests(transport)
    ] == wrapper_names


def test_required_contract_tools_have_first_class_wrappers_and_help():
    assert CURRENT_CONTRACT_VERSION == "2026-07-06.memory-tools.v18"
    assert set(REQUIRED_CONTRACT_TOOLS) <= set(CURRENT_TOOL_HELP)

    for tool_name in REQUIRED_CONTRACT_TOOLS:
        assert hasattr(OpenBrainClient, tool_name), tool_name
        assert CURRENT_TOOL_HELP[tool_name]


def _server_contract_source() -> str:
    # tests/ -> openbrain-memory/ -> python/ -> repo root
    repo_root = pathlib.Path(__file__).resolve().parents[3]
    contract = repo_root / "src" / "contract.ts"
    return contract.read_text(encoding="utf-8")


def _server_contract_version(source: str) -> str:
    match = re.search(r'CONTRACT_VERSION\s*=\s*"([^"]+)"', source)
    assert match, "could not find CONTRACT_VERSION in src/contract.ts"
    return match.group(1)


def _server_required_tools(source: str) -> set[str]:
    return {
        name
        for name, kind in re.findall(
            r'\{\s*name:\s*"([^"]+)",\s*version:\s*\d+,\s*kind:\s*"([^"]+)"',
            source,
        )
        if kind == "tool"
    }


def test_required_contract_matches_server_source_of_truth():
    # Guards against silent drift between the Python snapshot and the server's
    # canonical src/contract.ts. A server version bump or tool change must fail
    # here, forcing both sides to update in one PR.
    source = _server_contract_source()

    assert CURRENT_CONTRACT_VERSION == _server_contract_version(source)
    assert set(REQUIRED_CONTRACT_TOOLS) == _server_required_tools(source)


def test_current_agent_read_helpers_have_first_class_wrappers():
    for tool_name in ("brain_answer", "list_repo_facts", "get_contract", "get_entry"):
        assert hasattr(OpenBrainClient, tool_name), tool_name
        assert tool_name in CURRENT_TOOL_HELP


def test_upsert_repo_fact_sends_payload_without_default_namespace_delegation():
    # A write wrapper must (1) reach the server as the matching tool with the
    # caller payload intact, and (2) keep caller metadata from creating a
    # delegation header. Agent-role tokens derive namespace server-side.
    transport = FakeTransport()
    client = make_client(transport)

    client.upsert_repo_fact(
        repo="rodaddy/open-brain",
        metadata={"namespace": "other-namespace", "fact": "x"},
    )

    calls = tool_requests(transport)
    assert len(calls) == 1
    params = calls[0]["json"]["params"]
    assert params["name"] == "upsert_repo_fact"
    assert params["arguments"] == {
        "repo": "rodaddy/open-brain",
        "metadata": {"namespace": "other-namespace", "fact": "x"},
    }
    assert header_value(calls[0]["headers"], "X-Namespace") is None


def test_upsert_repo_fact_sends_delegation_header_when_enabled():
    transport = FakeTransport()
    client = make_delegating_client(transport)

    client.upsert_repo_fact(
        repo="rodaddy/open-brain",
        metadata={"namespace": "other-namespace", "fact": "x"},
    )

    calls = tool_requests(transport)
    assert len(calls) == 1
    assert header_value(calls[0]["headers"], "X-Namespace") == "bilby"


def test_client_exposes_current_tool_help():
    client = make_client(FakeTransport())

    assert "get_contract" in client.known_tools()
    assert "canonical Open Brain public contract" in client.tool_help("get_contract")
    help_map = client.tool_help()
    assert isinstance(help_map, dict)
    assert help_map["brain_answer"].startswith("Return cited answer")


def test_http_errors_include_context_status_and_redact_token():
    transport = FakeTransport()
    transport.next_status = 401
    transport.next_text = (
        "authorization: bearer secret-token session Mcp-Session-Id=session-123"
    )
    client = make_client(transport)

    with pytest.raises(OpenBrainHTTPError) as exc_info:
        client.call_tool("search_all", {"query": "x"})

    message = str(exc_info.value)
    assert "status=401" in message
    assert "context=initialize" in message
    assert "secret-token" not in message
    assert "[REDACTED]" in message
    assert "authorization" not in message.lower()
    assert "session-123" not in message


def test_tool_errors_include_tool_context_and_redact_token():
    transport = FakeTransport()
    transport.tool_results["search_all"] = {
        "isError": True,
        "content": [
            {
                "type": "text",
                "text": "tool failed with secret-token in body",
            }
        ],
    }
    client = make_client(transport)

    with pytest.raises(OpenBrainToolError) as exc_info:
        client.search_all(query="x")

    message = str(exc_info.value)
    assert "context=call_tool:search_all" in message
    assert "secret-token" not in message
    assert "[REDACTED]" in message


def test_error_body_redaction_caps_and_scrubs_secret_patterns():
    transport = FakeTransport()
    transport.tool_results["search_all"] = {
        "isError": True,
        "content": [
            {
                "type": "text",
                "text": "api_key=abc123456789 password=hunter2 " + ("x" * 1200),
            }
        ],
    }
    client = make_client(transport)

    with pytest.raises(OpenBrainToolError) as exc_info:
        client.search_all(query="x")

    message = str(exc_info.value)
    assert "abc123456789" not in message
    assert "hunter2" not in message
    assert "[truncated]" in message


def test_error_body_redaction_scrubs_json_secret_fields():
    transport = FakeTransport()
    transport.next_status = 500
    transport.next_text = json.dumps(
        {
            "api_key": "abc123456789",
            "password": "hunter2",
            "token": "othersecret123",
            "access_token": "access-secret-123",
            "refresh_token": "refresh-secret-123",
            "nested": {"client_secret": "client-secret-123"},
            "credential": "credential-secret-123",
            "message": "failed",
        }
    )
    client = make_client(transport)

    with pytest.raises(OpenBrainHTTPError) as exc_info:
        client.search_all(query="x")

    message = str(exc_info.value)
    assert "abc123456789" not in message
    assert "hunter2" not in message
    assert "othersecret123" not in message
    assert "access-secret-123" not in message
    assert "refresh-secret-123" not in message
    assert "client-secret-123" not in message
    assert "credential-secret-123" not in message
    assert "failed" in message


def test_error_body_redaction_scrubs_unlabelled_secret_shapes():
    transport = FakeTransport()
    transport.next_status = 500
    aws_access_key = "AKIA" + "ABCDEFGHIJKLMNOP"
    aws_secret = "abcdEFGH" + "ijklMNOP" + "qrstUVWX" + "yz012345" + "6789+/ab"
    slack_token = "xoxb-" + "123456789012-" + "abcdefghijklmnop"
    google_key = "AIza" + "ABCDEFGHIJKLMNOPQRSTUVWX" + "YZabcdefghi"
    jwt_token = (
        "eyJ" + "hbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcGVuLWJyYWluIn0.c2lnbmF0dXJlX3ZhbHVl"
    )
    transport.next_text = "\n".join(
        [aws_access_key, aws_secret, slack_token, google_key, jwt_token]
    )
    client = make_client(transport)

    with pytest.raises(OpenBrainHTTPError) as exc_info:
        client.search_all(query="x")

    message = str(exc_info.value)
    assert aws_access_key not in message
    assert aws_secret not in message
    assert slack_token not in message
    assert google_key not in message
    assert jwt_token not in message


def test_missing_session_id_is_protocol_error():
    class MissingSessionTransport(FakeTransport):
        def post(self, url, *, headers, json_body, timeout):
            response = super().post(
                url, headers=headers, json_body=json_body, timeout=timeout
            )
            if json_body.get("method") == "initialize":
                return TransportResponse(
                    status_code=200,
                    headers={"content-type": "application/json"},
                    text=response.text,
                )
            return response

    client = make_client(MissingSessionTransport())

    with pytest.raises(OpenBrainProtocolError, match="mcp-session-id"):
        client.search_all(query="x")


def test_initialize_rate_limit_retries_with_retry_after_metadata():
    class RateLimitedInitializeTransport(FakeTransport):
        def __init__(self) -> None:
            super().__init__()
            self.rate_limited_once = False

        def post(self, url, *, headers, json_body, timeout):
            if (
                json_body.get("method") == "initialize"
                and not self.rate_limited_once
            ):
                self.rate_limited_once = True
                self.requests.append(
                    {
                        "method": "POST",
                        "url": url,
                        "headers": dict(headers),
                        "json": json_body,
                        "timeout": timeout,
                    }
                )
                return TransportResponse(
                    status_code=429,
                    headers={
                        "content-type": "application/json",
                        "retry-after": "0",
                    },
                    text=json.dumps(
                        {
                            "error": "Too many active sessions",
                            "code": "session_cap_exceeded",
                            "active_sessions": 100,
                            "max_sessions": 100,
                            "retry_after_seconds": 0,
                        }
                    ),
                )
            return super().post(
                url, headers=headers, json_body=json_body, timeout=timeout
            )

    transport = RateLimitedInitializeTransport()
    client = make_retrying_client(transport)

    assert client.search_all(query="x")["tool"] == "search_all"
    assert [
        request["json"]["method"]
        for request in post_requests(transport)
        if request["json"].get("method") == "initialize"
    ] == ["initialize", "initialize"]


def test_initialize_rate_limit_exhaustion_surfaces_retry_after():
    class AlwaysRateLimitedInitializeTransport(FakeTransport):
        def post(self, url, *, headers, json_body, timeout):
            if json_body.get("method") == "initialize":
                self.requests.append(
                    {
                        "method": "POST",
                        "url": url,
                        "headers": dict(headers),
                        "json": json_body,
                        "timeout": timeout,
                    }
                )
                return TransportResponse(
                    status_code=429,
                    headers={
                        "content-type": "application/json",
                        "retry-after": "0.25",
                    },
                    text=json.dumps(
                        {
                            "error": "Too many active sessions",
                            "code": "session_cap_exceeded",
                            "active_sessions": 100,
                            "max_sessions": 100,
                            "retry_after_seconds": 0.25,
                        }
                    ),
                )
            return super().post(
                url, headers=headers, json_body=json_body, timeout=timeout
            )

    transport = AlwaysRateLimitedInitializeTransport()
    client = make_retrying_client(transport)

    with pytest.raises(OpenBrainHTTPError) as exc_info:
        client.search_all(query="x")

    assert exc_info.value.status_code == 429
    assert exc_info.value.retry_after_seconds == 0.25
    assert [
        request["json"]["method"]
        for request in post_requests(transport)
        if request["json"].get("method") == "initialize"
    ] == ["initialize", "initialize", "initialize"]


def test_initialized_failure_does_not_commit_session_and_retry_reinitializes():
    class FailingInitializedTransport(FakeTransport):
        def __init__(self) -> None:
            super().__init__()
            self.fail_initialized = True

        def post(self, url, *, headers, json_body, timeout):
            if (
                json_body.get("method") == "notifications/initialized"
                and self.fail_initialized
            ):
                self.fail_initialized = False
                return TransportResponse(
                    status_code=500,
                    headers={"content-type": "application/json"},
                    text='{"error":"init failed"}',
                )
            return super().post(
                url, headers=headers, json_body=json_body, timeout=timeout
            )

    transport = FailingInitializedTransport()
    client = make_client(transport)

    with pytest.raises(OpenBrainHTTPError, match="context=initialized"):
        client.search_all(query="x")

    assert client.session_id is None
    client.search_all(query="x")
    assert [
        request["json"]["method"]
        for request in post_requests(transport)
        if request["json"].get("method") == "initialize"
    ] == ["initialize", "initialize"]


def test_jsonrpc_response_id_must_match_request():
    class WrongIdTransport(FakeTransport):
        def post(self, url, *, headers, json_body, timeout):
            response = super().post(
                url, headers=headers, json_body=json_body, timeout=timeout
            )
            if json_body.get("method") == "tools/call":
                payload = response.json()
                payload["id"] = 999
                return TransportResponse(
                    status_code=200,
                    headers=response.headers,
                    text=json.dumps(payload),
                )
            return response

    client = make_client(WrongIdTransport())

    with pytest.raises(OpenBrainProtocolError, match="id did not match"):
        client.search_all(query="x")


def test_jsonrpc_response_requires_version():
    class MissingVersionTransport(FakeTransport):
        def post(self, url, *, headers, json_body, timeout):
            response = super().post(
                url, headers=headers, json_body=json_body, timeout=timeout
            )
            if json_body.get("method") == "tools/call":
                payload = response.json()
                payload.pop("jsonrpc", None)
                return TransportResponse(
                    status_code=200,
                    headers=response.headers,
                    text=json.dumps(payload),
                )
            return response

    client = make_client(MissingVersionTransport())

    with pytest.raises(OpenBrainProtocolError, match="jsonrpc=2.0"):
        client.search_all(query="x")


def test_initialize_error_does_not_establish_session():
    class InitializeErrorTransport(FakeTransport):
        def post(self, url, *, headers, json_body, timeout):
            if json_body.get("method") == "initialize":
                return TransportResponse(
                    status_code=200,
                    headers={
                        "content-type": "application/json",
                        "mcp-session-id": "session-123",
                    },
                    text=json.dumps(
                        {
                            "jsonrpc": "2.0",
                            "id": json_body["id"],
                            "error": {"message": "bad init"},
                        }
                    ),
                )
            return super().post(
                url, headers=headers, json_body=json_body, timeout=timeout
            )

    client = make_client(InitializeErrorTransport())

    with pytest.raises(OpenBrainProtocolError, match="JSON-RPC error"):
        client.search_all(query="x")
    assert client.session_id is None


def test_expired_session_400_reinitializes_and_retries_tool_call_once():
    class ExpiredSessionTransport(FakeTransport):
        def __init__(self) -> None:
            super().__init__()
            self.sessions = iter(["session-old", "session-new"])
            self.expired_once = False

        def post(self, url, *, headers, json_body, timeout):
            if json_body.get("method") == "initialize":
                session_id = next(self.sessions)
                self.requests.append(
                    {
                        "method": "POST",
                        "url": url,
                        "headers": dict(headers),
                        "json": json_body,
                        "timeout": timeout,
                    }
                )
                return TransportResponse(
                    status_code=200,
                    headers={
                        "content-type": "application/json",
                        "mcp-session-id": session_id,
                    },
                    text=json.dumps(
                        {
                            "jsonrpc": "2.0",
                            "id": json_body["id"],
                            "result": {"protocolVersion": "2025-03-26"},
                        }
                    ),
                )
            if json_body.get("method") == "tools/call" and not self.expired_once:
                self.expired_once = True
                self.requests.append(
                    {
                        "method": "POST",
                        "url": url,
                        "headers": dict(headers),
                        "json": json_body,
                        "timeout": timeout,
                    }
                )
                return TransportResponse(
                    status_code=400,
                    headers={"content-type": "application/json"},
                    text=(
                        '{"error":"Bad request: missing session or not an '
                        'initialize request"}'
                    ),
                )
            return super().post(
                url, headers=headers, json_body=json_body, timeout=timeout
            )

    transport = ExpiredSessionTransport()
    client = make_client(transport)

    assert client.search_all(query="x")["tool"] == "search_all"
    assert client.session_id == "session-new"
    assert [request["json"].get("method") for request in post_requests(transport)] == [
        "initialize",
        "notifications/initialized",
        "tools/call",
        "initialize",
        "notifications/initialized",
        "tools/call",
    ]

    tool_calls = tool_requests(transport)
    assert len(tool_calls) == 2
    assert header_value(tool_calls[0]["headers"], "Mcp-Session-Id") == "session-old"
    assert header_value(tool_calls[1]["headers"], "Mcp-Session-Id") == "session-new"
    assert tool_calls[0]["json"] == tool_calls[1]["json"]


def test_expired_session_404_reinitializes_and_retries_tool_call_once():
    class GoneSessionTransport(FakeTransport):
        def __init__(self) -> None:
            super().__init__()
            self.sessions = iter(["session-old", "session-new"])
            self.expired_once = False

        def post(self, url, *, headers, json_body, timeout):
            if json_body.get("method") == "initialize":
                session_id = next(self.sessions)
                self.requests.append(
                    {
                        "method": "POST",
                        "url": url,
                        "headers": dict(headers),
                        "json": json_body,
                        "timeout": timeout,
                    }
                )
                return TransportResponse(
                    status_code=200,
                    headers={
                        "content-type": "application/json",
                        "mcp-session-id": session_id,
                    },
                    text=json.dumps(
                        {
                            "jsonrpc": "2.0",
                            "id": json_body["id"],
                            "result": {"protocolVersion": "2025-03-26"},
                        }
                    ),
                )
            if json_body.get("method") == "tools/call" and not self.expired_once:
                self.expired_once = True
                self.requests.append(
                    {
                        "method": "POST",
                        "url": url,
                        "headers": dict(headers),
                        "json": json_body,
                        "timeout": timeout,
                    }
                )
                return TransportResponse(
                    status_code=404,
                    headers={"content-type": "application/json"},
                    text='{"error":"session not found"}',
                )
            return super().post(
                url, headers=headers, json_body=json_body, timeout=timeout
            )

    transport = GoneSessionTransport()
    client = make_client(transport)

    assert client.search_all(query="x")["tool"] == "search_all"
    assert client.session_id == "session-new"
    assert len(tool_requests(transport)) == 2


def test_auth_error_does_not_reinitialize_or_retry_tool_call():
    class AuthErrorTransport(FakeTransport):
        def post(self, url, *, headers, json_body, timeout):
            if json_body.get("method") == "tools/call":
                self.requests.append(
                    {
                        "method": "POST",
                        "url": url,
                        "headers": dict(headers),
                        "json": json_body,
                        "timeout": timeout,
                    }
                )
                return TransportResponse(
                    status_code=401,
                    headers={"content-type": "application/json"},
                    text='{"error":"unauthorized"}',
                )
            return super().post(
                url, headers=headers, json_body=json_body, timeout=timeout
            )

    transport = AuthErrorTransport()
    client = make_client(transport)

    with pytest.raises(OpenBrainHTTPError, match="status=401"):
        client.search_all(query="x")

    assert [request["json"].get("method") for request in post_requests(transport)] == [
        "initialize",
        "notifications/initialized",
        "tools/call",
    ]


def test_tool_validation_400_missing_session_text_does_not_retry():
    class ValidationErrorTransport(FakeTransport):
        def post(self, url, *, headers, json_body, timeout):
            if json_body.get("method") == "tools/call":
                self.requests.append(
                    {
                        "method": "POST",
                        "url": url,
                        "headers": dict(headers),
                        "json": json_body,
                        "timeout": timeout,
                    }
                )
                return TransportResponse(
                    status_code=400,
                    headers={"content-type": "application/json"},
                    text='{"error":"missing session_key argument"}',
                )
            return super().post(
                url, headers=headers, json_body=json_body, timeout=timeout
            )

    transport = ValidationErrorTransport()
    client = make_client(transport)

    with pytest.raises(OpenBrainHTTPError, match="missing session_key"):
        client.session_context()

    assert client.session_id == "session-123"
    assert [request["json"].get("method") for request in post_requests(transport)] == [
        "initialize",
        "notifications/initialized",
        "tools/call",
    ]


def test_sse_mcp_responses_are_decoded():
    class SseTransport(FakeTransport):
        def post(self, url, *, headers, json_body, timeout):
            response = super().post(
                url, headers=headers, json_body=json_body, timeout=timeout
            )
            if json_body.get("method") == "tools/call":
                return TransportResponse(
                    status_code=200,
                    headers={"content-type": "text/event-stream"},
                    text=f"event: message\ndata: {response.text}\n\n",
                )
            return response

    client = make_client(SseTransport())

    assert client.search_all(query="x")["tool"] == "search_all"


def test_openbrain_client_streams_until_matching_sse_jsonrpc_response():
    seen = []

    class StreamingMcpHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_POST(self):
            content_length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(content_length))
            seen.append(
                {
                    "headers": dict(self.headers.items()),
                    "json": payload,
                }
            )

            method = payload.get("method")
            if method == "initialize":
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Mcp-Session-Id", "session-stream")
                self.end_headers()
                self.wfile.write(
                    json.dumps(
                        {
                            "jsonrpc": "2.0",
                            "id": payload["id"],
                            "result": {"protocolVersion": "2025-03-26"},
                        }
                    ).encode("utf-8")
                )
                return

            if method == "notifications/initialized":
                self.send_response(202)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return

            if method == "tools/call":
                result = {
                    "content": [
                        {
                            "type": "text",
                            "text": json.dumps(
                                {
                                    "tool": payload["params"]["name"],
                                    "ok": True,
                                    "results": [],
                                }
                            ),
                        }
                    ]
                }
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                progress = (
                    b'{"jsonrpc":"2.0","method":"notifications/progress",'
                    b'"params":{"progress":1}}'
                )
                self.wfile.write(b"event: message\n" + b"data: " + progress + b"\n\n")
                self.wfile.flush()
                wrong_result = (
                    b'{"jsonrpc":"2.0","id":999,"result":{"content":['
                    b'{"type":"text","text":"{\\"tool\\":\\"wrong\\"}"}]}}'
                )
                self.wfile.write(
                    b"event: message\n" + b"data: " + wrong_result + b"\n\n"
                )
                self.wfile.flush()
                self.wfile.write(
                    b"event: message\n"
                    + (
                        "data: "
                        + json.dumps(
                            {
                                "jsonrpc": "2.0",
                                "id": payload["id"],
                                "result": result,
                            }
                        )
                        + "\n\n"
                    ).encode("utf-8")
                )
                self.wfile.flush()
                time.sleep(1.5)
                return

            self.send_response(400)
            self.end_headers()

        def log_message(self, _format, *args):
            return

    server = HTTPServer(("127.0.0.1", 0), StreamingMcpHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        client = OpenBrainClient(
            f"http://127.0.0.1:{server.server_port}",
            "secret-token",
            "bilby",
            agent_id="bilby-agent",
            role="agent",
            timeout=2,
            transport=UrllibTransport(),
        )
        started = time.monotonic()
        result = client.search_all(query="stream")
        elapsed = time.monotonic() - started
    finally:
        server.shutdown()
        thread.join(timeout=2)

    assert elapsed < 1
    assert result == {"tool": "search_all", "ok": True, "results": []}
    assert [request["json"].get("method") for request in seen] == [
        "initialize",
        "notifications/initialized",
        "tools/call",
    ]

    initialize, initialized, call = seen
    assert header_value(initialize["headers"], "Authorization") == "Bearer secret-token"
    assert header_value(initialize["headers"], "X-Namespace") is None
    assert header_value(initialize["headers"], "X-Agent-Id") == "bilby-agent"
    assert header_value(initialize["headers"], "X-Role") == "agent"
    assert header_value(initialize["headers"], "Mcp-Session-Id") is None
    assert initialize["json"]["id"] == 1

    assert header_value(initialized["headers"], "Mcp-Session-Id") == "session-stream"
    assert header_value(initialized["headers"], "MCP-Protocol-Version") == "2025-03-26"
    assert header_value(call["headers"], "Mcp-Session-Id") == "session-stream"
    assert header_value(call["headers"], "MCP-Protocol-Version") == "2025-03-26"
    assert call["json"] == {
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {"name": "search_all", "arguments": {"query": "stream"}},
    }


def test_urllib_transport_sends_namespace_when_delegation_is_enabled():
    seen = []

    class DelegatingMcpHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            content_length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(content_length))
            seen.append(
                {
                    "headers": dict(self.headers.items()),
                    "json": payload,
                }
            )
            method = payload.get("method")
            if method == "initialize":
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Mcp-Session-Id", "session-delegated")
                self.end_headers()
                self.wfile.write(
                    json.dumps(
                        {
                            "jsonrpc": "2.0",
                            "id": payload["id"],
                            "result": {"protocolVersion": "2025-03-26"},
                        }
                    ).encode("utf-8")
                )
                return
            if method == "notifications/initialized":
                self.send_response(202)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self.send_response(400)
            self.end_headers()

        def log_message(self, _format, *args):
            return

    server = HTTPServer(("127.0.0.1", 0), DelegatingMcpHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        client = OpenBrainClient(
            f"http://127.0.0.1:{server.server_port}",
            "secret-token",
            "bilby",
            agent_id="bilby-agent",
            role="agent",
            timeout=2,
            transport=UrllibTransport(),
            delegate_namespace=True,
        )
        client._ensure_session()
    finally:
        server.shutdown()
        thread.join(timeout=2)

    initialize, initialized = seen
    assert header_value(initialize["headers"], "Authorization") == "Bearer secret-token"
    assert header_value(initialize["headers"], "X-Namespace") == "bilby"
    assert header_value(initialize["headers"], "X-Agent-Id") == "bilby-agent"
    assert header_value(initialize["headers"], "X-Role") == "agent"
    assert header_value(initialize["headers"], "Mcp-Session-Id") is None
    assert header_value(initialized["headers"], "X-Namespace") == "bilby"
    assert header_value(initialized["headers"], "Mcp-Session-Id") == "session-delegated"


def test_urllib_transport_bounds_json_response_size():
    class OversizedHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b"x" * 16)

        def log_message(self, _format, *args):
            return

    server = HTTPServer(("127.0.0.1", 0), OversizedHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with pytest.raises(OpenBrainHTTPError, match="max_response_bytes"):
            UrllibTransport(max_response_bytes=8).get(
                f"http://127.0.0.1:{server.server_port}/health",
                headers={},
                timeout=2,
            )
    finally:
        server.shutdown()
        thread.join(timeout=2)


def test_urllib_transport_bounds_sse_response_size():
    class OversizedSseHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            self.wfile.write(b"data: " + (b"x" * 32) + b"\n\n")

        def log_message(self, _format, *args):
            return

    server = HTTPServer(("127.0.0.1", 0), OversizedSseHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with pytest.raises(OpenBrainHTTPError, match="SSE response exceeded"):
            UrllibTransport(max_response_bytes=8).post(
                f"http://127.0.0.1:{server.server_port}/mcp",
                headers={"Accept": "application/json, text/event-stream"},
                json_body={"jsonrpc": "2.0", "id": 1},
                timeout=2,
            )
    finally:
        server.shutdown()
        thread.join(timeout=2)


def test_urllib_transport_returns_after_first_sse_event_without_waiting_for_eof():
    class StreamingSseHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            self.wfile.write(
                b'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n'
            )
            self.wfile.flush()
            time.sleep(1.5)

        def log_message(self, _format, *args):
            return

    server = HTTPServer(("127.0.0.1", 0), StreamingSseHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        started = time.monotonic()
        response = UrllibTransport().post(
            f"http://127.0.0.1:{server.server_port}/mcp",
            headers={"Accept": "application/json, text/event-stream"},
            json_body={"jsonrpc": "2.0", "id": 1},
            timeout=2,
        )
        elapsed = time.monotonic() - started
    finally:
        server.shutdown()
        thread.join(timeout=2)

    assert elapsed < 1
    assert (
        response.text
        == 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n'
    )


def test_remote_http_requires_explicit_opt_in_but_loopback_is_allowed():
    with pytest.raises(ValueError, match="https"):
        OpenBrainClient("http://brain.example", "token", "bilby")

    OpenBrainClient("http://127.0.0.1:3100", "token", "bilby")
    OpenBrainClient(
        "http://brain.example",
        "token",
        "bilby",
        allow_insecure_http=True,
    )


def test_urllib_transport_does_not_follow_redirects_with_auth_headers():
    class RedirectHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            self.send_response(302)
            self.send_header("Location", "https://evil.example/mcp")
            self.end_headers()

        def log_message(self, _format, *args):
            return

    server = HTTPServer(("127.0.0.1", 0), RedirectHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        response = UrllibTransport().post(
            f"http://127.0.0.1:{server.server_port}/mcp",
            headers={"Authorization": "Bearer secret-token"},
            json_body={"jsonrpc": "2.0"},
            timeout=2,
        )
    finally:
        server.shutdown()
        thread.join(timeout=2)

    assert response.status_code == 302


def test_append_session_event_carries_explicit_share_candidate_nomination():
    # Issue #224: an agent nominates a session event for sharing by setting
    # metadata.share_candidate=true and memory_lifecycle_action=nominate_shared.
    # The low-level Python client must carry that nomination through to the
    # server as a tools/call argument, untouched.
    transport = FakeTransport()
    client = make_client(transport)

    client.append_session_event(
        session_key="chan/thread",
        event_type="fact",
        content="Promotable knowledge.",
        metadata={
            "share_candidate": True,
            "memory_lifecycle_action": "nominate_shared",
            "source": "agent",
        },
    )

    calls = tool_requests(transport)
    assert len(calls) == 1
    params = calls[0]["json"]["params"]
    assert params["name"] == "append_session_event"
    assert params["arguments"] == {
        "session_key": "chan/thread",
        "event_type": "fact",
        "content": "Promotable knowledge.",
        "metadata": {
            "share_candidate": True,
            "memory_lifecycle_action": "nominate_shared",
            "source": "agent",
        },
    }
    # The nomination flag must reach the server as a genuine boolean True, and
    # the explicit lifecycle action must remain attached.
    assert params["arguments"]["metadata"]["share_candidate"] is True
    assert (
        params["arguments"]["metadata"]["memory_lifecycle_action"]
        == "nominate_shared"
    )


def test_append_session_event_surfaces_share_candidate_rejection():
    # The server may synchronously refuse a nomination (e.g. secret/private)
    # and return share_candidate_rejected. The client must surface that field
    # unchanged in the returned payload rather than swallowing it.
    transport = FakeTransport()
    transport.tool_results["append_session_event"] = {
        "content": [
            {
                "type": "text",
                "text": json.dumps(
                    {
                        "tool": "append_session_event",
                        "ok": True,
                        "event_id": "evt-1",
                        "share_candidate_rejected": "reject-secret",
                        "reject_detail": {
                            "category": "reject-secret",
                            "matched_kind": "openai_api_key",
                            "span_count": 1,
                            "redaction_hint": "Remove the credential and re-nominate.",
                            "resubmittable": True,
                            "resubmit_attempt": 0,
                            "max_resubmit_attempts": 2,
                            "resubmit_metadata": {
                                "sanitized_resubmit_of": "evt-1",
                                "sanitized_resubmit_attempt": 1,
                            },
                        },
                    }
                ),
            }
        ]
    }
    client = make_client(transport)

    result = client.append_session_event(
        session_key="chan/thread",
        event_type="fact",
        content="Looks promotable but is secret.",
        metadata={"share_candidate": True},
    )

    assert result["share_candidate_rejected"] == "reject-secret"
    assert result["reject_detail"]["matched_kind"] == "openai_api_key"
    assert result["reject_detail"]["resubmit_metadata"] == {
        "sanitized_resubmit_of": "evt-1",
        "sanitized_resubmit_attempt": 1,
    }
    assert result["event_id"] == "evt-1"


def test_append_session_event_error_still_redacts_secret_metadata_values():
    # Adding the nomination field must not weaken error redaction. If a write
    # carrying secret-looking metadata fails, the secret value must not leak
    # into the raised error, matching existing redaction guarantees.
    transport = FakeTransport()
    transport.tool_results["append_session_event"] = {
        "isError": True,
        "content": [
            {
                "type": "text",
                "text": "append failed: api_key=abc123456789 password=hunter2",
            }
        ],
    }
    client = make_client(transport)

    with pytest.raises(OpenBrainToolError) as exc_info:
        client.append_session_event(
            session_key="chan/thread",
            event_type="fact",
            content="x",
            metadata={"share_candidate": True, "api_key": "abc123456789"},
        )

    message = str(exc_info.value)
    assert "context=call_tool:append_session_event" in message
    assert "abc123456789" not in message
    assert "hunter2" not in message
    assert "[REDACTED]" in message


def test_append_session_event_does_not_mutate_sensitive_looking_payload():
    # GOTCHA (#77 / "Live Writes vs Redaction"): a legitimate but
    # sensitive-LOOKING payload must be transmitted faithfully on the write
    # path. Redaction/refusal is the server's job for stored memory; the client
    # must not strip or mutate share_candidate, content, or metadata
    # client-side. This proves the outgoing body equals the caller's payload.
    transport = FakeTransport()
    client = make_client(transport)

    metadata = {
        "share_candidate": True,
        # Sensitive-looking keys/values that the diagnostic redaction layer
        # would scrub in an ERROR body, but which are legitimate write content.
        "api_key": "abc123456789",
        "password": "hunter2",
        "token": "looks-like-a-token",
    }
    content = "Token rotation runbook: password=hunter2 api_key=abc123456789"

    client.append_session_event(
        session_key="chan/thread",
        event_type="fact",
        content=content,
        metadata=metadata,
    )

    calls = tool_requests(transport)
    assert len(calls) == 1
    arguments = calls[0]["json"]["params"]["arguments"]
    # The write path transmits the payload verbatim -- no client-side scrubbing.
    assert arguments["content"] == content
    assert arguments["metadata"] == metadata
    assert arguments["metadata"]["share_candidate"] is True
    assert "[REDACTED]" not in json.dumps(arguments)
