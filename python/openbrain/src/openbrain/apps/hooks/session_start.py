"""The ``SessionStart`` hook entrypoint: inject CANON at the top of a session.

Purpose:
    Claude Code runs this when a session begins (``source`` is
    ``startup``/``resume``/``clear``/``compact``/``fork``) and hands it the event
    as JSON on stdin. It reads that payload, reads the CANON-tier context pack
    through the same ``openbrain_memory`` client the capture hooks use, and writes
    it through two independently registered ``additionalContext`` hook outputs:
    profile/process guidance first, then repo facts and any remaining sections.

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
    Two parse-and-exit console scripts share this module and partition the
    configured section names before calling the unchanged whole-pack capability.
    Claude Code registers both scripts as separate ``SessionStart`` hooks because
    ``additionalContext`` delivery is independent per hook. The capability that
    builds the client and reads ``agent_context_pack`` remains
    ``session.run_session_start`` (``_plans/418-prov-9-hook-entrypoints.md``).

Pattern/Convention:
    FAIL OPEN. A hook that opens a session must never block or break one. Every
    failure -- a malformed payload, an unconfigured canon, an unreachable server
    -- is logged content-free and swallowed, and stdout is left EMPTY, which is
    Claude Code's "proceed normally, inject nothing"
    (``tests/fixtures/captured_hooks/README.md``). The session opens uninjured
    either way; a missing injection is a degraded start, not a broken one.

    Each registered script writes one JSON object on stdout:
    ``{"hookSpecificOutput": {"hookEventName": "SessionStart",
    "additionalContext": "<rendered>"}}`` -- the documented SessionStart
    contract. Both headers identify their section set and name the two outputs as
    one canon pack; every rule body is copied whole into exactly one output.

    WHY PLAIN TEXT, NOT THE RAW PACK JSON. Measured 2026-08-01 against the #450
    cold-session prototype: dumping the raw ``agent_context_pack`` JSON envelope
    put ~30 KB of nested objects, ids, citations, confidences, and warnings into
    ``additionalContext``, and Claude Code diverted a payload that large to a
    file it surfaced only as a ~2 KB preview -- the session saw 2-3 of 31 items
    and could not name the sections. The canon-only design requires the RULES
    themselves front-of-mind, whole. The two hook emissions therefore render one
    exact rule body per line and put section identity in each emission's header,
    dropping the JSON envelope and per-item metadata that carried the bulk. The
    unsplit renderer keeps scope keys and lanes for diagnostic callers. This is
    FORMATTING, not content reduction: no rule text is shortened or omitted
    (``docs/CODING_STANDARDS.md`` section 6).

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
from enum import StrEnum
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

#: The sections that always belong to the first of the two canon emissions.
_PROFILE_PROCESS_SECTIONS = frozenset({"profile_guidance", "process_guidance"})


class CanonEmission(StrEnum):
    """Which independently registered ``SessionStart`` hook output is rendered."""

    PROFILE_PROCESS = "1/2"
    REMAINING = "2/2"


def sections_for_emission(
    configured: tuple[str, ...], emission: CanonEmission
) -> tuple[str, ...]:
    """Partition configured canon sections between the two hook emissions.

    Args:
        configured: The operator-configured section order.
        emission: Which registered hook output is being built.

    Returns:
        The sections for that emission, preserving configured order. Profile and
        process guidance always belong to emission one; every other configured
        section, including repo facts, belongs to emission two.
    """
    if emission is CanonEmission.PROFILE_PROCESS:
        return tuple(
            section for section in configured if section in _PROFILE_PROCESS_SECTIONS
        )
    return tuple(
        section for section in configured if section not in _PROFILE_PROCESS_SECTIONS
    )


def inject_canon(stream: TextIO, out: TextIO) -> None:
    """Write profile and process guidance as the first canon emission."""
    inject_canon_with(stream, out, None)


def inject_canon_remaining(stream: TextIO, out: TextIO) -> None:
    """Write repo facts and all other configured sections as emission two."""
    inject_canon_remaining_with(stream, out, None)


def inject_canon_with(
    stream: TextIO, out: TextIO, settings: CanonSettings | None
) -> None:
    """Inject emission one with a given (or loaded) canon configuration."""
    _inject_canon_with(stream, out, settings, CanonEmission.PROFILE_PROCESS)


def inject_canon_remaining_with(
    stream: TextIO, out: TextIO, settings: CanonSettings | None
) -> None:
    """Inject emission two with a given (or loaded) canon configuration."""
    _inject_canon_with(stream, out, settings, CanonEmission.REMAINING)


def _inject_canon_with(
    stream: TextIO,
    out: TextIO,
    settings: CanonSettings | None,
    emission: CanonEmission,
) -> None:
    """Inject one partition of canon and swallow every observer failure."""
    try:
        raw = stream.read()
        payload = SessionStartHook.model_validate_json(raw)
        canon = settings if settings is not None else load_canon_settings()
        sections = sections_for_emission(canon.sections, emission)
        if not sections:
            return
        selected = canon.model_copy(update={"sections": sections})
        pack = asyncio.run(run_session_start(payload, selected))
        if pack is None:
            return
        out.write(
            _injection_envelope(pack, emission=emission, requested_sections=sections)
        )
    except Exception as error:  # noqa: BLE001 -- an observer must never break its subject
        # Content-free BY CONSTRUCTION: only the exception class name is passed,
        # never the exception object, so no payload text or token reaches the
        # sink even under loguru's diagnose (see ``stop.capture_stop_with``).
        logger.warning(
            "SessionStart canon injection failed ({}); session opens uninjected",
            type(error).__name__,
        )


def render_pack(
    pack: Any,
    *,
    emission: CanonEmission | None = None,
    requested_sections: tuple[str, ...] | None = None,
) -> str:
    """Render selected canon sections as plain text with every rule whole.

    Args:
        pack: The decoded ``agent_context_pack.v1`` payload.
        emission: The registered hook output, or ``None`` for the unsplit renderer.
        requested_sections: The exact sections this emission owns. ``None`` renders
            every section present in the pack.

    Returns:
        One header line, a blank line, then every selected item on its own line.
        Rule text is copied in full from ``guidance`` or ``fact`` and is never
        shortened or split.
    """
    if not isinstance(pack, dict):
        return ""

    sections = pack.get("sections")
    sections = sections if isinstance(sections, dict) else {}
    labels = tuple(sections) if requested_sections is None else requested_sections

    counts: list[str] = []
    lines: list[str] = []
    for label in labels:
        section = sections.get(label)
        if not isinstance(section, dict):
            continue
        items = section.get("items")
        items = items if isinstance(items, list) else []
        counts.append(f"{label}={len(items)}")
        renderer = _render_item if emission is None else _render_rule_text
        lines.extend(renderer(label, item) for item in items)

    header_bits = _header_bits(pack, emission, labels)
    header_bits.append(
        "sections: " + ", ".join(counts) if counts else "sections: (none)"
    )
    return "\n".join([" | ".join(header_bits), "", *lines])


def _header_bits(
    pack: dict[str, Any],
    emission: CanonEmission | None,
    labels: tuple[str, ...],
) -> list[str]:
    """Build the canon header, identifying the shared pack and held sections."""
    schema = pack.get("schema") or "openbrain.agent_context_pack.v1"
    title = f"CANON ({schema})"
    if emission is not None:
        title = f"CANON PACK {emission.value} ({schema})"

    bits = [title]
    if emission is not None:
        bits.append("one pack across two SessionStart emissions")
        held = ", ".join(labels) if labels else "(none)"
        bits.append(f"this emission sections: {held}")

    scope = pack.get("scope")
    if isinstance(scope, dict) and scope.get("namespace"):
        bits.append(f"namespace={scope['namespace']}")
    return bits


def _render_rule_text(_label: str, item: Any) -> str:
    """Render only one item's exact rule body for an inline hook emission."""
    if not isinstance(item, dict):
        return str(item)
    text = item.get("guidance")
    if text is None:
        text = item.get("fact")
    return "" if text is None else str(text)


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


def _injection_envelope(
    pack: Any,
    *,
    emission: CanonEmission | None = None,
    requested_sections: tuple[str, ...] | None = None,
) -> str:
    """Wrap one rendered canon emission in the SessionStart response envelope."""
    return json.dumps({
        "hookSpecificOutput": {
            "hookEventName": _HOOK_EVENT_NAME,
            "additionalContext": render_pack(
                pack,
                emission=emission,
                requested_sections=requested_sections,
            ),
        }
    })


def main(stream: TextIO | None = None) -> int:
    """Run profile/process canon emission one and always report success."""
    inject_canon(sys.stdin if stream is None else stream, sys.stdout)
    return 0


def main_remaining(stream: TextIO | None = None) -> int:
    """Run repo/remaining canon emission two and always report success."""
    inject_canon_remaining(sys.stdin if stream is None else stream, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
