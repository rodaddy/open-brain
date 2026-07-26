"""Tests for logging setup.

The properties under test are the two that break silently in production:
nothing may reach stdout, and every emitted line must be a parseable JSON
object carrying the service field.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from loguru import logger

from openbrain_provider.config import LogConfig
from openbrain_provider.logger import bind, configure_logging


def _read_records(path: Path) -> list[dict[str, Any]]:
    logger.remove()  # flush the enqueue=True writer thread before reading
    records: list[dict[str, Any]] = [
        json.loads(line) for line in path.read_text().splitlines() if line.strip()
    ]
    return records


def test_nothing_is_written_to_stdout(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # stdout is the hook's machine-readable return channel. A log line there is
    # not noise, it is a corrupted response.
    configure_logging(LogConfig(level="DEBUG", log_file=tmp_path / "p.log"))

    logger.info("a message")
    logger.error("a failure")

    # Detach the sinks before reading. `enqueue=True` writes on a background
    # thread, so a sink still attached to the capsys stream can be mid-write
    # when the fixture tears the stream down.
    logger.remove()

    assert capsys.readouterr().out == ""


def test_file_output_is_one_json_object_per_line(tmp_path: Path) -> None:
    log_file = tmp_path / "provider.log"
    configure_logging(LogConfig(level="INFO", log_file=log_file))

    logger.info("first")
    logger.warning("second")

    records = _read_records(log_file)
    assert len(records) == 2
    assert [r["record"]["message"] for r in records] == ["first", "second"]
    assert [r["record"]["level"]["name"] for r in records] == ["INFO", "WARNING"]


def test_service_field_is_attached_to_every_record(tmp_path: Path) -> None:
    log_file = tmp_path / "provider.log"
    configure_logging(LogConfig(level="INFO", log_file=log_file))

    logger.info("plain")
    bind(correlation_id="abc123").info("bound")

    records = _read_records(log_file)
    extras = [r["record"]["extra"] for r in records]
    assert all(e["service"] == "openbrain-provider" for e in extras)
    assert extras[1]["correlation_id"] == "abc123"


def test_bound_fields_do_not_leak_into_later_records(tmp_path: Path) -> None:
    log_file = tmp_path / "provider.log"
    configure_logging(LogConfig(level="INFO", log_file=log_file))

    bind(correlation_id="abc123").info("bound")
    logger.info("unbound")

    records = _read_records(log_file)
    extras = [r["record"]["extra"] for r in records]
    assert "correlation_id" not in extras[1]


def test_level_filters_lower_severity(tmp_path: Path) -> None:
    log_file = tmp_path / "provider.log"
    configure_logging(LogConfig(level="ERROR", log_file=log_file))

    logger.debug("dropped")
    logger.info("dropped")
    logger.error("kept")

    records = _read_records(log_file)
    assert len(records) == 1
    assert records[0]["record"]["level"]["name"] == "ERROR"


def test_service_name_is_overridable(tmp_path: Path) -> None:
    log_file = tmp_path / "provider.log"
    configure_logging(
        LogConfig(level="INFO", log_file=log_file), service="ob-hook-capture"
    )

    logger.info("hello")

    records = _read_records(log_file)
    assert records[0]["record"]["extra"]["service"] == "ob-hook-capture"


def test_reconfiguring_does_not_duplicate_output(tmp_path: Path) -> None:
    # A duplicated sink is silent: the process works, it just writes every line
    # twice, and nobody notices until a log-volume alarm fires.
    log_file = tmp_path / "provider.log"
    configure_logging(LogConfig(level="INFO", log_file=log_file))
    configure_logging(LogConfig(level="INFO", log_file=log_file))

    logger.info("once")

    assert len(_read_records(log_file)) == 1


def test_missing_log_directory_is_created(tmp_path: Path) -> None:
    log_file = tmp_path / "nested" / "deeper" / "provider.log"
    configure_logging(LogConfig(level="INFO", log_file=log_file))

    logger.info("hello")

    assert len(_read_records(log_file)) == 1


def test_stderr_only_configuration_writes_nothing_to_stdout(
    capsys: pytest.CaptureFixture[str],
) -> None:
    configure_logging(LogConfig(level="INFO"))

    logger.info("hello")
    logger.remove()

    captured = capsys.readouterr()
    assert captured.out == ""
    assert "hello" in captured.err
