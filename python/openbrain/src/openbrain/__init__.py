"""openbrain - the shared foundation every Open Brain Python process is built on.

Purpose:
    One definition of each thing, imported everywhere it is needed. This package
    is the answer to a measured defect: the existing tree has 36 independent
    content-bound definitions across 25+ files, 18 files hand-writing the same
    hash-embed-insert sequence, four layers implementing one admission rule with
    three different behaviours, and no shared write path at all.

    None of that was a quality failure in any single file. It is what happens
    when there is nothing to import, so every caller writes its own. A 101 KB
    capture vanished with exit code 0 because the fix reached one of the four
    copies.

Architecture:
    Built bottom-up, each layer depending only on the ones beneath it.

    ``config`` is the base: settings declared once, validated at start, handed
    to everything else as a typed object. ``observability`` is established at
    the same moment, so every module inherits one configured logger rather than
    re-deriving one per file. ``models`` holds the Pydantic types the whole
    system speaks in. ``core`` holds what three or more modules need.

    Capability modules -- storage, embedding, capture, ingestion, distillation,
    dream, recall, api, cli -- build on that base. Language is the outer
    boundary because the toolchains differ; capability is the inner one.

    Incremental and honest: what is exported works. What is absent is absent,
    not stubbed. A placeholder that imports cleanly is worse than a missing
    module, because it passes every gate.

Key Components:
    - config: the one place a setting is defined
    - observability: the logger, established once and inherited
    - models: the Pydantic types everything speaks in
    - core: shared libraries -- anything used by three or more modules

Pattern/Convention:
    A second implementation of an existing rule is a defect on sight, even when
    it is correct today, because the next fix will reach one copy and not the
    others.

    Before writing a function, search for it: ``aqmd search "<word>"`` then
    ``rg``. Shared behaviour lives in ``core``.

    Recall means total recall. Nothing on a read or write path refuses,
    shortens, or clips content. Long text is split and embedded, never
    rejected. See ``docs/CODING_STANDARDS.md`` section 6.

Example:
    >>> from openbrain.config import load_settings
    >>> settings = load_settings()
    >>> settings.database.name
    'open_brain'

See Also:
    - ``docs/CODING_STANDARDS.md`` - the rules this tree is built to
    - ``docs/CONFIG_REFERENCE.md`` - every setting and its read site
    - ``_plans/consolidation-2026-07-30.md`` - the measured case for rebuilding
"""

from __future__ import annotations

from .config import Settings, load_settings

__all__ = [
    "Settings",
    "load_settings",
]
