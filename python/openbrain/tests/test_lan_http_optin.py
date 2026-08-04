"""The LAN plain-HTTP opt-in (#525): declared, and flowed to every client.

Two failures stacked to make a remote Claude-family host wake with an empty
skull, and this file pins both ends of the fix.

The FIRST is configuration: ``OPENBRAIN_ALLOW_INSECURE_HTTP`` matched no
declared setting, so :func:`unknown_prefixed_variables` rejected the whole
environment as a typo. The hook entrypoints swallow that rejection (fail-open
observer contract), which makes it a SILENT ZERO CAPTURE / ZERO INJECTION with
a clean exit 0 -- the worst shape a config error can take. The deployed
``openbrain-hook-env`` wrapper stripped the variable for exactly that reason.

The SECOND is plumbing: declaring the field changes nothing unless it reaches
``OpenBrainClient(allow_insecure_http=...)`` at EVERY site the hook stack
constructs one. A site left off the flow is a lane that silently declines on a
LAN box, which is #525 again in miniature -- so the construction sites are
enumerated here as a test, not as a comment.

The listener test is the one that cannot be faked by a stub: it binds a real
socket on this machine's real LAN address and drives a real client through it,
proving a non-loopback ``http`` endpoint is genuinely reachable under the opt-in
rather than merely passing a string check.

See Also:
    - ``openbrain.config.ALLOW_INSECURE_HTTP_ALIASES`` -- the posture and scope
    - ``openbrain_memory.client._validate_base_url`` -- the rule being opted out of
    - ``docs/CONFIG_REFERENCE.md`` -- the field and its wrapper coupling
"""

from __future__ import annotations

import json
import os
import socket
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import TYPE_CHECKING, Any

import pytest
from openbrain_memory.client import OpenBrainClient

from openbrain.config import (
    CanonSettings,
    CaptureSettings,
    UnknownEnvironmentVariableError,
    load_canon_settings,
    load_capture_settings,
    load_observation_settings,
    unknown_prefixed_variables,
)

if TYPE_CHECKING:
    from collections.abc import Iterator

#: A LAN-shaped endpoint: plain http, and a host that is NOT loopback. The
#: literal is a TEST FIXTURE, not configuration -- nothing here reads it as a
#: real endpoint, and the repo's never-hardcode-a-host rule is about the code
#: that connects, which takes its address from the environment.
LAN_BASE_URL = "http://10.71.1.20:3100"

#: A throwaway bearer value. Named rather than inlined so the linter's
#: hardcoded-credential check is satisfied by construction: there is one obvious
#: place a real token would have to be pasted, and it is a test fixture.
FAKE_TOKEN = "test-token"  # noqa: S105 - fixture value, never a real credential

#: The environment a LAN hook process actually carries, in the shape the
#: wrapper hands it: endpoint, token, and the opt-in.
LAN_ENV = {
    "OPENBRAIN_BASE_URL": LAN_BASE_URL,
    "OPENBRAIN_TOKEN": FAKE_TOKEN,
    "OPENBRAIN_ALLOW_INSECURE_HTTP": "true",
}


