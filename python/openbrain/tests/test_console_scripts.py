"""Every declared console script resolves to a real ``module:attr``.

A declared ``[project.scripts]`` entry whose target module or attribute does not
exist still installs an executable shim into ``.venv/bin``; the break only shows
when something runs the shim and gets ``ModuleNotFoundError`` or
``AttributeError``. No lint, type, or test gate inspects entry-point targets, so
a broken declaration ships green -- the exact fear ``pyproject.toml`` names above
``[project.scripts]`` and step 10 of ``_plans/python-port-sequence.md`` records.

This file is that missing gate. It parses the real ``[project.scripts]`` table
from ``pyproject.toml`` and imports each declared target, so a script whose
module is renamed, moved, or deleted -- or whose callable is removed -- fails
pytest here instead of installing a dead shim.

It reads the shipped ``pyproject.toml`` rather than a hard-coded list: a second
copy of the script names would drift from the file, which is the class of
duplication this whole tree exists to end.
"""

from __future__ import annotations

import importlib
import tomllib
from pathlib import Path

import pytest

#: The package's own ``pyproject.toml`` -- the file whose ``[project.scripts]``
#: table pip/uv turns into installed shims. ``parents[1]`` is the package root
#: (``tests/`` is ``parents[0]``), matching how ``test_turn_models.py`` walks to
#: the sibling package.
PYPROJECT = Path(__file__).resolve().parents[1] / "pyproject.toml"


def declared_scripts() -> dict[str, str]:
    """The ``[project.scripts]`` table, name -> ``module:attr`` target."""
    data = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))
    return dict(data.get("project", {}).get("scripts", {}))


class TestConsoleScripts:
    """Each declared script's ``module:attr`` target is importable and callable."""

    def test_pyproject_is_readable_and_declares_scripts(self) -> None:
        # A typo that emptied the table would make every per-target check below
        # vacuously pass -- so pin that at least one script is declared. This is
        # not a bound on how many scripts may exist; it is a floor that keeps the
        # gate from reporting success while inspecting nothing.
        assert PYPROJECT.is_file()
        assert declared_scripts(), "[project.scripts] must declare at least one entry"

    @pytest.mark.parametrize("target", sorted(set(declared_scripts().values())))
    def test_declared_target_resolves_to_a_real_callable(self, target: str) -> None:
        # `module:attr` is the entry-point spec pip/uv writes into the shim. A
        # missing colon, module, or attribute is exactly what installs a shim
        # that dies at runtime; each is an explicit failure here.
        assert ":" in target, f"{target!r} is not a module:attr entry point"
        module_name, _, attr = target.partition(":")

        module = importlib.import_module(module_name)
        assert hasattr(module, attr), (
            f"{module_name!r} has no attribute {attr!r} -- the script shim would "
            f"install and then die at runtime"
        )
        assert callable(getattr(module, attr)), f"{target} is not callable"
