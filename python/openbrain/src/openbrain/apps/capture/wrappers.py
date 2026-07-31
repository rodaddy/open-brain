"""Remove system-injected text from a turn, leaving what the operator typed.

Purpose:
    A prompt as it reaches the transcript carries machinery the operator never
    typed and never read as conversation: hook output, policy headers, reminder
    blocks. Capturing those as operator turns is how a corpus fills with its own
    plumbing.

Architecture:
    One function, one job. It removes known wrapper shapes and returns the rest
    unchanged.

    It does NOT decide whether the result is worth keeping. That question
    belongs to the caller, and the answer is almost always yes --
    ``docs/decisions/capture-never-drops-a-turn.md``: *"A filter on the capture
    path may TYPE a turn. It may never decide whether to keep one."*

Pattern/Convention:
    Wrappers are matched by their OWN markers, never by size or position. A
    rule like "drop the first paragraph" would eventually eat a real turn that
    happened to start the same way.

    Removal is non-greedy and anchored to a closing marker, so an unterminated
    block consumes only itself rather than the rest of the message.

Example:
    >>> strip_system_wrappers("<system-reminder>noise</system-reminder>real")
    'real'

See Also:
    - ``docs/decisions/capture-never-drops-a-turn.md`` - what capture may not do
    - ``openbrain.apps.capture.paste`` - the other remover, on shape not markers
"""

from __future__ import annotations

import re

#: Blocks injected around an operator's message, matched by their own markers.
#:
#: Each entry is a compiled pattern whose match is removed entirely. DOTALL so a
#: block spans lines; non-greedy so two blocks in one message do not merge into
#: one match that swallows the real text between them.
#:
#: Ordered most-specific first, so a narrow pattern claims its text before a
#: looser one can take a larger bite of it.
WRAPPER_PATTERNS: tuple[re.Pattern[str], ...] = (
    # Claude Code's own reminder block.
    re.compile(r"<system-reminder>.*?</system-reminder>", re.DOTALL),
    # Hook output, which this repo emits with an HTML-comment fence.
    re.compile(r"<!--\s*Development Policy Refresh.*?End Development Policy Refresh\s*-->", re.DOTALL),
    re.compile(r"<!--\s*Context Budget.*?End Context Budget\s*-->", re.DOTALL),
    # The reflex pointer block, appended per turn.
    re.compile(r"##\s*Open Brain reflex pointers.*?(?=\n#{1,2}\s|\Z)", re.DOTALL),
)


def strip_system_wrappers(text: str) -> str:
    """Remove every known system-injected block from a turn.

    Args:
        text: The turn as it appeared in the transcript.

    Returns:
        The text with wrapper blocks removed. Whitespace at the ends is left
        alone: what remains is returned as it was written, and deciding whether
        it is empty belongs to the caller.

    Example:
        >>> strip_system_wrappers("before<system-reminder>x</system-reminder>after")
        'beforeafter'
    """
    for pattern in WRAPPER_PATTERNS:
        text = pattern.sub("", text)
    return text
