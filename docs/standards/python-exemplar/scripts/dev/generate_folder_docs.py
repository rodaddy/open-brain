#!/usr/bin/env python3
"""Check that every package has a real module docstring, and report what is missing.

WHY THIS SCRIPT IS DIFFERENT FROM ITS ANCESTOR

The version this replaces is one of the three receipts in the README: it
returned 0 unconditionally, no hook ever called it, and three documents
described it as pre-commit enforced. It was a no-op with documentation.

So this one has exactly one job and reports honestly about it:

  --check   exit 1 when a package is missing or has a placeholder docstring
  (default) list what is missing, exit 0

A placeholder counts as missing. "Module for handling things." restates the
filename and tells a reader nothing they could not get from `ls`; treating it as
present is how a rule ends up satisfied by text that carries no information.

Usage:
    uv run python scripts/dev/generate_folder_docs.py --check
    uv run python scripts/dev/generate_folder_docs.py
"""

from __future__ import annotations

import argparse
import ast
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
PACKAGE_ROOT = PROJECT_ROOT / "src" / "exemplar"

#: A docstring shorter than this says nothing useful. Not a style preference:
#: the __init__ docstring is what an agent reads to decide whether a package is
#: relevant, and one line cannot carry that.
MIN_CHARS = 120

#: Phrasings that restate the filename. Matched case-insensitively against the
#: opening of the docstring.
PLACEHOLDERS = (
    "module for",
    "package for",
    "this module",
    "this package",
    "todo",
    "tbd",
    "placeholder",
)


def module_docstring(path: Path) -> str | None:
    """Return a file's module docstring, or None when it has none.

    Args:
        path: Python file to inspect.

    Returns:
        The docstring, or None if absent or the file does not parse.
    """
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except (SyntaxError, UnicodeDecodeError):
        return None
    return ast.get_docstring(tree)


def problems() -> list[tuple[Path, str]]:
    """Find every package __init__.py whose docstring is missing or empty.

    Returns:
        Pairs of (path, reason), empty when everything passes.
    """
    found: list[tuple[Path, str]] = []

    for init in sorted(PACKAGE_ROOT.rglob("__init__.py")):
        doc = module_docstring(init)
        rel = init.relative_to(PROJECT_ROOT)

        if doc is None:
            found.append((rel, "no module docstring"))
            continue

        stripped = doc.strip()
        if len(stripped) < MIN_CHARS:
            found.append((
                rel,
                f"docstring is {len(stripped)} chars (minimum {MIN_CHARS})",
            ))
            continue

        opening = stripped[:40].lower()
        for phrase in PLACEHOLDERS:
            if opening.startswith(phrase):
                found.append((rel, f"placeholder docstring (starts with {phrase!r})"))
                break

    return found


def main() -> int:
    """Run the check and report.

    Returns:
        0 when everything passes or when only listing; 1 under --check with
        problems found.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="exit 1 when any package docstring is missing or a placeholder",
    )
    args = parser.parse_args()

    if not PACKAGE_ROOT.is_dir():
        # Fail loudly rather than reporting a clean run over nothing. A path
        # that does not exist is precisely how the ancestor of this script
        # printed green forever.
        print(f"ERROR: package root does not exist: {PACKAGE_ROOT}", file=sys.stderr)
        return 1

    found = problems()
    total = len(list(PACKAGE_ROOT.rglob("__init__.py")))

    if not found:
        print(f"All {total} package docstrings present and substantive.")
        return 0

    print(f"{len(found)} of {total} package docstrings need work:\n")
    for path, reason in found:
        print(f"  {path}: {reason}")

    if args.check:
        print("\nFAILED (--check). Write the docstring; it is what an agent reads")
        print("to decide whether the package is relevant to its task.")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
