"""Functional tests for the hook entrypoints, over CAPTURED harness stdin.

Every entrypoint is exercised with the bytes Claude Code actually sent
(``tests/fixtures/captured_hooks/``), not a payload hand-written from docs. The
contract each proves is the acceptance criterion in
``_plans/418-prov-9-hook-entrypoints.md``: stdin in, exit 0, empty stdout.

``stop`` gets more: with a recording lane it must deliver the turns and advance
the watermark ONLY after the lane returns, and with a failing lane it must still
exit 0 with empty stdout and leave the watermark where it was -- capture never
blocks or breaks a session (``docs/decisions/capture-never-drops-a-turn.md``).
"""

from __future__ import annotations

import io
import json
import socket
import threading
import time
from collections.abc import Mapping
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import TYPE_CHECKING

import pytest

from conftest import (
    ClosingRecorder,
    RecordingLane,
    UnreachableLane,
    operator_line,
    write_lines,
)
from openbrain.apps.capture.watermark import WatermarkStore
from openbrain.apps.hooks import stop
from openbrain.apps.hooks.dispatch import ENTRYPOINTS
from openbrain.apps.hooks.session import (
    STOP_HOOK_DEADLINE_SECONDS,
    CaptureNotConfiguredError,
    StartedLane,
    StopHook,
    run_stop,
)
from openbrain.config import CaptureSettings

if TYPE_CHECKING:
    from typing import TextIO

FIXTURES = Path(__file__).parent / "fixtures" / "captured_hooks"

#: The verified events with a fixture and an entrypoint. ``PostCompact`` is now
#: present: a real compaction was forced on 2026-07-31, it fired, and its stdin
#: is captured (fixtures README) rather than unknown.
CAPTURED_EVENTS = (
    "SessionStart",
    "UserPromptSubmit",
    "Stop",
    "SessionEnd",
    "PreToolUse",
    "PostToolUse",
    "SubagentStop",
    "PreCompact",
    "PostCompact",
)


def fixture_bytes(event: str) -> str:
    """The captured stdin for one event, byte-exact as the harness sent it."""
    return (FIXTURES / f"{event}.json").read_text(encoding="utf-8")


def stream_for(event: str) -> TextIO:
    """A stdin stream carrying one event's captured payload."""
    return io.StringIO(fixture_bytes(event))


class TestEveryEntrypointAcceptsItsCapturedInput:
    """stdin -> exit 0, empty stdout, for each verified event's real bytes."""

    @pytest.mark.parametrize("event", CAPTURED_EVENTS)
    def test_the_dispatch_table_runs_the_captured_event(
        self, event: str, capsys: pytest.CaptureFixture[str]
    ) -> None:
        # Stop reaches load_settings, which needs capture config; the stubs do
        # not. Test Stop's real behaviour separately -- here, only that a
        # dispatch entry exists and the stubs run clean over real input.
        entrypoint = ENTRYPOINTS[event]
        assert callable(entrypoint)
        if event != "Stop":
            assert entrypoint(stream_for(event)) == 0
            assert capsys.readouterr().out == ""

    def test_the_table_covers_exactly_the_captured_events(self) -> None:
        """A key with no fixture, or a fixture with no key, is a drift bug."""
        assert set(ENTRYPOINTS) == set(CAPTURED_EVENTS)

    def test_postcompact_now_has_an_entrypoint_and_a_fixture(self) -> None:
        """The last uncaptured event fired on 2026-07-31 -- it is verified now.

        Its stdin was captured (not invented) by forcing a real compaction, so
        it earns a dispatch entry and a byte-exact fixture like every other
        verified event. The old ``must not exist`` assertion is inverted to the
        new truth.
        """
        assert "PostCompact" in ENTRYPOINTS
        assert (FIXTURES / "PostCompact.json").exists()

    def test_postcompact_fixture_carries_the_compact_summary(self) -> None:
        """The field that distinguishes PostCompact from PreCompact is present.

        ``compact_summary`` is the generated summary that replaces the discarded
        context -- the real payload field a parser must expect, proven by the
        captured bytes, not docs.
        """
        payload = json.loads(fixture_bytes("PostCompact"))
        assert payload["hook_event_name"] == "PostCompact"
        assert payload["trigger"] == "manual"
        assert isinstance(payload["compact_summary"], str)
        assert payload["compact_summary"] != ""


