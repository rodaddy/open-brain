"""Functional tests for the observation sink (#523).

The contract under test is the one ``apps.capture.observe`` states: the
observation lane reads the same transcript as the raw lane from its OWN
watermark, masks secret-shaped values before anything leaves the process,
advances only after the emitter returns, and never -- under any failure --
affects the memory delivery or its watermark.

The emitter here is always a recorder or a deliberate failure; the real
Langfuse client is covered by the live canary
(``/path/to/open-brain/_tmp/open-brain/_scratch/langfuse-canary``), not by
unit tests that would dial a server.
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

import pytest

from conftest import RecordingLane, operator_line, write_lines
from openbrain.apps.capture.langfuse_emitter import (
    INGESTION_SUFFIX,
    LangfuseEmitter,
    sink_host,
)
from openbrain.apps.capture.observe import (
    OBSERVE_KEY_PREFIX,
    observation_active,
    observe_new_turns,
)
from openbrain.apps.capture.watermark import WatermarkStore
from openbrain.apps.hooks.session import (
    StartedLane,
    StopHook,
    SubagentStopHook,
    run_stop,
    run_subagent_stop,
)
from openbrain.apps.hooks.stop import loaded_observation
from openbrain.config import (
    CaptureSettings,
    ObservationSettings,
    UnknownEnvironmentVariableError,
    load_observation_settings,
)
from openbrain.models.turn import RawTurn, TurnRole, TurnUsage

if TYPE_CHECKING:
    from collections.abc import Sequence
    from pathlib import Path


class RecordingEmitter:
    """An ObservationEmitter that remembers what it was asked to send."""

    def __init__(self) -> None:
        """Start with nothing recorded."""
        self.calls: list[tuple[str, tuple[RawTurn, ...]]] = []

    def emit(self, session_key: str, turns: Sequence[RawTurn]) -> None:
        self.calls.append((session_key, tuple(turns)))


class UnreachableEmitter:
    """An ObservationEmitter whose endpoint is down; every emit raises."""

    def __init__(self) -> None:
        """Count attempts, so a test can prove the emit was actually tried."""
        self.calls = 0

    def emit(self, session_key: str, turns: Sequence[RawTurn]) -> None:
        self.calls += 1
        message = "observation endpoint unreachable"
        raise RuntimeError(message)


def observation_settings() -> ObservationSettings:
    """An active sink config; the endpoint is inert under injected emitters."""
    return ObservationSettings(
        enabled=True,
        endpoint="http://127.0.0.1:0" + INGESTION_SUFFIX,
        public_key="pk-lf-test",
        secret_key="sk-lf-test",  # noqa: S106 -- not a real secret
    )


def capture_settings(watermark_path: Path) -> CaptureSettings:
    """A CaptureSettings pointed at a temp watermark; endpoints are inert."""
    return CaptureSettings(
        base_url="http://127.0.0.1:0",
        token="unused-in-injected-lane-tests",  # noqa: S106 -- not a real secret
        watermark_path=watermark_path,
    )


def started(lane: object) -> StartedLane:
    """Wrap a recorder as the StartedLane a lane_factory returns."""
    return StartedLane(lane=lane, close=lambda: None)  # type: ignore[arg-type]


class TestObservationActive:
    """The sink is opt-in AND needs every coordinate; anything less declines."""

    def test_the_default_section_is_inactive(self) -> None:
        assert observation_active(ObservationSettings()) is False

    def test_enabled_without_coordinates_is_inactive(self) -> None:
        assert observation_active(ObservationSettings(enabled=True)) is False

    def test_coordinates_without_enabled_are_inactive(self) -> None:
        settings = observation_settings().model_copy(update={"enabled": False})
        assert observation_active(settings) is False

    def test_enabled_with_every_coordinate_is_active(self) -> None:
        assert observation_active(observation_settings()) is True


class TestSinkHost:
    """Both provisioned spellings of the endpoint reach the same server root."""

    def test_the_ingestion_url_is_normalised_to_its_host(self) -> None:
        assert (
            sink_host("https://langfuse.example" + INGESTION_SUFFIX)
            == "https://langfuse.example"
        )

    def test_a_bare_host_passes_through(self) -> None:
        assert sink_host("https://langfuse.example") == "https://langfuse.example"

    def test_a_trailing_slash_does_not_hide_the_suffix(self) -> None:
        assert (
            sink_host("https://langfuse.example" + INGESTION_SUFFIX + "/")
            == "https://langfuse.example"
        )


class TestObserveDeliversUnderItsOwnWatermark:
    """The observe spine mirrors the raw lane's rules against its own key."""

    async def test_turns_are_emitted_and_the_watermark_advances_after(
        self, tmp_path: Path
    ) -> None:
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "observe me", session="sess")])
        store = WatermarkStore(tmp_path / "wm.sqlite")
        emitter = RecordingEmitter()

        result = await observe_new_turns(transcript, "sess", store, emitter)

        assert result.emitted == 1
        # The emitter sees the UNPREFIXED key, so traces group under the real
        # session; the stored position lives under the prefixed one.
        assert emitter.calls[0][0] == "sess"
        assert emitter.calls[0][1][0].content == "observe me"
        stored = await store.offset_for(OBSERVE_KEY_PREFIX + "sess")
        assert stored == result.next_offset == transcript.stat().st_size

    async def test_the_raw_lane_watermark_is_untouched(self, tmp_path: Path) -> None:
        """Independent lanes: observing must not move the memory lane's position."""
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "observe me", session="sess")])
        store = WatermarkStore(tmp_path / "wm.sqlite")

        await observe_new_turns(transcript, "sess", store, RecordingEmitter())

        assert await store.offset_for("sess") == 0

    async def test_already_observed_turns_are_not_re_emitted(
        self, tmp_path: Path
    ) -> None:
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "once only", session="sess")])
        store = WatermarkStore(tmp_path / "wm.sqlite")
        emitter = RecordingEmitter()

        await observe_new_turns(transcript, "sess", store, emitter)
        second = await observe_new_turns(transcript, "sess", store, emitter)

        assert second.emitted == 0
        assert len(emitter.calls) == 1

    async def test_secret_shaped_values_are_masked_before_the_emitter(
        self, tmp_path: Path
    ) -> None:
        """Langfuse redacts nothing server-side, so the mask happens here."""
        transcript = tmp_path / "t.jsonl"
        write_lines(
            transcript,
            [
                operator_line(
                    "u1",
                    "token is sk-abc123def456ghi789jkl",
                    session="sess",
                )
            ],
        )
        store = WatermarkStore(tmp_path / "wm.sqlite")
        emitter = RecordingEmitter()

        await observe_new_turns(transcript, "sess", store, emitter)

        sent = emitter.calls[0][1][0].content
        assert "sk-abc123def456ghi789jkl" not in sent
        assert "[REDACTED]" in sent

    async def test_a_failed_emit_leaves_the_watermark_where_it_was(
        self, tmp_path: Path
    ) -> None:
        """The unadvanced watermark is the retry, exactly as in the raw lane."""
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "retry me", session="sess")])
        store = WatermarkStore(tmp_path / "wm.sqlite")
        broken = UnreachableEmitter()

        with pytest.raises(RuntimeError):
            await observe_new_turns(transcript, "sess", store, broken)

        assert broken.calls == 1
        assert await store.offset_for(OBSERVE_KEY_PREFIX + "sess") == 0

        recovered = RecordingEmitter()
        result = await observe_new_turns(transcript, "sess", store, recovered)
        assert result.emitted == 1


