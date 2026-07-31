"""Functional tests for the logging sinks.

These test observable behaviour -- what lands in a sink, and whether it is
parseable -- not that ``logger.add`` was called with particular arguments.
A test asserting call shape passes against a configuration that produces no
usable logs, which is the failure mode worth catching.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from loguru import logger

from openbrain.config import LogSettings, load_settings
from openbrain.utils.logging_config import LogContext, setup_logging

MINIMAL_ENV = {
    "DB_HOST": "db.example",
    "DB_USER": "open_brain",
    "EMBEDDING_BASE_URL": "http://embed.example/v1",
}


@pytest.fixture(autouse=True)
def _clean_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Remove every variable the settings models read.

    Without this, a real shell leaks into the assertions and a test that should
    fail passes on one machine only.
    """
    for name in list(os.environ):
        upper = name.upper()
        if (
            upper.startswith(("OPENBRAIN_", "OPEN_BRAIN_", "DB_", "EMBEDDING_", "LOG_"))
            or upper in {"PORT", "SERVICE_NAME", "ALLOWED_ORIGINS"}
        ):
            monkeypatch.delenv(name, raising=False)


def log_settings(monkeypatch: pytest.MonkeyPatch, **values: str) -> LogSettings:
    """Build LogSettings the way production does -- from the environment.

    Field names cannot be passed as constructor kwargs: every field here
    declares a ``validation_alias``, and pydantic-settings then treats the field
    name itself as an unexpected extra. Setting the environment instead is both
    the only working path and the one that exercises the alias wiring a
    deployment actually depends on.
    """
    for name, value in values.items():
        monkeypatch.setenv(name, value)
    return LogSettings()


@pytest.fixture(autouse=True)
def _restore_logger() -> Iterator[None]:
    """Leave loguru as it was found.

    setup_logging calls logger.remove(), which is process-global. Without this
    a configured sink survives into the next test and the suite passes or fails
    depending on file order.
    """
    yield
    logger.remove()


class TestRotatingFileSink:
    """The plain-text sink a human reads."""

    def test_writes_the_message_to_the_configured_path(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        target = tmp_path / "nested" / "open-brain.log"
        setup_logging(
            log_settings(
                monkeypatch, LOG_FILE=str(target), OPENBRAIN_SERIALIZE="false"
            )
        )

        logger.info("CAPTURE: stored session=abc kind=fact")
        logger.complete()

        assert target.exists(), "sink created no file"
        assert "CAPTURE: stored session=abc kind=fact" in target.read_text()

    def test_creates_missing_parent_directories(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A fresh clone has no log directory; the sink must not require one."""
        target = tmp_path / "a" / "b" / "c" / "open-brain.log"
        setup_logging(
            log_settings(
                monkeypatch, LOG_FILE=str(target), OPENBRAIN_SERIALIZE="false"
            )
        )

        logger.info("READY")
        logger.complete()

        assert target.exists()


class TestJsonSink:
    """The structured sink that aggregates across workers."""

    def test_emits_one_parseable_object_per_line(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        target = tmp_path / "open-brain.jsonl"
        setup_logging(
            log_settings(
                monkeypatch, LOG_JSON_FILE=str(target), OPENBRAIN_SERIALIZE="false"
            )
        )

        logger.info("CAPTURE: stored")
        logger.complete()

        lines = [line for line in target.read_text().splitlines() if line.strip()]
        assert lines, "json sink wrote nothing"

        # Parsing is the assertion: a sink emitting text that only looks like
        # JSON is exactly what this sink exists to avoid.
        record = json.loads(lines[-1])
        assert record["record"]["message"] == "CAPTURE: stored"

    def test_carries_service_and_worker_as_real_keys(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """core01 runs two workers; a line must say which one emitted it."""
        target = tmp_path / "open-brain.jsonl"
        setup_logging(
            log_settings(
                monkeypatch,
                LOG_JSON_FILE=str(target),
                OPENBRAIN_SERIALIZE="false",
                SERVICE_NAME="open-brain",
                OPENBRAIN_WORKER_NAME="worker-2",
            )
        )

        logger.info("READY")
        logger.complete()

        lines = [line for line in target.read_text().splitlines() if line.strip()]
        extra = json.loads(lines[-1])["record"]["extra"]
        assert extra["service"] == "open-brain"
        assert extra["worker"] == "worker-2"


class TestCorrelationId:
    """LogContext binds an id that call sites never have to thread through."""

    def test_binds_the_id_onto_lines_emitted_inside_the_block(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        target = tmp_path / "open-brain.jsonl"
        setup_logging(
            log_settings(
                monkeypatch, LOG_JSON_FILE=str(target), OPENBRAIN_SERIALIZE="false"
            )
        )

        with LogContext("session-42"):
            logger.info("CAPTURE: inside")
        logger.info("CAPTURE: outside")
        logger.complete()

        lines = [line for line in target.read_text().splitlines() if line.strip()]
        records = [json.loads(line)["record"] for line in lines]
        by_message = {r["message"]: r["extra"]["correlation_id"] for r in records}

        assert by_message["CAPTURE: inside"] == "session-42"
        assert by_message["CAPTURE: outside"] == "-", "id leaked past the block"


class TestIdempotence:
    """Calling setup twice must not double every line."""

    def test_second_call_does_not_duplicate_output(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        target = tmp_path / "open-brain.log"
        settings = log_settings(
            monkeypatch, LOG_FILE=str(target), OPENBRAIN_SERIALIZE="false"
        )

        setup_logging(settings)
        setup_logging(settings)

        logger.info("CAPTURE: once")
        logger.complete()

        emitted = target.read_text().count("CAPTURE: once")
        assert emitted == 1, f"message emitted {emitted} times, expected 1"


class TestKeystone:
    """config.load_settings is what starts logging. Nothing else does."""

    def test_load_settings_configures_the_sinks(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A process holding Settings necessarily has working logging.

        This is the keystone property. If load_settings stops calling
        setup_logging, every module still imports the logger and every log line
        goes to loguru's default stderr sink instead of the configured ones --
        silently, because logging never raises.
        """
        target = tmp_path / "keystone.log"
        for key, value in MINIMAL_ENV.items():
            monkeypatch.setenv(key, value)
        # LogSettings carries env_prefix="OPENBRAIN_", so its own fields bind as
        # OPENBRAIN_SERIALIZE -- the nested delimiter applies to Settings' model
        # fields, not to a submodel's. Writing OPENBRAIN_LOG__SERIALIZE here was
        # rejected by unknown_prefixed_variables, which is the check working.
        monkeypatch.setenv("LOG_FILE", str(target))
        monkeypatch.setenv("OPENBRAIN_SERIALIZE", "false")

        settings = load_settings()
        assert settings.log.file == str(target)

        logger.info("CAPTURE: after load_settings")
        logger.complete()

        assert target.exists(), "load_settings did not configure the file sink"
        assert "CAPTURE: after load_settings" in target.read_text()
