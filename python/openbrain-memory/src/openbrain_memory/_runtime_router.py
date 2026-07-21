"""Private direct-client and fixed mcp2cli routing for the local runtime."""

from __future__ import annotations

import json
import os
import selectors
import subprocess
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Protocol, cast

from ._runtime_validation import (
    validate_context_pack_scope,
    validate_exact_fields,
    validate_started_lane,
)
from .client import (
    COMPATIBLE_CONTRACT_VERSIONS,
    CURRENT_CONTRACT_SCHEMA_HASH,
    CURRENT_CONTRACT_SCHEMA_VERSION,
    FIRST_CLASS_RUNTIME_TOOL_VERSIONS,
    FIRST_CLASS_RUNTIME_TOOLS,
    JSON,
    PACKAGE_VERSION,
)
from .contract import validate_contract_manifest
from .policy import redact_text

MAX_ERROR_CHARS = 500
DEFAULT_FALLBACK_TIMEOUT_SECONDS = 30.0
MAX_FALLBACK_OUTPUT_BYTES = 1_000_000
_FALLBACK_COMMAND = ("mcp2cli", "open-brain")


class RuntimeCallError(RuntimeError):
    """Raised internally when no direct or fallback call succeeded."""


class FallbackRunner(Protocol):
    """Callable boundary for the fixed mcp2cli fallback."""

    def __call__(
        self,
        argv: Sequence[str],
        *,
        timeout: float,
    ) -> Any: ...


class DirectClient(Protocol):
    """Direct Open Brain methods used by the first-class runtime."""

    timeout: float

    def get_contract(self, **arguments: Any) -> JSON: ...

    def session_start(self, **arguments: Any) -> JSON: ...

    def append_session_event(self, **arguments: Any) -> JSON: ...

    def lane_upsert(self, **arguments: Any) -> JSON: ...

    def upsert_repo_fact(self, **arguments: Any) -> JSON: ...

    def log_thought(self, **arguments: Any) -> JSON: ...

    def log_decision(self, **arguments: Any) -> JSON: ...

    def session_wrap(self, **arguments: Any) -> JSON: ...

    def agent_context_pack(self, **arguments: Any) -> JSON: ...

    def close(self) -> None: ...


DirectResultValidator = Callable[[str, Any], None]


class FallbackScope(Protocol):
    """Scope fields needed to verify fallback responses."""

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


@dataclass
class CallState:
    """Mutable evidence collected across one routed operation."""

    path: str | None = None
    direct_attempted: bool = False
    fallback_attempted: bool = False
    error: str | None = None