class TestRunStopObservationWiring:
    """run_stop runs the sink best-effort, after and independent of memory."""

    async def test_an_active_sink_receives_the_delivered_turns(
        self, tmp_path: Path
    ) -> None:
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "both lanes", session="sess")])
        settings = capture_settings(tmp_path / "wm.sqlite")
        emitter = RecordingEmitter()
        payload = StopHook(transcript_path=transcript, session_id="sess")

        result = await run_stop(
            payload,
            settings,
            lane_factory=lambda _s, _k: started(RecordingLane()),
            observation=observation_settings(),
            emitter_factory=lambda _o: emitter,
        )

        assert result is not None
        assert result.delivered == 1
        assert emitter.calls[0][1][0].content == "both lanes"

    async def test_an_emit_failure_never_reaches_the_caller(
        self, tmp_path: Path
    ) -> None:
        """Observation is best-effort: the memory delivery's result stands."""
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "kept", session="sess")])
        watermark = tmp_path / "wm.sqlite"
        settings = capture_settings(watermark)
        broken = UnreachableEmitter()
        payload = StopHook(transcript_path=transcript, session_id="sess")

        result = await run_stop(
            payload,
            settings,
            lane_factory=lambda _s, _k: started(RecordingLane()),
            observation=observation_settings(),
            emitter_factory=lambda _o: broken,
        )

        assert result is not None
        assert result.delivered == 1
        assert broken.calls == 1
        # The observe watermark stayed put -- the failure's retry -- while the
        # raw lane's advanced normally.
        store = WatermarkStore(watermark)
        assert await store.offset_for(OBSERVE_KEY_PREFIX + "sess") == 0
        assert await store.offset_for("sess") == transcript.stat().st_size

    async def test_an_inactive_sink_never_builds_an_emitter(
        self, tmp_path: Path
    ) -> None:
        transcript = tmp_path / "t.jsonl"
        write_lines(transcript, [operator_line("u1", "memory only", session="sess")])
        settings = capture_settings(tmp_path / "wm.sqlite")
        payload = StopHook(transcript_path=transcript, session_id="sess")

        def never(_: ObservationSettings) -> RecordingEmitter:
            message = "emitter built for an inactive sink"
            raise AssertionError(message)

        result = await run_stop(
            payload,
            settings,
            lane_factory=lambda _s, _k: started(RecordingLane()),
            observation=ObservationSettings(),
            emitter_factory=never,
        )

        assert result is not None
        assert result.delivered == 1

    async def test_the_subagent_spine_observes_under_its_own_key(
        self, tmp_path: Path
    ) -> None:
        transcript = tmp_path / "sub.jsonl"
        write_lines(transcript, [operator_line("u1", "subagent turn", session="sess")])
        settings = capture_settings(tmp_path / "wm.sqlite")
        emitter = RecordingEmitter()
        payload = SubagentStopHook(
            agent_transcript_path=transcript,
            session_id="sess",
            agent_id="agent-1",
        )

        result = await run_subagent_stop(
            payload,
            settings,
            lane_factory=lambda _s, _k: started(RecordingLane()),
            observation=observation_settings(),
            emitter_factory=lambda _o: emitter,
        )

        assert result is not None
        assert result.delivered == 1
        assert emitter.calls[0][0] == payload.watermark_key()


