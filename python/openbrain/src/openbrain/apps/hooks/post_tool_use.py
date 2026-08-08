"""The ``PostToolUse`` hook entrypoint: count skill and recall invocations.

Purpose:
    Fires after a tool runs, carrying ``tool_name``, ``tool_input``,
    ``tool_response``, ``tool_use_id``, and ``duration_ms``. It reads that
    payload and, for ``Skill`` calls and Open Brain RECALL reads only, records
    ONE usage metric -- which slug, which agent, which repo, which session --
    through the server's ``record_skill_usage`` tool (issues #469 and #451).

    METRICS ONLY, and the operator's ruling is why: "no automatic retirement.
    What I need is something that gives me metrics so that decisions can be made
    on facts and not on feel." This counts invocations. It does not categorize,
    recommend, rotate, shelve, or retire anything, and the server tool it calls
    cannot either.

    RECALL IS THE SAME RULE, DELIBERATELY. #451's operator ruling (2026-08-08,
    ledger item 24) made recall the MEASURE tier of a three-tier design whose
    other two tiers DO enforce: capture is a hard gate at merge
    (``.claude/hooks/capture-gate.ts``) and hydration stamps
    (``.claude/hooks/hydration-stamp.ts``). Recall was ruled measure-only
    because "recall before re-deriving" is unfalsifiable -- no gate can tell
    that canon already answered a question the agent chose to ask again -- so a
    recall ENFORCEMENT would fire on guesses. Counting is what an unfalsifiable
    property supports: the operator reads the trend and rules on it. Anything
    here that grows a recommendation has changed tiers without a ruling.

Non-goals:
    THE OPEN QUESTION STAYS OPEN. Tool input and output are the ~96% of
    ``ob_raw_turns`` that ``capture-never-drops-a-turn.md`` explicitly leaves
    UNDECIDED (memory versus observability), and this hook does NOT resolve it.
    It sends no ``tool_response`` at all and reads exactly one field out of
    ``tool_input`` -- the skill's name, which IS the metric. Every other key of
    both is dropped at the parse boundary by
    :class:`~openbrain.apps.hooks.session.PostToolUseHook` (``extra="ignore"``),
    so the content stream cannot be picked up here by accident. Recorded in
    ``_plans/rewrite-gotchas.md``.

    It also decides nothing about non-Skill tools. ``PostToolUse`` fires for
    Bash, Read, Edit, and the rest; all of them return before settings are
    loaded or a client is built, which keeps the common case free.

Architecture:
    A parse-and-exit shell. Reading stdin, loading settings, and choosing a
    capability is all this module does; the capability that builds the client
    and sends the metric is ``session.run_post_tool_use``, so there is no
    business logic here (``_plans/418-prov-9-hook-entrypoints.md``).

Pattern/Convention:
    ALWAYS EXIT 0 WITH EMPTY STDOUT. A hook that observes a session must never
    block or break one. Every failure -- a malformed payload, an unconfigured
    capture, an unreachable server -- is logged content-free and swallowed, the
    same fail-open contract ``stop`` and ``post_compact`` carry. A missed metric
    is one absent data point in a count, the cheapest possible failure, and
    never worth risking the session over.

Example:
    >>> import io
    >>> record_skill_usage(io.StringIO("not json"))   # swallowed, no raise
    >>> record_skill_usage(io.StringIO("{}"))          # not a Skill call
    >>> main(io.StringIO('{"hook_event_name":"PostToolUse"}'))
    0

See Also:
    - ``openbrain.apps.hooks.session`` - the capability this calls
    - ``_plans/rewrite-gotchas.md`` - the open question this leaves open
    - ``docs/decisions/capture-never-drops-a-turn.md`` - "what counts as the
      conversation", still open
"""

from __future__ import annotations

import asyncio
import sys
from typing import TYPE_CHECKING

from loguru import logger

from openbrain.apps.hooks.session import PostToolUseHook, run_post_tool_use
from openbrain.config import load_capture_settings

if TYPE_CHECKING:
    from typing import TextIO

    from openbrain.config import CaptureSettings


def record_skill_usage(stream: TextIO) -> None:
    """Read one ``PostToolUse`` payload from ``stream`` and count it, swallowing all.

    Args:
        stream: The hook's stdin. Read whole; a ``PostToolUse`` payload is one
            JSON object.

    Loads the ``capture`` settings itself. Takes the stream rather than reading
    ``sys.stdin`` directly so a test drives it with an in-memory buffer. Every
    exception is caught -- an observer must never break its subject.
    """
    record_skill_usage_with(stream, None)


def record_skill_usage_with(stream: TextIO, settings: CaptureSettings | None) -> None:
    """Count one ``PostToolUse`` payload's skill invocation with a given config.

    Args:
        stream: The hook's stdin.
        settings: The ``capture`` configuration, or ``None`` to load it. Injected
            so a test exercises the swallow with an explicit config -- e.g. an
            unconfigured one -- without reaching ``load_settings``.

    The swallow lives here so BOTH the entrypoint and tests get it: any failure,
    including a missing config or an unreachable server, is logged and eaten.

    Settings are loaded only AFTER the payload proves it is a Skill call, so a
    Bash or Read event -- the overwhelming majority of what fires this hook --
    costs one parse and nothing else.
    """
    try:
        raw = stream.read()
        payload = PostToolUseHook.model_validate_json(raw)
        if payload.skill_slug() is None:
            return
        capture = settings if settings is not None else load_capture_settings()
        asyncio.run(run_post_tool_use(payload, capture))
    except Exception as error:  # noqa: BLE001 -- an observer must never break its subject
        # Content-free BY CONSTRUCTION: only the exception class name is passed,
        # never the exception object, so no tool input or token reaches the sink
        # even under loguru's diagnose (see ``stop.capture_stop_with``).
        logger.warning(
            "PostToolUse usage metric failed ({}); invocation not counted",
            type(error).__name__,
        )


def main(stream: TextIO | None = None) -> int:
    """Run the ``PostToolUse`` metric over stdin and always report success.

    Args:
        stream: The hook's stdin. Defaults to ``sys.stdin``; the argument keeps
            the signature uniform with the other entrypoints so ``dispatch``
            holds one table of them.

    Returns:
        ``0``, unconditionally. The return value is the exit code, and a hook
        that observes a session may never fail it.
    """
    record_skill_usage(sys.stdin if stream is None else stream)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
