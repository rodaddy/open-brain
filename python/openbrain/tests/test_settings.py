from __future__ import annotations

import os

import pytest
from pydantic import ValidationError

from openbrain.config import (
    DatabaseSettings,
    EmbeddingSettings,
    LogSettings,
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


def _apply(monkeypatch: pytest.MonkeyPatch, **overrides: str) -> None:
    for key, value in {**MINIMAL_ENV, **overrides}.items():
        monkeypatch.setenv(key, value)


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
    assert settings.log.level == "INFO"
    assert settings.server.port == 3100
    assert settings.server.run_migrations is True


def test_legacy_flat_aliases_are_accepted(monkeypatch: pytest.MonkeyPatch) -> None:
    """The spellings already deployed keep working without a second definition."""
    _apply(monkeypatch, DB_PORT="6000", DB_NAME="other", LOG_LEVEL="DEBUG", PORT="9999")

    settings = load_settings(environ=dict(MINIMAL_ENV))

    assert settings.database.port == 6000
    assert settings.database.name == "other"
    assert settings.log.level == "DEBUG"
    assert settings.server.port == 9999


def test_prefixed_alias_is_accepted(monkeypatch: pytest.MonkeyPatch) -> None:
    _apply(monkeypatch, OPENBRAIN_DB_PORT="6543")

    settings = load_settings(environ=dict(MINIMAL_ENV))

    assert settings.database.port == 6543


def test_missing_required_host_names_the_field(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("DB_USER", "u")
    monkeypatch.setenv("EMBEDDING_BASE_URL", "http://x/v1")

    with pytest.raises(ValidationError) as caught:
        DatabaseSettings()  # type: ignore[call-arg]

    assert "DB_HOST" in str(caught.value)


def test_unparseable_integer_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    _apply(monkeypatch, DB_PORT="not-a-number")

    with pytest.raises(ValidationError) as caught:
        DatabaseSettings()  # type: ignore[call-arg]

    assert "DB_PORT" in str(caught.value)


def test_non_positive_port_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    _apply(monkeypatch, DB_PORT="0")

    with pytest.raises(ValidationError) as caught:
        DatabaseSettings()  # type: ignore[call-arg]

    assert "greater than 0" in str(caught.value)


def test_password_does_not_appear_in_repr(monkeypatch: pytest.MonkeyPatch) -> None:
    """A SecretStr keeps the credential out of reprs, logs, and tracebacks."""
    _apply(monkeypatch, DB_PASSWORD="hunter2-should-never-print")

    settings = DatabaseSettings()  # type: ignore[call-arg]

    assert "hunter2-should-never-print" not in repr(settings)
    assert settings.password is not None
    assert settings.password.get_secret_value() == "hunter2-should-never-print"


def test_overlap_at_or_above_segment_size_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An overlap that never advances through the text is a configuration error."""
    _apply(monkeypatch)

    with pytest.raises(ValidationError) as caught:
        EmbeddingSettings(segment_chars=1000, segment_overlap_chars=1000)  # type: ignore[call-arg]

    assert "never advances" in str(caught.value)


def test_overlap_below_segment_size_is_accepted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _apply(monkeypatch)

    settings = EmbeddingSettings(segment_chars=1000, segment_overlap_chars=999)  # type: ignore[call-arg]

    assert settings.segment_overlap_chars == 999


def test_rotation_without_a_file_sink_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Rotation settings with no file sink do nothing; saying so beats silence."""
    monkeypatch.setenv("LOG_MAX_FILES", "7")

    with pytest.raises(ValidationError) as caught:
        LogSettings()

    message = str(caught.value)
    assert "log rotation (max_files) is set but log.file is not" in message


def test_rotation_with_a_file_sink_is_accepted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LOG_FILE", "/var/log/ob.log")
    monkeypatch.setenv("LOG_MAX_FILES", "7")

    settings = LogSettings()

    assert settings.max_files == 7
    assert settings.file == "/var/log/ob.log"


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
