"""Idempotent maintenance handlers and an in-process scheduler (#344).

The automatic spool replay/quarantine flow (#296/#317) runs inline after a
successful direct write or recall. This module exposes that same flow as a
registrable, idempotent maintenance handler, a small registry that maps a
stable job ``kind`` to its handler, and an in-process scheduler that can run a
registered handler once, on demand, or on a bounded interval — without
inventing a second persistent job store.

The handler is a thin wrapper: it calls
``FirstClassMemoryRuntime.drain_spool_now``, which reuses the exact
``_drain_spool`` path. Every invariant of the standalone path is therefore
preserved unchanged — per-unit persisted exact scope, foreign-namespace and
unprovable-scope retention, ``REPLAYED``/``QUARANTINED`` disposition,
full-record namespace provenance, drain receipts, and content-free
observability. No new quarantine categories are introduced.

Durable work state is the spool file itself: a replayed unit leaves the spool
within its pass, so a re-run drains only what remains and a settled spool is a
no-op. The scheduler holds no job database of its own; it only owns the
in-process concerns of not overlapping a run and stopping cleanly.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

from .runtime import DrainReport, FirstClassMemoryRuntime

logger = logging.getLogger(__name__)

# Stable maintenance job kind for scheduled spool replay. Kept lowercase with
# the same token shape the TS maintenance queue accepts for a job kind so a
# cross-runtime scheduler can address this handler by a single identifier.
SPOOL_REPLAY_JOB_KIND = "spool_replay"


class MaintenanceHandler(Protocol):
    """A registrable maintenance job.

    ``kind`` is the stable identifier a registry and scheduler address the
    handler by; ``run`` executes exactly one idempotent pass and returns a
    content-free ``DrainReport`` (or ``None`` when there was nothing to do).
    """

    @property
    def kind(self) -> str: ...

    def run(self) -> DrainReport | None: ...


@dataclass(frozen=True)
class SpoolReplayMaintenanceHandler:
    """Run the runtime's spool replay/quarantine flow as a maintenance job.

    ``kind`` addresses this handler in a handler registry. ``run`` executes
    one drain pass and returns the same content-free ``DrainReport`` the
    standalone path produces (``None`` when nothing was pending or the drain
    machinery itself failed).

    Idempotent: replayed units are removed from the spool within the pass, so
    running the handler twice over a settled spool drains only what remains and
    the second run returns a zero-count report or ``None``. The handler holds no
    per-run state; a scheduler may invoke it repeatedly and safely retry a
    failed job. Any exception raised by ``run`` propagates to the scheduler for
    that scheduler's own retry/dead-letter accounting; the drain itself never
    raises (it returns ``None`` on internal failure), so ``run`` only raises if
    the runtime handle is unusable.
    """

    runtime: FirstClassMemoryRuntime

    @property
    def kind(self) -> str:
        return SPOOL_REPLAY_JOB_KIND

    def run(self) -> DrainReport | None:
        """Execute one idempotent spool replay pass."""
        return self.runtime.drain_spool_now()


class MaintenanceRegistryError(ValueError):
    """Raised for a duplicate or unknown maintenance job kind."""


class MaintenanceRegistry:
    """Maps a stable job ``kind`` to the handler that services it.

    Registration is deterministic: registering a kind that is already
    registered raises, and resolving a kind that was never registered raises.
    Both surface :class:`MaintenanceRegistryError` so a caller can tell a
    routing mistake from a job failure. The registry owns no execution
    concerns; it only answers "which handler runs this kind".
    """

    def __init__(self) -> None:
        self._handlers: dict[str, MaintenanceHandler] = {}

    def register(self, handler: MaintenanceHandler) -> None:
        """Register ``handler`` under its ``kind``; reject a duplicate kind."""
        kind = handler.kind
        if kind in self._handlers:
            raise MaintenanceRegistryError(
                f"maintenance kind is already registered: {kind}"
            )
        self._handlers[kind] = handler

    def get(self, kind: str) -> MaintenanceHandler:
        """Return the handler for ``kind``; reject an unknown kind."""
        try:
            return self._handlers[kind]
        except KeyError as error:
            raise MaintenanceRegistryError(
                f"no maintenance handler registered for kind: {kind}"
            ) from error

    def kinds(self) -> frozenset[str]:
        """Return the set of registered kinds."""
        return frozenset(self._handlers)


class MaintenanceScheduler:
    """Run a registered maintenance handler once, on demand, or on a bounded
    interval, in this process.

    The spool file is the durable work state; the scheduler adds only two
    in-process concerns:

    * **No overlap.** ``run_once``/``tick`` take a non-blocking lock. If a run
      is already in flight (including a background loop's run), the concurrent
      caller returns ``None`` immediately rather than draining the same spool
      twice at once.
    * **Clean stop.** ``start`` spins a single daemon loop that calls ``tick``
      and then waits on a stop event for ``interval`` seconds; ``stop`` sets the
      event and joins the loop. There is no background thread unless ``start``
      is called explicitly — construction and registration start nothing.

    Telemetry is content-free by construction: only ``kind``, a status token,
    elapsed milliseconds, and the drain's counts are logged. Records, paths,
    payloads, and exception bodies are never logged here — a handler failure is
    logged as ``status=error`` with no exception object.
    """

    def __init__(
        self,
        registry: MaintenanceRegistry,
        *,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._registry = registry
        self._monotonic = monotonic
        # Non-blocking guard: held for the duration of one handler run so an
        # overlapping tick is suppressed instead of double-draining the spool.
        self._run_lock = threading.Lock()
        self._stop = threading.Event()
        self._loop: threading.Thread | None = None
        # Guards loop lifecycle (start/stop) against itself, not the run lock.
        self._lifecycle_lock = threading.Lock()

    def run_once(self, kind: str) -> DrainReport | None:
        """Resolve ``kind`` and run it once if no run is already in flight.

        Returns the handler's ``DrainReport`` (or ``None`` when it had nothing
        to do), or ``None`` if a concurrent run holds the guard. Resolving an
        unknown kind raises :class:`MaintenanceRegistryError` before any lock is
        taken, so a routing mistake is never silently swallowed as a no-op.
        """
        handler = self._registry.get(kind)
        if not self._run_lock.acquire(blocking=False):
            logger.info(
                "maintenance run suppressed: already in flight",
                extra={"maintenance_kind": kind, "maintenance_status": "suppressed"},
            )
            return None
        try:
            return self._run_handler(handler)
        finally:
            self._run_lock.release()

    def tick(self, kind: str) -> DrainReport | None:
        """One scheduler beat: run ``kind`` once, suppressing overlap.

        Identical to :meth:`run_once`; named separately so a caller's own
        timer loop reads as a beat rather than a one-shot.
        """
        return self.run_once(kind)

    def start(self, kind: str, *, interval: float) -> None:
        """Start a single daemon loop that ticks ``kind`` every ``interval`` s.

        Explicit opt-in only — nothing runs in the background until this is
        called. ``interval`` must be > 0. Calling ``start`` while a loop is
        already running raises; call :meth:`stop` first. The kind is resolved
        eagerly so an unknown kind fails at ``start`` rather than silently in a
        background thread.
        """
        if interval <= 0:
            raise ValueError("interval must be > 0")
        # Fail fast on an unknown kind before spawning the loop.
        self._registry.get(kind)
        with self._lifecycle_lock:
            if self._loop is not None and self._loop.is_alive():
                raise RuntimeError("maintenance scheduler is already running")
            self._stop.clear()
            loop = threading.Thread(
                target=self._run_loop,
                args=(kind, interval),
                name=f"ob-maintenance-{kind}",
                daemon=True,
            )
            self._loop = loop
            loop.start()

    def stop(self, *, timeout: float | None = None) -> None:
        """Signal the loop to stop and join it; idempotent when not running."""
        with self._lifecycle_lock:
            loop = self._loop
            self._stop.set()
            if loop is not None:
                loop.join(timeout)
                if not loop.is_alive():
                    self._loop = None

    @property
    def is_running(self) -> bool:
        """True while a background loop thread is alive."""
        loop = self._loop
        return loop is not None and loop.is_alive()

    def _run_loop(self, kind: str, interval: float) -> None:
        # Tick immediately, then wait ``interval`` between beats. ``Event.wait``
        # returns True the instant ``stop`` is signalled, so a clean stop never
        # blocks for a full interval.
        while not self._stop.is_set():
            try:
                self.tick(kind)
            except Exception:
                # ``_run_handler`` already logged this failure content-free and
                # re-raised for a one-shot caller's own accounting. In the loop
                # that re-raise would escape the daemon thread and stop every
                # later beat; swallow it here so a transient handler failure
                # cannot kill the scheduler. Nothing new is logged — the error
                # was already recorded before it reached here.
                pass
            if self._stop.wait(interval):
                break

    def _run_handler(self, handler: MaintenanceHandler) -> DrainReport | None:
        kind = handler.kind
        started = self._monotonic()
        try:
            report = handler.run()
        except Exception:
            elapsed_ms = self._elapsed_ms(started)
            # Content-free: kind, status, timing only. No exception object, no
            # message body — the drain itself never raises, so reaching here
            # means the runtime handle was unusable.
            logger.warning(
                "maintenance run failed",
                extra={
                    "maintenance_kind": kind,
                    "maintenance_status": "error",
                    "maintenance_elapsed_ms": elapsed_ms,
                },
            )
            raise
        elapsed_ms = self._elapsed_ms(started)
        self._log_result(kind, report, elapsed_ms)
        return report

    def _elapsed_ms(self, started: float) -> int:
        return max(0, round((self._monotonic() - started) * 1000))

    @staticmethod
    def _log_result(
        kind: str, report: DrainReport | None, elapsed_ms: int
    ) -> None:
        extra: dict[str, object] = {
            "maintenance_kind": kind,
            "maintenance_elapsed_ms": elapsed_ms,
        }
        if report is None:
            extra["maintenance_status"] = "noop"
        else:
            # Counts only — never receipts, keys, operations, or payloads.
            extra["maintenance_status"] = "ran"
            extra["maintenance_attempted_units"] = report.attempted_units
            extra["maintenance_replayed_units"] = report.replayed_units
            extra["maintenance_failed_units"] = report.failed_units
            extra["maintenance_quarantined_units"] = report.quarantined_units
            extra["maintenance_retained_units"] = report.retained_units
        logger.info("maintenance run complete", extra=extra)
