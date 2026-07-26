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
import os
import signal
import subprocess
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
    _install_signal_flush,
    _usable_log_dir,
    configure_observability,
    flush_logs,
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
    # Signal dispositions are restored as well as sinks. configure_observability
    # installs a real SIGTERM/SIGINT handler on whatever process calls it, which
    # here is the pytest process itself. Leaving one behind puts this module's
    # handler in the path of a CI job cancellation, and of any later test that
    # cares about signal state.
    saved = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
    yield
    logger.remove()
    for sig, disposition in saved.items():
        signal.signal(sig, disposition)


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


#: Written by the SIGTERM subprocess below. Logs a burst, signals the parent that
#: it is ready, then blocks. The parent kills it mid-queue.
#: The probe signals ITSELF, immediately after the last `logger.info` returns,
#: so the writer thread gets no drain window at all.
#:
#: This shape matters. The first version of this test had the child write a
#: `ready` file and sleep while the parent polled and then signalled. That
#: handed the writer roughly ten milliseconds -- enough to finish the queue --
#: so it reported 200/200 with the fix reverted and proved nothing. Verified:
#: this shape gives 133/200 with `_install_signal_flush()` disabled and 200/200
#: with it enabled.
#:
#: `%s` rather than str.format: the source contains dict literals, and every
#: brace in them would have to be doubled to survive formatting.
_SIGTERM_PROBE = """
import os, signal, sys
from openbrain_provider.config import load_config
from openbrain_provider.observability import configure_observability, logger

configure_observability(load_config({"LOG_LEVEL": "info", "LOG_FILE": sys.argv[1]}))
for i in range(%s):
    logger.info("record", record_index=i)
os.kill(os.getpid(), signal.SIGTERM)
"""


def _run_sigterm_probe(tmp_path: Path, count: int) -> tuple[int, Path]:
    """Run the self-signalling probe and return its exit status and log path.

    Args:
        tmp_path: Directory for the generated script and its log file.
        count: How many records the probe logs before signalling itself.

    Returns:
        The probe's return code and the log file it wrote.
    """
    log_file = tmp_path / "signal.jsonl"
    script = tmp_path / "probe.py"
    script.write_text(_SIGTERM_PROBE % count)

    env = dict(os.environ)
    src = str(Path(__file__).resolve().parents[1] / "src")
    env["PYTHONPATH"] = f"{src}{os.pathsep}{env.get('PYTHONPATH', '')}"

    process = subprocess.Popen(
        [sys.executable, str(script), str(log_file)],
        env=env,
        stderr=subprocess.DEVNULL,
    )
    try:
        returncode = process.wait(timeout=60)
    finally:
        if process.poll() is None:  # pragma: no cover - only on a hung probe
            process.kill()
            process.wait(timeout=10)
    return returncode, log_file


def test_queued_records_survive_sigterm(tmp_path: Path) -> None:
    # Measured before this handler existed: 133 of 200 records reached disk on
    # SIGTERM, the missing 67 being the newest ones still in the enqueue=True
    # writer's queue. loguru's atexit hook covers a clean exit (200/200) and
    # nothing covered a signal.
    #
    # For a hook process that is the wrong way round: the records worth having
    # are the ones written just before something tore it down, and those are
    # exactly the ones that were being dropped.
    count = 200

    _, log_file = _run_sigterm_probe(tmp_path, count)

    records = [
        json.loads(line) for line in log_file.read_text().splitlines() if line.strip()
    ]
    assert len(records) == count, f"lost {count - len(records)} of {count} records"
    assert [r["context"]["record_index"] for r in records] == list(range(count))


def test_sigterm_still_terminates_the_process(tmp_path: Path) -> None:
    # Flushing must not swallow the signal. A handler that drains the queue and
    # then returns turns a lost log line into a process that ignores shutdown --
    # strictly worse, because a service manager escalates to SIGKILL and the
    # flush buys nothing.
    returncode, _ = _run_sigterm_probe(tmp_path, 1)

    assert returncode == -signal.SIGTERM


def test_a_caller_installed_signal_handler_is_not_replaced() -> None:
    # This module runs inside someone else's process. Claiming a slot another
    # component already owns would silently break their shutdown path, which is
    # a worse failure than the dropped records this handler exists to prevent.
    def caller_handler(_sig: int, _frame: object) -> None:  # pragma: no cover
        pass

    previous = signal.getsignal(signal.SIGTERM)
    signal.signal(signal.SIGTERM, caller_handler)
    try:
        _install_signal_flush()

        assert signal.getsignal(signal.SIGTERM) is caller_handler
    finally:
        signal.signal(signal.SIGTERM, previous)


def test_flush_logs_drains_the_queue(tmp_path: Path) -> None:
    config, log_file = _config(tmp_path)
    configure_observability(config)

    logger.info("queued")
    flush_logs()

    assert json.loads(log_file.read_text().splitlines()[0])["message"] == "queued"


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
