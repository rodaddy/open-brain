"""Tests for the queued spool-replay maintenance handler (#344).

The handler must run the *existing* spool replay/quarantine flow: the same
``REPLAYED``/``QUARANTINED`` outcomes and drain receipts as the standalone
auto-drain, each unit under its own persisted exact scope, with foreign
namespace/scope provenance retained, content-free, and idempotent.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from pathlib import Path

import pytest

from openbrain_memory import (
    SPOOL_REPLAY_JOB_KIND,
    DrainReport,
    FirstClassMemoryRuntime,
    JsonlSpool,
    MaintenanceHandler,
    MaintenanceRegistry,
    MaintenanceRegistryError,
    MaintenanceScheduler,
    ReceiptStatus,
    SpoolReplayMaintenanceHandler,
)
from openbrain_memory._runtime_spool import PARKED_NAMESPACE_KEY

from ._runtime_fakes import (
    LaneAwareTransport,
    runtime_config,
    runtime_scope,
    tool_calls,
)
from .test_runtime import _park_unit, _parked_unit_scope


def _seed_replay_and_quarantine_fixture(spool: JsonlSpool) -> None:
    """Seed one replayable unit and one unit that fails and quarantines.

    ``quarantine_threshold`` is 1 on the spool under test, so the unsupported
    operation fails its single replay attempt and quarantines in the same pass;
    the valid ``session_start`` unit replays. This exercises both a ``REPLAYED``
    and a ``QUARANTINED`` receipt in one drain.
    """
    scope = runtime_scope()
    spool.append(
        "unknown_operation",
        {"value": "will fail and quarantine"},
        key="poison-key",
    )
    spool.append(
        "session_start",
        {
            **scope.start_metadata(),
            "session_key": scope.session_key,
            "agent": scope.agent,
        },
        key="valid-key",
    )


def _build_runtime(
    spool: JsonlSpool, transport: LaneAwareTransport
) -> FirstClassMemoryRuntime:
    return FirstClassMemoryRuntime(
        runtime_config(),
        runtime_scope(),
        transport=transport,
        spool=spool,
    )


def test_handler_kind_is_the_stable_spool_replay_job_kind() -> None:
    spool = JsonlSpool("/dev/null")
    handler = SpoolReplayMaintenanceHandler(
        _build_runtime(spool, LaneAwareTransport())
    )
    assert handler.kind == SPOOL_REPLAY_JOB_KIND == "spool_replay"


def test_queued_drain_matches_standalone_outcomes_and_receipts(
    tmp_path: Path,
) -> None:
    # Standalone path: the drain the write/recall path triggers automatically.
    standalone_spool = JsonlSpool(
        tmp_path / "standalone.jsonl", quarantine_threshold=1
    )
    _seed_replay_and_quarantine_fixture(standalone_spool)
    standalone_runtime = _build_runtime(standalone_spool, LaneAwareTransport())
    standalone = standalone_runtime.recall_context("Trigger standalone drain")

    # Queued path: an identical fixture drained through the maintenance handler.
    queued_spool = JsonlSpool(tmp_path / "queued.jsonl", quarantine_threshold=1)
    _seed_replay_and_quarantine_fixture(queued_spool)
    queued_runtime = _build_runtime(queued_spool, LaneAwareTransport())
    queued_report = SpoolReplayMaintenanceHandler(queued_runtime).run()

    assert standalone.receipt.status is ReceiptStatus.DIRECT
    assert standalone.drain is not None
    assert queued_report is not None
    # Same REPLAYED and QUARANTINED outcomes and the same drain receipts.
    assert queued_report.as_dict() == standalone.drain.as_dict()
    # Concretely: one replayed unit and one quarantined unit in each path.
    assert queued_report.replayed_units == 1
    assert queued_report.quarantined_units == 1
    replayed = [
        receipt
        for receipt in queued_report.receipts
        if receipt.status is ReceiptStatus.REPLAYED
    ]
    quarantined = [
        receipt
        for receipt in queued_report.receipts
        if receipt.status is ReceiptStatus.QUARANTINED
    ]
    assert [receipt.spool_key for receipt in replayed] == ["valid-key"]
    assert [receipt.spool_key for receipt in quarantined] == ["poison-key"]


def test_queued_drain_replays_unit_under_its_own_persisted_exact_scope(
    tmp_path: Path,
) -> None:
    parked = _parked_unit_scope()
    spool = JsonlSpool(tmp_path / "queued.jsonl")
    _park_unit(spool, parked, "Parked in another project")
    transport = LaneAwareTransport()
    runtime = _build_runtime(spool, transport)

    report = SpoolReplayMaintenanceHandler(runtime).run()

    assert report is not None
    assert report.replayed_units == 1
    assert spool.status().pending_count == 0
    # The queued drain dispatched the parked unit under the scope it was parked
    # with — not the replaying runtime's scope.
    started = [
        call["params"]["arguments"]
        for call in tool_calls(transport)
        if call["params"]["name"] == "session_start"
    ]
    assert any(
        arguments["session_key"] == parked.session_key
        and arguments["channel_id"] == parked.channel_id
        for arguments in started
    )
    appended = [
        call["params"]["arguments"]
        for call in tool_calls(transport)
        if call["params"]["name"] == "append_session_event"
    ]
    assert any(
        arguments["content"] == "Parked in another project"
        and arguments["channel_id"] == parked.channel_id
        for arguments in appended
    )


def test_queued_drain_retains_unit_parked_under_another_namespace(
    tmp_path: Path,
) -> None:
    parked = _parked_unit_scope()
    spool = JsonlSpool(tmp_path / "queued.jsonl")
    spool.append_batch(
        [
            (
                "session_start",
                {
                    **parked.start_metadata(),
                    "session_key": parked.session_key,
                    "agent": parked.agent,
                    PARKED_NAMESPACE_KEY: "other-namespace",
                },
                None,
            ),
            (
                "append_session_event",
                {
                    **parked.start_metadata(),
                    "session_key": parked.session_key,
                    "agent": parked.agent,
                    "content": "Parked by another namespace",
                    "event_type": "fact",
                    "source": parked.agent,
                    "metadata": {"idempotency_key": "parked-other-namespace"},
                },
                None,
            ),
        ]
    )
    transport = LaneAwareTransport()
    runtime = _build_runtime(spool, transport)

    report = SpoolReplayMaintenanceHandler(runtime).run()

    assert report is not None
    # Foreign-namespace provenance is honored on the queued path exactly as on
    # the standalone path: retained, never dispatched, still parked.
    assert report.retained_units == 1
    assert report.replayed_units == 0
    assert [record.operation for record in spool.records()] == [
        "session_start",
        "append_session_event",
    ]
    dispatched_keys = [
        call["params"]["arguments"].get("session_key")
        for call in tool_calls(transport)
        if call["params"]["name"] != "get_contract"
    ]
    assert parked.session_key not in dispatched_keys


def test_queued_drain_is_idempotent_over_a_settled_spool(
    tmp_path: Path,
) -> None:
    spool = JsonlSpool(tmp_path / "queued.jsonl", quarantine_threshold=1)
    _seed_replay_and_quarantine_fixture(spool)
    runtime = _build_runtime(spool, LaneAwareTransport())
    handler = SpoolReplayMaintenanceHandler(runtime)

    first = handler.run()
    settled = spool.records()

    second = handler.run()

    assert first is not None
    assert first.replayed_units == 1
    assert first.quarantined_units == 1
    # Replayed units left the spool; the quarantined unit is on the sidecar,
    # not pending. A second pass has nothing to drain and is a no-op.
    assert second is None
    assert spool.status().pending_count == 0
    # The settled spool is unchanged by the redundant second run.
    assert [record.idempotency_key for record in spool.records()] == [
        record.idempotency_key for record in settled
    ]


def test_queued_drain_receipts_are_content_free(tmp_path: Path) -> None:
    spool = JsonlSpool(tmp_path / "queued.jsonl", quarantine_threshold=1)
    _seed_replay_and_quarantine_fixture(spool)
    runtime = _build_runtime(spool, LaneAwareTransport())

    report = SpoolReplayMaintenanceHandler(runtime).run()

    assert report is not None
    allowed_receipt_keys = {
        "schema",
        "operation",
        "status",
        "durable",
        "direct_attempted",
        "fallback_attempted",
        "spool_key",
        "error",
    }
    for receipt in report.as_dict()["receipts"]:
        assert set(receipt).issubset(allowed_receipt_keys)
        # error carries only a class name (the failing unit), never a body.
        assert receipt.get("error") in (None, "ValueError")


# --- Registry -------------------------------------------------------------


@dataclass
class _RecordingHandler:
    """A minimal handler that records how many times it ran.

    Structurally satisfies :class:`MaintenanceHandler` (kind + run); used to
    exercise the registry and scheduler without a real runtime or spool.
    """

    kind: str
    report: DrainReport | None = None
    calls: int = 0
    barrier: threading.Event | None = None
    released: threading.Event | None = None

    def run(self) -> DrainReport | None:
        self.calls += 1
        if self.released is not None:
            self.released.set()
        if self.barrier is not None:
            self.barrier.wait(2.0)
        return self.report


def _no_op_report() -> DrainReport:
    return DrainReport(
        attempted_units=0,
        replayed_units=0,
        replayed_records=0,
        failed_units=0,
        quarantined_units=0,
        retained_units=0,
    )


def test_registry_resolves_registered_kind_to_its_handler() -> None:
    handler: MaintenanceHandler = _RecordingHandler(SPOOL_REPLAY_JOB_KIND)
    registry = MaintenanceRegistry()
    registry.register(handler)

    assert registry.get(SPOOL_REPLAY_JOB_KIND) is handler
    assert registry.kinds() == frozenset({SPOOL_REPLAY_JOB_KIND})


def test_registry_rejects_duplicate_kind() -> None:
    registry = MaintenanceRegistry()
    registry.register(_RecordingHandler(SPOOL_REPLAY_JOB_KIND))

    with pytest.raises(MaintenanceRegistryError, match="already registered"):
        registry.register(_RecordingHandler(SPOOL_REPLAY_JOB_KIND))


def test_registry_rejects_unknown_kind() -> None:
    registry = MaintenanceRegistry()

    with pytest.raises(MaintenanceRegistryError, match="no maintenance handler"):
        registry.get("never_registered")


def test_spool_replay_handler_satisfies_the_handler_protocol(
    tmp_path: Path,
) -> None:
    spool = JsonlSpool(tmp_path / "queued.jsonl")
    handler: MaintenanceHandler = SpoolReplayMaintenanceHandler(
        _build_runtime(spool, LaneAwareTransport())
    )
    registry = MaintenanceRegistry()
    registry.register(handler)

    assert registry.get(SPOOL_REPLAY_JOB_KIND).kind == SPOOL_REPLAY_JOB_KIND


# --- Scheduler ------------------------------------------------------------


def _replay_registry(runtime: FirstClassMemoryRuntime) -> MaintenanceRegistry:
    registry = MaintenanceRegistry()
    registry.register(SpoolReplayMaintenanceHandler(runtime))
    return registry


def test_scheduled_and_standalone_share_fixture_outcomes_and_receipts(
    tmp_path: Path,
) -> None:
    # Standalone path: the drain the write/recall path triggers automatically.
    standalone_spool = JsonlSpool(
        tmp_path / "standalone.jsonl", quarantine_threshold=1
    )
    _seed_replay_and_quarantine_fixture(standalone_spool)
    standalone_runtime = _build_runtime(standalone_spool, LaneAwareTransport())
    standalone = standalone_runtime.recall_context("Trigger standalone drain")

    # Scheduled path: identical fixture drained through the scheduler.
    scheduled_spool = JsonlSpool(
        tmp_path / "scheduled.jsonl", quarantine_threshold=1
    )
    _seed_replay_and_quarantine_fixture(scheduled_spool)
    scheduled_runtime = _build_runtime(scheduled_spool, LaneAwareTransport())
    scheduler = MaintenanceScheduler(_replay_registry(scheduled_runtime))
    scheduled_report = scheduler.run_once(SPOOL_REPLAY_JOB_KIND)

    assert standalone.drain is not None
    assert scheduled_report is not None
    # Same REPLAYED and QUARANTINED outcomes and the same drain receipts as the
    # standalone auto-drain — the scheduler adds no behavior, only invocation.
    assert scheduled_report.as_dict() == standalone.drain.as_dict()
    assert scheduled_report.replayed_units == 1
    assert scheduled_report.quarantined_units == 1


def test_scheduler_run_once_unknown_kind_raises_before_running() -> None:
    scheduler = MaintenanceScheduler(MaintenanceRegistry())

    with pytest.raises(MaintenanceRegistryError, match="no maintenance handler"):
        scheduler.run_once("never_registered")


def test_scheduled_second_run_over_settled_spool_is_a_noop(
    tmp_path: Path,
) -> None:
    spool = JsonlSpool(tmp_path / "scheduled.jsonl", quarantine_threshold=1)
    _seed_replay_and_quarantine_fixture(spool)
    runtime = _build_runtime(spool, LaneAwareTransport())
    scheduler = MaintenanceScheduler(_replay_registry(runtime))

    first = scheduler.run_once(SPOOL_REPLAY_JOB_KIND)
    second = scheduler.tick(SPOOL_REPLAY_JOB_KIND)

    assert first is not None
    assert first.replayed_units == 1
    assert first.quarantined_units == 1
    # Replayed units left the spool; the settled spool is a no-op second pass.
    assert second is None
    assert spool.status().pending_count == 0


def test_scheduler_suppresses_an_overlapping_tick() -> None:
    # A run holds the guard on a barrier; a concurrent tick must be suppressed
    # (return None) rather than run the handler a second time in parallel.
    barrier = threading.Event()
    released = threading.Event()
    handler = _RecordingHandler(
        "slow", report=_no_op_report(), barrier=barrier, released=released
    )
    registry = MaintenanceRegistry()
    registry.register(handler)
    scheduler = MaintenanceScheduler(registry)

    holder: dict[str, DrainReport | None] = {}

    def hold() -> None:
        holder["result"] = scheduler.run_once("slow")

    worker = threading.Thread(target=hold)
    worker.start()
    assert released.wait(2.0)  # first run is inside the guard

    # Second tick while the first still holds the guard: suppressed no-op.
    suppressed = scheduler.tick("slow")
    assert suppressed is None
    assert handler.calls == 1

    barrier.set()
    worker.join(2.0)
    assert holder["result"] is handler.report
    assert handler.calls == 1


def test_scheduler_start_stop_lifecycle_runs_then_cleanly_stops() -> None:
    ran = threading.Event()
    handler = _RecordingHandler("loop", report=_no_op_report(), released=ran)
    registry = MaintenanceRegistry()
    registry.register(handler)
    scheduler = MaintenanceScheduler(registry)

    assert not scheduler.is_running
    scheduler.start("loop", interval=3600.0)
    assert ran.wait(2.0)  # the loop ticks immediately on start
    assert scheduler.is_running

    scheduler.stop(timeout=2.0)
    assert not scheduler.is_running
    # stop is idempotent when not running.
    scheduler.stop(timeout=2.0)
    assert handler.calls >= 1


def test_scheduler_start_rejects_a_non_positive_interval() -> None:
    registry = MaintenanceRegistry()
    registry.register(_RecordingHandler("loop", report=_no_op_report()))
    scheduler = MaintenanceScheduler(registry)

    with pytest.raises(ValueError, match="interval must be > 0"):
        scheduler.start("loop", interval=0.0)


def test_scheduler_start_rejects_unknown_kind_before_spawning() -> None:
    scheduler = MaintenanceScheduler(MaintenanceRegistry())

    with pytest.raises(MaintenanceRegistryError, match="no maintenance handler"):
        scheduler.start("never_registered", interval=3600.0)
    assert not scheduler.is_running


def test_scheduler_telemetry_is_content_free(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    spool = JsonlSpool(tmp_path / "scheduled.jsonl", quarantine_threshold=1)
    _seed_replay_and_quarantine_fixture(spool)
    runtime = _build_runtime(spool, LaneAwareTransport())
    scheduler = MaintenanceScheduler(_replay_registry(runtime))

    with caplog.at_level(logging.INFO, logger="openbrain_memory.maintenance"):
        report = scheduler.run_once(SPOOL_REPLAY_JOB_KIND)

    assert report is not None
    records = [r for r in caplog.records if r.name == "openbrain_memory.maintenance"]
    assert records
    allowed_extra = {
        "maintenance_kind",
        "maintenance_status",
        "maintenance_elapsed_ms",
        "maintenance_attempted_units",
        "maintenance_replayed_units",
        "maintenance_failed_units",
        "maintenance_quarantined_units",
        "maintenance_retained_units",
    }
    # The seeded fixture parks the poison payload; assert it never leaks into a
    # log message or structured field.
    for record in records:
        emitted = {
            key for key in vars(record) if key.startswith("maintenance_")
        }
        assert emitted.issubset(allowed_extra)
        assert record.args in (None, ())
        assert "will fail and quarantine" not in record.getMessage()
        assert getattr(record, "maintenance_kind") == SPOOL_REPLAY_JOB_KIND
        assert str(spool.path) not in record.getMessage()


def test_scheduler_logs_error_status_content_free_when_handler_raises(
    caplog: pytest.LogCaptureFixture,
) -> None:
    @dataclass
    class _RaisingHandler:
        kind: str = "boom"

        def run(self) -> DrainReport | None:
            raise RuntimeError("runtime handle carrying a secret path is unusable")

    registry = MaintenanceRegistry()
    registry.register(_RaisingHandler())
    scheduler = MaintenanceScheduler(registry)

    with caplog.at_level(logging.WARNING, logger="openbrain_memory.maintenance"):
        with pytest.raises(RuntimeError):
            scheduler.run_once("boom")

    records = [r for r in caplog.records if r.name == "openbrain_memory.maintenance"]
    assert any(
        getattr(record, "maintenance_status", None) == "error"
        for record in records
    )
    for record in records:
        # The exception body must never reach the log.
        assert "secret path" not in record.getMessage()
        assert record.exc_info is None


# --- Mutation checks ------------------------------------------------------


def test_mutation_scheduler_returning_noop_breaks_parity(
    tmp_path: Path,
) -> None:
    """Guard: if the handler stopped draining (always None), the scheduled
    parity and idempotency assertions must fail — proving those tests bind to
    real drain results, not to any report shape.
    """

    @dataclass
    class _NoopHandler:
        kind: str = SPOOL_REPLAY_JOB_KIND

        def run(self) -> DrainReport | None:
            return None

    spool = JsonlSpool(tmp_path / "standalone.jsonl", quarantine_threshold=1)
    _seed_replay_and_quarantine_fixture(spool)
    standalone = _build_runtime(spool, LaneAwareTransport()).recall_context(
        "Trigger standalone drain"
    )
    assert standalone.drain is not None

    registry = MaintenanceRegistry()
    registry.register(_NoopHandler())
    scheduler = MaintenanceScheduler(registry)
    mutated = scheduler.run_once(SPOOL_REPLAY_JOB_KIND)

    # The real handler returns a matching DrainReport; the mutant returns None.
    assert mutated is None
    assert mutated != standalone.drain