class Mcp2CliFallback:
    """Fixed-argv fallback for an existing mcp2cli installation."""

    def __init__(
        self,
        runner: FallbackRunner,
        *,
        namespace: str,
        scope: FallbackScope,
        timeout: float = DEFAULT_FALLBACK_TIMEOUT_SECONDS,
    ) -> None:
        self.runner = runner
        self.namespace = namespace
        self.scope = scope
        self.timeout = timeout
        self._lane_verified = False

    def call(
        self,
        tool: str,
        arguments: Mapping[str, Any],
        *,
        timeout: float | None = None,
    ) -> JSON:
        """Invoke one supported tool and verify its success evidence."""
        if tool in {"append_session_event", "session_wrap"} and not self._lane_verified:
            self.call(
                "session_start",
                _fallback_lane_arguments(arguments),
                timeout=timeout,
            )
        if tool != "get_contract":
            self.call("get_contract", {}, timeout=timeout)
        params = json.dumps(dict(arguments), separators=(",", ":"), sort_keys=True)
        argv = (*_FALLBACK_COMMAND, tool, "--params", params)
        try:
            completed = self.runner(argv, timeout=timeout or self.timeout)
        except Exception as error:
            raise RuntimeCallError(safe_error(error)) from error
        if completed.returncode != 0:
            detail = completed.stderr or completed.stdout or "mcp2cli failed"
            raise RuntimeCallError(safe_text(detail))
        if len(completed.stdout.encode("utf-8")) > MAX_FALLBACK_OUTPUT_BYTES:
            raise RuntimeCallError("mcp2cli output exceeded the response limit")
        if len(completed.stderr.encode("utf-8")) > MAX_FALLBACK_OUTPUT_BYTES:
            raise RuntimeCallError("mcp2cli error output exceeded the response limit")
        try:
            decoded = json.loads(completed.stdout)
        except json.JSONDecodeError as error:
            raise RuntimeCallError("mcp2cli returned invalid JSON") from error
        if not isinstance(decoded, dict):
            raise RuntimeCallError("mcp2cli returned a non-object JSON value")
        if decoded.get("success") is not True:
            raise RuntimeCallError("mcp2cli did not report success=true")
        result = decoded.get("result")
        if not isinstance(result, Mapping):
            raise RuntimeCallError("mcp2cli success response missing result object")
        self._verify_result(tool, result, arguments)
        return cast(JSON, dict(result))

    def _verify_result(
        self,
        tool: str,
        result: Mapping[str, Any],
        arguments: Mapping[str, Any],
    ) -> None:
        if tool == "get_contract":
            _validate_first_class_contract(result, "mcp2cli")
            return
        if tool == "session_start":
            _verify_fallback_lane(
                result,
                self.namespace,
                self.scope,
                project=arguments.get("project"),
            )
            self._lane_verified = True
            return
        if tool == "agent_context_pack":
            _verify_fallback_context_pack(result, self.namespace, self.scope)
            return
        if tool == "append_session_event":
            _verify_append_result(result)
            return
        if tool == "session_wrap":
            _verify_wrap_result(result)
            return
        raise RuntimeCallError(f"unsupported mcp2cli fallback tool: {tool}")


class RuntimeClientRouter:
    """Route first-class runtime calls and direct durable-record replays."""

    def __init__(
        self,
        direct: DirectClient | None,
        fallback: Mcp2CliFallback | None,
        *,
        setup_error: BaseException | None = None,
        direct_result_validator: DirectResultValidator | None = None,
    ) -> None:
        self.direct = direct
        self.fallback = fallback
        self.setup_error = setup_error
        self.direct_result_validator = direct_result_validator
        self.state = CallState()
        self._queue_only = False
        self._direct_only = False

    def reset(self) -> None:
        """Reset evidence for one public runtime operation."""
        self.state = CallState()

    @contextmanager
    def queue_only(self) -> Iterator[None]:
        """Prevent a requested write after failed lane setup from going remote."""
        previous = self._queue_only
        self._queue_only = True
        try:
            yield
        finally:
            self._queue_only = previous

    @contextmanager
    def direct_only(self) -> Iterator[None]:
        """Disable fallback while replaying records from the durable spool."""
        previous = self._direct_only
        self._direct_only = True
        try:
            yield
        finally:
            self._direct_only = previous

    def session_start(self, **arguments: Any) -> JSON:
        return self._call("session_start", arguments)

    def append_session_event(self, **arguments: Any) -> JSON:
        return self._call("append_session_event", arguments)

    def lane_upsert(self, **arguments: Any) -> JSON:
        return self._call("lane_upsert", arguments)

    def upsert_repo_fact(self, **arguments: Any) -> JSON:
        return self._call("upsert_repo_fact", arguments)

    def log_thought(self, **arguments: Any) -> JSON:
        return self._call("log_thought", arguments)

    def log_decision(self, **arguments: Any) -> JSON:
        return self._call("log_decision", arguments)

    def session_wrap(self, **arguments: Any) -> JSON:
        return self._call("session_wrap", arguments)

    def agent_context_pack(
        self,
        *,
        timeout: float | None = None,
        **arguments: Any,
    ) -> JSON:
        return self._call("agent_context_pack", arguments, timeout=timeout)

    def close(self) -> None:
        if self.direct is not None:
            self.direct.close()

    def _ensure_direct_contract(self, *, timeout: float | None) -> None:
        if self.direct is None:
            raise RuntimeCallError("direct client unavailable")
        original_timeout = self.direct.timeout
        if timeout is not None:
            self.direct.timeout = min(original_timeout, timeout)
        try:
            get_contract = getattr(self.direct, "get_contract", None)
            if not callable(get_contract):
                raise RuntimeCallError("direct client does not implement get_contract")
            manifest = get_contract()
            _validate_first_class_contract(manifest, "direct")
        finally:
            self.direct.timeout = original_timeout

    def _call(
        self,
        tool: str,
        arguments: Mapping[str, Any],
        *,
        timeout: float | None = None,
    ) -> JSON:
        if self._queue_only:
            raise RuntimeCallError(
                "lane setup failed; requested write is eligible only for ordered spool"
            )
        direct_error = self.setup_error
        self.state.direct_attempted = (
            self.direct is not None or direct_error is not None
        )
        if self.direct is not None:
            try:
                self._ensure_direct_contract(timeout=timeout)
                method = getattr(self.direct, tool, None)
                if not callable(method):
                    raise RuntimeCallError(
                        f"direct client does not implement {tool}"
                    )
                original_timeout = self.direct.timeout
                if timeout is not None:
                    self.direct.timeout = min(original_timeout, timeout)
                try:
                    result = cast(JSON, method(**dict(arguments)))
                finally:
                    self.direct.timeout = original_timeout
                _verify_direct_result(tool, result)
                if self.direct_result_validator is not None:
                    self.direct_result_validator(tool, result)
                if self.state.path is None:
                    self.state.path = "direct"
                return result
            except Exception as error:
                direct_error = error
        if self.fallback is not None and not self._direct_only:
            self.state.fallback_attempted = True
            try:
                result = self.fallback.call(tool, arguments, timeout=timeout)
                self.state.path = "fallback"
                return result
            except Exception as fallback_error:
                self.state.error = combined_error(direct_error, fallback_error)
                raise RuntimeCallError(self.state.error) from fallback_error
        self.state.error = safe_error(
            direct_error or RuntimeError("direct client unavailable")
        )
        raise RuntimeCallError(self.state.error) from direct_error


