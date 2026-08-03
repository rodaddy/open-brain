"""Render the gate's operator-visible text.

Every string here is byte-identical to what the TypeScript gate emits, and that
is load-bearing rather than cosmetic: the recovery command printed in a banner is
the SAME command :mod:`openbrain_provider.gate_shell` accepts as checkpoint
activity. A banner that reworded the command would print an instruction the gate
then refuses — which is the deadlock #419 is about, arriving by a different door.

What this module does NOT do: it makes no decisions and touches no state. It
turns a state into text.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .gate_shell import activated_provider_script_paths, shell_quote
from .gate_state import SessionState

__all__ = [
    "PresentationContext",
    "capture_banner",
    "gate_status_line",
    "nag_banner",
    "readback_banner",
    "transition_message",
]


@dataclass(frozen=True)
class PresentationContext:
    """What rendering needs besides the session state.

    Attributes:
        advisory_tokens: The advisory high-water mark quoted in the nag.
        provider_script_path: Provider path used in a recovery command.
        settings_path: Settings scanned for an activated adapter generation.
        cwd: Development cwd embedded in a recovery payload.
    """

    advisory_tokens: int
    provider_script_path: str
    settings_path: Path
    cwd: str


def _format_thousands(value: int) -> str:
    """Render a token count the way the banners do.

    Args:
        value: Token count.

    Returns:
        e.g. ``250k``. Rounded, matching `Math.round(value / 1000)`.
    """
    return f"{round(value / 1000)}k"


def _provider_payload_command(
    event_name: str, payload: dict[str, Any], context: PresentationContext
) -> str:
    """Build the exact executable recovery command.

    An activated adapter generation wins over the sibling path when one is
    installed and the sibling is not, so the printed command names the provider
    that is actually wired up.

    Args:
        event_name: `session-start`, `capture`, or `checkpoint`.
        payload: The JSON payload to pipe in.
        context: Provider paths.

    Returns:
        A single-line shell command.
    """
    activated = activated_provider_script_paths(context.settings_path)
    preferred = (
        activated[0]
        if activated and context.provider_script_path not in activated
        else context.provider_script_path
    )
    # `separators` reproduces JSON.stringify's spacing exactly; a space after a
    # colon would change the quoted payload and make the printed command stop
    # matching the one the allowance accepts.
    encoded = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    return (
        f"printf '%s' {shell_quote(encoded)} | bun {shell_quote(preferred)} "
        f"--runtime claude --event {event_name}"
    )


def capture_banner(state: SessionState, context: PresentationContext) -> str:
    """Render the banner shown when durable capture is owed.

    Args:
        state: Session state.
        context: Rendering context.

    Returns:
        The multi-line banner, including the exact command that clears it.
    """
    command = _provider_payload_command(
        "capture",
        {
            "cwd": context.cwd,
            "session_id": state.session_id,
            "distilled": {
                "content": "<distilled durable action only>",
                "event_type": "action",
            },
        },
        context,
    )
    return "\n".join(
        [
            "<!-- OB Capture Gate -->",
            "Work landed last turn but nothing was written to Open Brain."
            " Task tools are",
            "BLOCKED until you capture it — if it isn't in OB, it might as well"
            " not have",
            "happened. Replace the placeholder with distilled durable content and run:",
            f"  {command}",
            "A direct saved receipt or durable spool clears capture."
            " Read-only tools and",
            "provider activity remain available; canonical ritual:"
            " _ob/skills/ob-checkpoint.",
            "<!-- End OB Capture Gate -->",
        ]
    )


def nag_banner(state: SessionState, context: PresentationContext) -> str:
    """Render the advisory context-pressure notice.

    Advisory by design: it reports the number and explicitly says no manual
    action is required, because automatic compaction handles rollover.

    Args:
        state: Session state.
        context: Rendering context.

    Returns:
        The multi-line notice.
    """
    return "\n".join(
        [
            "<!-- Context Budget Warning -->",
            f"Context is ~{_format_thousands(state.context_tokens)} tokens "
            f"(advisory high-water mark {_format_thousands(context.advisory_tokens)}).",
            "Continue task work; automatic compaction handles rollover. "
            "No manual /compact is required.",
            "<!-- End Context Budget Warning -->",
        ]
    )


def readback_banner(state: SessionState, context: PresentationContext) -> str:
    """Render the banner shown when a post-compact recall is owed.

    Args:
        state: Session state.
        context: Rendering context.

    Returns:
        The multi-line banner, including the exact correlated recall command.
    """
    command = _provider_payload_command(
        "session-start",
        {
            "cwd": context.cwd,
            "session_id": state.session_id,
            "source": "compact",
            "correlation_id": state.readback_correlation_id,
        },
        context,
    )
    return "\n".join(
        [
            "<!-- Context Budget: forced post-compact read-back -->",
            "A compact just happened. Task tools are BLOCKED until a fresh"
            " direct recall",
            "receipt proves Open Brain was read (the built-in summary is not enough).",
            "SessionStart:compact normally runs this automatically."
            " If it did not, run:",
            f"  {command}",
            "A direct receipt unblocks the next gate check; "
            "fallback/failed recall does not.",
            "<!-- End Context Budget -->",
        ]
    )


def gate_status_line(
    state: SessionState, policy_stale: bool | None, spool_pending: int | None
) -> str:
    """Render the one-line per-turn status.

    Args:
        state: Session state.
        policy_stale: Policy refresh staleness, or None when unknown.
        spool_pending: Pending spool entries, or None when unreadable.

    Returns:
        A single line. Unknown is rendered as a distinct marker rather than as
        "ok", because reporting an unread file as healthy is the failure mode
        this line exists to make visible.
    """
    failing = state.readback_required or state.capture_required or policy_stale is True
    if policy_stale is None:
        policy = "—"
    else:
        policy = "STALE" if policy_stale else "ok"
    segments = [
        f"recall {'DUE' if state.readback_required else 'ok'}",
        f"policy {policy}",
        f"capture {'DUE' if state.capture_required else 'ok'}",
        f"spool {'?' if spool_pending is None else spool_pending}",
    ]
    if state.repair_mode_active:
        segments.append(f"repair ACTIVE until {state.repair_mode_expires_at}")
    if state.context_tokens > 0:
        segments.append(f"ctx ~{_format_thousands(state.context_tokens)}")
    marker = "✗" if failing else "✓"
    return f"OB {marker} {' · '.join(segments)}"


def transition_message(name: str, reason: str) -> str:
    """Render a transition as a greppable one-liner.

    Args:
        name: Transition name.
        reason: Why it happened.

    Returns:
        ``context-budget-gate transition=<name> reason=<reason>``.
    """
    return f"context-budget-gate transition={name} reason={reason}"
