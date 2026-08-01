"""The monitor's orchestration loop: check every target, evaluate, persist, repeat.

This is where the pieces meet. Everything it coordinates -- checking,
evaluating, storing -- lives elsewhere and is independently testable; this
module owns only the sequencing, the concurrency, and the shutdown.

THE RULES THIS FILE DEMONSTRATES
    **1. A background loop must never die from one bad round.** The loop catches
    ``Exception`` per round, logs it with a traceback, and continues. A monitor
    that exits because one round raised is a monitor that stops monitoring at
    exactly the moment something is wrong -- and nothing is left to report it.

    **2. ``asyncio.CancelledError`` is caught SEPARATELY and re-raised.** It is
    not an error; it is the shutdown signal. Swallowing it inside a broad
    ``except Exception`` makes the task unkillable, so shutdown hangs until
    something sends SIGKILL. In Python 3.8+ ``CancelledError`` inherits from
    ``BaseException``, not ``Exception``, so a bare ``except Exception`` does not
    catch it -- but that is a subtlety worth being explicit about rather than
    relying on.

    **3. Concurrency is bounded.** Targets are checked concurrently, but through
    a semaphore. Unbounded ``gather`` over a large target list opens every
    connection at once, which exhausts file descriptors locally and looks like a
    denial of service remotely.

    **4. State is saved after every round, not on exit.** A process killed
    without a clean shutdown -- OOM, SIGKILL, a node failure -- still has state
    from the last completed round. Saving only on exit means the one case that
    most needs durable state is the one case that loses it.

WHY ONE ROUND IS ITS OWN METHOD
    ``run_once`` does a complete round and returns. The loop calls it repeatedly.
    That split means the entire behaviour can be tested with a single call and no
    timers -- a test that has to wait for a scheduler tick is slow, flaky, and
    usually ends up asserting the sleep rather than the work.

Key Components:
    - MonitorService: owns the loop, the client, the store, and the statuses.

Pattern/Convention:
    Constructed with its dependencies -- settings section, store, client -- and
    never reaching for globals or config. The HTTP client is created by the
    caller so its lifetime is visible where the app starts and stops.

Example:
    >>> service = MonitorService(settings.monitor, store, client)  # doctest: +SKIP
    >>> await service.run_once()          # one round, no loop, for tests
    >>> await service.run_forever()       # the real loop

See Also:
    - exemplar.apps.monitor.checker: performs one check
    - exemplar.apps.monitor.evaluator: decides what checks mean
    - exemplar.apps.monitor.store: persists the result
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from loguru import logger

from exemplar.apps.monitor.checker import check
from exemplar.apps.monitor.evaluator import evaluate, initial_status
from exemplar.models import HealthState, Target
from exemplar.utils.http import RetryPolicy

if TYPE_CHECKING:
    import httpx

    from exemplar.apps.monitor.store import StatusStore
    from exemplar.config import MonitorSettings
    from exemplar.models import CheckResult, HealthStatus

#: Maximum targets checked at once. Bounded for the reason in the module
#: docstring; 10 is a deliberate default, not a tuned value -- large enough that
#: a hundred targets finish quickly, small enough not to exhaust descriptors.
MAX_CONCURRENT_CHECKS = 10


class MonitorService:
    """Checks every configured target on an interval and tracks their health."""

    def __init__(
        self,
        settings: MonitorSettings,
        store: StatusStore,
        client: httpx.AsyncClient,
    ) -> None:
        """Wire the service to its dependencies.

        All three are injected rather than constructed here, so a test can pass
        a fake store and a mock transport without patching anything global.

        Args:
            settings: The monitor section of the application settings.
            store: Persistence for health status.
            client: Caller-owned HTTP client, so its lifetime is explicit.
        """
        self._settings = settings
        self._store = store
        self._client = client
        self._semaphore = asyncio.Semaphore(MAX_CONCURRENT_CHECKS)

        self._retry_policy = RetryPolicy(max_attempts=settings.max_retries)

        # Targets come from config as bare URLs; the name is derived from the
        # host so log lines and the API are readable. A real deployment would
        # let the operator name them, but deriving is better than indexing --
        # "target 3 is down" tells nobody anything.
        self._targets = [
            Target(name=self._derive_name(str(url), index), url=url)
            for index, url in enumerate(settings.targets)
        ]

        # Loaded once at startup so a restart resumes rather than resets.
        self._statuses: dict[str, HealthStatus] = self._store.load()

    @staticmethod
    def _derive_name(url: str, index: int) -> str:
        """Derive a readable, filename-safe target name from its URL.

        Falls back to a positional name only when the host cannot be parsed,
        which should not happen for a validated ``HttpUrl`` but is handled
        rather than assumed.
        """
        from urllib.parse import urlparse

        host = urlparse(url).hostname
        if not host:
            return f"target-{index}"
        # Dots are legal in a filename but awkward in a log field parsed by
        # delimiter, so they become dashes. Target.name rejects slashes and
        # whitespace, which a hostname cannot contain anyway.
        return host.replace(".", "-")

    @property
    def statuses(self) -> dict[str, HealthStatus]:
        """Current health of every target. Read by the HTTP surface."""
        return self._statuses

    async def run_once(self) -> list[CheckResult]:
        """Run one complete round: check all targets, evaluate, persist.

        Returns:
            Every observation from this round, in completion order.

        Raises:
            OSError: The state file could not be written. Propagated -- see
                ``StatusStore.save``.
        """
        if not self._targets:
            # A monitor with nothing to monitor is a configuration mistake, not
            # a crash. Logged at WARNING every round so it cannot go unnoticed.
            logger.warning(
                "ROUND: no targets configured. "
                "ACTION REQUIRED: set EXEMPLAR_MONITOR__TARGETS or add them to "
                "secrets/config.{env}.json"
            )
            return []

        logger.info(f"ROUND: checking {len(self._targets)} target(s)")

        results = await asyncio.gather(
            *(self._check_one(target) for target in self._targets)
        )

        for result in results:
            self._record(result)

        self._store.save(self._statuses)

        unhealthy = sum(
            1 for s in self._statuses.values() if s.state is HealthState.UNHEALTHY
        )
        logger.info(
            f"ROUND: complete checked={len(results)} "
            f"ok={sum(1 for r in results if r.ok)} unhealthy={unhealthy}"
        )
        return list(results)

    async def _check_one(self, target: Target) -> CheckResult:
        """Check one target, holding a concurrency slot for the duration."""
        async with self._semaphore:
            return await check(
                self._client,
                target,
                default_timeout=self._settings.timeout_seconds,
                policy=self._retry_policy,
            )

    def _record(self, result: CheckResult) -> None:
        """Fold one observation into the target's running status."""
        current = self._statuses.get(result.target_name) or initial_status(
            result.target_name
        )
        updated = evaluate(
            current,
            result,
            failure_threshold=self._settings.failure_threshold,
        )

        # Log the TRANSITION, not the state. A line every round saying "still
        # healthy" is noise that buries the one line that matters; a line when
        # something changes is the signal.
        if updated.state is not current.state:
            logger.warning(
                f"HEALTH: {result.target_name} {current.state.value} -> "
                f"{updated.state.value} streak={updated.consecutive_failures} "
                f"error={updated.last_error}"
            )

        self._statuses[result.target_name] = updated

    async def run_forever(self) -> None:
        """Run rounds on the configured interval until cancelled.

        Never returns normally. Exits only via ``asyncio.CancelledError``, which
        is re-raised so the caller's shutdown completes.

        Raises:
            asyncio.CancelledError: Shutdown was requested. Re-raised
                deliberately -- see rule 2 in the module docstring.
        """
        logger.info(
            f"SCHED: starting interval={self._settings.interval_seconds}s "
            f"targets={len(self._targets)}"
        )

        while True:
            try:
                await self.run_once()
            except asyncio.CancelledError:
                # Shutdown, not failure. Re-raise so the task actually ends.
                logger.info("SCHED: cancelled, stopping")
                raise
            except Exception:  # ruff: ignore[blind-except]
                # A blind `except Exception` is normally a defect, and ruff is
                # right to flag it -- BLE001 exists because a bare catch usually
                # hides a bug the author did not anticipate.
                #
                # A SUPERVISOR LOOP IS THE GENUINE EXCEPTION, and it is worth
                # being precise about why, because "supervisor" is also the
                # excuse people use for a catch that just swallows things.
                #
                # This qualifies on three counts, all of which must hold:
                #   1. The alternative is worse. An unhandled exception ends the
                #      loop, so the monitor stops monitoring at exactly the
                #      moment something is wrong, and nothing is left to report.
                #   2. Nothing is swallowed. Every exception is logged at ERROR
                #      with a full traceback, so it is as diagnosable as an
                #      unhandled one -- it just does not kill the process.
                #   3. CancelledError is handled separately, ABOVE this clause,
                #      and re-raised. Shutdown still works. A catch that traps
                #      cancellation is the failure mode that makes a service
                #      unkillable, and that is the case BLE001 usually catches.
                #
                # Remove this suppression the moment any of those stops being
                # true. See STANDARDS-python.md ## Error handling, pattern 4.
                logger.error(
                    "SCHED: round failed, continuing to next interval",
                    exc_info=True,
                )

            try:
                await asyncio.sleep(self._settings.interval_seconds)
            except asyncio.CancelledError:
                # Cancellation almost always lands here, in the sleep, since
                # that is where the loop spends its time.
                logger.info("SCHED: cancelled while idle, stopping")
                raise
