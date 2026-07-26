"""Tests for observability init.

These assert the properties that broke silently in the previous revision: the
emitted envelope must match OBSERVABILITY_CONTRACT.md, and nothing may reach
stdout. The first revision passed its own tests while emitting loguru's
internal `{"text":..., "record":{...}}` shape, because those tests asserted on
loguru's structure instead of the contract's.
"""

from __future__ import annotations

import io
import json
import sys
import tempfile
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from openbrain_provider.config import LogConfig, ProviderConfig, load_config
from openbrain_provider.observability import (
    SERVICE_NAME,
    TOP_LEVEL_FIELDS,
    _usable_log_dir,
    configure_observability,
    logger,
    resolve_log_file,
)

#: OBSERVABILITY_CONTRACT.md §1.1. Every record MUST carry these at top level.
#: Written out literally rather than imported, so a change to the module's own
#: tuple cannot silently redefine what "conforming" means.
REQUIRED_TOP_LEVEL_FIELDS = ("timestamp", "level", "service", "host", "message")

#: §1.1 again: lowercase only. `warn`/`err`/`crit` are named non-conforming.
CONFORMING_LEVELS = frozenset({"debug", "info", "warning", "error", "critical"})


@pytest.fixture(autouse=True)
def _isolate_sinks() -> Iterator[None]:
    yield
    logger.remove()


def _config(tmp_path: Path, level: str = "info") -> tuple[ProviderConfig, Path]:
    log_file = tmp_path / "provider.jsonl"
    config = load_config(
        {"LOG_LEVEL": level, "LOG_FILE": str(log_file)},
    )
    return config, log_file


def _read_records(path: Path) -> list[dict[str, Any]]:
    logger.remove()  # flush the enqueue=True writer thread before reading
    records: list[dict[str, Any]] = [
        json.loads(line) for line in path.read_text().splitlines() if line.strip()
    ]
    return records


def test_envelope_has_the_required_top_level_fields(tmp_path: Path) -> None:
    config, log_file = _config(tmp_path)
    configure_observability(config)

    logger.info("hello world")

    record = _read_records(log_file)[0]
    for field in REQUIRED_TOP_LEVEL_FIELDS:
        assert field in record, f"contract requires top-level {field!r}"
    assert record["message"] == "hello world"
    assert record["service"] == SERVICE_NAME
    assert record["host"]


def test_level_is_lowercase_in_the_envelope(tmp_path: Path) -> None:
    # Loki matches literally. An uppercase level means every contract query
    # filtering on level="error" silently returns nothing.
    config, log_file = _config(tmp_path, level="debug")
    configure_observability(config)

    logger.debug("d")
    logger.warning("w")
    logger.error("e")

    records = _read_records(log_file)
    assert [r["level"] for r in records] == ["debug", "warning", "error"]
    assert all(r["level"] in CONFORMING_LEVELS for r in records)


def test_timestamp_is_rfc3339_utc(tmp_path: Path) -> None:
    config, log_file = _config(tmp_path)
    configure_observability(config)

    logger.info("t")

    timestamp = _read_records(log_file)[0]["timestamp"]
    assert timestamp.endswith("Z"), f"contract requires a Z suffix, got {timestamp!r}"
    # Millisecond precision: 2026-07-25T04:16:07.418Z
    assert len(timestamp) == len("2026-07-25T04:16:07.418Z")


def test_nothing_is_written_to_stdout(tmp_path: Path) -> None:
    # stdout is the hook's machine-readable return channel, so a log line there
    # is a corrupted response. Nothing in this module may ever add a stdout
    # sink; this test is what holds that in place.
    config, log_file = _config(tmp_path, level="debug")
    captured = io.StringIO()
    real_stdout = sys.stdout
    sys.stdout = captured
    try:
        configure_observability(config)
        logger.debug("d")
        logger.info("i")
        logger.error("e")
        logger.remove()
    finally:
        sys.stdout = real_stdout

    assert captured.getvalue() == ""
    messages = [r["message"] for r in _read_records(log_file)]
    assert messages == ["d", "i", "e"]