class TestStubsDrainAndExitZero:
    """A stub consumes its payload and acts on nothing."""

    STUB_EVENTS = tuple(e for e in CAPTURED_EVENTS if e != "Stop")

    @pytest.mark.parametrize("event", STUB_EVENTS)
    def test_a_stub_returns_zero_and_reads_its_input(self, event: str) -> None:
        stream = stream_for(event)
        assert ENTRYPOINTS[event](stream) == 0
        # The whole payload was consumed -- an unread pipe can wedge the writer.
        assert stream.read() == ""


class TestStopParsesTheCapturedPayload:
    """The Stop fixture yields the transcript path and session id capture needs."""

    def test_transcript_and_session_are_read_from_the_real_bytes(self) -> None:
        payload = StopHook.model_validate_json(fixture_bytes("Stop"))
        captured = json.loads(fixture_bytes("Stop"))
        assert payload.session_id == captured["session_id"]
        assert str(payload.transcript_path) == captured["transcript_path"]


def started(lane: object, close: object = None) -> StartedLane:
    """Wrap a recorder as the :class:`StartedLane` a ``lane_factory`` returns.

    The injected factory now hands back a lane PLUS its closer; a recorder holds
    no session slot, so its close defaults to a no-op unless the test wants to
    observe it.
    """
    return StartedLane(lane=lane, close=close or (lambda: None))  # type: ignore[arg-type]


def capture_settings(watermark_path: Path) -> CaptureSettings:
    """A CaptureSettings pointed at a temp watermark; endpoint values are inert.

    run_stop with an injected lane_factory never builds a real client, so the
    base_url and token here are never dialed -- they exist because the section
    requires them, not because the test reaches a service.
    """
    return CaptureSettings(
        base_url="http://127.0.0.1:0",
        token="unused-in-injected-lane-tests",  # noqa: S106 -- not a real secret
        watermark_path=watermark_path,
    )


class TestStopDeliversThroughTheSpine:
    """run_stop is the capability the entrypoint calls; drive it with a lane."""

    async def test_turns_are_delivered_and_the_watermark_advances_after(
        self, tmp_path: Path
    ) -> None:
        transcript = tmp_path / "t.jsonl"
        write_lines(
            transcript,
            [operator_line("u1", "use postgres not sqlite", session="sess")],
        )
        watermark = tmp_path / "wm.sqlite"
        settings = capture_settings(watermark)
        lane = RecordingLane()
        payload = StopHook(transcript_path=transcript, session_id="sess")

        result = await run_stop(
            payload, settings, lane_factory=lambda _s, _k: started(lane)
        )

        assert result is not None
        assert result.delivered == 1
        assert lane.turns[0]["content"] == "use postgres not sqlite"
        # Advanced only after the lane returned: the stored offset now matches
        # what the delivery reported, which is EOF of the read file.
        stored = await WatermarkStore(watermark).offset_for("sess")
        assert stored == result.next_offset
        assert stored == transcript.stat().st_size

    async def test_a_payload_with_no_transcript_delivers_nothing(
        self, tmp_path: Path
    ) -> None:
        settings = capture_settings(tmp_path / "wm.sqlite")
        payload = StopHook(session_id="sess")  # no transcript_path

        result = await run_stop(
            payload, settings, lane_factory=lambda _s, _k: started(RecordingLane())
        )

        assert result is None

    async def test_a_failed_lane_leaves_the_watermark_where_it_was(
        self, tmp_path: Path
    ) -> None:
        """The unadvanced watermark is the retry; the turn is not lost."""
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "must not be lost", session="sess")])
        watermark = tmp_path / "wm.sqlite"
        settings = capture_settings(watermark)
        broken = UnreachableLane()
        payload = StopHook(transcript_path=transcript, session_id="sess")

        with pytest.raises(RuntimeError):
            await run_stop(
                payload, settings, lane_factory=lambda _s, _k: started(broken)
            )

        assert broken.calls == 1
        assert await WatermarkStore(watermark).offset_for("sess") == 0