@pytest.fixture(autouse=True)
def _clean_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Drop every prefixed variable so a developer's shell cannot mask a failure.

    The loaders validate the WHOLE prefixed environment, not just the section
    being read, so an unrelated ``OPENBRAIN_*`` left in a real shell would raise
    from the typo check and make these assertions pass or fail for the wrong
    reason.
    """
    for name in list(os.environ):
        if name.upper().startswith(("OPENBRAIN_", "OPEN_BRAIN_")):
            monkeypatch.delenv(name, raising=False)


# --------------------------------------------------------------------------
# The config half: the variable is declared, so the environment is not rejected
# --------------------------------------------------------------------------


def test_the_variable_is_recognised_rather_than_flagged_as_a_typo() -> None:
    """The opt-in is a DECLARED name, not an unknown one.

    This is the assertion that fails on the pre-fix code, and it is deliberately
    the narrowest one: :func:`unknown_prefixed_variables` is the exact function
    whose verdict the loaders turn into a raise.
    """
    assert unknown_prefixed_variables(LAN_ENV) == ()


@pytest.mark.parametrize(
    "loader",
    [load_capture_settings, load_canon_settings, load_observation_settings],
    ids=["capture", "canon", "observation"],
)
def test_every_section_loader_accepts_the_lan_environment(
    loader: Any,
) -> None:
    """No hook-section loader rejects a LAN environment.

    ``observation`` is included even though it builds no Open Brain client: each
    loader validates the ENTIRE prefixed environment, so an undeclared variable
    takes down whichever loader runs first regardless of which section owns it.
    That is precisely how one missing declaration killed all three lanes.
    """
    loader(LAN_ENV)


def test_capture_and_canon_both_read_the_opt_in_from_one_variable() -> None:
    """One environment name reaches both lanes.

    A per-section spelling would make a LAN host set two variables meaning the
    same thing, and would still leave the sibling package's own reader
    (``openbrain_memory.runtime``) looking at a third.
    """
    assert load_capture_settings(LAN_ENV).allow_insecure_http is True
    assert load_canon_settings(LAN_ENV).allow_insecure_http is True


def test_the_opt_in_is_off_when_the_variable_is_absent() -> None:
    """The default is unchanged: no opt-in unless a host asks for one.

    The fix must not weaken the client's loopback-only rule for anybody who did
    not explicitly turn it on.
    """
    without = {k: v for k, v in LAN_ENV.items() if "INSECURE" not in k}
    assert load_capture_settings(without).allow_insecure_http is False
    assert load_canon_settings(without).allow_insecure_http is False


def test_a_misspelled_opt_in_is_still_rejected() -> None:
    """Declaring one name does not stop the typo check doing its job.

    ``OPENBRAIN_ALLOW_INSECURE_HTTPS`` is the plausible slip, and it must raise
    rather than load clean as an unset opt-in -- otherwise the operator believes
    the LAN endpoint is permitted and the lane declines silently anyway.
    """
    typo = dict(LAN_ENV)
    del typo["OPENBRAIN_ALLOW_INSECURE_HTTP"]
    typo["OPENBRAIN_ALLOW_INSECURE_HTTPS"] = "true"

    with pytest.raises(UnknownEnvironmentVariableError) as raised:
        load_capture_settings(typo)

    assert "OPENBRAIN_ALLOW_INSECURE_HTTPS" in str(raised.value)


# --------------------------------------------------------------------------
# The plumbing half: every construction site passes the flag through
# --------------------------------------------------------------------------


class _ClientSpy:
    """Stand in for ``OpenBrainClient`` and remember its keyword arguments.

    Only the constructor contract matters here, so every call the lanes make is
    absorbed by ``__getattr__``. The point of the test is what was PASSED, not
    what came back.
    """

    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs

    def __getattr__(self, name: str) -> Any:
        def _anything(*_args: Any, **_kwargs: Any) -> Any:
            return {}

        return _anything


@pytest.fixture
def spy_client(monkeypatch: pytest.MonkeyPatch) -> list[_ClientSpy]:
    """Capture every client the code under test constructs.

    Patched on ``openbrain_memory.client``, which is where all five sites import
    the name from at call time, so one patch covers them all.
    """
    built: list[_ClientSpy] = []

    def _factory(**kwargs: Any) -> _ClientSpy:
        spy = _ClientSpy(**kwargs)
        built.append(spy)
        return spy

    monkeypatch.setattr("openbrain_memory.client.OpenBrainClient", _factory)
    return built


def test_capture_spine_passes_the_opt_in(spy_client: list[_ClientSpy]) -> None:
    """``_started_memory`` -- the lane every captured turn goes through."""
    from openbrain.apps.hooks.session import _started_memory

    _started_memory(load_capture_settings(LAN_ENV), "session-key")

    assert spy_client[0].kwargs["allow_insecure_http"] is True


def test_skill_usage_recorder_passes_the_opt_in(
    spy_client: list[_ClientSpy],
) -> None:
    """``_record_skill_usage`` -- the ``PostToolUse`` metric lane."""
    from openbrain.apps.hooks.session import _record_skill_usage

    _record_skill_usage(load_capture_settings(LAN_ENV), "session-key", {})

    assert spy_client[0].kwargs["allow_insecure_http"] is True


def test_canon_read_passes_the_opt_in(spy_client: list[_ClientSpy]) -> None:
    """``_canon_context`` -- the CANON PACK read #525 opens on."""
    from openbrain.apps.hooks.session import _canon_context

    _canon_context(load_canon_settings(LAN_ENV))

    assert spy_client[0].kwargs["allow_insecure_http"] is True


def test_lane_resume_passes_the_opt_in(spy_client: list[_ClientSpy]) -> None:
    """``_lane_resume_text`` -- emission two (#519), on the same coordinates."""
    from openbrain.apps.hooks import session_start

    canon = load_canon_settings(LAN_ENV)
    monkey_payload = object()

    original = session_start._resolve_lane_key
    session_start._resolve_lane_key = lambda *_a, **_k: "lane-key"  # type: ignore[assignment]
    try:
        session_start._lane_resume_text(monkey_payload, canon)  # type: ignore[arg-type]
    finally:
        session_start._resolve_lane_key = original  # type: ignore[assignment]

    assert spy_client[0].kwargs["allow_insecure_http"] is True


