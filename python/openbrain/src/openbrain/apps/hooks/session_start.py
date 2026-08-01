"""The ``SessionStart`` hook entrypoint: inject CANON at the top of a session.

Purpose:
    Claude Code runs this when a session begins (``source`` is
    ``startup``/``resume``/``clear``/``compact``/``fork``) and hands it the event
    as JSON on stdin. It reads that payload, reads the CANON-tier context pack
    through the same ``openbrain_memory`` client the capture hooks use, and writes
    the pack back to the harness as ``hookSpecificOutput.additionalContext`` on
    stdout so it lands in front of the model for the whole session.

    CANON ONLY. The injection is the always-known layer -- who Rico is
    (``profile_guidance``), the rules/LAWs/standards/persona
    (``process_guidance``), and this repo's facts (``repo_facts``) -- and NOTHING
    episodic. No lane history, no session events, no working-set dump: knowing
    that back-information poisons what the session is trying to do next. Back
    history stays explicit-on-request (the resume flow), the way session start
    used to be a direct command. Operator ruling 2026-08-01, superseding the
    "stays stub" row in ``_plans/rewrite-gotchas.md``; the canon-vs-episodic model
    it enforces is ``_ob/skills/brain/workflows/canon.md`` and
    ``_plans/canon-always-known.md``.

Non-goals:
    This does NOT load back-history -- that is the resume flow, which already
    exists elsewhere. It bounds nothing: the pack is injected WHOLE, with no
    truncation, shortening, or size logic (``docs/CODING_STANDARDS.md`` section
    6). It owns no namespace logic (token-derived server-side) and no durability
    or retry mechanism.

Architecture:
    A parse-and-exit shell. Reading stdin, loading settings, choosing a
    capability, and serialising the response is all this module does; the
    capability that builds the client and reads ``agent_context_pack`` is
    ``session.run_session_start``, so there is no business logic here
    (``_plans/418-prov-9-hook-entrypoints.md``).

Pattern/Convention:
    FAIL OPEN. A hook that opens a session must never block or break one. Every
    failure -- a malformed payload, an unconfigured canon, an unreachable server
    -- is logged content-free and swallowed, and stdout is left EMPTY, which is
    Claude Code's "proceed normally, inject nothing"
    (``tests/fixtures/captured_hooks/README.md``). The session opens uninjured
    either way; a missing injection is a degraded start, not a broken one.

    The injecting response is one JSON object on stdout:
    ``{"hookSpecificOutput": {"hookEventName": "SessionStart",
    "additionalContext": "<pack>"}}`` -- the documented SessionStart contract.
    ``additionalContext`` is a string, so the assembled canon pack is serialised
    into it verbatim.

Example:
    >>> import io
    >>> main(io.StringIO("not json"))   # swallowed: empty stdout, exit 0
    0

See Also:
    - ``openbrain.apps.hooks.session`` - the capability this calls
    - ``_ob/skills/brain/workflows/canon.md`` - the canon-vs-episodic model
    - ``_plans/rewrite-gotchas.md`` - the ruling that made this real
"""

from __future__ import annotations

import asyncio
import json
import sys
from typing import TYPE_CHECKING, Any

from loguru import logger

from openbrain.apps.hooks.session import SessionStartHook, run_session_start
from openbrain.config import load_canon_settings

if TYPE_CHECKING:
    from typing import TextIO

    from openbrain.config import CanonSettings

#: The hook event name echoed back in the response envelope. The harness matches
#: the injection to the event by this exact string.
_HOOK_EVENT_NAME = "SessionStart"


def inject_canon(stream: TextIO, out: TextIO) -> None:
    """Read one ``SessionStart`` payload and write its canon injection, swallowing all.

    Args:
        stream: The hook's stdin. Read whole; a ``SessionStart`` payload is one
            JSON object.
        out: Where the injection is written -- the hook's stdout. Nothing is
            written on any failure or when there is no pack, so the session opens
            with an empty stdout, the "proceed normally" response.

    Loads the ``canon`` settings itself. Takes the streams rather than reading
    ``sys.stdin`` / writing ``sys.stdout`` directly so a test drives it with
    in-memory buffers. Every exception is caught -- an observer must never break
    the session it opens.
    """
    inject_canon_with(stream, out, None)


def inject_canon_with(
    stream: TextIO, out: TextIO, settings: CanonSettings | None
) -> None:
    """Inject one ``SessionStart`` payload's canon with a given (or loaded) config.

    Args:
        stream: The hook's stdin.
        out: The hook's stdout.
        settings: The ``canon`` configuration, or ``None`` to load it. Injected
            so a test exercises the swallow with an explicit config -- e.g. an
            unconfigured one -- without reaching ``load_canon_settings``.

    The swallow lives here so BOTH the entrypoint and tests get it: any failure,
    including a missing config or an unreachable server, is logged and eaten with
    nothing written to stdout.
    """
    try:
        raw = stream.read()
        payload = SessionStartHook.model_validate_json(raw)
        canon = settings if settings is not None else load_canon_settings()
        pack = asyncio.run(run_session_start(payload, canon))
        if pack is None:
            return
        out.write(_injection_envelope(pack))
    except Exception as error:  # noqa: BLE001 -- an observer must never break its subject
        # Content-free BY CONSTRUCTION: only the exception class name is passed,
        # never the exception object, so no payload text or token reaches the
        # sink even under loguru's diagnose (see ``stop.capture_stop_with``).
        logger.warning(
            "SessionStart canon injection failed ({}); session opens uninjected",
            type(error).__name__,
        )


def _injection_envelope(pack: Any) -> str:
    """Serialise the canon pack into the ``additionalContext`` response envelope.

    The SessionStart contract carries the injection as a STRING on
    ``hookSpecificOutput.additionalContext``, so the assembled pack -- a JSON
    object -- is serialised into that string verbatim. Nothing is bounded,
    shortened, or dropped: the pack is injected WHOLE.
    """
    return json.dumps(
        {
            "hookSpecificOutput": {
                "hookEventName": _HOOK_EVENT_NAME,
                "additionalContext": json.dumps(pack, ensure_ascii=False),
            }
        }
    )


def main(stream: TextIO | None = None) -> int:
    """Run the ``SessionStart`` canon injection over stdin and always report success.

    Args:
        stream: The hook's stdin. Defaults to ``sys.stdin``; the argument keeps
            the signature uniform with the other entrypoints so ``dispatch``
            holds one table of them.

    Returns:
        ``0``, unconditionally. The return value is the exit code, and a hook
        that opens a session may never fail it.
    """
    inject_canon(sys.stdin if stream is None else stream, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