class TestStopReleasesTheSessionSlot:
    """run_stop closes the lane on BOTH paths -- a slot left open exhausts the cap.

    The server caps sessions per worker; a Stop that opens one and never frees it
    lets a burst hit ``session_cap_exceeded``. ``run_stop`` owns the close in a
    ``finally``, so it happens whether the delivery returned or raised.
    """

    async def test_close_is_called_after_a_successful_delivery(
        self, tmp_path: Path
    ) -> None:
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "kept", session="sess")])
        settings = capture_settings(tmp_path / "wm.sqlite")
        recorder = ClosingRecorder()
        payload = StopHook(transcript_path=transcript, session_id="sess")

        result = await run_stop(
            payload,
            settings,
            lane_factory=lambda _s, _k: started(recorder, recorder.close),
        )

        assert result is not None
        assert result.delivered == 1
        assert recorder.closed == 1

    async def test_close_is_called_even_when_the_send_fails(
        self, tmp_path: Path
    ) -> None:
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "boom", session="sess")])
        settings = capture_settings(tmp_path / "wm.sqlite")
        recorder = ClosingRecorder(fail=True)
        payload = StopHook(transcript_path=transcript, session_id="sess")

        with pytest.raises(RuntimeError):
            await run_stop(
                payload,
                settings,
                lane_factory=lambda _s, _k: started(recorder, recorder.close),
            )

        assert recorder.closed == 1


class TestStopEntrypointNeverDisruptsTheSession:
    """capture_stop swallows everything and exits 0 with empty stdout."""

    def test_a_malformed_payload_is_swallowed(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        stop.capture_stop(io.StringIO("{not json"))
        assert capsys.readouterr().out == ""

    def test_main_returns_zero(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("sys.stdin", io.StringIO("{not json"))
        assert stop.main() == 0

    def test_stdin_content_never_reaches_the_log(
        self, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """A sentinel in a malformed payload must not appear in any log output.

        loguru's ``diagnose`` renders an exception's locals -- and a pydantic
        ``ValidationError`` from a bad Stop payload carries its ``input_value``,
        which is the hook's raw stdin. The failure log must be content-free by
        construction, so it holds even against a sink with diagnose turned ON
        (the default for the stderr handler a hook actually logs to).
        """
        from loguru import logger

        sink = io.StringIO()
        sink_id = logger.add(sink, backtrace=True, diagnose=True, level="WARNING")
        try:
            # session_id is a list, so pydantic raises a ValidationError whose
            # input_value embeds SECRET-CONTENT-SENTINEL verbatim.
            payload = '{"session_id": ["SECRET-CONTENT-SENTINEL"], '
            payload += '"transcript_path": "/x"}'
            stop.capture_stop(io.StringIO(payload))
        finally:
            logger.remove(sink_id)

        captured = capsys.readouterr()
        assert "SECRET-CONTENT-SENTINEL" not in sink.getvalue()
        assert "SECRET-CONTENT-SENTINEL" not in captured.err
        assert "SECRET-CONTENT-SENTINEL" not in captured.out
        # The failure WAS logged -- content-free, by class name.
        assert "Stop capture failed" in sink.getvalue()


class TestUnconfiguredCaptureFailsAtUseNotAtLoad:
    """base_url/token are optional so a non-hook process loads; a hook needs both.

    The requirement moved to use time (``apps.hooks.session``) so an unrelated
    process is not failed at startup by capture config it never uses. When a
    ``Stop`` DOES run against an unconfigured capture, the real lane factory
    raises -- and the entrypoint swallows it, exactly like any other fault.
    """

    async def test_run_stop_raises_when_no_endpoint_or_token(
        self, tmp_path: Path
    ) -> None:
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "hi", session="sess")])
        # No lane_factory: run_stop uses the real _started_memory, which checks
        # config before importing or dialing anything.
        settings = CaptureSettings(watermark_path=tmp_path / "wm.sqlite")
        payload = StopHook(transcript_path=transcript, session_id="sess")

        with pytest.raises(CaptureNotConfiguredError):
            await run_stop(payload, settings)

    def test_the_entrypoint_swallows_that_and_leaves_stdout_empty(
        self, capsys: pytest.CaptureFixture[str], tmp_path: Path
    ) -> None:
        # A payload with a transcript reaches the real factory, which raises
        # CaptureNotConfiguredError; capture_stop must eat it.
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "hi", session="sess")])
        payload = json.dumps(
            {"transcript_path": str(transcript), "session_id": "sess"}
        )

        stop.capture_stop_with(io.StringIO(payload), _unconfigured_settings())

        assert capsys.readouterr().out == ""


