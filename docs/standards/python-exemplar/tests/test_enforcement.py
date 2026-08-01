"""Prove the linters actually reject what the standard says they reject.

THIS IS THE TEST THAT PROVES THE SUITE CAN FAIL.

A configured rule is not an enforced rule. `ruff` prints a warning and exits 0
when a selected rule needs a setting that is absent -- PLR1702 does exactly
this without `preview = true`, so the config LOOKS right, the run reports
success, and nothing was ever examined. That failure is invisible by
construction: nobody notices a check that always passes.

So each test here feeds ruff or mypy a snippet that MUST be rejected, and
asserts the specific rule code appears. If someone removes `preview`, loosens
`max-nested-blocks`, or drops a rule from `select`, one of these goes red and
names the rule that stopped working.

The mirror image also matters: a compliant snippet must PASS. A linter that
rejects everything is as useless as one that rejects nothing, and far more
likely to get switched off.

See Also:
    - _DOCS/STANDARDS-python.md ## Testing
    - pyproject.toml [tool.ruff.lint] -- the config under test
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def run_ruff(source: str, tmp_path: Path) -> set[str]:
    """Lint a snippet with the project's real config; return the rule codes.

    Uses ``--output-format json`` and reads the ``code`` field. The human
    formats (`full`, `concise`) print the rule NAME
    ("undocumented-public-function") rather than the code, and which one appears
    varies by ruff version -- asserting against them failed here on ruff 0.16.1
    even though every rule had fired correctly. The JSON ``code`` field is the
    stable contract.

    Args:
        source: Python source to check.
        tmp_path: pytest-provided scratch directory.

    Returns:
        The set of rule codes ruff reported, e.g. ``{"D103", "ANN201"}``.
    """
    target = tmp_path / "snippet.py"
    target.write_text(source)
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "ruff",
            "check",
            "--config",
            str(PROJECT_ROOT / "pyproject.toml"),
            "--no-cache",
            "--output-format",
            "json",
            str(target),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if not result.stdout.strip():
        return set()
    return {item["code"] for item in json.loads(result.stdout) if item.get("code")}


class TestNestingRuleFires:
    """PLR1702 -- the mechanical form of the no-nested-conditionals LAW."""

    def test_four_levels_is_rejected(self, tmp_path: Path) -> None:
        """The pyramid the standard bans must be caught."""
        codes = run_ruff(
            '"""Snippet."""\n\n\n'
            "def deep(a: int, b: int, c: int, d: int) -> int:\n"
            '    """Nest too deeply."""\n'
            "    if a:\n"
            "        if b:\n"
            "            if c:\n"
            "                if d:\n"
            "                    return 1\n"
            "    return 0\n",
            tmp_path,
        )
        assert "PLR1702" in codes, (
            "PLR1702 did not fire. Most likely `preview = true` was removed "
            "from [tool.ruff] -- without it ruff SKIPS this rule and exits 0, "
            "so the config looks correct and enforces nothing."
        )

    def test_guard_clauses_are_accepted(self, tmp_path: Path) -> None:
        """The sanctioned rewrite of the same logic must pass."""
        codes = run_ruff(
            '"""Snippet."""\n\n\n'
            "def flat(a: int, b: int, c: int, d: int) -> int:\n"
            '    """Use guard clauses."""\n'
            "    if not a:\n"
            "        return 0\n"
            "    if not b:\n"
            "        return 0\n"
            "    if not c:\n"
            "        return 0\n"
            "    return 1 if d else 0\n",
            tmp_path,
        )
        assert "PLR1702" not in codes


class TestComplexityRuleFires:
    """C901 -- many small branches that collectively make a function untestable."""

    def test_high_complexity_is_rejected(self, tmp_path: Path) -> None:
        """Past max-complexity, the function must be flagged."""
        branches = "".join(
            f"    if value == {n}:\n        return {n}\n" for n in range(15)
        )
        codes = run_ruff(
            '"""Snippet."""\n\n\n'
            "def classify(value: int) -> int:\n"
            '    """Branch many times."""\n' + branches + "    return -1\n",
            tmp_path,
        )
        assert codes & {"C901", "PLR0911", "PLR0912"}


class TestDocstringRuleFires:
    """D rules -- a public function without a docstring is rejected."""

    def test_missing_docstring_is_rejected(self, tmp_path: Path) -> None:
        """Undocumented public function must not pass."""
        codes = run_ruff(
            '"""Snippet."""\n\n\ndef undocumented(a: int) -> int:\n    return a\n',
            tmp_path,
        )
        assert "D103" in codes


class TestAnnotationRuleFires:
    """ANN -- an unannotated signature is rejected."""

    def test_missing_return_annotation_is_rejected(self, tmp_path: Path) -> None:
        """No return type means the caller cannot know what it gets."""
        codes = run_ruff(
            '"""Snippet."""\n\n\ndef stamp(a: int):\n    """Return a."""\n    return a\n',
            tmp_path,
        )
        assert "ANN201" in codes


class TestSuiteCanFail:
    """A guard against a suite that passes because it asserts nothing."""

    def test_a_false_assertion_actually_fails(self) -> None:
        """If this does not raise, the runner is not evaluating assertions."""
        with pytest.raises(AssertionError):
            assert False, "expected"  # ruff: ignore[assert-false]