def test_canon_reconcile_passes_the_opt_in(spy_client: list[_ClientSpy]) -> None:
    """``apps.canon.run._apply`` -- the operator reconcile path."""
    from openbrain.apps.canon.run import _apply

    _apply([], load_canon_settings(LAN_ENV))

    assert spy_client[0].kwargs["allow_insecure_http"] is True


def test_bulk_ingest_passes_the_opt_in(spy_client: list[_ClientSpy]) -> None:
    """``apps.bulk.run._lane`` -- the operator bulk-ingest path."""
    from openbrain.apps.bulk.run import _lane

    _lane(load_capture_settings(LAN_ENV), "session-key")

    assert spy_client[0].kwargs["allow_insecure_http"] is True


# --------------------------------------------------------------------------
# The real-socket proof: non-loopback plain http actually connects
# --------------------------------------------------------------------------


def _lan_address() -> str:
    """This machine's own LAN address, or skip.

    Opening a UDP socket toward a routable address makes the kernel choose the
    outbound interface without sending anything, which is how the real
    non-loopback address is learned without hardcoding one. A host with no LAN
    address (an isolated CI container) skips rather than fails: the test needs a
    genuinely non-loopback bind to mean anything.
    """
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("10.255.255.255", 1))
        address: str = probe.getsockname()[0]
    except OSError:  # pragma: no cover - depends on the host's network
        pytest.skip("no non-loopback address available on this host")
    finally:
        probe.close()

    if address.startswith("127."):  # pragma: no cover - depends on the host
        pytest.skip("resolved address is loopback; nothing to prove")
    return address


class _HealthHandler(BaseHTTPRequestHandler):
    """Answer ``/health`` and say nothing to the test log."""

    def do_GET(self) -> None:  # noqa: N802 - name fixed by BaseHTTPRequestHandler
        body = json.dumps({"status": "ok"}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args: Any) -> None:
        """Silence the default stderr access log."""


@pytest.fixture
def lan_server() -> Iterator[str]:
    """A real HTTP server bound to this machine's real LAN address.

    Port 0 lets the kernel pick a free port, so the test never collides with the
    7100-7199 development range or with anything else already listening.
    """
    address = _lan_address()
    server = HTTPServer((address, 0), _HealthHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://{address}:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_a_real_non_loopback_http_endpoint_is_refused_without_the_opt_in(
    lan_server: str,
) -> None:
    """The default still refuses, against a genuinely reachable endpoint.

    Reachability is not the question the rule asks -- the server here is up and
    answering, and the client must still decline, which is what makes the opt-in
    a deliberate choice rather than a fallback.
    """
    with pytest.raises(ValueError, match="allow_insecure_http"):
        OpenBrainClient(base_url=lan_server, token=FAKE_TOKEN, namespace="n")


def test_a_real_non_loopback_http_endpoint_answers_under_the_opt_in(
    lan_server: str,
) -> None:
    """A LAN client built from the declared setting completes a real request.

    End to end in one assertion: the environment a LAN host carries, through the
    strict config that used to reject it, into a client that used to refuse the
    URL, over a real socket on a real non-loopback address, to a 200.
    """
    settings = load_capture_settings({**LAN_ENV, "OPENBRAIN_BASE_URL": lan_server})
    assert settings.base_url is not None
    assert settings.token is not None

    client = OpenBrainClient(
        base_url=settings.base_url,
        token=settings.token.get_secret_value(),
        namespace=settings.agent_id,
        agent_id=settings.agent_id,
        allow_insecure_http=settings.allow_insecure_http,
    )
    try:
        assert client.health() == {"status": "ok"}
    finally:
        client.close()


def test_the_settings_sections_agree_on_the_flag_type() -> None:
    """Both sections coerce the environment's string to a real bool.

    An env layer hands ``"true"`` in as a string; a field that silently kept it
    as a truthy string would also make ``"false"`` mean True -- the failure mode
    where turning the opt-in OFF turns it on.
    """
    off = {**LAN_ENV, "OPENBRAIN_ALLOW_INSECURE_HTTP": "false"}
    assert load_capture_settings(off).allow_insecure_http is False
    assert load_canon_settings(off).allow_insecure_http is False
    assert CaptureSettings().allow_insecure_http is False
    assert CanonSettings().allow_insecure_http is False