def _unconfigured_settings() -> CaptureSettings:
    """A CaptureSettings with no endpoint or token -- capture is not set up."""
    return CaptureSettings()


class _StallingEndpoint:
    """A TCP listener that accepts a connection and never answers it.

    This is the failure the timeout budget exists for: an endpoint that is up
    enough to accept the socket but never sends a byte back. Without a client
    timeout the request blocks on the read until the OS gives up, far past the
    5-second Stop deadline, and Claude Code kills the process mid-capture.
    """

    def __init__(self) -> None:
        self._server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._server.bind(("127.0.0.1", 0))
        self._server.listen(8)
        self.port = self._server.getsockname()[1]
        self._accepted: list[socket.socket] = []
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._accept_and_hold, daemon=True)
        self._thread.start()

    def _accept_and_hold(self) -> None:
        self._server.settimeout(0.25)
        while not self._stop.is_set():
            try:
                conn, _addr = self._server.accept()
            except OSError:
                continue
            # Hold the connection open and send nothing -- the client's read
            # blocks until ITS timeout fires, which is the whole point.
            self._accepted.append(conn)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def close(self) -> None:
        self._stop.set()
        self._thread.join(timeout=2.0)
        for conn in self._accepted:
            conn.close()
        self._server.close()


@pytest.fixture
def stalling_endpoint() -> object:
    """A stalling TCP endpoint, torn down after the test."""
    endpoint = _StallingEndpoint()
    try:
        yield endpoint
    finally:
        endpoint.close()


class TestStopSurvivesAStalledEndpointWithinTheDeadline:
    """The structural time budget: a stalled endpoint cannot outlast the deadline.

    Drives the REAL ``_started_memory`` factory (no injected lane) against a
    socket that accepts and never responds. The client's per-request timeout,
    with retry pinned to one attempt, bounds the worst-case wall time under
    Claude Code's 5-second Stop deadline. The turn is not lost: the watermark is
    left unmoved, so the next Stop re-reads it.
    """

    def test_main_returns_zero_fast_and_leaves_the_watermark_unmoved(
        self,
        capsys: pytest.CaptureFixture[str],
        tmp_path: Path,
        stalling_endpoint: _StallingEndpoint,
    ) -> None:
        transcript = tmp_path / "t.jsonl"
        write_lines(
            transcript, [operator_line("u1", "held hostage", session="sess")]
        )
        watermark = tmp_path / "wm.sqlite"
        settings = CaptureSettings(
            base_url=stalling_endpoint.base_url,
            token="tok",  # noqa: S106 -- not a real secret
            watermark_path=watermark,
        )
        payload = json.dumps(
            {"transcript_path": str(transcript), "session_id": "sess"}
        )

        start = time.monotonic()
        # capture_stop_with(settings=...) reaches the real factory and dials the
        # stalling endpoint, then swallows the timeout.
        stop.capture_stop_with(io.StringIO(payload), settings)
        elapsed = time.monotonic() - start

        # Under the deadline, with headroom -- the harness would not have killed
        # it. This is the acceptance criterion the budget exists to satisfy.
        assert elapsed < STOP_HOOK_DEADLINE_SECONDS
        # The Stop contract held: empty stdout, and no exception escaped.
        assert capsys.readouterr().out == ""
        # The turn was NOT delivered, so the watermark never advanced -- the next
        # Stop re-reads it. No watermark file, or a zero offset, both prove it.
        store = WatermarkStore(watermark)
        assert asyncio_run(store.offset_for("sess")) == 0