def test_every_record_is_a_single_json_line(tmp_path: Path) -> None:
    # §1: pretty-printing is forbidden; a multi-line record breaks line-oriented
    # collection. A message containing a newline must not produce two lines.
    config, log_file = _config(tmp_path)
    configure_observability(config)

    logger.info("first line\nsecond line")

    # Remove the sinks BEFORE reading. `enqueue=True` writes on a background
    # thread, so reading first is a race: it passed locally and failed on the CI
    # runner, which is the worst possible ordering for noticing. Every other
    # test here flushes via _read_records; this one read the file directly.
    logger.remove()

    lines = [ln for ln in log_file.read_text().splitlines() if ln.strip()]
    assert len(lines) == 1
    assert json.loads(lines[0])["message"] == "first line\nsecond line"


def test_level_filters_lower_severity(tmp_path: Path) -> None:
    config, log_file = _config(tmp_path, level="error")
    configure_observability(config)

    logger.debug("dropped")
    logger.info("dropped")
    logger.error("kept")

    records = _read_records(log_file)
    assert [r["message"] for r in records] == ["kept"]


def test_reconfiguring_does_not_duplicate_output(tmp_path: Path) -> None:
    # A duplicated sink is silent: the process works, it just writes every line
    # twice, and nobody notices until a log-volume alarm fires.
    config, log_file = _config(tmp_path)
    configure_observability(config)
    configure_observability(config)

    logger.info("once")

    assert len(_read_records(log_file)) == 1


def test_service_name_is_overridable(tmp_path: Path) -> None:
    config, log_file = _config(tmp_path)
    configure_observability(config, service="ob-hook-capture")

    logger.info("hello")

    assert _read_records(log_file)[0]["service"] == "ob-hook-capture"


def test_unwritable_log_file_is_not_fatal(tmp_path: Path) -> None:
    # §5.1: being unable to open LOG_FILE MUST NOT be fatal. An earlier
    # revision raised OSError at init, which takes down the hook over a logging
    # problem -- the opposite of the contract's intent.
    config = ProviderConfig(
        log=LogConfig(level="info", log_file=Path("/proc/nonexistent/x.jsonl")),
        dispatch=load_config({}).dispatch,
    )

    configure_observability(config)
    logger.info("still running")
    logger.remove()


def test_unwritable_explicit_log_file_does_not_leak_to_stdout() -> None:
    # Review finding (HIGH, two lanes independently). resolve_log_file honored
    # an operator-supplied path unchecked, so an unwritable LOG_FILE fell through
    # to a stdout sink -- redirecting every record onto the hook's
    # machine-readable response channel. The old
    # test_unwritable_log_file_is_not_fatal passed throughout because it never
    # captured stdout. On the pre-fix code this leaked 436 bytes.
    config = ProviderConfig(
        log=LogConfig(level="info", log_file=Path("/proc/nonexistent/x.jsonl")),
        dispatch=load_config({}).dispatch,
    )

    captured = io.StringIO()
    real_stdout = sys.stdout
    sys.stdout = captured
    try:
        configure_observability(config)
        logger.info("must not reach stdout")
        logger.remove()
    finally:
        sys.stdout = real_stdout

    assert captured.getvalue() == ""


def test_unwritable_explicit_path_falls_back_to_a_writable_one() -> None:
    resolved = resolve_log_file(Path("/proc/nonexistent/x.jsonl"), service="svc")

    assert resolved != Path("/proc/nonexistent/x.jsonl")
    resolved.parent.mkdir(parents=True, exist_ok=True)
    resolved.write_text("")  # must really accept a write


def test_writable_explicit_path_is_still_honored(tmp_path: Path) -> None:
    # The fallback must not relocate a path that works. An operator who names a
    # usable file gets exactly that file.
    explicit = tmp_path / "chosen.jsonl"

    assert resolve_log_file(explicit) == explicit


