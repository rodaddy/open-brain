from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from pydantic import ValidationError

from openbrain.config import (
    _SECTION_MODELS,
    Settings,
    load_settings,
    unknown_prefixed_variables,
)

MINIMAL_ENV = {
    "DB_HOST": "db.example",
    "DB_USER": "open_brain",
    "EMBEDDING_BASE_URL": "http://embed.example/v1",
}


@pytest.fixture(autouse=True)
def _clean_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Remove every variable the settings models read.

    Without this, a developer's real shell leaks into the assertions and a test
    that should fail passes on their machine only.
    """
    for name in list(os.environ):
        upper = name.upper()
        if (
            upper.startswith("OPENBRAIN_")
            or upper.startswith("OPEN_BRAIN_")
            or upper.startswith("DB_")
            or upper.startswith("EMBEDDING_")
            or upper.startswith("LOG_")
            or upper in {"PORT", "SERVICE_NAME", "ALLOWED_ORIGINS"}
        ):
            monkeypatch.delenv(name, raising=False)


#: A directory with no config layers in it, so a test exercises the environment
#: alone. Passed explicitly because the real secrets/ directory would otherwise
#: leak whatever an operator has configured locally into the assertions.
NO_FILE_LAYERS = Path("/nonexistent-so-no-file-layer")


def _apply(monkeypatch: pytest.MonkeyPatch, **overrides: str) -> None:
    for key, value in {**MINIMAL_ENV, **overrides}.items():
        monkeypatch.setenv(key, value)


def _load(**overrides: str) -> Settings:
    """Load settings from an explicit environment, with no file layers.

    Sections are plain ``BaseModel`` and read no environment of their own -- the
    environment is resolved by ``Settings`` through ``LegacyFlatEnvSource``. So
    a test that wants to see what a variable does has to go through the loader;
    constructing ``DatabaseSettings()`` directly yields field defaults.

    That indirection is the fix for a measured bug, not incidental: when each
    section was its own ``BaseSettings``, each ran an independent environment
    source during construction, and a ``config.json`` silently outranked
    ``DB_HOST``.
    """
    return load_settings(
        environ={**MINIMAL_ENV, **overrides},
        secrets_dir=NO_FILE_LAYERS,
        configure_logging=False,
    )


def test_minimal_environment_loads_with_documented_defaults(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _apply(monkeypatch)

    settings = load_settings(environ=dict(MINIMAL_ENV))

    assert settings.database.host == "db.example"
    assert settings.database.port == 5432
    assert settings.database.name == "open_brain"
    assert settings.database.pool_max == 10
    assert settings.embedding.model == "embeddinggemma-300m-8bit"
    assert settings.embedding.dimensions == 768
    assert settings.logging.level == "INFO"
    assert settings.server.port == 3100
    assert settings.server.run_migrations is True


def test_legacy_flat_aliases_are_accepted() -> None:
    """The spellings already deployed keep working without a second definition.

    docs/CONFIG_REFERENCE.md records every variable the codebase reads, and all
    of them are flat. .env, local-clone.env, play.env, and the launchd plists
    carry these names, so breaking them would stop the service starting.
    """
    settings = _load(
        DB_PORT="6000", DB_NAME="other", LOG_LEVEL="DEBUG", PORT="9999"
    )

    assert settings.database.port == 6000
    assert settings.database.name == "other"
    assert settings.logging.level == "DEBUG"
    assert settings.server.port == 9999


def test_prefixed_alias_is_accepted() -> None:
    settings = _load(OPENBRAIN_DB_PORT="6543")

    assert settings.database.port == 6543


def test_prefixed_alias_wins_over_the_legacy_spelling() -> None:
    """Declaration order decides, and the prefixed name is declared first."""
    settings = _load(OPENBRAIN_DB_PORT="6543", DB_PORT="6000")

    assert settings.database.port == 6543


def test_missing_required_host_names_the_field() -> None:
    with pytest.raises(ValidationError) as caught:
        load_settings(
            environ={"DB_USER": "u", "EMBEDDING_BASE_URL": "http://x/v1"},
            secrets_dir=NO_FILE_LAYERS,
            configure_logging=False,
        )

    assert "DB_HOST" in str(caught.value)


def test_unparseable_integer_is_rejected() -> None:
    with pytest.raises(ValidationError) as caught:
        _load(DB_PORT="not-a-number")

    assert "port" in str(caught.value)


def test_non_positive_port_is_rejected() -> None:
    with pytest.raises(ValidationError) as caught:
        _load(DB_PORT="0")

    assert "greater than 0" in str(caught.value)


def test_password_does_not_appear_in_repr() -> None:
    """A SecretStr keeps the credential out of reprs, logs, and tracebacks."""
    settings = _load(DB_PASSWORD="hunter2-should-never-print")

    assert "hunter2-should-never-print" not in repr(settings)
    assert "hunter2-should-never-print" not in repr(settings.database)
    assert settings.database.password is not None
    assert (
        settings.database.password.get_secret_value() == "hunter2-should-never-print"
    )


def test_overlap_at_or_above_segment_size_is_rejected() -> None:
    """An overlap that never advances through the text is a configuration error."""
    with pytest.raises(ValidationError) as caught:
        _load(
            OPENBRAIN_EMBEDDING_SEGMENT_CHARS="1000",
            OPENBRAIN_EMBEDDING_SEGMENT_OVERLAP_CHARS="1000",
        )

    assert "never advances" in str(caught.value)


def test_overlap_below_segment_size_is_accepted() -> None:
    settings = _load(
        OPENBRAIN_EMBEDDING_SEGMENT_CHARS="1000",
        OPENBRAIN_EMBEDDING_SEGMENT_OVERLAP_CHARS="999",
    )

    assert settings.embedding.segment_overlap_chars == 999


def test_rotation_without_a_file_sink_is_rejected() -> None:
    """Rotation settings with no file sink do nothing; saying so beats silence."""
    with pytest.raises(ValidationError) as caught:
        _load(LOG_MAX_FILES="7")

    assert "log rotation (max_files) is set but log.file is not" in str(caught.value)


def test_rotation_with_a_file_sink_is_accepted() -> None:
    settings = _load(LOG_FILE="/var/log/ob.log", LOG_MAX_FILES="7")

    assert settings.logging.max_files == 7
    assert settings.logging.file == "/var/log/ob.log"


class TestSectionRegistry:
    """_SECTION_MODELS must describe every section of Settings."""

    def test_every_settings_section_is_registered(self) -> None:
        """A section missing here gets no flat variables and no typo checking.

        Both failures are silent: the setting simply does nothing, and a typo in
        it is not reported. Asserting the tuple against the model is what makes
        adding a section without registering it a test failure instead.
        """
        registered = {name for name, _ in _SECTION_MODELS}
        declared = set(Settings.model_fields)

        assert registered == declared


class TestFileLayers:
    """JSON config layers, and their precedence against the environment."""

    def _write(self, directory: Path, name: str, payload: dict[str, object]) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        (directory / name).write_text(json.dumps(payload))

    def test_a_layer_supplies_settings(self, tmp_path: Path) -> None:
        self._write(
            tmp_path,
            "config.json",
            {
                "database": {"host": "from-json.example", "user": "json_user"},
                "embedding": {"base_url": "http://json.example/v1"},
            },
        )

        settings = load_settings(
            environ={}, secrets_dir=tmp_path, configure_logging=False
        )

        assert settings.database.host == "from-json.example"
        assert settings.embedding.base_url == "http://json.example/v1"

    def test_environment_beats_a_file(self, tmp_path: Path) -> None:
        """THE precedence property, and it was measurably inverted before.

        When each section was its own BaseSettings it ran an independent
        environment source during construction, so a committed config.json
        silently outranked an exported DB_HOST -- the reverse of the documented
        order, with nothing logged. See STANDARDS-python.md on config.py.
        """
        self._write(
            tmp_path,
            "config.json",
            {
                "database": {"host": "from-json.example", "user": "json_user"},
                "embedding": {"base_url": "http://json.example/v1"},
            },
        )

        settings = load_settings(
            environ={"DB_HOST": "from-env.example"},
            secrets_dir=tmp_path,
            configure_logging=False,
        )

        assert settings.database.host == "from-env.example"
        # Untouched by the environment, so the file still supplies it.
        assert settings.database.user == "json_user"

    def test_layers_deep_merge_rather_than_replace(self, tmp_path: Path) -> None:
        """A per-environment layer setting one key keeps its siblings."""
        self._write(
            tmp_path,
            "config.json",
            {
                "database": {"host": "base.example", "user": "base_user"},
                "embedding": {"base_url": "http://base/v1"},
                "logging": {"level": "INFO", "service_name": "open-brain"},
            },
        )
        self._write(tmp_path, "config.prod.json", {"logging": {"level": "ERROR"}})

        settings = load_settings(
            environ={}, secrets_dir=tmp_path, env="prod", configure_logging=False
        )

        assert settings.logging.level == "ERROR"
        assert settings.logging.service_name == "open-brain"
        assert settings.database.host == "base.example"

    def test_a_missing_layer_is_not_an_error(self, tmp_path: Path) -> None:
        """Configuring entirely through the environment is a valid deployment."""
        settings = load_settings(
            environ=dict(MINIMAL_ENV),
            secrets_dir=tmp_path / "absent",
            configure_logging=False,
        )

        assert settings.database.host == "db.example"

    def test_an_unknown_key_in_a_layer_is_rejected(self, tmp_path: Path) -> None:
        """A typo in a file fails loudly rather than sitting inert."""
        self._write(
            tmp_path,
            "config.json",
            {
                "database": {"host": "h", "user": "u", "hsot": "typo"},
                "embedding": {"base_url": "http://x/v1"},
            },
        )

        with pytest.raises(ValidationError, match="hsot"):
            load_settings(environ={}, secrets_dir=tmp_path, configure_logging=False)


class TestUnknownVariableDetection:
    """extra='forbid' does NOT catch a typo'd prefixed environment variable.

    Measured 2026-07-30: pydantic-settings collects only variables matching a
    declared field, so OPENBRAIN_NOPE=1 is invisible to the model and loads
    clean. These tests pin the explicit scan that does catch it.
    """

    def test_typo_is_reported_by_name(self) -> None:
        environ = {**MINIMAL_ENV, "OPENBRAIN_DB_TYPPO": "1"}

        assert unknown_prefixed_variables(environ) == ("OPENBRAIN_DB_TYPPO",)

    def test_typo_blocks_loading(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _apply(monkeypatch)
        environ = {**MINIMAL_ENV, "OPENBRAIN_DB_TYPPO": "1"}

        with pytest.raises(ValueError, match="OPENBRAIN_DB_TYPPO"):
            load_settings(environ=environ)

    def test_recognised_prefixed_variables_are_not_flagged(self) -> None:
        environ = {
            **MINIMAL_ENV,
            "OPENBRAIN_LOG_LEVEL": "DEBUG",
            "OPENBRAIN_DB_PORT": "5432",
            "OPENBRAIN_EMBEDDING_MODEL": "some-model",
        }

        assert unknown_prefixed_variables(environ) == ()

    def test_unprefixed_variables_are_ignored(self) -> None:
        """Only the Open Brain namespace is ours to police."""
        environ = {**MINIMAL_ENV, "PATH": "/usr/bin", "SOME_OTHER_APP_SETTING": "1"}

        assert unknown_prefixed_variables(environ) == ()

    def test_several_typos_are_all_reported(self) -> None:
        environ = {
            **MINIMAL_ENV,
            "OPENBRAIN_ZZZ": "1",
            "OPENBRAIN_AAA": "2",
        }

        assert unknown_prefixed_variables(environ) == ("OPENBRAIN_AAA", "OPENBRAIN_ZZZ")
