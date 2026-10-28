"""Tests for what the package actually ships.

The gates that run on this package -- ruff, mypy, pytest -- all read source
files. None of them read packaging metadata, so a `[project.scripts]` entry
pointing at a module that does not exist passes every one of them and still
installs a broken executable into `.venv/bin`. It fails at
ModuleNotFoundError, at the moment an operator or hook first runs it.

That is exactly how this package shipped its first console script: declared in
PROV-2, targeting a `cli_provider` module scheduled for PROV-9.
"""

from __future__ import annotations

import importlib
import tomllib
from pathlib import Path
from typing import Any

PYPROJECT = Path(__file__).resolve().parent.parent / "pyproject.toml"


def _pyproject() -> dict[str, Any]:
    data: dict[str, Any] = tomllib.loads(PYPROJECT.read_text())
    return data


def _declared_scripts() -> dict[str, str]:
    scripts: dict[str, str] = _pyproject().get("project", {}).get("scripts", {})
    return scripts


def test_every_declared_console_script_resolves() -> None:
    """Each `[project.scripts]` target must import and be callable.

    Parametrizing over a possibly-empty dict would silently pass with zero
    cases, so the loop is explicit and the emptiness is its own signal.
    """
    for command, target in _declared_scripts().items():
        module_name, _, attribute = target.partition(":")

        assert attribute, f"{command} target {target!r} names no callable"

        # A bare import_module: ModuleNotFoundError IS the failure, and its own
        # message already names the missing module. Catching it to re-raise a
        # prettier one only buys a worse traceback.
        module = importlib.import_module(module_name)

        entry = getattr(module, attribute, None)
        assert entry is not None, (
            f"console script {command!r} targets {target!r}, "
            f"but {module_name!r} has no attribute {attribute!r}"
        )
        assert callable(entry), f"console script {command!r} target is not callable"


def test_package_ships_py_typed() -> None:
    # Without this marker mypy treats the package as untyped for every
    # downstream consumer under strict mode, silently degrading their checking.
    marker = Path(__file__).resolve().parent.parent / "src" / "openbrain_provider"
    assert (marker / "py.typed").is_file()


def test_py_typed_is_included_in_the_wheel() -> None:
    # A py.typed on disk that hatchling does not package is the same failure,
    # just one step later. The wheel target must include the package directory.
    wheel = (
        _pyproject()
        .get("tool", {})
        .get("hatch", {})
        .get("build", {})
        .get("targets", {})
        .get("wheel", {})
    )
    assert "src/openbrain_provider" in wheel.get("packages", [])
