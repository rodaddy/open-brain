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
    "additionalContext": "<rendered>"}}`` -- the documented SessionStart
    contract. ``additionalContext`` is a string, so the assembled canon pack is
    RENDERED into it as plain text.

    WHY PLAIN TEXT, NOT THE RAW PACK JSON. Measured 2026-08-01 against the #450
    cold-session prototype: dumping the raw ``agent_context_pack`` JSON envelope
    put ~30 KB of nested objects, ids, citations, confidences, and warnings into
    ``additionalContext``, and Claude Code diverted a payload that large to a
    file it surfaced only as a ~2 KB preview -- the session saw 2-3 of 31 items
    and could not name the sections. The canon-only design requires the RULES
    themselves front-of-mind, whole. So this renders every item to its own line
    -- scope key, the rule text IN FULL, lane -- and drops the JSON envelope and
    per-item metadata that carried the bulk. This is FORMATTING, not content
    reduction: no rule text is shortened or omitted (``docs/CODING_STANDARDS.md``
    section 6). If a choice ever arises between dropping content and a large
    injection, the injection stays whole and large.

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


def render_pack(pack: Any) -> str:
    """Render a canon ``agent_context_pack`` payload to front-of-mind plain text.

    Args:
        pack: The decoded ``agent_context_pack.v1`` payload the server assembled
            -- ``schema``, ``scope``, ``sections`` (each a labelled block of
            ``items``), and ``warnings``.

    Returns:
        One header line then every item on its own line, the rule text WHOLE. The
        header names the schema, the resolved namespace, and the per-section
        counts so the session can state what it was given. Each item line is
        ``[<lane>] <scope-key>: <rule text in full>`` -- the lane is the item's
        candidate/fact type, the scope-key is its stable name, and the rule text
        is the item's ``guidance`` (profile/process items) or ``fact`` (repo
        facts), never shortened.

    This drops the JSON envelope and per-item metadata (ids, citations,
    confidences, promotion timestamps, the ``warnings`` block) that carried the
    bulk without carrying a rule. That is the whole point: it is the RULES the
    session must hold, and only removing the scaffolding around them keeps the
    injection small enough that Claude Code presents it inline instead of
    diverting it to a preview file. No rule text is bounded, shortened, or
    dropped (``docs/CODING_STANDARDS.md`` section 6).

    Defensive by construction: a section, an item field, or the whole pack being
    absent or the wrong type must not raise -- the entrypoint swallows, but a
    partial pack should still render what it does carry rather than nothing. A
    non-dict pack renders to an empty string, which the entrypoint treats as
    "nothing to inject".
    """
    if not isinstance(pack, dict):
        return ""

    sections = pack.get("sections")
    sections = sections if isinstance(sections, dict) else {}

    schema = pack.get("schema") or "openbrain.agent_context_pack.v1"
    scope = pack.get("scope")
    namespace = ""
    if isinstance(scope, dict):
        namespace = str(scope.get("namespace") or "")

    counts: list[str] = []
    lines: list[str] = []
    for label, section in sections.items():
        if not isinstance(section, dict):
            continue
        items = section.get("items")
        items = items if isinstance(items, list) else []
        counts.append(f"{label}={len(items)}")
        for item in items:
            lines.append(_render_item(label, item))

    header_bits = [f"CANON ({schema})"]
    if namespace:
        header_bits.append(f"namespace={namespace}")
    header_bits.append("sections: " + ", ".join(counts) if counts else "sections: (none)")
    header = " | ".join(header_bits)

    return "\n".join([header, "", *lines])


def _render_item(label: str, item: Any) -> str:
    """Render one canon item to a single ``[<lane>] <key>: <rule text>`` line.

    Two item shapes reach here from ``agent_context_pack``: guidance items
    (``profile_guidance``/``process_guidance``) carry ``scope_key``,
    ``guidance``, and ``candidate_type``; fact items (``repo_facts``) carry
    ``subject``, ``fact``, and ``fact_type``. The lane falls back to the section
    ``label`` when an item names no type, and the key falls back to empty; the
    rule TEXT is whatever the item carries, in full, and is never dropped.
    """
    if not isinstance(item, dict):
        return f"[{label}] {item}"

    text = item.get("guidance")
    if text is None:
        text = item.get("fact")
    text = "" if text is None else str(text)

    key = item.get("scope_key")
    if key is None:
        key = item.get("subject")
    key = "" if key is None else str(key)

    lane = item.get("candidate_type") or item.get("fact_type") or label

    prefix = f"[{lane}] "
    if key:
        return f"{prefix}{key}: {text}"
    return f"{prefix}{text}"


def _injection_envelope(pack: Any) -> str:
    """Wrap the rendered canon in the ``additionalContext`` response envelope.

    The SessionStart contract carries the injection as a STRING on
    ``hookSpecificOutput.additionalContext``. The pack is RENDERED to plain text
    (:func:`render_pack`) rather than dumped as raw JSON so it arrives whole and
    front-of-mind instead of being diverted to a preview file; nothing in the
    rendered rules is bounded, shortened, or dropped.
    """
    return json.dumps(
        {
            "hookSpecificOutput": {
                "hookEventName": _HOOK_EVENT_NAME,
                "additionalContext": render_pack(pack),
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
