"""The ``SessionStart`` hook entrypoint: inject CANON at the top of a session.

Purpose:
    Claude Code runs this when a session begins (``source`` is
    ``startup``/``resume``/``clear``/``compact``/``fork``) and hands it the event
    as JSON on stdin. It reads that payload, reads the CANON-tier context pack
    through the same ``openbrain_memory`` client the capture hooks use, and writes
    it through two independently registered ``additionalContext`` hook outputs:
    profile/process guidance first, then repo facts and any remaining sections.

    CANON, PLUS THIS REPO'S OWN LANE. The injection is the always-known layer
    -- who Rico is (``profile_guidance``), the rules/LAWs/standards/persona
    (``process_guidance``), and this repo's facts (``repo_facts``) -- plus one
    REPO-SCOPED lane resume in emission two (#519): the lane's checkpoint and
    its most recent day's intent events, so a session opens knowing where the
    repo's work left off without anyone typing a resume command. Operator
    amendment 2026-08-03 ("startup should already know most of this stuff"),
    amending the 2026-08-01 canon-only ruling by scope, not by reversal:
    CROSS-lane history and deeper digs stay explicit-on-request (the resume
    flow), because loading ANOTHER lane's history poisons what the session is
    trying to do next -- the same contamination rule, now enforced by scoping
    the auto-load to the repo the session is in. The canon-vs-episodic model is
    ``_ob/skills/brain/workflows/canon.md`` and ``_plans/canon-always-known.md``.

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

from openbrain.apps.hooks.session import (
    CANON_REQUEST_TIMEOUT_SECONDS,
    SessionStartHook,
    _derive_repo_slug,
    run_session_start,
)
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
        trailer = None
        if emission is CanonEmission.REMAINING:
            try:
                trailer = _lane_resume_text(payload, canon)
            except Exception as error:  # noqa: BLE001 -- the lane read must not cost the pack
                # Same content-free rule as the outer handler: class name only.
                logger.warning(
                    "SessionStart lane resume failed ({}); canon emitted without it",
                    type(error).__name__,
                )
        out.write(
            _injection_envelope(
                pack,
                emission=emission,
                requested_sections=sections,
                trailer=trailer,
            )
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


def _resolve_lane_key(payload: SessionStartHook, canon: CanonSettings) -> str | None:
    """The lane the startup resume reads: explicit setting, else ``dev:<repo>``.

    An explicitly configured ``OPENBRAIN_CANON_SESSION_KEY`` always wins, the
    same precedence rule the ``repo`` binding uses (#517). Otherwise the lane is
    ``dev:<git-root basename>`` derived from the payload's cwd. ``None`` --
    outside any repo -- means no lane is read at all: the scoping IS the
    contamination guard, so there is no fallback lane.
    """
    if "session_key" in canon.model_fields_set:
        return canon.session_key
    repo = _derive_repo_slug(payload.cwd)
    return None if repo is None else f"dev:{repo}"


#: The event types the startup lane resume renders -- the intent lanes
#: ``resume.py --brief`` shows. ``fact`` is excluded there for noise, the same
#: reason it is excluded here.
_LANE_RESUME_EVENT_TYPES = frozenset(
    {"decision", "blocker", "correction", "checkpoint", "handoff"}
)


def _render_lane_resume(lane_key: str, context: Any) -> str:
    """Render one lane's recent state in the ``resume.py --brief`` shape.

    Header, the lane checkpoint's first line, then the newest calendar day's
    intent events (newest last, so reading order matches time order). Every
    rendered event body is carried whole -- formatting, not content reduction.
    An empty lane says so in one line; it never borrows another lane's events.
    """
    header = f"LANE RESUME ({lane_key}) | openbrain.session_context"
    lane = context.get("lane") if isinstance(context, dict) else None
    events = (context.get("events") or []) if isinstance(context, dict) else []
    if not lane:
        return f"{header}\nNo lane history for this repo yet."
    lines = [header]
    checkpoint = str(lane.get("current_context_md") or "").strip()
    if checkpoint:
        lines.append(f"Checkpoint: {checkpoint.splitlines()[0]}")
    intent = [
        event
        for event in events
        if event.get("event_type") in _LANE_RESUME_EVENT_TYPES
        and event.get("created_at")
    ]
    if not intent:
        lines.append("No recent decisions or blockers recorded.")
        return "\n".join(lines)
    newest_day = str(intent[0]["created_at"])[:10]
    day_events = [e for e in intent if str(e["created_at"])[:10] == newest_day]
    lines.append(f"{newest_day} — {len(day_events)} recent intent events:")
    for event in reversed(day_events):
        stamp = str(event["created_at"])[11:16]
        body = str(event.get("content") or "").strip()
        lines.append(f"- {stamp} {event['event_type']}: {body}")
    return "\n".join(lines)


def _lane_resume_text(payload: SessionStartHook, canon: CanonSettings) -> str | None:
    """Read and render the repo lane's recent state for emission two (#519).

    One ``session_context`` call on the same client configuration the canon
    read uses: single attempt, the canon timeout, token-scoped namespace. Any
    failure propagates to the caller, which logs content-free and emits the
    pack without the trailer -- the lane read must never cost the canon.
    """
    lane_key = _resolve_lane_key(payload, canon)
    if lane_key is None or canon.base_url is None or canon.token is None:
        return None

    from openbrain_memory.client import OpenBrainClient
    from openbrain_memory.policy import RetryPolicy

    client = OpenBrainClient(
        base_url=canon.base_url,
        token=canon.token.get_secret_value(),
        namespace=canon.agent,
        agent_id=canon.agent,
        timeout=CANON_REQUEST_TIMEOUT_SECONDS,
        retry_policy=RetryPolicy(attempts=1),
        # The LAN opt-in (#525), on the same client configuration the canon read
        # uses -- emission two must not be the one lane that still refuses.
        allow_insecure_http=canon.allow_insecure_http,
    )
    try:
        context = client.session_context(
            session_key=lane_key, include_events=True, event_limit=50
        )
    finally:
        client.close()
    return _render_lane_resume(lane_key, context)


def _injection_envelope(
    pack: Any,
    *,
    emission: CanonEmission | None = None,
    requested_sections: tuple[str, ...] | None = None,
    trailer: str | None = None,
) -> str:
    """Wrap one rendered canon emission in the SessionStart response envelope."""
    rendered = render_pack(
        pack,
        emission=emission,
        requested_sections=requested_sections,
    )
    if trailer:
        rendered = f"{rendered}\n\n{trailer}"
    return json.dumps({
        "hookSpecificOutput": {
            "hookEventName": _HOOK_EVENT_NAME,
            "additionalContext": rendered,
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
