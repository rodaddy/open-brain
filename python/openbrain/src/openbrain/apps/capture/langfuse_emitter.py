"""The real observation emitter: one delivery's turns as one Langfuse trace.

Purpose:
    Implements :class:`~openbrain.apps.capture.observe.ObservationEmitter`
    against the fleet Langfuse server. Each delivery becomes one trace whose
    ``session_id`` is the session's own key, so the Langfuse session view
    stitches every Stop of a conversation into one timeline.

Architecture:
    A thin mapping, nothing else: the spine already read, ordered, and masked
    the turns. Each turn becomes one child observation typed by its role --
    ``assistant`` turns are generations (that is what Langfuse costs and
    renders as model output), ``tool`` turns are tool observations, ``user``
    turns are spans carrying the input side. The SDK batches in a background
    thread, so ``emit`` flushes before returning: a hook process exits
    immediately after, and an unflushed batch would be dropped silently --
    while the spine, seeing ``emit`` return, would advance the watermark past
    turns that never left the machine.

Pattern/Convention:
    SDK v4 SURFACE, pinned by ``pyproject.toml`` (``langfuse>=4``): trace-level
    attributes travel through ``propagate_attributes``; v3's
    ``update_trace``/``start_as_current_span`` spellings do not exist in v4,
    and the floor keeps an older resolve failing at import rather than
    misbehaving.

    The provisioned endpoint carries the ``/api/public/ingestion`` path the
    #372 HMAC lane posts to; the SDK wants the bare host. Normalised here, at
    the boundary that owns the SDK, so the shared env file keeps one spelling.

    NO VALUE FROM SETTINGS IN ANY ERROR PATH. A transport failure's message
    can carry the endpoint; the spine's caller logs failures as the exception
    class alone, and nothing here adds a message of its own.

See Also:
    - ``openbrain.apps.capture.observe`` - the spine that calls this
    - ``openbrain.config.ObservationSettings`` - where the coordinates live
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Sequence

    from openbrain.config import ObservationSettings
    from openbrain.models.turn import RawTurn

#: The path suffix the provisioned endpoint carries for the #372 ingestion
#: lane. The SDK addresses the server root and appends its own paths.
INGESTION_SUFFIX = "/api/public/ingestion"

#: Tags on every trace this emitter writes, so capture-sink traffic is
#: filterable next to anything else the server ingests.
TRACE_TAGS = ("claude-code", "open-brain-capture")


class ObservationSinkUnconfiguredError(ValueError):
    """The emitter was asked to send without every coordinate the SDK needs.

    Unreachable through the spine, which gates on ``observation_active`` first;
    named so a future caller that skips the gate fails with the cause, not an
    SDK stack trace. Carries no value from settings, per this module's rule.
    """

    def __init__(self) -> None:
        """The message is fixed; there is nothing safe to interpolate."""
        super().__init__("observation sink is not configured")


def sink_host(endpoint: str) -> str:
    """The server root the SDK addresses, from the provisioned endpoint.

    Accepts either spelling -- the bare host, or the ingestion URL the #372
    lane posts to -- and returns the root, without a trailing slash either
    way, so both forms of the env value configure the same client.
    """
    return endpoint.removesuffix("/").removesuffix(INGESTION_SUFFIX)


class LangfuseEmitter:
    """An :class:`~openbrain.apps.capture.observe.ObservationEmitter` over the SDK.

    Built from a validated :class:`~openbrain.config.ObservationSettings` whose
    coordinates :func:`~openbrain.apps.capture.observe.observation_active` has
    already confirmed present -- the constructor asserts nothing and a missing
    key surfaces as the SDK's own authentication failure, which the spine's
    caller logs content-free like any other emit failure.
    """

    def __init__(self, settings: ObservationSettings) -> None:
        """Hold the coordinates; the client is built per emit.

        Per emit rather than here because a hook is a short-lived process: one
        Stop is one emit, and a client held across emits would buy nothing
        while making the constructor a network boundary.
        """
        self._settings = settings

    def emit(self, session_key: str, turns: Sequence[RawTurn]) -> None:
        """Send one delivery as one trace; flush before returning.

        Raises:
            Whatever the SDK raises building the client or flushing. The spine
            leaves its watermark unadvanced in that case, which is the retry.
        """
        # Imported at use, not module top: every hook entrypoint imports the
        # session capability, which imports the capture package -- and the SDK
        # starts OpenTelemetry machinery at import. Only the one process that
        # actually emits should pay that, or crash if the dependency is absent.
        from langfuse import Langfuse, propagate_attributes

        settings = self._settings
        if (
            settings.endpoint is None
            or settings.public_key is None
            or settings.secret_key is None
        ):  # pragma: no cover - the spine gates on observation_active first
            raise ObservationSinkUnconfiguredError

        client = Langfuse(
            public_key=settings.public_key,
            secret_key=settings.secret_key.get_secret_value(),
            host=sink_host(settings.endpoint),
        )
        try:
            repo = next((turn.repo for turn in turns if turn.repo), None)
            with (
                propagate_attributes(
                    session_id=session_key,
                    tags=list(TRACE_TAGS),
                    metadata={"repo": repo} if repo else None,
                    trace_name="claude-code-exchange",
                ),
                client.start_as_current_observation(
                    name="claude-code-exchange", as_type="span"
                ),
            ):
                for turn in turns:
                    self._observe_turn(client, turn)
        finally:
            # flush() drains the batch; shutdown() also stops the SDK's
            # background machinery so the hook process exits promptly. In the
            # finally so a mapping failure still releases the threads --
            # flushing a partial trace is harmless next to the alternative,
            # a hook process that lingers.
            client.shutdown()

    @staticmethod
    def _observe_turn(client: object, turn: RawTurn) -> None:
        """One turn as one child observation, typed by who produced it."""
        from openbrain.models.turn import TurnRole

        if turn.role is TurnRole.ASSISTANT:
            observation = client.start_observation(  # type: ignore[attr-defined]
                name="assistant-turn", as_type="generation", output=turn.content
            )
        elif turn.role is TurnRole.TOOL:
            observation = client.start_observation(  # type: ignore[attr-defined]
                name="tool-turn", as_type="tool", output=turn.content
            )
        else:
            observation = client.start_observation(  # type: ignore[attr-defined]
                name="user-turn", as_type="span", input=turn.content
            )
        observation.end()
