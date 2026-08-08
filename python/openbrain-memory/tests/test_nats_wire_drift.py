"""Drift canary: hold ``nats_wire``'s local mirror against the fleet-bus source.

``openbrain_memory.nats_wire`` mirrors shapes owned by fleet-bus
(``packages/fleet-nats`` and ``packages/fleet-core``). fleet-nats is not on PyPI
and is not an installable dependency of this lightweight client, so the mirror
cannot be checked by importing the real library on most machines. It CAN be
checked against the monorepo clone when that clone is on disk — which is the
case on fleet dev machines and is exactly where a stale mirror would first be
noticed by a human.

These tests read the clone READ-ONLY and never import it as a package (it pulls
pydantic and fleet-core, neither of which this client depends on). Upstream
``subjects.py``/``spec.py`` are parsed as source: the subject builder is
executed in an isolated namespace with a stub ``slug``, and the envelope wire
key list is read out of ``Envelope.to_bytes``'s literal body dict via ``ast``.

When the clone is absent (CI, a fresh checkout, a non-fleet machine) every test
here SKIPS. A skip is the designed outcome, not a silent pass: the canary's job
is to fail on the machine that has the source of truth.

Why this exists: fleet-bus ``2b20f97`` (2026-07-28) shipped
``ob_context_pack``, renamed ``_slug`` to ``slug``, added a ``>`` rejection, and
moved ``Envelope`` under ``fleet_core.spec`` with two new wire keys — and the
mirror's probe note still read 2026-07-08 (open-brain #550). Nothing failed;
the mirror just aged. That is what this file converts into a test failure.
"""

from __future__ import annotations

import ast
from pathlib import Path
from typing import Any

import pytest

from openbrain_memory.nats_wire import (
    _FLEET_ENVELOPE_VERSION,
    _local_envelope_wire,
    _local_slug,
    build_context_pack_subject,
)

# The fleet-bus monorepo clone. Known, fixed path on fleet dev machines; the
# tests skip when it is not there rather than guessing at alternatives.
FLEET_BUS_CLONE = Path("/workspace/fleet-bus")
_SUBJECTS_SRC = FLEET_BUS_CLONE / "packages/fleet-nats/src/fleet_nats/subjects.py"
_SPEC_SRC = FLEET_BUS_CLONE / "packages/fleet-core/src/fleet_core/spec.py"

requires_clone = pytest.mark.skipif(
    not _SUBJECTS_SRC.is_file() or not _SPEC_SRC.is_file(),
    reason=f"fleet-bus clone not present at {FLEET_BUS_CLONE}; drift canary skipped",
)


def _parse(path: Path) -> ast.Module:
    return ast.parse(path.read_text(encoding="utf-8"))


def _function(tree: ast.Module, name: str) -> ast.FunctionDef:
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    raise AssertionError(f"upstream no longer defines {name}()")


def _class(tree: ast.Module, name: str) -> ast.ClassDef:
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == name:
            return node
    raise AssertionError(f"upstream no longer defines class {name}")


def _exec_upstream_function(
    func: ast.FunctionDef, path: Path, namespace: dict[str, Any]
) -> Any:
    """Compile and run ONE upstream function in an isolated namespace.

    Lifting a single function out of the module keeps the canary free of
    upstream's own imports (pydantic, fleet-core), which this client does not
    depend on and must not start depending on just to check a mirror.
    """
    module = ast.Module(body=[func], type_ignores=[])
    exec(compile(module, str(path), "exec"), namespace)
    return namespace[func.name]


def _upstream_ob_context_pack() -> Any:
    """Execute upstream's ``ob_context_pack`` with a stub ``slug``.

    Isolates the one function under test from the rest of ``subjects.py`` (which
    imports fleet-core) so the canary needs no upstream dependencies installed.
    The stub is this module's own ``_local_slug`` — deliberately, so a change to
    upstream's *subject template* is caught here while a change to its *slug
    rule* is caught by :func:`test_local_slug_matches_upstream_slug` instead of
    being masked by the substitution.
    """
    func = _function(_parse(_SUBJECTS_SRC), "ob_context_pack")
    return _exec_upstream_function(func, _SUBJECTS_SRC, {"slug": _local_slug})


@requires_clone
def test_subject_template_matches_upstream_builder() -> None:
    """The mirror's subject must equal what upstream's builder produces."""
    upstream = _upstream_ob_context_pack()
    for env in ("dev", "prod", "staging", "PROD", "my env.1"):
        assert build_context_pack_subject(env) == upstream(env), (
            f"subject drift for env={env!r}: mirror and fleet-bus disagree"
        )