def _validate_first_class_contract(manifest: Any, path: str) -> None:
    if not isinstance(manifest, Mapping):
        raise RuntimeCallError(f"{path} get_contract returned a non-object result")
    validation = validate_contract_manifest(
        manifest,
        client_version=PACKAGE_VERSION,
        required_tools=FIRST_CLASS_RUNTIME_TOOLS,
        required_tool_versions=FIRST_CLASS_RUNTIME_TOOL_VERSIONS,
        compatible_contract_versions=COMPATIBLE_CONTRACT_VERSIONS,
        expected_schema_version=CURRENT_CONTRACT_SCHEMA_VERSION,
        expected_schema_hash=CURRENT_CONTRACT_SCHEMA_HASH,
    )
    if not validation.ok:
        raise RuntimeCallError(
            f"{path} get_contract did not prove the first-class runtime contract: "
            + "; ".join(validation.reasons)
        )


def _verify_direct_result(tool: str, result: Any) -> None:
    if tool not in {"append_session_event", "session_wrap"}:
        return
    if not isinstance(result, Mapping):
        raise RuntimeCallError(f"direct {tool} returned a non-object result")
    if tool == "append_session_event":
        _verify_append_result(result)
    else:
        _verify_wrap_result(result)


def _verify_append_result(result: Mapping[str, Any]) -> None:
    if result.get("duplicate") is True:
        return
    if not _nonempty_text(result.get("event_id")) or not _nonempty_text(
        result.get("lane_id")
    ):
        raise RuntimeCallError(
            "append_session_event result did not prove a created or duplicate event"
        )
    if not isinstance(result.get("lane_created"), bool):
        raise RuntimeCallError(
            "append_session_event result missing lane_created boolean"
        )


def _verify_wrap_result(result: Mapping[str, Any]) -> None:
    if (
        not _nonempty_text(result.get("lane_id"))
        or result.get("context_updated") is not True
    ):
        raise RuntimeCallError(
            "session_wrap result did not prove durable lane context update"
        )
    if result.get("duplicate") is True:
        return
    if not _nonempty_text(result.get("session_id")):
        raise RuntimeCallError(
            "session_wrap result did not prove a created or duplicate checkpoint"
        )


