r"""Recognise pasted terminal output, which is not something the operator said.

Purpose:
    A pasted transcript of a terminal session looks like a conversation to every
    text-based test, because it contains one. Measured 2026-07-25: a 1,035-char
    paste of a terminal session was stored as a ``decision``.

Architecture:
    One function, one job: does this text have the SHAPE of machine output.

    Shape, never length. ``docs/decisions/capture-never-drops-a-turn.md:87``
    keeps this rejector while deleting the length floor precisely because they
    are different mechanisms catching different failures:

        *"a pasted transcript contains real decision words, because it contains
        a real conversation."*

    No length test could have caught the 1,035-char case, and no shape test
    would have caught a two-word acknowledgement. Keeping them in separate
    modules is what stops one being mistaken for the other again -- the removed
    floor spent months hiding an unrelated allowlist behind it.

Pattern/Convention:
    This module DOES NOT drop turns. It answers a question; the caller decides.
    That separation is why the same answer can later be used to type a turn
    rather than reject it, without touching this code.

    Every marker here is a glyph Claude Code itself draws. A human writing prose
    does not emit box-drawing runs or the tool-call bullets, so matching on them
    is matching on provenance rather than on content.

Example:
    >>> looks_pasted("⏺ Bash(ls)\\n  ⎿  file.txt")
    True
    >>> looks_pasted("use postgres not sqlite")
    False

See Also:
    - ``docs/decisions/capture-never-drops-a-turn.md`` - why this survives
    - ``openbrain.apps.capture.wrappers`` - the other remover, on markers
"""

from __future__ import annotations

#: Glyphs Claude Code draws in its own terminal UI.
#:
#: A human typing prose does not produce these, so their presence is evidence
#: about where the text came from rather than about what it says.
UI_GLYPHS = ("❯", "⏺", "⎿", "✻", "✽", "✢", "·")

#: Box-drawing characters, which appear in pasted tables and tool frames.
BOX_GLYPHS = ("─", "│", "┌", "┐", "└", "┘", "├", "┤", "┬", "┴", "┼", "━", "┃")

#: Distinct glyph KINDS that together make the shape conclusive.
#:
#: Two rather than one, because a lone "·" is ordinary punctuation in prose and
#: a lone "❯" is how people write a quoted shell prompt inline. Two DIFFERENT
#: glyphs together is the terminal's own rendering, which prose does not
#: reproduce by accident.
#:
#: Counts glyph kinds, not occurrences, so a message repeating one character is
#: never mistaken for machine output.
DISTINCT_GLYPHS_FOR_PASTE = 2


def _distinct_glyph_count(text: str, glyphs: tuple[str, ...]) -> int:
    """Count the glyphs from ``glyphs`` that appear at least once in ``text``."""
    return sum(1 for glyph in glyphs if glyph in text)


def looks_pasted(text: str) -> bool:
    r"""Report whether text has the shape of pasted terminal output.

    Args:
        text: The turn, after system wrappers have been removed.

    Returns:
        ``True`` when the text carries the terminal's own rendering. ``False``
        for anything a person plausibly typed -- including short turns, angry
        turns, and turns full of decision words.

    Example:
        >>> looks_pasted("⏺ Read(config.py)\\n  ⎿  Read 40 lines")
        True
        >>> looks_pasted("no, do it the other way")
        False
    """
    if _distinct_glyph_count(text, UI_GLYPHS) >= DISTINCT_GLYPHS_FOR_PASTE:
        return True

    return _distinct_glyph_count(text, BOX_GLYPHS) >= DISTINCT_GLYPHS_FOR_PASTE