@requires_clone
def test_local_slug_matches_upstream_slug() -> None:
    """The mirror's slug rule must match upstream's ``slug`` byte-for-byte.

    Upstream renamed ``_slug`` to ``slug`` and added the ``>`` rejection in
    2b20f97. Executing the real function keeps this honest as the rule evolves.
    """
    func = _function(_parse(_SUBJECTS_SRC), "slug")
    upstream_slug = _exec_upstream_function(func, _SUBJECTS_SRC, {})

    for token in ("dev", "PROD", "my env.1", "A.B C", "*"):
        assert _local_slug(token) == upstream_slug(token), f"slug drift for {token!r}"

    for bad in ("   ", ""):
        with pytest.raises(ValueError):
            _local_slug(bad)
        with pytest.raises(ValueError):
            upstream_slug(bad)

    # The wildcard rejection is a security rule, not cosmetics: an unrejected
    # '>' env token subscribes across the whole subject tree.
    with pytest.raises(ValueError, match="multi-token wildcard"):
        _local_slug("a>b")
    with pytest.raises(ValueError):
        upstream_slug("a>b")


def _upstream_wire_keys() -> list[str]:
    """Wire keys upstream's ``Envelope.to_bytes`` writes, in source order."""
    to_bytes = _function_in_class(_class(_parse(_SPEC_SRC), "Envelope"), "to_bytes")
    for node in ast.walk(to_bytes):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "update"
            and node.args
            and isinstance(node.args[0], ast.Dict)
        ):
            keys = node.args[0].keys
            if any(isinstance(k, ast.Constant) and k.value == "id" for k in keys):
                return [k.value for k in keys if isinstance(k, ast.Constant)]
    raise AssertionError("could not locate the wire-key dict in Envelope.to_bytes")


def _function_in_class(cls: ast.ClassDef, name: str) -> ast.FunctionDef:
    for node in cls.body:
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    raise AssertionError(f"upstream Envelope no longer defines {name}()")


@requires_clone
def test_envelope_version_matches_upstream() -> None:
    """``_FLEET_ENVELOPE_VERSION`` must equal upstream's ``ENVELOPE_VERSION``.

    A bump upstream means the fleet is on a new envelope major and this
    transport must be looked at, not silently keep stamping the old one.
    """
    tree = _parse(_SPEC_SRC)
    upstream_version = None
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "ENVELOPE_VERSION" for t in node.targets
        ):
            assert isinstance(node.value, ast.Constant)
            upstream_version = node.value.value
    assert upstream_version is not None, "upstream no longer defines ENVELOPE_VERSION"
    assert _FLEET_ENVELOPE_VERSION == upstream_version


@requires_clone
def test_mirror_envelope_is_an_ordered_prefix_of_the_upstream_wire() -> None:
    """The mirror's keys must be upstream's leading keys, in the same order.

    Two separate guarantees, and the failure modes differ:

    * ORDER — ``envelope_to_wire_bytes`` does not sort keys, so JSON key order
      IS the byte contract the cross-language fixture locks. A reordering
      upstream is a wire break for both languages.
    * PREFIX — the mirror is allowed to LAG upstream's trailing additions
      (today: ``act``/``state``, added after this transport's fixture was
      locked; see ``nats_wire``'s module docstring). It is not allowed to carry
      a key upstream does not have, or to drop one from the middle.

    Adopting a new trailing key is a deliberate joint change with the TS mirror
    (``src/nats-runtime.ts``) and the shared fixture, so this test tolerates the
    gap while still pinning everything before it.
    """
    upstream_keys = _upstream_wire_keys()
    mirror_keys = list(
        _local_envelope_wire(
            msg_id="i",
            ts="t",
            sender="s",
            correlation_id="c",
            payload={},
        )
    )

    assert upstream_keys[: len(mirror_keys)] == mirror_keys, (
        "envelope wire drift: the mirror's keys are no longer upstream's leading "
        f"keys in order.\n  mirror:   {mirror_keys}\n  upstream: {upstream_keys}"
    )


@requires_clone
def test_upstream_still_owns_the_ob_subject_domain() -> None:
    """``ob_context_pack`` must still exist upstream.

    ``build_context_pack_subject`` delegates to it whenever fleet-nats is
    importable. If upstream renames or removes it, that delegation silently
    falls back to the local mirror at import time (a bare ``except``) and the
    single-owner design quietly stops holding — so assert the symbol directly.
    """
    _function(_parse(_SUBJECTS_SRC), "ob_context_pack")
