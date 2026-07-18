"""Shared typed fakes for runtime facade tests."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from openbrain_memory import RuntimeConfig, RuntimeScope
from openbrain_memory.client import TransportResponse


class LaneAwareTransport:
    """Fake MCP boundary that rejects writes before session_start."""

    def __init__(self, *, fail_session_start: bool = False) -> None:
        self.fail_session_start = fail_session_start
        self.requests: list[dict[str, Any]] = []
        self.started_sessions: dict[str, dict[str, Any]] = {}
        self.delete_calls = 0

    def get(self, url: str, *, headers: Mapping[str, str], timeout: float) -> Any:
        raise AssertionError("GET not expected")

    def delete(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        timeout: float,
    ) -> TransportResponse:
        self.delete_calls += 1
        return TransportResponse(status_code=200, headers={}, text="")

    def post(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        json_body: Mapping[str, Any],
        timeout: float,
    ) -> TransportResponse:
        self.requests.append(
            {
                "url": url,
                "headers": dict(headers),
                "json": dict(json_body),
                "timeout": timeout,
            }
        )
        method = json_body.get("method")
        if method == "initialize":
            return TransportResponse(
                status_code=200,
                headers={
                    "content-type": "application/json",
                    "mcp-session-id": "runtime-session",
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
        if method != "tools/call":
            raise AssertionError(f"unexpected method: {method}")

        params = json_body["params"]
        tool = params["name"]
        arguments = params["arguments"]
        if tool == "session_start":
            if self.fail_session_start:
                return self._tool_error(json_body["id"], "lane creation failed")
            requested_lane = {
                "namespace": "bilby",
                "session_key": arguments["session_key"],
                "agent": arguments.get("agent"),
                "source": arguments.get("platform"),
                "channel_id": arguments.get("channel_id"),
                "thread_id": arguments.get("thread_id"),
                "project": arguments.get("project"),
                "current_context_md": None,
                "metadata": {"server_id": arguments.get("server_id")},
            }
            lane = self.started_sessions.setdefault(
                arguments["session_key"], requested_lane
            )
            if any(
                lane.get(key) != requested_lane.get(key)
                for key in ("agent", "source", "channel_id", "thread_id")
            ) or lane["metadata"].get("server_id") != requested_lane["metadata"].get(
                "server_id"
            ):
                return self._tool_error(
                    json_body["id"],
                    "existing lane exact scope does not match session_start request",
                )
            return self._tool_result(
                json_body["id"],
                {"lane": lane, "events": [], "is_new": lane is requested_lane},
            )
        elif tool in {"append_session_event", "session_wrap"}:
            session_key = arguments.get("session_key")
            lane = self.started_sessions.get(session_key)
            if lane is None:
                return self._tool_error(json_body["id"], "session lane does not exist")
            expected_scope = {
                "agent": lane.get("agent"),
                "platform": lane.get("source"),
                "server_id": lane["metadata"].get("server_id"),
                "channel_id": lane.get("channel_id"),
                "thread_id": lane.get("thread_id"),
            }
            if any(
                arguments.get(key) != value for key, value in expected_scope.items()
            ):
                return self._tool_error(
                    json_body["id"],
                    f"existing lane scope does not match requested {tool} scope",
                )
            if tool == "session_wrap":
                lane["current_context_md"] = arguments["summary"]
                return self._tool_result(
                    json_body["id"],
                    {
                        "session_id": "session-1",
                        "lane_id": "lane-1",
                        "context_updated": True,
                    },
                )
            return self._tool_result(
                json_body["id"],
                {
                    "event_id": "event-1",
                    "lane_id": "lane-1",
                    "lane_created": False,
                },
            )
        elif tool == "agent_context_pack":
            lane = self.started_sessions.get(arguments["session_key"])
            exact = lane is not None and all(
                (
                    lane.get("agent") == arguments.get("agent"),
                    lane.get("source") == arguments.get("platform"),
                    lane["metadata"].get("server_id") == arguments.get("server_id"),
                    lane.get("channel_id") == arguments.get("channel_id"),
                    lane.get("thread_id") == arguments.get("thread_id"),
                )
            )
            durable = None
            if exact and "durable_lane_context" in arguments.get(
                "requested_sections", []
            ):
                assert lane is not None
                durable = {
                    "label": "durable_lane_context",
                    "lane": {"current_context_md": lane["current_context_md"]},
                    "events": [],
                }
            body = {
                "tool": tool,
                "arguments": arguments,
                "sections": (
                    {"durable_lane_context": durable} if durable is not None else {}
                ),
            }
            return self._tool_result(json_body["id"], body)
        body = {
            "tool": tool,
            "arguments": arguments,
            "sections": {"working_set": {"items": []}},
        }
        return self._tool_result(json_body["id"], body)

    @staticmethod
    def _tool_result(request_id: int, body: Mapping[str, Any]) -> TransportResponse:
        return TransportResponse(
            status_code=200,
            headers={"content-type": "application/json"},
            text=json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {"content": [{"type": "text", "text": json.dumps(body)}]},
                }
            ),
        )

    @staticmethod
    def _tool_error(request_id: int, message: str) -> TransportResponse:
        return TransportResponse(
            status_code=200,
            headers={"content-type": "application/json"},
            text=json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {
                        "isError": True,
                        "content": [{"type": "text", "text": message}],
                    },
                }
            ),
        )


class StartThenFailClient:
    def __init__(self, *, fail_start: bool = False) -> None:
        self.fail_start = fail_start
        self.timeout = 30.0
        self.started = False
        self.closed = False

    def session_start(self, **arguments: Any) -> dict[str, Any]:
        if self.fail_start:
            raise ConnectionError("session start failed with token=secret-value")
        self.started = True
        return {
            "lane": {
                "namespace": "bilby",
                "session_key": arguments["session_key"],
                "agent": arguments["agent"],
                "source": arguments["platform"],
                "channel_id": arguments["channel_id"],
                "thread_id": arguments.get("thread_id"),
                "metadata": {"server_id": arguments["server_id"]},
            }
        }

    def append_session_event(self, **arguments: Any) -> dict[str, Any]:
        if not self.started:
            raise RuntimeError("lane missing")
        raise ConnectionError("append failed with token=secret-value")

    def session_wrap(self, **arguments: Any) -> dict[str, Any]:
        if not self.started:
            raise RuntimeError("lane missing")
        raise ConnectionError("wrap failed with token=secret-value")

    def agent_context_pack(self, **arguments: Any) -> dict[str, Any]:
        raise ConnectionError("recall failed with token=secret-value")

    def close(self) -> None:
        self.closed = True


class WriteResultClient(StartThenFailClient):
    def __init__(
        self,
        *,
        append_result: Mapping[str, Any] | None = None,
        wrap_result: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__()
        self.append_result = dict(append_result or {})
        self.wrap_result = dict(wrap_result or {})

    def append_session_event(self, **arguments: Any) -> dict[str, Any]:
        if not self.started:
            raise RuntimeError("lane missing")
        return dict(self.append_result)

    def session_wrap(self, **arguments: Any) -> dict[str, Any]:
        if not self.started:
            raise RuntimeError("lane missing")
        return dict(self.wrap_result)


class ContextClient(StartThenFailClient):
    def __init__(self) -> None:
        super().__init__()
        self.observed_timeouts: list[float] = []

    def agent_context_pack(self, **arguments: Any) -> dict[str, Any]:
        self.observed_timeouts.append(self.timeout)
        return {"authorized_memory": "token=historical-value"}


class FakeSpool:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.calls: list[tuple[str, dict[str, Any], str | None]] = []

    def append(
        self,
        operation: str,
        payload: Mapping[str, Any],
        *,
        key: str | None = None,
    ) -> str:
        if self.fail:
            raise OSError("spool unavailable")
        self.calls.append((operation, dict(payload), key))
        return key or "spool-key"

    def append_batch(
        self,
        records: Sequence[tuple[str, Mapping[str, Any], str | None]],
    ) -> list[str]:
        if self.fail:
            raise OSError("spool unavailable")
        keys = []
        for operation, payload, key in records:
            self.calls.append((operation, dict(payload), key))
            keys.append(key or f"spool-key-{len(keys)}")
        return keys


@dataclass(frozen=True)
class RunnerResult:
    returncode: int = 0
    stdout: str = ""
    stderr: str = ""


class FakeRunner:
    def __init__(self, result: RunnerResult | None = None) -> None:
        self.result = result
        self.calls: list[tuple[tuple[str, ...], float]] = []

    def __call__(
        self,
        argv: Sequence[str],
        *,
        timeout: float,
    ) -> RunnerResult:
        call = tuple(argv)
        self.calls.append((call, timeout))
        if self.result is not None:
            return self.result
        return RunnerResult(stdout=json.dumps(self._response(call[2])))

    @staticmethod
    def _response(tool: str) -> dict[str, Any]:
        scope = {
            "namespace": "bilby",
            "session_key": "repo/session-4",
            "agent": "bilby",
            "platform": "discord",
            "server_id": "guild-1",
            "channel_id": "channel-2",
            "thread_id": "thread-3",
        }
        if tool == "session_start":
            lane = {
                "namespace": scope["namespace"],
                "session_key": scope["session_key"],
                "agent": scope["agent"],
                "source": scope["platform"],
                "channel_id": scope["channel_id"],
                "thread_id": scope["thread_id"],
                "metadata": {"server_id": scope["server_id"]},
            }
            return {"success": True, "result": {"lane": lane, "is_new": True}}
        if tool == "agent_context_pack":
            return {
                "success": True,
                "result": {
                    "schema": "openbrain.agent_context_pack.v1",
                    "status": "ok",
                    "scope": scope,
                    "sections": {},
                },
            }
        if tool == "append_session_event":
            return {
                "success": True,
                "result": {
                    "event_id": "event-1",
                    "lane_id": "lane-1",
                    "lane_created": False,
                },
            }
        if tool == "session_wrap":
            return {
                "success": True,
                "result": {
                    "session_id": "session-1",
                    "lane_id": "lane-1",
                    "context_updated": True,
                },
            }
        raise AssertionError(f"unexpected fallback tool: {tool}")


class WriteResultRunner(FakeRunner):
    def __init__(self, write_result: Mapping[str, Any]) -> None:
        super().__init__()
        self.write_result = dict(write_result)

    def __call__(
        self,
        argv: Sequence[str],
        *,
        timeout: float,
    ) -> RunnerResult:
        call = tuple(argv)
        self.calls.append((call, timeout))
        tool = call[2]
        response = (
            {"success": True, "result": self.write_result}
            if tool in {"append_session_event", "session_wrap"}
            else self._response(tool)
        )
        return RunnerResult(stdout=json.dumps(response))


def runtime_config(**overrides: Any) -> RuntimeConfig:
    values: dict[str, Any] = {
        "base_url": "https://brain.example",
        "token": "unit-test-token",
        "namespace": "bilby",
    }
    values.update(overrides)
    return RuntimeConfig(**values)


def runtime_scope() -> RuntimeScope:
    return RuntimeScope(
        agent="bilby",
        platform="discord",
        server_id="guild-1",
        channel_id="channel-2",
        thread_id="thread-3",
        session_key="repo/session-4",
    )


def tool_calls(transport: LaneAwareTransport) -> list[dict[str, Any]]:
    return [
        request["json"]
        for request in transport.requests
        if request["json"].get("method") == "tools/call"
    ]


def request_payload(operation: str, **values: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "operation": operation,
        "scope": {
            "agent": "bilby",
            "platform": "discord",
            "server_id": "guild",
            "channel_id": "channel",
            "session_key": "session",
        },
        "config": {
            "base_url": "https://brain.example",
            "token": "unit-test-token",
            "namespace": "bilby",
        },
    }
    payload.update(values)
    return payload