class TestObservationSettingsResolution:
    """The provisioned variable names resolve; a typo is rejected, not inert."""

    def test_the_provisioned_variables_resolve(self) -> None:
        settings = load_observation_settings(
            {
                "OPENBRAIN_OBSERVATION_ENABLED": "1",
                "OPENBRAIN_OBSERVATION_ENDPOINT": "https://lf.example"
                + INGESTION_SUFFIX,
                "OPENBRAIN_OBSERVATION_PUBLIC_KEY": "pk-lf-x",
                "OPENBRAIN_OBSERVATION_SECRET_KEY": "sk-lf-x",
                "OPENBRAIN_OBSERVATION_HMAC_SECRET": "hmac-x",
            }
        )
        assert settings.enabled is True
        assert observation_active(settings) is True
        assert settings.secret_key is not None
        assert settings.secret_key.get_secret_value() == "sk-lf-x"

    def test_an_empty_environment_loads_the_inactive_default(self) -> None:
        settings = load_observation_settings({})
        assert settings.enabled is False
        assert observation_active(settings) is False

    def test_a_typo_is_rejected_rather_than_loading_clean(self) -> None:
        with pytest.raises(UnknownEnvironmentVariableError):
            load_observation_settings({"OPENBRAIN_OBSERVATION_ENDPONT": "x"})

    def test_a_secret_never_appears_in_the_repr(self) -> None:
        settings = observation_settings()
        assert "sk-lf-test" not in repr(settings)


class FakeObservation:
    """The two methods ``_observe_turn`` uses on what it starts."""

    def __init__(self) -> None:
        """Start un-ended, so a test can prove the observation was closed."""
        self.ended = False

    def end(self) -> None:
        self.ended = True


class FakeClient:
    """Records the kwargs each observation was started with.

    Deliberately NOT a real ``Langfuse``: the assertion here is about the
    arguments this module composes, and a real client would dial the fleet
    server (the failure #544 pinned).
    """

    def __init__(self) -> None:
        """Start with nothing recorded."""
        self.started: list[dict[str, object]] = []

    def start_observation(self, **kwargs: object) -> FakeObservation:
        self.started.append(kwargs)
        return FakeObservation()


def observed(turn: RawTurn) -> dict[str, object]:
    """The kwargs ``_observe_turn`` passes for one turn."""
    client = FakeClient()
    LangfuseEmitter._observe_turn(client, turn)  # noqa: SLF001
    return client.started[0]


