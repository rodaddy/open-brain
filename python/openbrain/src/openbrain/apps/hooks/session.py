"""Build the raw-lane client from settings and run one capture delivery.

Purpose:
    The capability the ``stop`` entrypoint calls. It turns a parsed ``Stop``
    payload plus the settings keystone into a delivered batch: construct the
    ``openbrain_memory`` client, start its session, and hand off to the spine.

Architecture:
    This is where the sibling package is CONSTRUCTED, which the spine
    (``apps.capture.deliver``) deliberately does not do -- its docstring names
    that the entrypoint's job. It lives in its own module rather than in
    ``stop`` so the wiring is testable without a subprocess and so the
    entrypoint stays a parse-and-exit shell with no business logic
    (``_plans/418-prov-9-hook-entrypoints.md``).

    ``openbrain_memory`` is imported inside the factory, not at module top. A
    hook's cost is paid on every turn against a 5-second deadline, and the
    client's import graph is not needed to parse a payload that carries no
    transcript, nor by the injected-lane tests that never build the real client.
    It is a declared dependency (``pyproject.toml``); the lazy import is about
    when the cost is paid, not whether the package is present.

Pattern/Convention:
    NOTHING HERE BOUNDS CONTENT, retries, or times out. Durability is the
    sibling package's spool (``openbrain_memory.spool``); order is the spine's
    watermark rule. This module only composes the two, so a change that reaches
    for a queue or a batch cap belongs to one of those owners, not here.

    The namespace this requests is ADVISORY. The server derives the real one
    from the token (``src/tools/ingest-raw-turn.ts``), so ``CaptureSettings``'
    value is provenance, not authorisation.

Example:
    >>> from openbrain.apps.hooks.session import StopHook
    >>> StopHook.model_fields["transcript_path"].is_required()
    False

See Also:
    - ``openbrain.apps.capture.deliver`` - the spine this runs
    - ``openbrain.config`` - the ``CaptureSettings`` section it reads
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from pydantic import BaseModel, ConfigDict

from openbrain.apps.capture.deliver import Delivery, RawLane, deliver_new_turns
from openbrain.apps.capture.watermark import WatermarkStore
from openbrain.config import CaptureSettings, ConfigurationError

if TYPE_CHECKING:
    from collections.abc import Callable


class CaptureNotConfiguredError(ConfigurationError):
    """A ``Stop`` fired but capture has no endpoint or token to send to.

    ``base_url`` and ``token`` are optional on ``CaptureSettings`` so a non-hook
    process loads without them; a hook that actually runs needs both. Raised
    here rather than at settings load, and swallowed by the entrypoint -- an
    unconfigured capture must not break the session it observes, only decline to
    record it.
    """

    def __init__(self, missing: str) -> None:
        """Name which capture coordinates were absent."""
        super().__init__(
            f"capture is not configured: {missing} unset. "
            f"ACTION REQUIRED: set OPENBRAIN_CAPTURE_BASE_URL and "
            f"OPENBRAIN_CAPTURE_TOKEN (or the OPENBRAIN_BASE_URL / "
            f"OPENBRAIN_TOKEN aliases) to the Open Brain service this hook "
            f"writes to."
        )


class StopHook(BaseModel):
    """The fields a ``Stop`` payload carries that capture needs.

    Modelled from the captured fixture (``tests/fixtures/captured_hooks/
    Stop.json``): the transcript to read and the session it belongs to. Both are
    optional here -- a hook can fire before either exists, and that is a
    do-nothing outcome, not a parse failure. ``extra="ignore"`` because the real
    payload carries many more fields (``stop_hook_active``, ``effort``, ...)
    that capture has no interest in.
    """

    model_config = ConfigDict(extra="ignore")

    transcript_path: Path | None = None
    session_id: str | None = None


async def run_stop(
    payload: StopHook,
    settings: CaptureSettings,
    *,
    lane_factory: Callable[[CaptureSettings, str], RawLane] | None = None,
) -> Delivery | None:
    """Deliver the turns written since the watermark for one ``Stop`` payload.

    Args:
        payload: The parsed ``Stop`` hook fields.
        settings: The ``capture`` configuration section: endpoint, token,
            identity, and the watermark store path.
        lane_factory: Builds the raw lane for a session key. Injected so tests
            hand in a recorder; defaults to a real ``openbrain_memory``
            client with its session started.

    Returns:
        The :class:`~openbrain.apps.capture.deliver.Delivery`, or ``None`` when
        the payload named no transcript or no session -- there is nothing to
        read then, and no watermark key to advance.

    Raises:
        Whatever the lane or the reader raises. The ENTRYPOINT swallows these;
        this capability surfaces them so its tests can see a failure and so the
        watermark is left unadvanced (the spine's rule), which is the retry.
    """
    if payload.transcript_path is None or payload.session_id is None:
        return None

    build = lane_factory if lane_factory is not None else _started_memory
    lane = build(settings, payload.session_id)
    store = WatermarkStore(settings.watermark_path)

    return await deliver_new_turns(
        payload.transcript_path, payload.session_id, store, lane
    )


def _started_memory(settings: CaptureSettings, session_key: str) -> RawLane:
    """Construct a real ``openbrain_memory`` client with its session started.

    The one non-test lane factory. The sibling is imported here rather than at
    module top so its import graph is not paid on a payload that carries no
    transcript, and so the injected-lane tests never trigger it.

    Raises:
        CaptureNotConfiguredError: When no endpoint or token is set. The
            entrypoint swallows it -- an unconfigured hook declines to record,
            it does not fail the session.
    """
    if settings.base_url is None or settings.token is None:
        missing = ", ".join(
            name
            for name, value in (
                ("base_url", settings.base_url),
                ("token", settings.token),
            )
            if value is None
        )
        raise CaptureNotConfiguredError(missing)

    from openbrain_memory.agent import AgentMemory
    from openbrain_memory.client import OpenBrainClient

    client = OpenBrainClient(
        base_url=settings.base_url,
        token=settings.token.get_secret_value(),
        namespace=settings.namespace,
        agent_id=settings.agent_id,
    )
    # Annotated to RawLane, the Protocol the spine needs, which AgentMemory
    # structurally satisfies. start_session is not part of that Protocol -- it is
    # session lifecycle, not the write call -- so calling it here needs the
    # ignore; the narrowing is deliberate, not a cast around a missing type.
    memory: RawLane = AgentMemory(client, agent=settings.agent_id)
    memory.start_session(session_key)  # type: ignore[attr-defined]
    return memory
