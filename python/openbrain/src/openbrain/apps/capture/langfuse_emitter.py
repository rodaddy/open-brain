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

import subprocess
from functools import lru_cache
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Sequence

    from openbrain.config import ObservationSettings
    from openbrain.models.turn import RawTurn, TurnUsage

#: The path suffix the provisioned endpoint carries for the #372 ingestion
#: lane. The SDK addresses the server root and appends its own paths.
INGESTION_SUFFIX = "/api/public/ingestion"

#: Tags on every trace this emitter writes, so capture-sink traffic is
#: filterable next to anything else the server ingests.
TRACE_TAGS = ("claude-code", "open-brain-capture")

#: How long ``git rev-parse`` may take before the release is treated as unknown.
#:
#: Short by intent: this runs on a hook's delivery path, and a hung git call
#: must never be what delays a capture. Resolving the SHA is an enrichment, so
#: the timeout expiring costs a metadata field and nothing else.
REV_PARSE_TIMEOUT_S = 2.0


def _usage_details(usage: TurnUsage) -> dict[str, int]:
    """One turn's token counts under the key names LANGFUSE prices against.

    THE KEY NAMES ARE THE CONTRACT, not a formatting choice. Langfuse matches
    ``usage_details`` keys against a model price's own unit names; a key it does
    not recognise contributes NOTHING to the total, and the generation lands at
    NULL cost exactly as if no usage had been sent. Sending the transcript's own
    ``input_tokens``/``output_tokens`` spelling would look correct in the UI's
    raw JSON and still price at zero, which is the failure mode #560 exists to
    remove -- so the rename happens here, once, at the boundary that owns the
    SDK, and a test asserts the literal strings.
    """
    return {
        "input": usage.input_tokens,
        "output": usage.output_tokens,
        "cache_read_input_tokens": usage.cache_read_input_tokens,
        "cache_creation_input_tokens": usage.cache_creation_input_tokens,
    }


@lru_cache(maxsize=1)
def repo_release() -> str | None:
    """The short git SHA of the checkout this process runs from, or ``None``.

    Langfuse's ``release`` is what turns "cost went up" into "cost went up at
    THIS commit"; #560 measured it empty on 100% of traces.

    Cached for the process, because the SHA cannot change under a running
    process and a hook is short-lived -- resolving it per emit would put a
    subprocess on the delivery path, which is a defect rather than a cost.

    Returns ``None`` when the SHA cannot be resolved -- a deployed tarball, no
    git binary, a timeout. Deliberately NOT a placeholder like ``"unknown"``:
    an omitted release is correctly read as absent, while a placeholder becomes
    a release value that groups every unversioned trace together as if they
    shared a commit.
    """
    try:
        completed = subprocess.run(  # noqa: S603 - fixed argv, no shell, no input
            ["git", "rev-parse", "--short", "HEAD"],  # noqa: S607
            capture_output=True,
            text=True,
            timeout=REV_PARSE_TIMEOUT_S,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        # No git, or it could not be executed. Not knowing the release is not
        # a reason to lose the trace.
        return None
    if completed.returncode != 0:
        return None
    return completed.stdout.strip() or None


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

        # `release` is a CLIENT-level attribute in SDK v4, not a
        # `propagate_attributes` one -- that function's signature accepts
        # user_id/session_id/metadata/version/tags/trace_name/environment/prompt
        # and nothing else, so passing release there is a TypeError that would
        # take the whole capture down (verified against the installed SDK).
        # Passed straight through as None when unresolvable (#560): the
        # parameter is declared `Optional[str]` and defaults to None, so an
        # explicit None is exactly equivalent to omitting it -- and unlike a
        # `**dict` splat it stays checkable, which is what mypy caught here.
        client = Langfuse(
            public_key=settings.public_key,
            secret_key=settings.secret_key.get_secret_value(),
            host=sink_host(settings.endpoint),
            release=repo_release(),
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
            # #560: model and usage_details are what make a generation COST
            # something. Without them Langfuse has a model-less observation with
            # no quantity to price, and total_cost lands NULL -- measured on
            # 23,439 of 23,440 live generations.
            #
            # Built as kwargs and splatted so an absent field is OMITTED rather
            # than sent as None or {}. A zeroed usage_details reads as a turn
            # that was measured at zero cost, which is a false measurement; an
            # absent one correctly reads as unknown.
            cost: dict[str, object] = {}
            if turn.model is not None:
                cost["model"] = turn.model
            if turn.usage is not None:
                cost["usage_details"] = _usage_details(turn.usage)
            observation = client.start_observation(  # type: ignore[attr-defined]
                name="assistant-turn",
                as_type="generation",
                output=turn.content,
                **cost,
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
