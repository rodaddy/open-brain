from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, HTTPServer
import threading

import pytest

from openbrain_memory import (
    OpenBrainClient,
    OpenBrainHTTPError,
    OpenBrainProtocolError,
    OpenBrainToolError,
)
from openbrain_memory.client import TransportResponse, UrllibTransport


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
            text=json.dumps(self.health_payload) if not self.next_text else self.next_text,
        )

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


def post_requests(transport: FakeTransport):
    return [request for request in transport.requests if request["method"] == "POST"]


def tool_requests(transport: FakeTransport):
    return [
        request
        for request in post_requests(transport)
        if request["json"].get("method") == "tools/call"
    ]


def test_health_check_uses_public_health_endpoint_without_credentials():
    transport = FakeTransport()
    client = make_client(transport)

    assert client.health()["status"] == "healthy"

    request = transport.requests[0]
    assert request["method"] == "GET"
    assert request["url"] == "https://brain.example/health"
    assert request["headers"] == {"Accept": "application/json"}


def test_initialize_sends_auth_namespace_and_stores_session_id():
    transport = FakeTransport()
    client = make_client(transport)

    client.call_tool("search_all", {"query": "namespace routing"})

    initialize = post_requests(transport)[0]
    headers = initialize["headers"]
    assert headers["Authorization"] == "Bearer secret-token"
    assert headers["Accept"] == "application/json, text/event-stream"
    assert headers["Content-Type"] == "application/json"
    assert headers["X-Namespace"] == "bilby"
    assert headers["X-Agent-Id"] == "bilby-agent"
    assert headers["X-Role"] == "agent"
    assert "Mcp-Session-Id" not in headers
    assert initialize["json"]["method"] == "initialize"
    assert client.session_id == "session-123"


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
    client.session_wrap(session_key="s", summary="done")
    client.log_thought(content="fact")
    client.log_decision(title="decision", rationale="because")
    client.search_brain(query="decision")

    assert [call["json"]["params"]["name"] for call in tool_requests(transport)] == [
        "session_context",
        "session_wrap",
        "log_thought",
        "log_decision",
        "search_brain",
    ]


def test_all_registered_tool_wrappers_call_matching_tool_names():
    transport = FakeTransport()
    client = make_client(transport)
    wrapper_names = [
        "access_report",
        "adjacent_context",
        "append_session_event",
        "archive_entry",
        "bulk_archive",
        "bulk_set_tier",
        "curate_entries",
        "demote_entry",
        "find_duplicates",
        "find_person",
        "get_entry",
        "get_stats",
        "lane_load",
        "lane_upsert",
        "link_entities",
        "list_namespaces",
        "list_recent",
        "list_stale",
        "log_decision",
        "log_thought",
        "promote_entry",
        "rate_entry",
        "scan_namespace",
        "search_all",
        "search_brain",
        "session_context",
        "session_load",
        "session_save",
        "session_start",
        "session_wrap",
        "set_tier",
        "tier_recommendations",
        "update_entry",
        "upsert_entity",
        "upsert_person",
    ]

    for name in wrapper_names:
        getattr(client, name)(probe=True)

    assert [call["json"]["params"]["name"] for call in tool_requests(transport)] == wrapper_names


def test_http_errors_include_context_status_and_redact_token():
    transport = FakeTransport()
    transport.next_status = 401
    transport.next_text = "authorization: bearer secret-token session Mcp-Session-Id=session-123"
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
                "text": "api_key=abc123456789 password=hunter2 "
                + ("x" * 1200),
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


def test_initialized_failure_does_not_commit_session_and_retry_reinitializes():
    class FailingInitializedTransport(FakeTransport):
        def __init__(self) -> None:
            super().__init__()
            self.fail_initialized = True

        def post(self, url, *, headers, json_body, timeout):
            if json_body.get("method") == "notifications/initialized" and self.fail_initialized:
                self.fail_initialized = False
                return TransportResponse(
                    status_code=500,
                    headers={"content-type": "application/json"},
                    text='{"error":"init failed"}',
                )
            return super().post(url, headers=headers, json_body=json_body, timeout=timeout)

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
            return super().post(url, headers=headers, json_body=json_body, timeout=timeout)

    client = make_client(InitializeErrorTransport())

    with pytest.raises(OpenBrainProtocolError, match="JSON-RPC error"):
        client.search_all(query="x")
    assert client.session_id is None


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
                    text="event: message\n"
                    f"data: {response.text}\n\n",
                )
            return response

    client = make_client(SseTransport())

    assert client.search_all(query="x")["tool"] == "search_all"


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