def test_no_log_file_configured_still_never_uses_stdout() -> None:
    # The collision this module exists to resolve. rtech-obs defaults LOG_FILE
    # to /mnt/logs/...; where that mount is absent the §5.1 fallback adds a
    # stdout sink, overriding stdout=False. For a hook that means logging onto
    # the response channel. resolve_log_file must pick a writable path so the
    # fallback never fires.
    config = load_config({"LOG_LEVEL": "info"})
    captured = io.StringIO()
    real_stdout = sys.stdout
    sys.stdout = captured
    try:
        configure_observability(config)
        logger.info("hello")
        logger.remove()
    finally:
        sys.stdout = real_stdout

    assert captured.getvalue() == ""


def test_resolve_log_file_honors_an_explicit_path(tmp_path: Path) -> None:
    # An operator who names a path gets that path. Silently relocating their
    # logs is worse than failing somewhere they can see it.
    explicit = tmp_path / "chosen.jsonl"

    assert resolve_log_file(explicit) == explicit


def test_resolve_log_file_defaults_to_somewhere_writable() -> None:
    resolved = resolve_log_file(None, service="openbrain-provider-test")

    resolved.parent.mkdir(parents=True, exist_ok=True)
    resolved.write_text("")
    assert resolved.parent.is_dir()
    assert resolved.name.endswith(".jsonl")


def test_resolve_log_file_falls_back_when_the_shared_root_is_unwritable(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # /mnt/logs is not provisioned, so this is the path that actually runs
    # today. Pointing the shared root at a location that cannot be created
    # proves the fallback rather than assuming it.
    monkeypatch.setattr(
        "openbrain_provider.observability._CONTRACT_LOG_ROOT",
        Path("/proc/nonexistent/services"),
    )
    monkeypatch.setattr(tempfile, "gettempdir", lambda: str(tmp_path))

    resolved = resolve_log_file(None, service="svc")

    assert tmp_path in resolved.parents
    resolved.write_text("")  # the returned path must really accept a write


def test_resolve_log_file_prefers_the_shared_root_when_it_works(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # The day /mnt/logs exists, this must start using it with no code change.
    shared = tmp_path / "shared"
    monkeypatch.setattr("openbrain_provider.observability._CONTRACT_LOG_ROOT", shared)

    resolved = resolve_log_file(None, service="svc")

    assert resolved.parent == shared / "svc"


def test_write_probe_leaves_nothing_behind(tmp_path: Path) -> None:
    # The probe creates a file to prove writability; leaving it would litter a
    # log directory with junk on every hook invocation.
    monkeypatch_dir = tmp_path / "probe-target"

    assert _usable_log_dir(monkeypatch_dir) == monkeypatch_dir
    assert list(monkeypatch_dir.iterdir()) == []


def test_module_field_list_matches_the_contract() -> None:
    # The module exports its own tuple for callers; if it ever drifts from the
    # contract's five fields, the envelope drifts with it.
    assert TOP_LEVEL_FIELDS == REQUIRED_TOP_LEVEL_FIELDS


def test_extra_fields_are_nested_under_context(tmp_path: Path) -> None:
    # Contract: field names not in the envelope MUST go inside `context`, never
    # at the top level, or they collide with indexed fields.
    config, log_file = _config(tmp_path)
    configure_observability(config)

    logger.bind(namespace="shared-kb", attempt=2).info("bound")

    record = _read_records(log_file)[0]
    assert record["context"] == {"namespace": "shared-kb", "attempt": 2}
    assert "namespace" not in record


def test_known_contract_fields_stay_at_the_top_level(tmp_path: Path) -> None:
    config, log_file = _config(tmp_path)
    configure_observability(config)

    logger.bind(correlation_id="abc123", event="hook.capture").info("e")

    record = _read_records(log_file)[0]
    assert record["correlation_id"] == "abc123"
    assert record["event"] == "hook.capture"
    assert "context" not in record


def test_exceptions_are_recorded_as_a_structured_error(tmp_path: Path) -> None:
    config, log_file = _config(tmp_path)
    configure_observability(config)

    try:
        raise ValueError("boom")
    except ValueError:
        logger.opt(exception=True).error("failed")

    record = _read_records(log_file)[0]
    assert record["error"]["type"] == "ValueError"
    assert record["error"]["message"] == "boom"
    assert "stacktrace" in record["error"]