def asyncio_run(coro: object) -> object:
    """Run a coroutine to completion -- a tiny shim so the sync test can await."""
    import asyncio

    return asyncio.run(coro)  # type: ignore[arg-type]


def _make_scripted_handler(
    server: _ScriptedMCPServer,
) -> type[BaseHTTPRequestHandler]:
    """Build a request handler bound to one scripted server.

    The handler is a thin adapter: it reads the body, pays the configured delay,
    asks the server for the reply, and writes it. All routing choices live on the
    server, so this stays trivial and the server holds the test-visible state.
    """

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: object) -> None:  # noqa: D401 - silence logs
            return

        def _write(self, reply: _ScriptedReply) -> None:
            status, body, headers = reply
            self.send_response(status)
            for key, value in headers.items():
                self.send_header(key, value)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_DELETE(self) -> None:  # noqa: N802 - http.server naming
            server.delay()
            self._write(server.delete_reply())

        def do_POST(self) -> None:  # noqa: N802 - http.server naming
            server.delay()
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b""
            try:
                payload = json.loads(raw or b"{}")
            except json.JSONDecodeError:
                payload = {}
            self._write(server.reply_for(payload))

    return Handler


#: One scripted reply: the HTTP status, the JSON body, and any extra headers.
_ScriptedReply = tuple[int, bytes, dict[str, str]]


def _jsonrpc_ok(request_id: object, result: dict[str, object]) -> bytes:
    return json.dumps({"jsonrpc": "2.0", "id": request_id, "result": result}).encode()


def _tool_ok_body(request_id: object) -> bytes:
    return _jsonrpc_ok(
        request_id,
        {"content": [{"type": "text", "text": json.dumps({"ok": 1})}]},
    )


