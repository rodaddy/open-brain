"""``OPENBRAIN_DEVELOPMENT_ROOT`` is declared, so a #557-installed box keeps canon.

The fourth instance of one defect class, and the first where the package
REJECTED a variable its own code already READ.

``receipts.scope`` has consumed ``OPENBRAIN_DEVELOPMENT_ROOT`` since #556 --
via ``os.environ`` directly, per call, because the value is answered against
the filesystem and a module constant would be frozen during pytest collection.
Reading it that way never registered the name with the config, so
:func:`unknown_prefixed_variables` still classed it a typo and rejected the
WHOLE environment. PR #557 then taught the installer and ``openbrain-hook-env``
to pass it, and every box built from that bundle lost canon injection: the
``SessionStart`` entrypoint swallows the rejection (fail-open observer
contract) and exits 0, so the session opens with an empty skull and no error
the operator ever sees. Field-proved on two machines 2026-08-04 (open-brain#565).

What the declaration is, and is not. It makes the config ACCEPT the name; it
does not move the read. ``receipts.scope.development_root`` and the gate's
``openbrain_provider.development_scope.development_root`` stay the single
source of the resolved path, deliberately spelled identically so the writer and
the reader can never land in different scopes. A settings field that some other
module resolved independently would reintroduce exactly that split, so the test
below pins the value as EXPOSED-BUT-NOT-AUTHORITATIVE: readable from settings,
with the scope modules still answering the question.

See Also:
    - ``docs/GOTCHAS.md`` -- the matched-pair rule and its third clause
    - ``openbrain.receipts.scope`` -- the reader this name has always served
    - ``python/openbrain/tests/test_lan_http_optin.py`` -- the #544 precedent
"""

from __future__ import annotations

import io
import json

import pytest

from openbrain.apps.hooks.session_start import inject_canon
from openbrain.config import (
    ServerSettings,
    UnknownEnvironmentVariableError,
    load_canon_settings,
    load_capture_settings,
    load_observation_settings,
    unknown_prefixed_variables,
)
from openbrain.receipts.scope import DEVELOPMENT_ROOT_ENV_VAR, development_root

#: A root that is not the shipped default, so a test asserting the override
#: took effect cannot pass by accidentally matching the built-in value.
OTHER_ROOT = "/Volumes/Elsewhere/Development"

#: The environment a #557-installed hook process actually carries: the endpoint
#: and token the wrapper always passed, plus the lane root it now adds.
INSTALLED_ENV = {
    "OPENBRAIN_BASE_URL": "http://127.0.0.1:3100",
    "OPENBRAIN_TOKEN": "test-token",  # noqa: S106 - fixture value, never real
    DEVELOPMENT_ROOT_ENV_VAR: OTHER_ROOT,
}


def test_development_root_is_a_recognised_variable() -> None:
    """The name no longer reads as a typo.

    This is the assertion that was RED before the declaration: the variable was
    reported unknown, and every caller of the check raised on it.
    """
    assert unknown_prefixed_variables(INSTALLED_ENV) == ()


@pytest.mark.parametrize(
    "loader",
    [load_canon_settings, load_capture_settings, load_observation_settings],
)
def test_every_section_loader_accepts_the_installed_environment(loader) -> None:  # noqa: ANN001
    """No hook lane rejects the environment #557 ships.

    All three section loaders run the same whole-environment typo check, so one
    undeclared variable took down capture, observation, and canon together.
    Canon is the lane that was field-proved dead; the others are pinned because
    they failed for the identical reason and would regress the same way.
    """
    loader(INSTALLED_ENV)


def test_the_declared_field_exposes_the_configured_root() -> None:
    """The value is readable from settings, not merely tolerated.

    Declaring the name only to discard it would silence the crash while leaving
    an operator unable to see what the process believes -- so the resolved
    value is asserted, not just the absence of an exception.
    """
    settings = ServerSettings.model_validate(
        {"development_root": INSTALLED_ENV[DEVELOPMENT_ROOT_ENV_VAR]}
    )

    assert settings.development_root == OTHER_ROOT


def test_an_empty_value_reads_as_unset() -> None:
    """``env -i VAR="${VAR:-}"`` hands the child ``""``, which must not raise.

    The wrapper's assignment style cannot express "absent"; an unset variable
    arrives as an empty string. #544 re-armed this exact defect by declaring a
    field that rejected ``""``, killing every hook on a host that never opted
    in. The convention this repo settled on is empty-means-unset.
    """
    settings = ServerSettings.model_validate({"development_root": ""})

    assert settings.development_root is None


def test_the_scope_module_remains_the_authority(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The declaration did not move where the root is resolved.

    ``receipts.scope`` and the provider gate read the SAME variable so a write
    and a read cannot land in different scopes. If the config ever became the
    resolver, that guarantee would depend on the two agreeing.
    """
    monkeypatch.setenv(DEVELOPMENT_ROOT_ENV_VAR, OTHER_ROOT)

    assert str(development_root()) == OTHER_ROOT


def test_a_rejected_environment_names_the_variable_on_stderr(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The one actionable failure says which variable, and does not block.

    #558's posture: loud diagnosis, non-blocking, stderr, and stdout left
    untouched so the harness still reads a clean "inject nothing". The bare
    warning that shipped before named only the exception class, which is why
    two machines read a dead canon as a healthy session.
    """
    monkeypatch.setenv("OPENBRAIN_DEVELOPMENT_ROOOT", OTHER_ROOT)
    stream = io.StringIO(
        json.dumps(
            {
                "hook_event_name": "SessionStart",
                "session_id": "p",
                "cwd": OTHER_ROOT,
            }
        )
    )
    out = io.StringIO()

    inject_canon(stream, out)

    captured = capsys.readouterr()
    assert "OPENBRAIN_DEVELOPMENT_ROOOT" in captured.err
    assert "ACTION REQUIRED" in captured.err
    # stdout stays EMPTY: Claude Code's "proceed normally, inject nothing".
    assert out.getvalue() == ""


def test_a_misspelling_is_still_rejected() -> None:
    """Silence is granted to the name we declared, never to a typo near it.

    The declaration must not widen into prefix leniency: the typo check is the
    only thing standing between a fat-fingered variable and a process running
    on defaults nobody chose.
    """
    with pytest.raises(UnknownEnvironmentVariableError):
        load_canon_settings({"OPENBRAIN_DEVELOPMENT_ROOOT": OTHER_ROOT})