def _nonempty_text(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _fallback_lane_arguments(arguments: Mapping[str, Any]) -> dict[str, Any]:
    lane_arguments = {
        name: arguments[name]
        for name in (
            "session_key",
            "agent",
            "platform",
            "server_id",
            "channel_id",
            "thread_id",
            "project",
        )
        if name in arguments
    }
    required = ("session_key", "agent", "platform", "server_id", "channel_id")
    missing = [
        name for name in required if not _nonempty_text(lane_arguments.get(name))
    ]
    if missing:
        raise RuntimeCallError(
            "mcp2cli fallback write cannot verify lane without: " + ", ".join(missing)
        )
    return lane_arguments


def run_subprocess(
    argv: Sequence[str],
    *,
    timeout: float,
) -> subprocess.CompletedProcess[str]:
    """Run argv with incrementally bounded stdout/stderr and a hard timeout."""
    process = subprocess.Popen(  # noqa: S603 - argv is fixed by the caller boundary
        list(argv),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=False,
    )
    if process.stdout is None or process.stderr is None:
        _terminate_and_reap(process)
        raise RuntimeCallError("mcp2cli subprocess pipes were unavailable")
    streams = {process.stdout: bytearray(), process.stderr: bytearray()}
    selector = selectors.DefaultSelector()
    for stream in streams:
        os.set_blocking(stream.fileno(), False)
        selector.register(stream, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout
    try:
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                _terminate_and_reap(process)
                raise RuntimeCallError("mcp2cli timed out")
            events = selector.select(remaining)
            if not events:
                continue
            for key, _ in events:
                stream = cast(Any, key.fileobj)
                chunk = os.read(stream.fileno(), 65_536)
                if not chunk:
                    selector.unregister(stream)
                    continue
                buffer = streams[stream]
                buffer.extend(chunk)
                if len(buffer) > MAX_FALLBACK_OUTPUT_BYTES:
                    _terminate_and_reap(process)
                    label = "output" if stream is process.stdout else "error output"
                    raise RuntimeCallError(
                        f"mcp2cli {label} exceeded the response limit"
                    )
        returncode = process.wait(timeout=max(0.0, deadline - time.monotonic()))
    except subprocess.TimeoutExpired as error:
        _terminate_and_reap(process)
        raise RuntimeCallError("mcp2cli timed out") from error
    except Exception:
        _terminate_and_reap(process)
        raise
    finally:
        selector.close()
        process.stdout.close()
        process.stderr.close()
    stdout = streams[process.stdout].decode("utf-8", errors="replace")
    stderr = streams[process.stderr].decode("utf-8", errors="replace")
    return subprocess.CompletedProcess(list(argv), returncode, stdout, stderr)


def _terminate_and_reap(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        process.wait()
        return
    process.terminate()
    try:
        process.wait(timeout=1.0)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def safe_error(error: BaseException) -> str:
    """Return a bounded redacted exception string."""
    return safe_text(str(error) or error.__class__.__name__)


def safe_text(value: str) -> str:
    """Return bounded redacted diagnostic text."""
    return redact_text(value)[:MAX_ERROR_CHARS]


def combined_error(
    direct_error: BaseException | None,
    fallback_error: BaseException,
) -> str:
    """Combine direct and fallback failures without leaking secrets."""
    direct = safe_error(direct_error) if direct_error is not None else "unavailable"
    return safe_text(
        f"direct failed: {direct}; fallback failed: {safe_error(fallback_error)}"
    )


def _verify_fallback_lane(
    result: Mapping[str, Any],
    namespace: str,
    scope: FallbackScope,
    *,
    project: Any,
) -> None:
    try:
        validate_started_lane(result, namespace, scope)
        lane = cast(Mapping[str, Any], result["lane"])
        if isinstance(project, str) and project and "project" in lane:
            validate_exact_fields(lane, {"project": project}, "session_start result")
    except ValueError as error:
        raise RuntimeCallError(f"mcp2cli {error}") from error


def _verify_fallback_context_pack(
    result: Mapping[str, Any],
    namespace: str,
    scope: FallbackScope,
) -> None:
    try:
        validate_context_pack_scope(result, namespace, scope)
    except ValueError as error:
        raise RuntimeCallError(f"mcp2cli {error}") from error