class _ScriptedMCPServer:
    """A real localhost MCP endpoint that speaks the five-request lifecycle.

    The stalling endpoint above proves the timeout on a socket that answers
    NOTHING; these tests need one that answers, and can be told HOW: return a 429
    with ``Retry-After`` on ``session_start``, or add a real per-request delay to
    every leg. It drives the REAL ``_started_memory`` factory end to end, so what
    it observes is proof about the factory's own wiring -- both retry policies,
    the close on the startup path -- not about a stubbed lane.

    It counts each request kind and records whether the ``DELETE`` (session
    close) ever arrived, so a test can assert on exactly-once calls and on
    slot release. ``request_delay_seconds`` sleeps inside EVERY handler, so the
    worst-case wall time is the whole lifecycle paying the delay, which is what
    the per-request-timeout budget is sized against.

    The routing lives on the server (``reply_for``/``delete_reply``), not in the
    nested handler, so the handler stays a thin adapter: read, delay, delegate,
    write.
    """

    def __init__(
        self,
        *,
        session_start_status: int = 200,
        session_start_retry_after: str | None = None,
        request_delay_seconds: float = 0.0,
    ) -> None:
        self.session_start_status = session_start_status
        self.session_start_retry_after = session_start_retry_after
        self.request_delay_seconds = request_delay_seconds
        self.counts: dict[str, int] = {}
        self.deleted = False
        self._lock = threading.Lock()

        self._server = ThreadingHTTPServer(
            ("127.0.0.1", 0), _make_scripted_handler(self)
        )
        self.port = self._server.server_address[1]
        self._thread = threading.Thread(
            target=self._server.serve_forever, daemon=True
        )
        self._thread.start()

    def _bump(self, name: str) -> None:
        with self._lock:
            self.counts[name] = self.counts.get(name, 0) + 1

    def delay(self) -> None:
        if self.request_delay_seconds > 0:
            time.sleep(self.request_delay_seconds)

    def delete_reply(self) -> _ScriptedReply:
        with self._lock:
            self.deleted = True
        self._bump("delete")
        return 200, b"{}", {}

    def reply_for(self, payload: Mapping[str, object]) -> _ScriptedReply:
        method = payload.get("method")
        request_id = payload.get("id")
        if method == "initialize":
            self._bump("initialize")
            body = _jsonrpc_ok(
                request_id,
                {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "serverInfo": {"name": "scripted", "version": "0"},
                },
            )
            return 200, body, {"Mcp-Session-Id": "scripted-sess"}
        if method == "notifications/initialized":
            self._bump("initialized")
            return 202, b"", {}
        if method == "tools/call":
            return self._reply_for_tool(payload, request_id)
        return 200, b"{}", {}

    def _reply_for_tool(
        self, payload: Mapping[str, object], request_id: object
    ) -> _ScriptedReply:
        params = payload.get("params")
        tool = params.get("name") if isinstance(params, Mapping) else None
        self._bump(f"tool:{tool}")
        if tool == "session_start" and self.session_start_status != 200:
            headers = (
                {"Retry-After": self.session_start_retry_after}
                if self.session_start_retry_after is not None
                else {}
            )
            body = json.dumps({"error": "rate limited"}).encode()
            return self.session_start_status, body, headers
        return 200, _tool_ok_body(request_id), {}

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def count(self, name: str) -> int:
        with self._lock:
            return self.counts.get(name, 0)

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=2.0)


def _scripted_settings(server: _ScriptedMCPServer, watermark: Path) -> CaptureSettings:
    return CaptureSettings(
        base_url=server.base_url,
        token="tok",  # noqa: S106 -- not a real secret
        watermark_path=watermark,
    )


class TestSessionStart429MakesExactlyOneCall:
    """R1: a 429+Retry-After on session_start fires ONE call, under the deadline.

    Before the fix, AgentMemory kept the sibling default of two attempts, so a
    single 429 on session_start independently retried -- two calls -- while the
    client had already been pinned to one. This drives the REAL factory, so the
    single call it observes is proof AgentMemory received attempts=1 too. And
    because attempts=1 means with_retry never sleeps, the Retry-After header is
    never honoured, so the process cannot be parked past the budget.
    """

    def test_one_call_and_under_deadline(
        self, capsys: pytest.CaptureFixture[str], tmp_path: Path
    ) -> None:
        server = _ScriptedMCPServer(
            session_start_status=429,
            # A large Retry-After: if it were ever honoured, the wall time would
            # blow the deadline. attempts=1 means it is not.
            session_start_retry_after="30",
        )
        try:
            transcript = tmp_path / "t.jsonl"
            write_lines(
                transcript, [operator_line("u1", "one call only", session="sess")]
            )
            watermark = tmp_path / "wm.sqlite"
            settings = _scripted_settings(server, watermark)
            payload = json.dumps(
                {"transcript_path": str(transcript), "session_id": "sess"}
            )

            start = time.monotonic()
            stop.capture_stop_with(io.StringIO(payload), settings)
            elapsed = time.monotonic() - start

            # Exactly one session_start attempt -- the retry pinning held on BOTH
            # the client and AgentMemory.
            assert server.count("tool:session_start") == 1
            # The Retry-After was NOT slept on: well under the deadline.
            assert elapsed < STOP_HOOK_DEADLINE_SECONDS
            assert capsys.readouterr().out == ""
            # The turn was not delivered (session_start failed), so the watermark
            # never advanced -- the next Stop re-reads it.
            assert asyncio_run(WatermarkStore(watermark).offset_for("sess")) == 0
        finally:
            server.close()