class TestAGenerationCarriesWhatLangfusePrices:
    """Model and usage reach the generation, under the names that PRICE (#560).

    ``usage_details`` keys are matched against a model price's own unit names.
    A key Langfuse does not recognise contributes nothing, so a generation with
    the transcript's own ``input_tokens`` spelling looks populated in the UI and
    still costs NULL -- which is why these tests assert the literal strings
    rather than only the values.
    """

    async def test_the_generation_names_its_model(self) -> None:
        turn = RawTurn(
            turn_uuid="a1",
            content="hi",
            role=TurnRole.ASSISTANT,
            model="claude-opus-5",
        )

        assert observed(turn)["model"] == "claude-opus-5"

    async def test_usage_details_uses_the_keys_langfuse_prices_against(
        self,
    ) -> None:
        turn = RawTurn(
            turn_uuid="a1",
            content="hi",
            role=TurnRole.ASSISTANT,
            model="claude-opus-5",
            usage=TurnUsage(
                input_tokens=2,
                output_tokens=456,
                cache_read_input_tokens=15510,
                cache_creation_input_tokens=41238,
            ),
        )

        assert observed(turn)["usage_details"] == {
            "input": 2,
            "output": 456,
            "cache_read_input_tokens": 15510,
            "cache_creation_input_tokens": 41238,
        }

    async def test_a_turn_without_usage_omits_the_field_entirely(self) -> None:
        """Absent, not empty: ``{}`` would read as a turn measured at zero."""
        turn = RawTurn(
            turn_uuid="a1", content="hi", role=TurnRole.ASSISTANT, model="claude-opus-5"
        )

        assert "usage_details" not in observed(turn)

    async def test_a_turn_without_a_model_omits_the_field_entirely(self) -> None:
        turn = RawTurn(turn_uuid="a1", content="hi", role=TurnRole.ASSISTANT)

        assert "model" not in observed(turn)

    async def test_a_user_turn_is_a_span_and_is_never_priced(self) -> None:
        """Only the assistant produces a generation; a span has no cost."""
        kwargs = observed(RawTurn(turn_uuid="u1", content="hi", role=TurnRole.USER))

        assert kwargs["as_type"] == "span"
        assert "model" not in kwargs
        assert "usage_details" not in kwargs


class TestTheSuiteNeverInheritsAnOperatorsSink:
    """A developer's real observation coordinates must not reach a test (#544).

    THE FAILURE THIS PINS. ``capture_stop_with`` accepts an injected
    ``CaptureSettings`` but resolves the OBSERVATION section itself, from the
    live process environment, on every call. On a machine whose shell carries
    the four provisioned coordinates -- which the operator env file
    ``claudex-observation.env`` supplies, so any hook-configured host has them
    -- the unit suite built a real ``LangfuseEmitter`` and posted its fixture
    transcripts to the fleet server. ``emit`` ends in ``client.shutdown()``,
    which BLOCKS draining the OpenTelemetry batch worker, so
    ``test_capture_outage_notice`` hung indefinitely at test 8 of 45 rather
    than failing. A hang is the worst shape for this: it reports nothing, and
    it looked like the branch that merely UNMASKED it (declaring
    ``OPENBRAIN_ALLOW_INSECURE_HTTP`` stopped the typo check from rejecting the
    load, which had been shadowing the sink) was the branch that caused it.

    Asserted at ``loaded_observation`` and at the environment itself, rather
    than by running the hook: the hook's symptom is a HANG, and a test that
    hangs to prove a hang reports nothing and blocks the suite behind it. These
    two are the boundary that reads the environment and the environment it
    reads; the autouse ``_clean_environment`` fixture in ``conftest`` is what
    keeps both inert. Both fail without it -- verified by flipping the fixture
    to ``autouse=False`` in an operator shell, 2026-08-04.
    """

    def test_ambient_coordinates_do_not_activate_the_sink(self) -> None:
        """The section the hook resolves for itself is inert under the fixture."""
        resolved = loaded_observation()
        assert resolved is not None
        assert observation_active(resolved) is False

    def test_the_environment_the_hook_reads_carries_no_openbrain_variables(
        self,
    ) -> None:
        """No ``OPENBRAIN_*`` survives into a test, whatever the shell holds.

        The one exception is the ``OPENBRAIN_TEST_*`` prefix the ``-m live``
        gate addresses its playground service through; clearing that would make
        the live gate pass having run nothing.
        """
        leaked = [
            name
            for name in os.environ
            if name.upper().startswith("OPENBRAIN_")
            and not name.upper().startswith("OPENBRAIN_TEST_")
        ]
        assert leaked == []