class TestEveryRequestDelayedStillFitsTheDeadline:
    """R1: a delay on EVERY leg of the lifecycle still exits 0 under the deadline.

    The old comment sized the budget against four calls and 1.0 s each; the real
    lifecycle is five requests including the closing DELETE. This puts a real
    per-request delay on all five and proves the whole run still finishes under
    the deadline with the watermark unmoved -- the arithmetic the constant block
    documents, exercised rather than asserted on paper.
    """

    def test_all_five_legs_delayed_exits_zero_fast(
        self, capsys: pytest.CaptureFixture[str], tmp_path: Path
    ) -> None:
        # A delay on every request. Five legs at 0.2 s is 1.0 s of pure network
        # wait, well under the per-request timeout on each and under the whole
        # deadline -- the point is that the delay lands on EVERY leg, DELETE
        # included, not just initialize.
        server = _ScriptedMCPServer(request_delay_seconds=0.2)
        try:
            transcript = tmp_path / "t.jsonl"
            write_lines(
                transcript, [operator_line("u1", "delayed everywhere", session="sess")]
            )
            watermark = tmp_path / "wm.sqlite"
            settings = _scripted_settings(server, watermark)
            payload = json.dumps(
                {"transcript_path": str(transcript), "session_id": "sess"}
            )

            start = time.monotonic()
            stop.capture_stop_with(io.StringIO(payload), settings)
            elapsed = time.monotonic() - start

            assert elapsed < STOP_HOOK_DEADLINE_SECONDS
            assert capsys.readouterr().out == ""
            # Every leg was reached, DELETE included -- the delay hit all five.
            assert server.count("initialize") == 1
            assert server.count("tool:session_start") == 1
            assert server.count("tool:ingest_raw_turn") == 1
            assert server.count("delete") == 1
            # A full clean delivery: this run succeeded, so the watermark advanced
            # to EOF -- the delay never broke the write, it only slowed it.
            stored = asyncio_run(WatermarkStore(watermark).offset_for("sess"))
            assert stored == transcript.stat().st_size
        finally:
            server.close()


class TestStartupFailureReleasesTheSessionSlot:
    """R2: session_start failing AFTER initialize still closes the server session.

    initialize allocates the slot; if session_start then raises, the factory has
    not returned the StartedLane whose close run_stop's finally would call, so
    the slot would leak on the STARTUP path -- the same leak the delivery-path
    close() fix addressed, one step earlier. The factory now closes the client
    and re-raises. Proof: the DELETE arrives even though session_start failed.
    """

    def test_delete_is_issued_when_session_start_fails(
        self, capsys: pytest.CaptureFixture[str], tmp_path: Path
    ) -> None:
        server = _ScriptedMCPServer(session_start_status=500)
        try:
            transcript = tmp_path / "t.jsonl"
            write_lines(
                transcript, [operator_line("u1", "no leak", session="sess")]
            )
            watermark = tmp_path / "wm.sqlite"
            settings = _scripted_settings(server, watermark)
            payload = json.dumps(
                {"transcript_path": str(transcript), "session_id": "sess"}
            )

            stop.capture_stop_with(io.StringIO(payload), settings)

            # initialize opened the slot, session_start failed, and the factory's
            # cleanup released the slot on the way out.
            assert server.count("initialize") == 1
            assert server.count("tool:session_start") == 1
            assert server.deleted is True
            # ingest never ran -- the lane was never returned to the spine.
            assert server.count("tool:ingest_raw_turn") == 0
            # Entrypoint swallowed it: exit contract held.
            assert capsys.readouterr().out == ""
            assert asyncio_run(WatermarkStore(watermark).offset_for("sess")) == 0
        finally:
            server.close()
